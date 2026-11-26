import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getFirebaseDB, initFirebase } from './firebase/firestore';
import { ReferralAttribution, ReferralLink, ReferralMetricsSummary, ReferralStats } from './types';

export const REFERRAL_CODE_REGEX = /^[A-Z0-9]{6,12}$/;
const PENDING_REF_KEY = 'talk2tm_pending_ref_v1';
const REF_SUMMARY_PREFIX = 'talk2tm_ref_summary_v1_';

let memoryPendingReferralCode: string | null = null;
const memorySummaryCache = new Map<string, ReferralMetricsSummary>();

export function isValidReferralCode(code: string | null | undefined): boolean {
  if (!code || typeof code !== 'string') return false;
  return REFERRAL_CODE_REGEX.test(code.trim().toUpperCase());
}

export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return REFERRAL_CODE_REGEX.test(cleaned) ? cleaned : null;
}

export function extractReferralCodeFromSearch(search: string): string | null {
  if (!search || typeof search !== 'string') return null;
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    return normalizeReferralCode(params.get('ref'));
  } catch {
    return null;
  }
}

export function deriveDeterministicReferralCode(uid: string): string {
  const input = String(uid || '').trim() || 'talk2tm';
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  let combined = (BigInt(h1) << 32n) | BigInt(h2);
  for (let i = 0; i < 6; i++) {
    const idx = Number(combined % BigInt(alphabet.length));
    suffix += alphabet[idx];
    combined = combined / BigInt(alphabet.length);
  }
  return `TM${suffix}`;
}

export function buildCanonicalReferralUrl(origin: string, code: string): string {
  const normalizedOrigin = String(origin || '').replace(/\/+$/, '');
  const safeCode = normalizeReferralCode(code) || '';
  if (!normalizedOrigin) return safeCode ? `/?ref=${safeCode}` : '/';
  return safeCode ? `${normalizedOrigin}/?ref=${safeCode}` : normalizedOrigin;
}

export function buildWhatsAppReferralShareUrl(messageText: string): string {
  return `https://wa.me/?text=${encodeURIComponent(String(messageText || '').trim())}`;
}

export function computeConversionRatePercent(sharedCount: number, convertedCount: number): number {
  const safeShared = Number.isFinite(sharedCount) ? Math.max(0, sharedCount) : 0;
  const safeConverted = Number.isFinite(convertedCount) ? Math.max(0, convertedCount) : 0;
  if (safeConverted <= 0) return 0;
  if (safeShared <= 0) return 100;
  return Math.min(100, Math.round((safeConverted / safeShared) * 100));
}

export function savePendingReferralCode(rawCode: string | null | undefined): string | null {
  const normalized = normalizeReferralCode(rawCode);
  if (!normalized) return null;
  memoryPendingReferralCode = normalized;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PENDING_REF_KEY, normalized);
    }
  } catch {
    // Fallback em memória
  }
  return normalized;
}

export function getPendingReferralCode(): string | null {
  if (memoryPendingReferralCode) return memoryPendingReferralCode;
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = normalizeReferralCode(localStorage.getItem(PENDING_REF_KEY));
      if (stored) {
        memoryPendingReferralCode = stored;
        return stored;
      }
    }
  } catch {
    // Fallback
  }
  return null;
}

export function clearPendingReferralCode(): void {
  memoryPendingReferralCode = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PENDING_REF_KEY);
    }
  } catch {
    // noop
  }
}

export function loadCachedReferralMetrics(uid: string): ReferralMetricsSummary | null {
  if (!uid) return null;
  const mem = memorySummaryCache.get(uid);
  if (mem) return mem;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`${REF_SUMMARY_PREFIX}${uid}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ReferralMetricsSummary;
      if (parsed && typeof parsed.referralCode === 'string') {
        memorySummaryCache.set(uid, parsed);
        return parsed;
      }
    }
  } catch {
    // noop
  }
  return null;
}

export function saveCachedReferralMetrics(uid: string, summary: ReferralMetricsSummary): void {
  if (!uid) return;
  memorySummaryCache.set(uid, summary);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${REF_SUMMARY_PREFIX}${uid}`, JSON.stringify(summary));
    }
  } catch {
    // noop
  }
}

export function clearReferralMemoryForTests(): void {
  memoryPendingReferralCode = null;
  memorySummaryCache.clear();
}

