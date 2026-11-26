/**
 * Talk2TM Dating (Fase 1) — Módulo `datingProfiles`
 *
 * Responsabilidades:
 * 1. Validação estrita de perfil adulto (+18 obrigatório, bio <= 160 chars, termos aceitos).
 * 2. Descoberta finita (máx. 5 sugestões diárias, zero feed infinito, zero GPS contínuo).
 * 3. Filtros por idade, género, preferência recíproca, país e cidade.
 * 4. Exclusão de perfis ocultos, pausados/suspensos, bloqueados e já avaliados.
 * 5. Cache local leve (localStorage + fallback em memória) para latência zero e economia de leituras.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
  QueryConstraint,
  Unsubscribe,
} from 'firebase/firestore';
import {
  Conversation,
  DatingDiscoveryFilters,
  DatingDiscoveryResult,
  DatingEvaluationDecision,
  DatingEvaluationRecord,
  DatingGender,
  DatingIntent,
  DatingLike,
  DatingLikeResult,
  DatingMatch,
  DatingProfile,
  DatingProfileInput,
  DatingSeeking,
} from './types';
import {
  getFirebaseAuth,
  getFirebaseDB,
  handleFirestoreError,
  initFirebase,
  isAuthValidAndNonAnonymous,
  OperationType,
} from './firebase/firestore';
import { buildUidConversationId } from './conversation';
import { sanitizeName } from './utils/sanitize';
import { normalizeSearchText, PHONE_COUNTRIES } from './utils/phone';
import { t } from './i18n';
import {
  addBlockedUidLocally,
  buildNextDailyRateLimitState,
  fetchSyncedRateLimitState,
  isLocallyBlockedPair,
  loadLocalBlockedUids,
  saveLocalRateLimitState,
} from './safety';
import { deleteDatingPhotoFromStorage, uploadDatingPhotoWebP } from './media/photo';

export const DATING_DAILY_DISCOVERY_LIMIT = 5;
export const DATING_MIN_AGE = 18;
export const DATING_MAX_AGE = 99;
export const DATING_BIO_MAX_LENGTH = 160;
export const DATING_CITY_MAX_LENGTH = 60;
export const DATING_TERMS_VERSION = '2026-11';
export const DATING_FETCH_PAGE_SIZE = 25;
const DATING_MAX_PAGES_PER_DISCOVERY = 3;

const DATING_PROFILE_CACHE_PREFIX = 'talk2tm_dating_profile_v1_';
const DATING_FILTERS_CACHE_PREFIX = 'talk2tm_dating_filters_v1_';
const DATING_EVALUATIONS_CACHE_PREFIX = 'talk2tm_dating_evals_v1_';
const DATING_BLOCKS_CACHE_PREFIX = 'talk2tm_dating_blocks_v1_';
const DATING_MATCHES_CACHE_PREFIX = 'talk2tm_dating_matches_v1_';

const VALID_COUNTRY_CODES = new Set(PHONE_COUNTRIES.map((c) => c.iso));
const VALID_GENDERS = new Set<DatingGender>(['woman', 'man', 'non_binary']);
const VALID_SEEKING = new Set<DatingSeeking>(['women', 'men', 'all']);
const VALID_INTENTS = new Set<DatingIntent>(['serious', 'meet_people', 'chat']);

const memoryStorageFallback = new Map<string, string>();

function readStorageItem(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    // fallback em memória abaixo
  }
  return memoryStorageFallback.get(key) ?? null;
}

function writeStorageItem(key: string, value: string): void {
  memoryStorageFallback.set(key, value);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // ignora erro de quota/privacidade no navegador
  }
}

export function clearDatingMemoryFallbackForTests(): void {
  memoryStorageFallback.clear();
}

export function getLocalDayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeCityName(rawCity: string): string {
  if (!rawCity) return '';
  return rawCity
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DATING_CITY_MAX_LENGTH);
}

export function normalizeCityKey(rawCity: string): string {
  const clean = normalizeCityName(rawCity);
  if (!clean) return '';
  return normalizeSearchText(clean).slice(0, DATING_CITY_MAX_LENGTH);
}

export function sanitizeDatingBio(rawBio: string): string {
  if (!rawBio) return '';
  return rawBio
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDatingCountryCode(rawCode?: string): string {
  const code = (rawCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  if (VALID_COUNTRY_CODES.size > 0 && !VALID_COUNTRY_CODES.has(code)) return '';
  return code;
}

export function isValidGender(val: unknown): val is DatingGender {
  return typeof val === 'string' && VALID_GENDERS.has(val as DatingGender);
}

export function isValidSeeking(val: unknown): val is DatingSeeking {
  return typeof val === 'string' && VALID_SEEKING.has(val as DatingSeeking);
}

export function isValidIntent(val: unknown): val is DatingIntent {
  return typeof val === 'string' && VALID_INTENTS.has(val as DatingIntent);
}

export interface ValidatedDatingProfilePayload {
  displayName: string;
  age: number;
  gender: DatingGender;
  seeking: DatingSeeking;
  countryCode: string;
  city: string;
  cityKey: string;
  bio: string;
  intent: DatingIntent;
  adultConfirmed: true;
  discoverable: boolean;
  paused: boolean;
}

export function validateDatingProfileInput(input: DatingProfileInput): {
  valid: boolean;
  error?: string;
  normalized?: ValidatedDatingProfilePayload;
} {
  const displayName = sanitizeName(input.displayName || '');
  if (!displayName) {
    return { valid: false, error: t('dating.errNameRequired') };
  }

  const parsedAge = Number(input.age);
  if (!Number.isInteger(parsedAge) || parsedAge < DATING_MIN_AGE || parsedAge > DATING_MAX_AGE) {
    return { valid: false, error: t('dating.errAdultAgeRequired') };
  }

  if (input.adultConfirmed !== true) {
    return { valid: false, error: t('dating.errAdultConfirmRequired') };
  }

  if (input.termsAccepted !== true) {
    return { valid: false, error: t('dating.errTermsRequired') };
  }

  if (!isValidGender(input.gender)) {
    return { valid: false, error: t('dating.errGenderRequired') };
  }

  if (!isValidSeeking(input.seeking)) {
    return { valid: false, error: t('dating.errSeekingRequired') };
  }

  const countryCode = normalizeDatingCountryCode(input.countryCode);
  if (!countryCode) {
    return { valid: false, error: t('dating.errCountryRequired') };
  }

  const city = normalizeCityName(input.city || '');
  const cityKey = normalizeCityKey(city);
  if (!city || !cityKey) {
    return { valid: false, error: t('dating.errCityRequired') };
  }

  const bio = sanitizeDatingBio(input.bio || '');
  if (!bio) {
    return { valid: false, error: t('dating.errBioRequired') };
  }
  if (bio.length > DATING_BIO_MAX_LENGTH) {
    return {
      valid: false,
      error: t('dating.errBioTooLong', { max: DATING_BIO_MAX_LENGTH }),
    };
  }

  if (!isValidIntent(input.intent)) {
    return { valid: false, error: t('dating.errIntentRequired') };
  }

  return {
    valid: true,
    normalized: {
      displayName,
      age: parsedAge,
      gender: input.gender,
      seeking: input.seeking,
      countryCode,
      city,
      cityKey,
      bio,
      intent: input.intent,
      adultConfirmed: true,
      discoverable: input.discoverable !== false,
      paused: input.paused === true,
    },
  };
}

export function validateDatingFilters(
  filters: Partial<DatingDiscoveryFilters>,
  fallbackCountryCode = ''
): DatingDiscoveryFilters {
  let minAge = Number.isFinite(Number(filters.minAge))
    ? Math.floor(Number(filters.minAge))
    : DATING_MIN_AGE;
  let maxAge = Number.isFinite(Number(filters.maxAge))
    ? Math.floor(Number(filters.maxAge))
    : DATING_MAX_AGE;

  minAge = Math.max(DATING_MIN_AGE, Math.min(DATING_MAX_AGE, minAge));
  maxAge = Math.max(DATING_MIN_AGE, Math.min(DATING_MAX_AGE, maxAge));
  if (maxAge < minAge) {
    maxAge = minAge;
  }

  const seeking: DatingSeeking = isValidSeeking(filters.seeking) ? filters.seeking : 'all';
  const rawCountry =
    filters.countryCode === ''
      ? ''
      : normalizeDatingCountryCode(filters.countryCode ?? fallbackCountryCode);
  const city = normalizeCityName(filters.city || '');

  return {
    minAge,
    maxAge,
    seeking,
    countryCode: rawCountry,
    city,
  };
}

function seekingMatchesGender(seeking: DatingSeeking, gender: DatingGender): boolean {
  if (seeking === 'all') return true;
  if (seeking === 'women') return gender === 'woman';
  if (seeking === 'men') return gender === 'man';
  return false;
}

/**
 * Compatibilidade bilateral estrita de género e preferência:
 * - O perfil candidato deve corresponder à preferência escolhida pelo utilizador
 * - E o utilizador também deve corresponder à preferência declarada pelo perfil candidato.
 */
