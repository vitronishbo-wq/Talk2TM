/**
 * Talk2TM — Fase 3: Bloqueio de Utilizadores, Denúncias (Reports) e Anti-Spam (Rate Limiting)
 *
 * Arquitetura Zero Custos Variáveis (Firebase Starter Tier):
 * - Bloqueios persistidos em /userBlocks/{blockerUid}_{blockedUid} + cache local para resposta imediata.
 * - Denúncias gravam prova textual congelada em /moderationReports/{reportId} sem conceder leitura de chats privados ao Admin.
 * - Rate limiting combina travas em memória/localStorage no cliente + validação atômica em /userRateLimits/{uid}.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  setDoc,
  Unsubscribe,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  getFirebaseAuth,
  getFirebaseDB,
  handleFirestoreError,
  initFirebase,
  isAuthValidAndNonAnonymous,
  OperationType,
} from './firebase/firestore';
import { t } from './i18n';
import {
  DatingEvaluationRecord,
  DatingMatch,
  ModerationReport,
  ReportReason,
  ReportSourceType,
  UserBlock,
  UserRateLimitState,
} from './types';

export const RATE_LIMITS = {
  DAILY_LIKES_MAX: 5,
  DAILY_REPORTS_MAX: 10,
  DAILY_INVITES_MAX: 25,
  MESSAGE_BURST_MAX: 12,
  MESSAGE_BURST_WINDOW_MS: 15_000,
  MESSAGE_DUPLICATE_COOLDOWN_MS: 1_500,
  SIGNUP_MAX_PER_HOUR: 3,
  SIGNUP_WINDOW_MS: 3_600_000,
  MIN_REPORT_INTERVAL_MS: 4_000,
  MIN_INVITE_INTERVAL_MS: 3_000,
} as const;

export const VALID_REPORT_REASONS: readonly ReportReason[] = [
  'spam',
  'harassment',
  'fake_profile',
  'underage',
  'scam',
  'other',
] as const;

const BLOCKS_CACHE_PREFIX = 'talk2tm_blocks_v1_';
const DATING_BLOCKED_CACHE_PREFIX = 'talk2tm_dating_blocks_v1_';
const DATING_EVALS_CACHE_PREFIX = 'talk2tm_dating_evals_v1_';
const DATING_MATCHES_CACHE_PREFIX = 'talk2tm_dating_matches_v1_';
const RATELIMIT_CACHE_PREFIX = 'talk2tm_ratelimit_v1_';
const SIGNUP_GUARD_KEY = 'talk2tm_signup_guard_v1';

// Estruturas em memória para proteção imediata no cliente (inclusive durante execução de testes unitários)
const messageTimestampsByUid = new Map<string, number[]>();
const lastMessageByUid = new Map<string, { text: string; ts: number }>();
let signupAttemptsMemory: number[] = [];

export function clearSafetyMemoryForTests(): void {
  messageTimestampsByUid.clear();
  lastMessageByUid.clear();
  signupAttemptsMemory = [];
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SIGNUP_GUARD_KEY);
    }
  } catch {
    // ambiente sem localStorage
  }
}

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // quota ou SSR
  }
}

export function getLocalDayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function sanitizePlainTextSnippet(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// ====================================================================
// 1. BLOQUEIO DE UTILIZADORES
// ====================================================================

export function buildUserBlockId(blockerUid: string, blockedUid: string): string {
  return `${blockerUid.trim()}_${blockedUid.trim()}`;
}

export function loadLocalBlockedUids(uid: string): string[] {
  if (!uid) return [];
  const merged = new Set<string>();
  for (const prefix of [BLOCKS_CACHE_PREFIX, DATING_BLOCKED_CACHE_PREFIX]) {
    const raw = readStorage(`${prefix}${uid}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim() && item.trim() !== uid) {
            merged.add(item.trim());
          }
        }
      }
    } catch {
      // ignora JSON inválido
    }
  }
  return Array.from(merged);
}

export function saveLocalBlockedUids(uid: string, blockedUids: string[]): void {
  if (!uid) return;
  const clean = Array.from(
    new Set(blockedUids.map((u) => u.trim()).filter((u) => Boolean(u) && u !== uid))
  );
  const serialized = JSON.stringify(clean);
  writeStorage(`${BLOCKS_CACHE_PREFIX}${uid}`, serialized);
  writeStorage(`${DATING_BLOCKED_CACHE_PREFIX}${uid}`, serialized);
}

export function addBlockedUidLocally(uid: string, targetUid: string): string[] {
  if (!uid || !targetUid || uid === targetUid) return loadLocalBlockedUids(uid);
  const current = new Set(loadLocalBlockedUids(uid));
  current.add(targetUid.trim());
  const next = Array.from(current);
  saveLocalBlockedUids(uid, next);
  return next;
}

export function removeBlockedUidLocally(uid: string, targetUid: string): string[] {
  if (!uid || !targetUid) return loadLocalBlockedUids(uid);
  const next = loadLocalBlockedUids(uid).filter((u) => u !== targetUid.trim());
  saveLocalBlockedUids(uid, next);
  return next;
}

export function isLocallyBlockedPair(uidA: string, uidB: string): boolean {
  if (!uidA || !uidB || uidA === uidB) return false;
  return (
    loadLocalBlockedUids(uidA).includes(uidB) ||
    loadLocalBlockedUids(uidB).includes(uidA)
  );
}

function recordLocalBlockedEvaluation(uid: string, targetUid: string, nowIso: string): void {
  const key = `${DATING_EVALS_CACHE_PREFIX}${uid}`;
  let map: Record<string, DatingEvaluationRecord> = {};
  const raw = readStorage(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        map = parsed as Record<string, DatingEvaluationRecord>;
      }
    } catch {
      map = {};
    }
  }
  map[targetUid] = {
    targetUid,
    decision: 'blocked',
    createdAt: nowIso,
    dayKey: getLocalDayKey(new Date(nowIso)),
  };
  writeStorage(key, JSON.stringify(map));
}

function updateLocalMatchAsUnmatched(uid: string, targetUid: string, nowIso: string): void {
  const key = `${DATING_MATCHES_CACHE_PREFIX}${uid}`;
  const raw = readStorage(key);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const updated = (parsed as DatingMatch[]).map((m) => {
      const isPair =
        (m.participantA === uid && m.participantB === targetUid) ||
        (m.participantA === targetUid && m.participantB === uid);
      if (!isPair || m.status === 'unmatched') return m;
      return {
        ...m,
        status: 'unmatched' as const,
        unmatchedByUid: uid,
        unmatchedAt: nowIso,
        updatedAt: nowIso,
      };
    });
    writeStorage(key, JSON.stringify(updated));
  } catch {
    // ignora cache corrompido
  }
}

/**
 * Escuta bloqueios em que o utilizador é autor (blockerUid) ou destinatário (blockedUid),
 * mantendo o cache local sempre sincronizado para filtragem instantânea.
 */