export async function fetchPublicReferralInvite(rawCode: string): Promise<ReferralLink | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;

  await initFirebase();
  const db = getFirebaseDB();
  if (!db) return null;

  try {
    const snap = await Promise.race([
      getDoc(doc(db, 'referralLinks', code)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2200)),
    ]);
    if (!snap || !snap.exists()) return null;
    const data = snap.data() as ReferralLink;
    if (!data || data.active !== true || !isValidReferralCode(data.code)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function ensureOwnReferralLink(uid: string, displayName: string): Promise<ReferralLink | null> {
  if (!uid) return null;
  await initFirebase();
  const db = getFirebaseDB();
  if (!db) return null;

  const code = deriveDeterministicReferralCode(uid);
  const safeName = String(displayName || 'Talk2TM').trim().slice(0, 30) || 'Talk2TM';
  const linkRef = doc(db, 'referralLinks', code);

  try {
    const existing = await getDoc(linkRef);
    if (!existing.exists()) {
      const payload: ReferralLink = {
        code,
        referrerUid: uid,
        referrerDisplayName: safeName,
        active: true,
        createdAt: new Date().toISOString(),
      };
      await setDoc(linkRef, payload);
      return payload;
    }
    const data = existing.data() as ReferralLink;
    if (data.referrerUid === uid && (data.referrerDisplayName !== safeName || data.active !== true)) {
      await updateDoc(linkRef, {
        referrerDisplayName: safeName,
        active: true,
      });
      return { ...data, referrerDisplayName: safeName, active: true };
    }
    return data;
  } catch {
    return null;
  }
}

export async function fetchOwnReferralMetrics(
  uid: string,
  displayName: string,
  origin: string = typeof window !== 'undefined' ? window.location.origin : '',
  shareMessageBuilder?: (inviteUrl: string) => string
): Promise<ReferralMetricsSummary> {
  const code = deriveDeterministicReferralCode(uid);
  const inviteUrl = buildCanonicalReferralUrl(origin, code);
  const messageText = shareMessageBuilder ? shareMessageBuilder(inviteUrl) : inviteUrl;
  const whatsappUrl = buildWhatsAppReferralShareUrl(messageText);

  const cached = loadCachedReferralMetrics(uid);
  const fallback: ReferralMetricsSummary = {
    referralCode: code,
    inviteUrl,
    whatsappUrl,
    invitesSharedCount: cached?.invitesSharedCount ?? 0,
    convertedCount: cached?.convertedCount ?? 0,
  };

  if (!uid) return fallback;
  await initFirebase();
  const db = getFirebaseDB();
  if (!db) return fallback;

  try {
    await ensureOwnReferralLink(uid, displayName);
    const statsSnap = await getDoc(doc(db, 'referralStats', uid));
    const statsData = statsSnap.exists() ? (statsSnap.data() as ReferralStats) : null;

    const attrSnap = await getDocs(
      query(
        collection(db, 'referralAttributions'),
        where('referrerUid', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(200)
      )
    );

    const summary: ReferralMetricsSummary = {
      referralCode: code,
      inviteUrl,
      whatsappUrl,
      invitesSharedCount: Math.max(cached?.invitesSharedCount ?? 0, statsData?.invitesSharedCount ?? 0),
      convertedCount: attrSnap.size,
    };
    saveCachedReferralMetrics(uid, summary);
    return summary;
  } catch {
    return fallback;
  }
}

export async function incrementOwnReferralShareCount(
  uid: string,
  referralCode?: string
): Promise<number> {
  if (!uid) return 0;
  const code = normalizeReferralCode(referralCode) || deriveDeterministicReferralCode(uid);
  const cached = loadCachedReferralMetrics(uid);
  const nextLocal = (cached?.invitesSharedCount ?? 0) + 1;

  if (cached) {
    saveCachedReferralMetrics(uid, {
      ...cached,
      invitesSharedCount: nextLocal,
    });
  }

  await initFirebase();
  const db = getFirebaseDB();
  if (!db) return nextLocal;

  const statsRef = doc(db, 'referralStats', uid);
  try {
    const snap = await getDoc(statsRef);
    const nowIso = new Date().toISOString();
    if (!snap.exists()) {
      const nextCount = Math.max(1, nextLocal);
      const docPayload: ReferralStats = {
        uid,
        referralCode: code,
        invitesSharedCount: nextCount,
        updatedAt: nowIso,
      };
      await setDoc(statsRef, docPayload);
      return nextCount;
    }
    const data = snap.data() as ReferralStats;
    const nextCount = Math.min(50000, (Number(data.invitesSharedCount) || 0) + 1);
    await updateDoc(statsRef, {
      referralCode: code,
      invitesSharedCount: nextCount,
      updatedAt: nowIso,
    });
    if (cached) {
      saveCachedReferralMetrics(uid, {
        ...cached,
        invitesSharedCount: nextCount,
      });
    }
    return nextCount;
  } catch {
    return nextLocal;
  }
}

export async function attributeRegistrationReferral(params: {
  newUid: string;
  newTalk2tmId: string;
  referralCode: string;
}): Promise<boolean> {
  const code = normalizeReferralCode(params.referralCode);
  if (!code || !params.newUid || !params.newTalk2tmId) return false;

  await initFirebase();
  const db = getFirebaseDB();
  if (!db) return false;

  try {
    const linkSnap = await getDoc(doc(db, 'referralLinks', code));
    if (!linkSnap.exists()) return false;
    const linkData = linkSnap.data() as ReferralLink;
    if (!linkData.active || !linkData.referrerUid || linkData.referrerUid === params.newUid) {
      return false;
    }

    const attrRef = doc(db, 'referralAttributions', params.newUid);
    const existingAttr = await getDoc(attrRef);
    if (existingAttr.exists()) return false;

    const attribution: ReferralAttribution = {
      newUid: params.newUid,
      newTalk2tmId: params.newTalk2tmId,
      referralCode: code,
      referrerUid: linkData.referrerUid,
      createdAt: new Date().toISOString(),
    };
    await setDoc(attrRef, attribution);
    return true;
  } catch {
    return false;
  }
}