export function isGenderCompatible(
  viewerGender: DatingGender,
  viewerSeeking: DatingSeeking,
  candidateGender: DatingGender,
  candidateSeeking: DatingSeeking
): boolean {
  return (
    seekingMatchesGender(viewerSeeking, candidateGender) &&
    seekingMatchesGender(candidateSeeking, viewerGender)
  );
}

export function doesProfileMatchFilters(
  candidate: DatingProfile,
  viewer: {
    uid: string;
    gender: DatingGender;
    blockedUids?: ReadonlySet<string>;
    evaluatedUids?: ReadonlySet<string>;
  },
  filters: DatingDiscoveryFilters
): boolean {
  if (!candidate || !candidate.uid || candidate.uid === viewer.uid) return false;
  if (!candidate.discoverable || candidate.paused || candidate.suspended) return false;
  if (!candidate.adultConfirmed || !Number.isInteger(candidate.age) || candidate.age < DATING_MIN_AGE) {
    return false;
  }
  if (viewer.blockedUids?.has(candidate.uid)) return false;
  if (viewer.evaluatedUids?.has(candidate.uid)) return false;

  if (candidate.age < filters.minAge || candidate.age > filters.maxAge) return false;
  if (!isGenderCompatible(viewer.gender, filters.seeking, candidate.gender, candidate.seeking)) {
    return false;
  }

  if (filters.countryCode && candidate.countryCode !== filters.countryCode) {
    return false;
  }
  const filterCityKey = normalizeCityKey(filters.city);
  if (filterCityKey && candidate.cityKey !== filterCityKey) {
    return false;
  }

  return true;
}