export function subscribeToUserBlocks(
  uid: string,
  onUpdate: (blockedUids: Set<string>, ownBlocks: UserBlock[]) => void
): Unsubscribe | null {
  const db = getFirebaseDB();
  if (!db || !isAuthValidAndNonAnonymous() || !uid) return null;

  const ownMap = new Map<string, UserBlock>();
  const incomingMap = new Map<string, UserBlock>();

  const emit = () => {
    const peerUids = new Set<string>();
    ownMap.forEach((b) => {
      if (b.blockedUid && b.blockedUid !== uid) peerUids.add(b.blockedUid);
    });
    incomingMap.forEach((b) => {
      if (b.blockerUid && b.blockerUid !== uid) peerUids.add(b.blockerUid);
    });
    saveLocalBlockedUids(uid, Array.from(peerUids));
    onUpdate(peerUids, Array.from(ownMap.values()));
  };

  const unsubOwn = onSnapshot(
    query(collection(db, 'userBlocks'), where('blockerUid', '==', uid), limit(100)),
    (snap) => {
      ownMap.clear();
      snap.forEach((d) => {
        const data = d.data() as UserBlock;
        ownMap.set(data.blockId || d.id, data);
      });
      emit();
    },
    (err) => console.warn('Talk2TM [Safety]: Erro ao ouvir userBlocks (own):', err)
  );

  const unsubIncoming = onSnapshot(
    query(collection(db, 'userBlocks'), where('blockedUid', '==', uid), limit(100)),
    (snap) => {
      incomingMap.clear();
      snap.forEach((d) => {
        const data = d.data() as UserBlock;
        incomingMap.set(data.blockId || d.id, data);
      });
      emit();
    },
    (err) => console.warn('Talk2TM [Safety]: Erro ao ouvir userBlocks (incoming):', err)
  );

  return () => {
    unsubOwn();
    unsubIncoming();
  };
}

