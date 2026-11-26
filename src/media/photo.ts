import { FirebaseApp } from 'firebase/app';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { getFirebaseApp, initFirebase } from '../firebase/firestore';

export const DATING_PHOTO_MAX_DIMENSION = 420;
export const DATING_PHOTO_MIN_DIMENSION = 300;
export const DATING_PHOTO_MAX_BYTES = 140 * 1024;
export const DATING_PHOTO_MAX_RAW_BYTES = 12 * 1024 * 1024;
export const DATING_PHOTO_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface CompressedDatingPhoto {
  blob: Blob;
  byteSize: number;
  width: number;
  height: number;
  previewDataUrl: string;
}

export interface UploadedDatingPhoto {
  photoUrl: string;
  photoPath: string;
}

export function isSupportedPhotoMimeType(mime: string | null | undefined): boolean {
  if (!mime || typeof mime !== 'string') return false;
  const normalized = mime.trim().toLowerCase();
  return (DATING_PHOTO_ACCEPTED_TYPES as readonly string[]).includes(normalized);
}

export function computeTargetPhotoDimensions(
  width: number,
  height: number,
  maxDimension: number = DATING_PHOTO_MAX_DIMENSION
): { width: number; height: number } {
  const safeMax = Math.max(DATING_PHOTO_MIN_DIMENSION, Math.min(500, Math.round(maxDimension)));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: safeMax, height: safeMax };
  }
  const largest = Math.max(width, height);
  if (largest <= safeMax) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }
  const ratio = safeMax / largest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export function buildDatingPhotoStoragePath(uid: string): string {
  return `datingPhotos/${String(uid || '').trim()}/avatar.webp`;
}

function loadHtmlImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      reject(new Error('IMAGE_PROCESSING_UNSUPPORTED'));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('IMAGE_DECODE_FAILED'));
    };
    img.src = objectUrl;
  });
}

function canvasToWebPBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
  });
}

/**
 * Converte e comprime localmente para WebP (máx. 420px, <= 140 KB),
 * removendo metadados EXIF ao redesenhar em canvas.
 */
export async function compressImageToDatingWebP(file: File): Promise<CompressedDatingPhoto> {
  if (!file || !isSupportedPhotoMimeType(file.type)) {
    throw new Error('PHOTO_UNSUPPORTED_TYPE');
  }
  if (file.size <= 0 || file.size > DATING_PHOTO_MAX_RAW_BYTES) {
    throw new Error('PHOTO_FILE_TOO_LARGE');
  }

  const img = await loadHtmlImageFromFile(file);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) {
    throw new Error('IMAGE_DECODE_FAILED');
  }

  const dimensionAttempts = [DATING_PHOTO_MAX_DIMENSION, DATING_PHOTO_MIN_DIMENSION];
  const qualitySteps = [0.8, 0.65, 0.5, 0.38];

  for (const maxDim of dimensionAttempts) {
    const target = computeTargetPhotoDimensions(naturalW, naturalH, maxDim);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('CANVAS_UNSUPPORTED');
    }
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(img, 0, 0, target.width, target.height);

    for (const q of qualitySteps) {
      const blob = await canvasToWebPBlob(canvas, q);
      if (!blob || blob.type !== 'image/webp') {
        throw new Error('WEBP_ENCODE_UNSUPPORTED');
      }
      if (blob.size <= DATING_PHOTO_MAX_BYTES) {
        const previewDataUrl = canvas.toDataURL('image/webp', q);
        return {
          blob,
          byteSize: blob.size,
          width: target.width,
          height: target.height,
          previewDataUrl,
        };
      }
    }
  }

  throw new Error('PHOTO_COMPRESSION_EXCEEDED_LIMIT');
}

export async function uploadDatingPhotoWebP(uid: string, blob: Blob): Promise<UploadedDatingPhoto> {
  if (!uid) throw new Error('AUTH_REQUIRED');
  if (!blob || blob.size <= 0) throw new Error('PHOTO_EMPTY');
  if (blob.type !== 'image/webp') throw new Error('PHOTO_WEBP_REQUIRED');
  if (blob.size > DATING_PHOTO_MAX_BYTES) throw new Error('PHOTO_FILE_TOO_LARGE');

  if (!getFirebaseApp()) {
    await initFirebase();
  }
  const app = getFirebaseApp();
  if (!app) throw new Error('FIREBASE_NOT_INITIALIZED');

  const photoPath = buildDatingPhotoStoragePath(uid);
  const storage = getStorage(app);
  const storageRef = ref(storage, photoPath);

  await uploadBytes(storageRef, blob, {
    contentType: 'image/webp',
    cacheControl: 'public, max-age=3600',
  });
  const photoUrl = await getDownloadURL(storageRef);

  return { photoUrl, photoPath };
}

export async function deleteDatingPhotoFromStorage(
  uid: string,
  appOverride?: FirebaseApp | null
): Promise<void> {
  if (!uid) return;
  try {
    let app = appOverride ?? getFirebaseApp();
    if (!app) {
      await initFirebase();
      app = getFirebaseApp();
    }
    if (!app) return;
    const storage = getStorage(app);
    const storageRef = ref(storage, buildDatingPhotoStoragePath(uid));
    await deleteObject(storageRef);
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'storage/object-not-found') return;
    // Best-effort cleanup so missing Storage setup never blocks profile removal/Hard Delete
  }
}