export function filterAndLimitDiscoveryCandidates(params: {
  rawCandidates: DatingProfile[];
  viewer: {
    uid: string;
    gender: DatingGender;
    blockedUids?: ReadonlySet<string>;
    evaluatedUids?: ReadonlySet<string>;
  };
  filters: DatingDiscoveryFilters;
  remainingToday: number;
}): DatingProfile[] {
  const limitCount = Math.max(0, Math.min(DATING_DAILY_DISCOVERY_LIMIT, params.remainingToday));
  if (limitCount === 0) return [];

  const matched: DatingProfile[] = [];
  const seenUids = new Set<string>();

  for (const candidate of params.rawCandidates) {
    if (!candidate?.uid || seenUids.has(candidate.uid)) continue;
    seenUids.add(candidate.uid);
    if (doesProfileMatchFilters(candidate, params.viewer, params.filters)) {
      matched.push(candidate);
      if (matched.length >= limitCount) break;
    }
  }

  return matched;
}

// ====================================================================
// Cache Local de Perfil, Filtros, Bloqueios & Limite Diário (5/dia)
// ====================================================================

export function saveLocalDatingProfile(profile: DatingProfile): void {
  writeStorageItem(`${DATING_PROFILE_CACHE_PREFIX}${profile.uid}`, JSON.stringify(profile));
}