/**
 * Bloqueia outro utilizador:
 * 1. Persiste /userBlocks/{blockerUid}_{blockedUid}
 * 2. Atualiza cache local e avaliação 'blocked' no Dating (se tiver perfil)
 * 3. Desfaz Match ativo e remove Likes pendentes do par
 * 4. Cancela/recusa convite pendente se existir
 */
export async function blockUserConnection(params: {
  blockerUid: string;
  blockerTalk2tmId?: string;
  blockedUid: string;
  reason?: string;
}): Promise<UserBlock> {
  const { blockerUid, blockedUid } = params;
  if (!blockerUid || !blockedUid || blockerUid === blockedUid) {
    throw new Error(t('safety.errInvalidTarget'));
  }

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== blockerUid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const nowIso = new Date().toISOString();
  const blockId = buildUserBlockId(blockerUid, blockedUid);
  const cleanReason = sanitizePlainTextSnippet(params.reason || '', 120);
  const blockDoc: UserBlock = {
    blockId,
    blockerUid,
    blockedUid,
    ...(params.blockerTalk2tmId ? { blockerTalk2tmId: params.blockerTalk2tmId } : {}),
    ...(cleanReason ? { reason: cleanReason } : {}),
    createdAt: nowIso,
  };

  try {
    await setDoc(doc(db, 'userBlocks', blockId), blockDoc);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `userBlocks/${blockId}`);
  }

  addBlockedUidLocally(blockerUid, blockedUid);
  recordLocalBlockedEvaluation(blockerUid, blockedUid, nowIso);
  updateLocalMatchAsUnmatched(blockerUid, blockedUid, nowIso);

  // Efeitos colaterais seguros (melhor esforço após bloqueio gravado)
  const sorted = [blockerUid, blockedUid].sort();
  const matchId = `match_${sorted[0]}_${sorted[1]}`;
  const convId = `conv_${sorted[0]}_${sorted[1]}`;

  await Promise.allSettled([
    // Marca avaliação 'blocked' no perfil Dating se existir
    (async () => {
      const ownDating = await getDoc(doc(db, 'datingProfiles', blockerUid));
      if (ownDating.exists()) {
        const evalRec: DatingEvaluationRecord = {
          targetUid: blockedUid,
          decision: 'blocked',
          createdAt: nowIso,
          dayKey: getLocalDayKey(new Date(nowIso)),
        };
        await setDoc(doc(db, 'datingProfiles', blockerUid, 'evaluations', blockedUid), evalRec);
      }
    })(),
    // Anula likes pendentes nos dois sentidos
    deleteDoc(doc(db, 'datingLikes', `${blockerUid}_${blockedUid}`)),
    deleteDoc(doc(db, 'datingLikes', `${blockedUid}_${blockerUid}`)),
    // Desfaz match ativo caso exista
    (async () => {
      const matchSnap = await getDoc(doc(db, 'datingMatches', matchId));
      if (matchSnap.exists() && (matchSnap.data() as DatingMatch).status === 'matched') {
        await updateDoc(doc(db, 'datingMatches', matchId), {
          status: 'unmatched',
          unmatchedByUid: blockerUid,
          unmatchedAt: nowIso,
          updatedAt: nowIso,
        });
      }
    })(),
    // Cancela ou recusa convite pendente se existir
    (async () => {
      const invRef = doc(db, 'conversationInvites', convId);
      const invSnap = await getDoc(invRef);
      if (invSnap.exists()) {
        const inv = invSnap.data() as { status?: string; fromUid?: string; toUid?: string };
        if (inv.status === 'pending') {
          if (inv.fromUid === blockerUid) {
            await updateDoc(invRef, { status: 'cancelled', updatedAt: nowIso });
          } else if (inv.toUid === blockerUid) {
            await updateDoc(invRef, { status: 'declined', updatedAt: nowIso });
          }
        }
      }
    })(),
  ]);

  return blockDoc;
}

export async function unblockUserConnection(params: {
  blockerUid: string;
  blockedUid: string;
}): Promise<void> {
  const { blockerUid, blockedUid } = params;
  if (!blockerUid || !blockedUid) return;

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== blockerUid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const blockId = buildUserBlockId(blockerUid, blockedUid);
  try {
    await deleteDoc(doc(db, 'userBlocks', blockId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `userBlocks/${blockId}`);
  }
  removeBlockedUidLocally(blockerUid, blockedUid);
}

// ====================================================================
// 2. RATE LIMITING ANTI-SPAM (CLIENTE + FIRESTORE)
// ====================================================================

export function createEmptyRateLimitState(uid: string, now: Date = new Date()): UserRateLimitState {
  const dayKey = getLocalDayKey(now);
  return {
    uid,
    dayKey,
    likeDayKey: dayKey,
    likeCountToday: 0,
    reportDayKey: dayKey,
    reportCountToday: 0,
    inviteDayKey: dayKey,
    inviteCountToday: 0,
    updatedAt: now.toISOString(),
  };
}

export function loadLocalRateLimitState(uid: string): UserRateLimitState {
  if (!uid) return createEmptyRateLimitState('');
  const raw = readStorage(`${RATELIMIT_CACHE_PREFIX}${uid}`);
  if (!raw) return createEmptyRateLimitState(uid);
  try {
    const parsed = JSON.parse(raw) as Partial<UserRateLimitState>;
    const today = getLocalDayKey();
    return {
      uid,
      dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : today,
      likeDayKey: typeof parsed.likeDayKey === 'string' ? parsed.likeDayKey : today,
      likeCountToday: Number.isFinite(parsed.likeCountToday) ? Number(parsed.likeCountToday) : 0,
      reportDayKey: typeof parsed.reportDayKey === 'string' ? parsed.reportDayKey : today,
      reportCountToday: Number.isFinite(parsed.reportCountToday) ? Number(parsed.reportCountToday) : 0,
      inviteDayKey: typeof parsed.inviteDayKey === 'string' ? parsed.inviteDayKey : today,
      inviteCountToday: Number.isFinite(parsed.inviteCountToday) ? Number(parsed.inviteCountToday) : 0,
      ...(typeof parsed.lastReportAtMs === 'number' ? { lastReportAtMs: parsed.lastReportAtMs } : {}),
      ...(typeof parsed.lastInviteAtMs === 'number' ? { lastInviteAtMs: parsed.lastInviteAtMs } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return createEmptyRateLimitState(uid);
  }
}

export function saveLocalRateLimitState(state: UserRateLimitState): void {
  if (!state?.uid) return;
  writeStorage(`${RATELIMIT_CACHE_PREFIX}${state.uid}`, JSON.stringify(state));
}

export function buildNextDailyRateLimitState(
  current: UserRateLimitState,
  kind: 'like' | 'report' | 'invite',
  now: Date = new Date()
): UserRateLimitState {
  const today = getLocalDayKey(now);
  const nowMs = now.getTime();
  const base: UserRateLimitState = {
    uid: current.uid,
    dayKey: today,
    likeDayKey: current.likeDayKey === today ? current.likeDayKey : today,
    likeCountToday: current.likeDayKey === today ? Math.max(0, current.likeCountToday) : 0,
    reportDayKey: current.reportDayKey === today ? current.reportDayKey : today,
    reportCountToday: current.reportDayKey === today ? Math.max(0, current.reportCountToday) : 0,
    inviteDayKey: current.inviteDayKey === today ? current.inviteDayKey : today,
    inviteCountToday: current.inviteDayKey === today ? Math.max(0, current.inviteCountToday) : 0,
    ...(typeof current.lastReportAtMs === 'number' ? { lastReportAtMs: current.lastReportAtMs } : {}),
    ...(typeof current.lastInviteAtMs === 'number' ? { lastInviteAtMs: current.lastInviteAtMs } : {}),
    updatedAt: now.toISOString(),
  };

  if (kind === 'like') {
    if (base.likeCountToday >= RATE_LIMITS.DAILY_LIKES_MAX) {
      throw new Error(t('safety.errRateLimitLikes'));
    }
    return {
      ...base,
      likeDayKey: today,
      likeCountToday: base.likeCountToday + 1,
    };
  }

  if (kind === 'report') {
    if (
      typeof base.lastReportAtMs === 'number' &&
      nowMs - base.lastReportAtMs < RATE_LIMITS.MIN_REPORT_INTERVAL_MS
    ) {
      throw new Error(t('safety.errRateLimitReportCooldown'));
    }
    if (base.reportCountToday >= RATE_LIMITS.DAILY_REPORTS_MAX) {
      throw new Error(t('safety.errRateLimitReports'));
    }
    return {
      ...base,
      reportDayKey: today,
      reportCountToday: base.reportCountToday + 1,
      lastReportAtMs: nowMs,
    };
  }

  // kind === 'invite'
  if (
    typeof base.lastInviteAtMs === 'number' &&
    nowMs - base.lastInviteAtMs < RATE_LIMITS.MIN_INVITE_INTERVAL_MS
  ) {
    throw new Error(t('safety.errRateLimitInviteCooldown'));
  }
  if (base.inviteCountToday >= RATE_LIMITS.DAILY_INVITES_MAX) {
    throw new Error(t('safety.errRateLimitInvites'));
  }
  return {
    ...base,
    inviteDayKey: today,
    inviteCountToday: base.inviteCountToday + 1,
    lastInviteAtMs: nowMs,
  };
}

export async function fetchSyncedRateLimitState(uid: string): Promise<UserRateLimitState> {
  const local = loadLocalRateLimitState(uid);
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) {
    return local;
  }
  try {
    const snap = await getDoc(doc(db, 'userRateLimits', uid));
    if (!snap.exists()) return local;
    const remote = snap.data() as UserRateLimitState;
    const today = getLocalDayKey();
    const merged: UserRateLimitState = {
      uid,
      dayKey: today,
      likeDayKey: today,
      likeCountToday: Math.max(
        local.likeDayKey === today ? local.likeCountToday : 0,
        remote.likeDayKey === today ? remote.likeCountToday : 0
      ),
      reportDayKey: today,
      reportCountToday: Math.max(
        local.reportDayKey === today ? local.reportCountToday : 0,
        remote.reportDayKey === today ? remote.reportCountToday : 0
      ),
      inviteDayKey: today,
      inviteCountToday: Math.max(
        local.inviteDayKey === today ? local.inviteCountToday : 0,
        remote.inviteDayKey === today ? remote.inviteCountToday : 0
      ),
      ...(typeof remote.lastReportAtMs === 'number' || typeof local.lastReportAtMs === 'number'
        ? { lastReportAtMs: Math.max(remote.lastReportAtMs || 0, local.lastReportAtMs || 0) }
        : {}),
      ...(typeof remote.lastInviteAtMs === 'number' || typeof local.lastInviteAtMs === 'number'
        ? { lastInviteAtMs: Math.max(remote.lastInviteAtMs || 0, local.lastInviteAtMs || 0) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    saveLocalRateLimitState(merged);
    return merged;
  } catch {
    return local;
  }
}

export async function recordInviteRateLimitAttempt(uid: string): Promise<void> {
  const current = await fetchSyncedRateLimitState(uid);
  const next = buildNextDailyRateLimitState(current, 'invite');
  saveLocalRateLimitState(next);

  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (db && auth?.currentUser && auth.currentUser.uid === uid) {
    try {
      await setDoc(doc(db, 'userRateLimits', uid), next, { merge: true });
    } catch {
      // Não bloqueia envio caso offline; validação primária protege abuso continuado
    }
  }
}

/**
 * Proteção anti-rajada no envio interativo de mensagens (nunca aplicada no drain do outbox offline).
 */
export function checkAndRecordMessageBurst(
  uid: string,
  text: string,
  nowMs: number = Date.now()
): void {
  const cleanUid = (uid || '').trim() || 'anon';
  const normalizedText = text.trim();

  const last = lastMessageByUid.get(cleanUid);
  if (
    last &&
    last.text === normalizedText &&
    nowMs - last.ts < RATE_LIMITS.MESSAGE_DUPLICATE_COOLDOWN_MS
  ) {
    throw new Error(t('safety.errRateLimitDuplicate'));
  }

  const recent = (messageTimestampsByUid.get(cleanUid) || []).filter(
    (ts) => nowMs - ts < RATE_LIMITS.MESSAGE_BURST_WINDOW_MS
  );
  if (recent.length >= RATE_LIMITS.MESSAGE_BURST_MAX) {
    throw new Error(t('safety.errRateLimitMessages'));
  }

  recent.push(nowMs);
  messageTimestampsByUid.set(cleanUid, recent);
  lastMessageByUid.set(cleanUid, { text: normalizedText, ts: nowMs });
}

function getSignupAttempts(nowMs: number): number[] {
  const merged = new Set<number>(signupAttemptsMemory);
  const raw = readStorage(SIGNUP_GUARD_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'number' && Number.isFinite(item)) {
            merged.add(item);
          }
        }
      }
    } catch {
      // ignora JSON inválido
    }
  }
  return Array.from(merged)
    .filter((ts) => nowMs - ts < RATE_LIMITS.SIGNUP_WINDOW_MS)
    .sort((a, b) => a - b);
}

export function checkAccountCreationThrottle(nowMs: number = Date.now()): void {
  const recent = getSignupAttempts(nowMs);
  if (recent.length >= RATE_LIMITS.SIGNUP_MAX_PER_HOUR) {
    throw new Error(t('safety.errRateLimitSignup'));
  }
}

export function recordAccountCreationAttempt(nowMs: number = Date.now()): void {
  const recent = getSignupAttempts(nowMs);
  recent.push(nowMs);
  signupAttemptsMemory = recent;
  writeStorage(SIGNUP_GUARD_KEY, JSON.stringify(recent));
}

// ====================================================================
// 3. SISTEMA DE DENÚNCIAS (MODERATION REPORTS)
// ====================================================================

export function generateReportId(reporterUid: string, nowMs: number = Date.now()): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const uidFrag = reporterUid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'usr';
  return `rep_${uidFrag}_${nowMs}_${suffix}`;
}