export function loadSavedDatingProfile(uid: string): DatingProfile | null {
  if (!uid) return null;
  const raw = readStorageItem(`${DATING_PROFILE_CACHE_PREFIX}${uid}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DatingProfile;
    if (parsed && parsed.uid === uid && typeof parsed.age === 'number') {
      return parsed;
    }
  } catch {
    // ignora cache corrompido
  }
  return null;
}

export function saveLocalDatingFilters(uid: string, filters: DatingDiscoveryFilters): void {
  if (!uid) return;
  writeStorageItem(`${DATING_FILTERS_CACHE_PREFIX}${uid}`, JSON.stringify(filters));
}

export function loadSavedDatingFilters(
  uid: string,
  defaultSeeking: DatingSeeking = 'all',
  defaultCountryCode = ''
): DatingDiscoveryFilters {
  const fallback = validateDatingFilters(
    {
      minAge: DATING_MIN_AGE,
      maxAge: DATING_MAX_AGE,
      seeking: defaultSeeking,
      countryCode: defaultCountryCode,
      city: '',
    },
    defaultCountryCode
  );
  if (!uid) return fallback;
  const raw = readStorageItem(`${DATING_FILTERS_CACHE_PREFIX}${uid}`);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<DatingDiscoveryFilters>;
    return validateDatingFilters(parsed, defaultCountryCode);
  } catch {
    return fallback;
  }
}

export function loadLocalEvaluations(uid: string): Record<string, DatingEvaluationRecord> {
  if (!uid) return {};
  const raw = readStorageItem(`${DATING_EVALUATIONS_CACHE_PREFIX}${uid}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, DatingEvaluationRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalEvaluationsMap(uid: string, map: Record<string, DatingEvaluationRecord>): void {
  writeStorageItem(`${DATING_EVALUATIONS_CACHE_PREFIX}${uid}`, JSON.stringify(map));
}

export function loadBlockedUids(uid: string): Set<string> {
  if (!uid) return new Set();
  const blocked = new Set<string>();
  const rawBlocks = readStorageItem(`${DATING_BLOCKS_CACHE_PREFIX}${uid}`);
  if (rawBlocks) {
    try {
      const list = JSON.parse(rawBlocks);
      if (Array.isArray(list)) {
        list.forEach((id) => {
          if (typeof id === 'string' && id) blocked.add(id);
        });
      }
    } catch {
      // ignora
    }
  }
  const evals = loadLocalEvaluations(uid);
  for (const rec of Object.values(evals)) {
    if (rec?.decision === 'blocked' && rec.targetUid) {
      blocked.add(rec.targetUid);
    }
  }
  return blocked;
}

export function getDailyDiscoveryQuota(
  uid: string,
  dayKey: string = getLocalDayKey()
): {
  dayKey: string;
  usedToday: number;
  remainingToday: number;
  dailyLimit: number;
  evaluatedUids: Set<string>;
} {
  const evals = loadLocalEvaluations(uid);
  const evaluatedUids = new Set<string>();
  let usedToday = 0;

  for (const rec of Object.values(evals)) {
    if (!rec?.targetUid) continue;
    evaluatedUids.add(rec.targetUid);
    if (rec.dayKey === dayKey) {
      usedToday++;
    }
  }

  const remainingToday = Math.max(0, DATING_DAILY_DISCOVERY_LIMIT - usedToday);
  return {
    dayKey,
    usedToday,
    remainingToday,
    dailyLimit: DATING_DAILY_DISCOVERY_LIMIT,
    evaluatedUids,
  };
}

export function recordLocalEvaluation(
  uid: string,
  targetUid: string,
  decision: DatingEvaluationDecision,
  dayKey: string = getLocalDayKey()
): DatingEvaluationRecord {
  const map = loadLocalEvaluations(uid);
  const record: DatingEvaluationRecord = {
    targetUid,
    decision,
    createdAt: new Date().toISOString(),
    dayKey,
  };
  map[targetUid] = record;
  saveLocalEvaluationsMap(uid, map);
  return record;
}

// ====================================================================
// Persistência e Consultas Paginadas no Firestore (`datingProfiles`)
// ====================================================================

export async function getOwnDatingProfile(uid: string): Promise<DatingProfile | null> {
  const cached = loadSavedDatingProfile(uid);
  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    return cached;
  }

  try {
    const snap = await getDoc(doc(db, 'datingProfiles', uid));
    if (!snap.exists()) {
      return null;
    }
    const remote = snap.data() as DatingProfile;
    saveLocalDatingProfile(remote);
    return remote;
  } catch (err) {
    if (cached) return cached;
    handleFirestoreError(err, OperationType.GET, `datingProfiles/${uid}`);
  }
}

export async function upsertOwnDatingProfile(
  uid: string,
  talk2tmId: string,
  input: DatingProfileInput
): Promise<DatingProfile> {
  const check = validateDatingProfileInput(input);
  if (!check.valid || !check.normalized) {
    throw new Error(check.error || t('dating.errProfileInvalid'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const existing = await getOwnDatingProfile(uid).catch(() => loadSavedDatingProfile(uid));
  const nowIso = new Date().toISOString();
  const norm = check.normalized;

  if (!existing) {
    const profile: DatingProfile = {
      uid,
      talk2tmId,
      displayName: norm.displayName,
      age: norm.age,
      gender: norm.gender,
      seeking: norm.seeking,
      countryCode: norm.countryCode,
      city: norm.city,
      cityKey: norm.cityKey,
      bio: norm.bio,
      intent: norm.intent,
      adultConfirmed: true,
      termsAcceptedAt: nowIso,
      termsVersion: DATING_TERMS_VERSION,
      discoverable: norm.discoverable,
      paused: norm.paused,
      suspended: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      await setDoc(doc(db, 'datingProfiles', uid), profile);
      saveLocalDatingProfile(profile);
      return profile;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `datingProfiles/${uid}`);
    }
  }

  const updated: DatingProfile = {
    ...existing,
    displayName: norm.displayName,
    age: norm.age,
    gender: norm.gender,
    seeking: norm.seeking,
    countryCode: norm.countryCode,
    city: norm.city,
    cityKey: norm.cityKey,
    bio: norm.bio,
    intent: norm.intent,
    adultConfirmed: true,
    termsAcceptedAt: existing.termsAcceptedAt || nowIso,
    termsVersion: existing.termsVersion || DATING_TERMS_VERSION,
    discoverable: norm.discoverable,
    paused: norm.paused,
    updatedAt: nowIso,
  };

  try {
    await updateDoc(doc(db, 'datingProfiles', uid), {
      displayName: updated.displayName,
      age: updated.age,
      gender: updated.gender,
      seeking: updated.seeking,
      countryCode: updated.countryCode,
      city: updated.city,
      cityKey: updated.cityKey,
      bio: updated.bio,
      intent: updated.intent,
      adultConfirmed: true,
      termsAcceptedAt: updated.termsAcceptedAt,
      termsVersion: updated.termsVersion,
      discoverable: updated.discoverable,
      paused: updated.paused,
      updatedAt: updated.updatedAt,
    });
    saveLocalDatingProfile(updated);
    return updated;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `datingProfiles/${uid}`);
  }
}

/**
 * Garante que apenas fotografias explicitamente aprovadas pela moderação
 * sejam exibidas a terceiros nos cartões de descoberta ou lista de matches.
 */
export function shouldDisplayCandidatePhoto(
  profile?: Pick<DatingProfile, 'photoUrl' | 'photoStatus'> | null
): boolean {
  return Boolean(
    typeof profile?.photoUrl === 'string' &&
      profile.photoUrl.startsWith('https://') &&
      profile.photoStatus === 'approved'
  );
}

export async function updateOwnDatingPhoto(params: {
  uid: string;
  fileBlob: Blob;
}): Promise<DatingProfile> {
  const { uid, fileBlob } = params;
  const existing = await getOwnDatingProfile(uid);
  if (!existing) {
    throw new Error(t('dating.errProfileNotFound'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const { photoUrl, photoPath } = await uploadDatingPhotoWebP(uid, fileBlob);
  const nowIso = new Date().toISOString();
  const updated: DatingProfile = {
    ...existing,
    photoUrl,
    photoPath,
    photoStatus: 'pending',
    photoUpdatedAt: nowIso,
    photoModerationNote: null,
    updatedAt: nowIso,
  };

  try {
    await updateDoc(doc(db, 'datingProfiles', uid), {
      photoUrl,
      photoPath,
      photoStatus: 'pending',
      photoUpdatedAt: nowIso,
      photoModerationNote: null,
      updatedAt: nowIso,
    });
    saveLocalDatingProfile(updated);
    return updated;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `datingProfiles/${uid}`);
  }
}

export async function removeOwnDatingPhoto(uid: string): Promise<DatingProfile> {
  const existing = await getOwnDatingProfile(uid);
  if (!existing) {
    throw new Error(t('dating.errProfileNotFound'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const nowIso = new Date().toISOString();
  const updated: DatingProfile = {
    ...existing,
    photoUrl: null,
    photoPath: null,
    photoStatus: 'none',
    photoUpdatedAt: nowIso,
    photoModerationNote: null,
    updatedAt: nowIso,
  };

  try {
    await updateDoc(doc(db, 'datingProfiles', uid), {
      photoUrl: null,
      photoPath: null,
      photoStatus: 'none',
      photoUpdatedAt: nowIso,
      photoModerationNote: null,
      updatedAt: nowIso,
    });
    await deleteDatingPhotoFromStorage(uid);
    saveLocalDatingProfile(updated);
    return updated;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `datingProfiles/${uid}`);
  }
}

export async function setDatingProfileVisibility(
  uid: string,
  opts: { discoverable?: boolean; paused?: boolean }
): Promise<DatingProfile> {
  const existing = await getOwnDatingProfile(uid);
  if (!existing) {
    throw new Error(t('dating.errProfileNotFound'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const nextDiscoverable =
    typeof opts.discoverable === 'boolean' ? opts.discoverable : existing.discoverable;
  const nextPaused = typeof opts.paused === 'boolean' ? opts.paused : existing.paused;
  const nowIso = new Date().toISOString();

  const updated: DatingProfile = {
    ...existing,
    discoverable: nextDiscoverable,
    paused: nextPaused,
    updatedAt: nowIso,
  };

  try {
    await updateDoc(doc(db, 'datingProfiles', uid), {
      discoverable: nextDiscoverable,
      paused: nextPaused,
      updatedAt: nowIso,
    });
    saveLocalDatingProfile(updated);
    return updated;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `datingProfiles/${uid}`);
  }
}

export async function syncEvaluationsFromFirestore(uid: string): Promise<void> {
  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) return;

  try {
    const snap = await getDocs(
      query(collection(db, 'datingProfiles', uid, 'evaluations'), limit(300))
    );
    const localMap = loadLocalEvaluations(uid);
    snap.forEach((d) => {
      const rec = d.data() as DatingEvaluationRecord;
      if (rec?.targetUid && !localMap[rec.targetUid]) {
        localMap[rec.targetUid] = rec;
      }
    });
    saveLocalEvaluationsMap(uid, localMap);
  } catch {
    // offline ou sem avaliações ainda — mantém cache local
  }
}

export async function recordDatingEvaluation(
  uid: string,
  targetUid: string,
  decision: DatingEvaluationDecision
): Promise<DatingEvaluationRecord> {
  const record = recordLocalEvaluation(uid, targetUid, decision);
  if (decision === 'blocked') {
    addBlockedUidLocally(uid, targetUid);
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (db && auth?.currentUser && auth.currentUser.uid === uid) {
    try {
      await setDoc(doc(db, 'datingProfiles', uid, 'evaluations', targetUid), record);
    } catch (err) {
      console.warn('Talk2TM [Dating]: Avaliação salva localmente, sincronizará depois:', err);
    }
  }

  return record;
}

export async function discoverDatingProfiles(params: {
  viewerProfile: DatingProfile;
  filters: DatingDiscoveryFilters;
  cursorUpdatedAt?: string;
}): Promise<DatingDiscoveryResult> {
  const { viewerProfile, filters } = params;
  const quota = getDailyDiscoveryQuota(viewerProfile.uid);

  if (quota.remainingToday <= 0) {
    return {
      candidates: [],
      usedToday: quota.usedToday,
      remainingToday: 0,
      dailyLimit: quota.dailyLimit,
      exhaustedReason: 'daily_limit',
    };
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== viewerProfile.uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  await syncEvaluationsFromFirestore(viewerProfile.uid);
  const refreshedQuota = getDailyDiscoveryQuota(viewerProfile.uid);
  if (refreshedQuota.remainingToday <= 0) {
    return {
      candidates: [],
      usedToday: refreshedQuota.usedToday,
      remainingToday: 0,
      dailyLimit: refreshedQuota.dailyLimit,
      exhaustedReason: 'daily_limit',
    };
  }

  const blockedUids = new Set<string>([
    ...loadBlockedUids(viewerProfile.uid),
    ...loadLocalBlockedUids(viewerProfile.uid),
  ]);
  const collected: DatingProfile[] = [];
  let cursor = params.cursorUpdatedAt;
  const filterCityKey = normalizeCityKey(filters.city);

  for (let page = 0; page < DATING_MAX_PAGES_PER_DISCOVERY; page++) {
    const constraints: QueryConstraint[] = [
      where('discoverable', '==', true),
      where('paused', '==', false),
      where('suspended', '==', false),
      where('adultConfirmed', '==', true),
    ];

    if (filters.countryCode) {
      constraints.push(where('countryCode', '==', filters.countryCode));
      if (filterCityKey) {
        constraints.push(where('cityKey', '==', filterCityKey));
      }
    }

    constraints.push(orderBy('updatedAt', 'desc'));
    if (cursor) {
      constraints.push(startAfter(cursor));
    }
    constraints.push(limit(DATING_FETCH_PAGE_SIZE));

    let snap;
    try {
      snap = await getDocs(query(collection(db, 'datingProfiles'), ...constraints));
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, 'datingProfiles');
    }

    if (snap.empty) {
      cursor = undefined;
      break;
    }

    const pageDocs: DatingProfile[] = [];
    snap.forEach((docSnap) => {
      pageDocs.push(docSnap.data() as DatingProfile);
    });
    cursor = pageDocs[pageDocs.length - 1]?.updatedAt;

    const filtered = filterAndLimitDiscoveryCandidates({
      rawCandidates: pageDocs,
      viewer: {
        uid: viewerProfile.uid,
        gender: viewerProfile.gender,
        blockedUids,
        evaluatedUids: refreshedQuota.evaluatedUids,
      },
      filters,
      remainingToday: refreshedQuota.remainingToday - collected.length,
    });

    for (const item of filtered) {
      collected.push(item);
      if (collected.length >= refreshedQuota.remainingToday) break;
    }

    if (
      collected.length >= refreshedQuota.remainingToday ||
      snap.size < DATING_FETCH_PAGE_SIZE
    ) {
      break;
    }
  }

  return {
    candidates: collected,
    usedToday: refreshedQuota.usedToday,
    remainingToday: refreshedQuota.remainingToday,
    dailyLimit: refreshedQuota.dailyLimit,
    exhaustedReason: collected.length === 0 ? 'no_matches' : undefined,
    nextCursorUpdatedAt: cursor,
  };
}

// ====================================================================
// FASE 2: INTERESSE SECRETO (LIKE), MATCH RECÍPROCO & DESFAZER MATCH
// ====================================================================

export function buildDatingLikeId(fromUid: string, toUid: string): string {
  return `${fromUid.trim()}_${toUid.trim()}`;
}

export function buildDatingMatchId(uid1: string, uid2: string): string {
  const sorted = [uid1.trim(), uid2.trim()].sort();
  return `match_${sorted[0]}_${sorted[1]}`;
}

export function buildDatingMatchPayload(params: {
  viewerProfile: DatingProfile;
  candidate: DatingProfile;
  nowIso?: string;
}): { match: DatingMatch; conversation: Conversation } {
  const { viewerProfile, candidate } = params;
  const nowIso = params.nowIso || new Date().toISOString();
  const isViewerA = viewerProfile.uid < candidate.uid;
  const first = isViewerA ? viewerProfile : candidate;
  const second = isViewerA ? candidate : viewerProfile;

  const matchId = buildDatingMatchId(first.uid, second.uid);
  const conversationId = buildUidConversationId(first.uid, second.uid);

  const match: DatingMatch = {
    matchId,
    conversationId,
    participantA: first.uid,
    participantB: second.uid,
    talk2tmIdA: first.talk2tmId,
    talk2tmIdB: second.talk2tmId,
    displayNameA: first.displayName,
    displayNameB: second.displayName,
    matchedByUid: viewerProfile.uid,
    status: 'matched',
    seenByA: first.uid === viewerProfile.uid,
    seenByB: second.uid === viewerProfile.uid,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const conversation: Conversation = {
    conversationId,
    participantA: first.uid,
    participantB: second.uid,
    talk2tmIdA: first.talk2tmId,
    talk2tmIdB: second.talk2tmId,
    displayNameA: first.displayName,
    displayNameB: second.displayName,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastReadA: null,
    lastReadB: null,
  };

  return { match, conversation };
}

export function filterActiveDatingMatches(matches: DatingMatch[], myUid: string): DatingMatch[] {
  return matches
    .filter(
      (m) =>
        m.status === 'matched' &&
        (m.participantA === myUid || m.participantB === myUid)
    )
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

export function getUnseenDatingMatches(matches: DatingMatch[], myUid: string): DatingMatch[] {
  return filterActiveDatingMatches(matches, myUid).filter((m) =>
    m.participantA === myUid ? !m.seenByA : !m.seenByB
  );
}

export function getUnmatchedConversationIds(matches: DatingMatch[]): Set<string> {
  const ids = new Set<string>();
  for (const m of matches) {
    if (m.status === 'unmatched' && m.conversationId) {
      ids.add(m.conversationId);
    }
  }
  return ids;
}

export function getDatingMatchPartner(
  match: DatingMatch,
  myUid: string
): { uid: string; talk2tmId: string; displayName: string } {
  const isA = match.participantA === myUid;
  return {
    uid: isA ? match.participantB : match.participantA,
    talk2tmId: isA ? match.talk2tmIdB : match.talk2tmIdA,
    displayName: isA ? match.displayNameB : match.displayNameA,
  };
}

export function saveLocalDatingMatches(uid: string, matches: DatingMatch[]): void {
  if (!uid) return;
  writeStorageItem(`${DATING_MATCHES_CACHE_PREFIX}${uid}`, JSON.stringify(matches));
}

export function loadLocalDatingMatches(uid: string): DatingMatch[] {
  if (!uid) return [];
  const raw = readStorageItem(`${DATING_MATCHES_CACHE_PREFIX}${uid}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DatingMatch[]) : [];
  } catch {
    return [];
  }
}

function upsertLocalDatingMatchRecord(uid: string, match: DatingMatch): void {
  const existing = loadLocalDatingMatches(uid);
  const idx = existing.findIndex((m) => m.matchId === match.matchId);
  if (idx >= 0) {
    existing[idx] = match;
  } else {
    existing.unshift(match);
  }
  saveLocalDatingMatches(uid, existing);
}

export async function ensureConversationForDatingMatch(match: DatingMatch): Promise<Conversation> {
  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || !isAuthValidAndNonAnonymous()) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const convRef = doc(db, 'conversations', match.conversationId);
  const existing = await getDoc(convRef).catch(() => null);
  if (existing?.exists()) {
    return existing.data() as Conversation;
  }

  const nowIso = new Date().toISOString();
  const conv: Conversation = {
    conversationId: match.conversationId,
    participantA: match.participantA,
    participantB: match.participantB,
    talk2tmIdA: match.talk2tmIdA,
    talk2tmIdB: match.talk2tmIdB,
    displayNameA: match.displayNameA,
    displayNameB: match.displayNameB,
    createdAt: match.createdAt || nowIso,
    updatedAt: nowIso,
    lastReadA: null,
    lastReadB: null,
  };

  try {
    await setDoc(convRef, conv);
    return conv;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `conversations/${match.conversationId}`);
  }
}

export async function sendSecretDatingLike(params: {
  viewerProfile: DatingProfile;
  candidate: DatingProfile;
}): Promise<DatingLikeResult> {
  const { viewerProfile, candidate } = params;
  if (!viewerProfile?.uid || !candidate?.uid || viewerProfile.uid === candidate.uid) {
    throw new Error(t('dating.errProfileInvalid'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== viewerProfile.uid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  if (isLocallyBlockedPair(viewerProfile.uid, candidate.uid)) {
    throw new Error(t('safety.errBlockedInteraction'));
  }

  try {
    const [b1, b2] = await Promise.all([
      getDoc(doc(db, 'userBlocks', `${viewerProfile.uid}_${candidate.uid}`)),
      getDoc(doc(db, 'userBlocks', `${candidate.uid}_${viewerProfile.uid}`)),
    ]);
    if (b1.exists() || b2.exists()) {
      addBlockedUidLocally(viewerProfile.uid, candidate.uid);
      throw new Error(t('safety.errBlockedInteraction'));
    }
  } catch (err) {
    if (err instanceof Error && err.message === t('safety.errBlockedInteraction')) {
      throw err;
    }
  }

  const nowIso = new Date().toISOString();
  const likeId = buildDatingLikeId(viewerProfile.uid, candidate.uid);
  const like: DatingLike = {
    likeId,
    fromUid: viewerProfile.uid,
    toUid: candidate.uid,
    fromTalk2tmId: viewerProfile.talk2tmId,
    fromDisplayName: viewerProfile.displayName,
    createdAt: nowIso,
  };

  const likeRef = doc(db, 'datingLikes', likeId);
  try {
    const existingLike = await getDoc(likeRef).catch(() => null);
    if (!existingLike?.exists()) {
      const currentLimits = await fetchSyncedRateLimitState(viewerProfile.uid);
      const nextLimits = buildNextDailyRateLimitState(currentLimits, 'like');

      const likeBatch = writeBatch(db);
      likeBatch.set(doc(db, 'userRateLimits', viewerProfile.uid), nextLimits);
      likeBatch.set(likeRef, like);
      await likeBatch.commit();
      saveLocalRateLimitState(nextLimits);
    }
  } catch (err) {
    if (err instanceof Error && err.message === t('safety.errRateLimitLikes')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.CREATE, `datingLikes/${likeId}`);
  }

  // Regista avaliação local + Firestore para respeitar quota de 5/dia e exclusão
  await recordDatingEvaluation(viewerProfile.uid, candidate.uid, 'like');

  // 3. Verifica silenciosamente se existe Like recíproco (só funciona após Like próprio)
  const reciprocalId = buildDatingLikeId(candidate.uid, viewerProfile.uid);
  let hasReciprocalLike = false;
  try {
    const recSnap = await getDoc(doc(db, 'datingLikes', reciprocalId));
    hasReciprocalLike = recSnap.exists();
  } catch {
    // permission-denied quando o outro lado ainda não curtiu -> interesse permanece secreto
    hasReciprocalLike = false;
  }

  if (!hasReciprocalLike) {
    return { matched: false, like };
  }

  // 4. Reciprocidade confirmada -> cria Match e conversa bilateral automática
  const matchId = buildDatingMatchId(viewerProfile.uid, candidate.uid);
  const matchRef = doc(db, 'datingMatches', matchId);
  const existingMatchSnap = await getDoc(matchRef).catch(() => null);

  if (existingMatchSnap?.exists()) {
    const existingMatch = existingMatchSnap.data() as DatingMatch;
    if (existingMatch.status === 'unmatched') {
      return { matched: false, like };
    }
    const conversation = await ensureConversationForDatingMatch(existingMatch);
    upsertLocalDatingMatchRecord(viewerProfile.uid, existingMatch);
    return { matched: true, like, match: existingMatch, conversation };
  }

  const { match, conversation } = buildDatingMatchPayload({
    viewerProfile,
    candidate,
    nowIso,
  });
  const convRef = doc(db, 'conversations', conversation.conversationId);
  const existingConvSnap = await getDoc(convRef).catch(() => null);

  try {
    if (existingConvSnap?.exists()) {
      await setDoc(matchRef, match);
      upsertLocalDatingMatchRecord(viewerProfile.uid, match);
      return {
        matched: true,
        like,
        match,
        conversation: existingConvSnap.data() as Conversation,
      };
    }

    const batch = writeBatch(db);
    batch.set(matchRef, match);
    batch.set(convRef, conversation);
    await batch.commit();
    upsertLocalDatingMatchRecord(viewerProfile.uid, match);
    return { matched: true, like, match, conversation };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `datingMatches/${matchId}`);
  }
}

export async function markDatingMatchSeen(
  match: DatingMatch,
  myUid: string
): Promise<DatingMatch | null> {
  if (match.status !== 'matched') return match;
  const isA = match.participantA === myUid;
  const isB = match.participantB === myUid;
  if (!isA && !isB) return null;
  if ((isA && match.seenByA) || (isB && match.seenByB)) return match;

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== myUid) {
    return match;
  }

  const nowIso = new Date().toISOString();
  const updated: DatingMatch = {
    ...match,
    seenByA: isA ? true : match.seenByA,
    seenByB: isB ? true : match.seenByB,
    updatedAt: nowIso,
  };

  try {
    await updateDoc(doc(db, 'datingMatches', match.matchId), {
      ...(isA ? { seenByA: true } : { seenByB: true }),
      updatedAt: nowIso,
    });
    upsertLocalDatingMatchRecord(myUid, updated);
    return updated;
  } catch (err) {
    console.warn('Talk2TM [Dating]: Não foi possível marcar Match como visto:', err);
    return match;
  }
}

export async function unmatchDatingConnection(
  matchId: string,
  myUid: string
): Promise<DatingMatch> {
  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== myUid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const nowIso = new Date().toISOString();
  const matchRef = doc(db, 'datingMatches', matchId);
  try {
    const snap = await getDoc(matchRef);
    if (!snap.exists()) {
      throw new Error(t('dating.errProfileInvalid'));
    }
    const current = snap.data() as DatingMatch;
    if (current.status === 'unmatched') {
      upsertLocalDatingMatchRecord(myUid, current);
      return current;
    }
    await updateDoc(matchRef, {
      status: 'unmatched',
      unmatchedByUid: myUid,
      unmatchedAt: nowIso,
      updatedAt: nowIso,
    });
    const updated: DatingMatch = {
      ...current,
      status: 'unmatched',
      unmatchedByUid: myUid,
      unmatchedAt: nowIso,
      updatedAt: nowIso,
    };
    upsertLocalDatingMatchRecord(myUid, updated);
    return updated;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `datingMatches/${matchId}`);
  }
}

export function subscribeToDatingMatches(
  myUid: string,
  onUpdate: (matches: DatingMatch[]) => void
): Unsubscribe | null {
  const db = getFirebaseDB();
  if (!db || !isAuthValidAndNonAnonymous() || !myUid) return null;

  const mapA = new Map<string, DatingMatch>();
  const mapB = new Map<string, DatingMatch>();

  const emitMerged = () => {
    const merged = new Map<string, DatingMatch>();
    mapA.forEach((v, k) => merged.set(k, v));
    mapB.forEach((v, k) => merged.set(k, v));
    const list = Array.from(merged.values()).sort((a, b) =>
      (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
    );
    saveLocalDatingMatches(myUid, list);
    onUpdate(list);
  };

  const unsubA = onSnapshot(
    query(collection(db, 'datingMatches'), where('participantA', '==', myUid)),
    (snap) => {
      mapA.clear();
      snap.forEach((d) => {
        const m = d.data() as DatingMatch;
        mapA.set(m.matchId || d.id, m);
      });
      emitMerged();
    },
    (err) => console.warn('Erro ao ouvir datingMatches (A):', err)
  );

  const unsubB = onSnapshot(
    query(collection(db, 'datingMatches'), where('participantB', '==', myUid)),
    (snap) => {
      mapB.clear();
      snap.forEach((d) => {
        const m = d.data() as DatingMatch;
        mapB.set(m.matchId || d.id, m);
      });
      emitMerged();
    },
    (err) => console.warn('Erro ao ouvir datingMatches (B):', err)
  );

  return () => {
    unsubA();
    unsubB();
  };
}

export function subscribeToDatingMatchById(
  matchId: string,
  onUpdate: (match: DatingMatch | null) => void
): Unsubscribe | null {
  const db = getFirebaseDB();
  if (!db || !isAuthValidAndNonAnonymous() || !matchId) return null;
  return onSnapshot(
    doc(db, 'datingMatches', matchId),
    (snap) => {
      onUpdate(snap.exists() ? (snap.data() as DatingMatch) : null);
    },
    (err) => console.warn('Erro ao ouvir status do Match:', err)
  );
}

const MATCH_CHAT_STARTED_PREFIX = 'talk2tm_match_chat_started_';

export async function markDatingMatchChatStarted(params: {
  conversationId: string;
  myUid: string;
  participantA?: string | null;
  participantB?: string | null;
}): Promise<void> {
  const conversationId = (params.conversationId || '').trim();
  const myUid = (params.myUid || '').trim();
  if (!conversationId || !conversationId.startsWith('conv_') || !myUid) return;

  const cacheKey = `${MATCH_CHAT_STARTED_PREFIX}${conversationId}`;
  if (readStorageItem(cacheKey) === '1') return;

  const localMatch = loadLocalDatingMatches(myUid).find((m) => m.conversationId === conversationId);
  if (localMatch?.chatStarted === true) {
    writeStorageItem(cacheKey, '1');
    return;
  }

  let matchId = localMatch?.matchId || '';
  if (!matchId && params.participantA && params.participantB) {
    matchId = buildDatingMatchId(params.participantA, params.participantB);
  }
  if (!matchId) {
    const rest = conversationId.slice('conv_'.length);
    matchId = `match_${rest}`;
  }

  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== myUid || !isAuthValidAndNonAnonymous()) {
    return;
  }

  try {
    const matchRef = doc(db, 'datingMatches', matchId);
    const snap = await getDoc(matchRef);
    if (!snap.exists()) {
      // Conversa direta sem origem em Match Dating -> evita leituras futuras
      writeStorageItem(cacheKey, '1');
      return;
    }
    const matchData = snap.data() as DatingMatch;
    if (matchData.status !== 'matched') {
      return;
    }
    if (matchData.chatStarted === true) {
      writeStorageItem(cacheKey, '1');
      upsertLocalDatingMatchRecord(myUid, matchData);
      return;
    }

    const nowIso = new Date().toISOString();
    await updateDoc(matchRef, {
      chatStarted: true,
      chatStartedAt: nowIso,
      updatedAt: nowIso,
    });
    writeStorageItem(cacheKey, '1');
    upsertLocalDatingMatchRecord(myUid, {
      ...matchData,
      chatStarted: true,
      chatStartedAt: nowIso,
      updatedAt: nowIso,
    });
  } catch (err) {
    console.debug('Talk2TM [Dating]: Não foi possível marcar início de conversa no Match:', err);
  }
}