export interface SubmitModerationReportParams {
  reporterUid: string;
  reporterTalk2tmId: string;
  targetUid: string;
  targetTalk2tmId?: string;
  targetDisplayName?: string;
  sourceType: ReportSourceType;
  channelId?: string;
  itemRefId?: string;
  reason: ReportReason;
  details?: string;
  evidenceSnapshot: string;
}

export async function submitModerationReport(
  params: SubmitModerationReportParams
): Promise<ModerationReport> {
  if (!params.reporterUid || !params.targetUid || params.reporterUid === params.targetUid) {
    throw new Error(t('safety.errInvalidTarget'));
  }
  if (!VALID_REPORT_REASONS.includes(params.reason)) {
    throw new Error(t('safety.errReportReasonRequired'));
  }

  const evidenceSnapshot = sanitizePlainTextSnippet(params.evidenceSnapshot, 500);
  if (!evidenceSnapshot) {
    throw new Error(t('safety.errReportEvidenceRequired'));
  }

  const cleanDetails = sanitizePlainTextSnippet(params.details || '', 300);
  const cleanTargetName = sanitizePlainTextSnippet(params.targetDisplayName || '', 30);

  await initFirebase();
  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== params.reporterUid) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const currentLimits = await fetchSyncedRateLimitState(params.reporterUid);
  const nextLimits = buildNextDailyRateLimitState(currentLimits, 'report');

  const nowIso = nextLimits.updatedAt;
  const reportId = generateReportId(params.reporterUid);
  const report: ModerationReport = {
    reportId,
    reporterUid: params.reporterUid,
    reporterTalk2tmId: params.reporterTalk2tmId,
    targetUid: params.targetUid,
    ...(params.targetTalk2tmId ? { targetTalk2tmId: params.targetTalk2tmId } : {}),
    ...(cleanTargetName ? { targetDisplayName: cleanTargetName } : {}),
    sourceType: params.sourceType,
    ...(params.channelId ? { channelId: sanitizePlainTextSnippet(params.channelId, 140) } : {}),
    ...(params.itemRefId ? { itemRefId: sanitizePlainTextSnippet(params.itemRefId, 140) } : {}),
    reason: params.reason,
    ...(cleanDetails ? { details: cleanDetails } : {}),
    evidenceSnapshot,
    status: 'pending',
    createdAt: nowIso,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userRateLimits', params.reporterUid), nextLimits);
    batch.set(doc(db, 'moderationReports', reportId), report);
    await batch.commit();
    saveLocalRateLimitState(nextLimits);
    return report;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `moderationReports/${reportId}`);
  }
}
