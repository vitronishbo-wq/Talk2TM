/**
 * Talk2TM — Módulo Firebase Administrativo Isolado (Carregamento sob Demanda)
 *
 * Isolamento estrito de sessão:
 * - Usa uma instância secundária nomeada ('talk2tm-admin') com inMemoryPersistence.
 * - Nunca toca no Firebase Auth padrão, IndexedDB local ou MonitorContext de utilizadores comuns
 *   (nem de Truman / Mãezinha).
 * - Consulta apenas metadados de contas (paginado, 20 por página) e nunca lê conversas, mensagens ou convites.
 */

import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  User,
  browserPopupRedirectResolver,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  Firestore,
  QueryDocumentSnapshot,
  DocumentData,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  writeBatch,
} from 'firebase/firestore';
import { getFirebaseAppOptions } from './firestore';
import {
  AdminGrowthMetricsSnapshot,
  AdminPhotoFilter,
  AdminPhotoQueueItem,
  AdminReportFilter,
  AdminStatusFilter,
  AdminUserRow,
  DatingMatch,
  DatingProfile,
  GrowthTelemetryRecord,
  ModerationReport,
  PhoneDirectoryEntry,
  ReferralAttribution,
  ReferralLink,
  ReferralStats,
  ReportStatus,
  UserAccount,
  UserProfile,
} from '../types';
import { hashPhoneNumber, normalizePhoneNumber } from '../utils/phone';
import { deleteDatingPhotoFromStorage } from '../media/photo';
import { computeGrowthMetricsSummary } from '../growth';

const ADMIN_APP_NAME = 'talk2tm-admin';
const DEFAULT_PLAN_NAME = 'Base Orgânico';
const PROTECTED_LEGACY_UIDS = new Set(['uid_truman_852456', 'uid_maezinha_135790']);

export const ADMIN_PAGE_SIZE = 20;

export interface AdminUsersPageResult {
  rows: AdminUserRow[];
  lastCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

export interface AdminModerationReportsPageResult {
  rows: ModerationReport[];
  lastCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

export interface AdminDatingPhotosPageResult {
  rows: AdminPhotoQueueItem[];
  lastCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

let adminApp: FirebaseApp | null = null;
let adminAuth: Auth | null = null;
let adminDb: Firestore | null = null;

async function ensureIsolatedAdminClient(): Promise<{ auth: Auth; db: Firestore }> {
  if (adminApp && adminAuth && adminDb) {
    return { auth: adminAuth, db: adminDb };
  }

  const existing = getApps().find((a) => a.name === ADMIN_APP_NAME);
  if (existing) {
    adminApp = existing;
  } else {
    const options = await getFirebaseAppOptions();
    if (!options || !options.projectId) {
      throw new Error('Configuração Firebase indisponível para autenticação administrativa.');
    }
    adminApp = initializeApp(options, ADMIN_APP_NAME);
  }

  try {
    adminAuth = initializeAuth(adminApp, {
      persistence: inMemoryPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    // Se já inicializado nesta instância nomeada, obtém via getAuth dinâmico não necessário porque guardamos adminAuth;
    // fallback seguro caso módulo recarregue em dev:
    const { getAuth } = await import('firebase/auth');
    adminAuth = getAuth(adminApp);
  }

  adminDb = getFirestore(adminApp);
  return { auth: adminAuth, db: adminDb };
}

export function getAdminCurrentUser(): User | null {
  return adminAuth?.currentUser || null;
}

export async function signOutAdmin(): Promise<void> {
  if (adminAuth?.currentUser) {
    await signOut(adminAuth).catch(() => {});
  }
}

/**
 * Autentica a conta administrativa exclusivamente no cliente isolado em RAM
 * e valida a autorização real nas Firestore Security Rules (UID explícito).
 */
export async function signInAdminWithCredentials(
  rawEmail: string,
  rawPassword: string
): Promise<AdminUsersPageResult> {
  const email = (rawEmail || '').trim();
  const password = rawPassword || '';
  if (!email || !password) {
    throw new Error('Informe o e-mail e a senha da conta administrativa.');
  }

  const { auth } = await ensureIsolatedAdminClient();
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err: any) {
    const code = err?.code || '';
    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/wrong-password' ||
      code === 'auth/user-not-found' ||
      code === 'auth/invalid-email'
    ) {
      throw new Error('Credenciais administrativas inválidas.');
    }
    if (code === 'auth/too-many-requests') {
      throw new Error('Muitas tentativas seguidas. Aguarde alguns minutos.');
    }
    throw new Error('Não foi possível autenticar a conta administrativa.');
  }

  // Validação real nas Firestore Security Rules (list userProfiles exige isAdmin())
  try {
    return await fetchAdminUsersPage({ filter: 'all', pageSize: ADMIN_PAGE_SIZE });
  } catch (err: any) {
    await signOutAdmin();
    if (err?.code === 'permission-denied' || String(err?.message || '').includes('permission')) {
      throw new Error('Acesso negado: esta conta não está autorizada ou o e-mail não está verificado nas regras.');
    }
    throw err;
  }
}

/**
 * Autentica a conta administrativa via Google Sign-In (pop-up) na instância isolada em RAM
 * e valida a autorização real nas Firestore Security Rules (e-mail master verificado).
 */
export async function signInAdminWithGoogle(): Promise<AdminUsersPageResult> {
  const { auth } = await ensureIsolatedAdminClient();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (err: any) {
    const code = typeof err?.code === 'string' ? err.code : '';
    let message = 'Não foi possível autenticar via Google.';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      message = 'Autenticação Google cancelada.';
    } else if (code === 'auth/popup-blocked') {
      message = 'O navegador bloqueou a janela do Google. Permita pop-ups para continuar.';
    } else if (code === 'auth/unauthorized-domain') {
      message = 'Domínio não autorizado no Firebase Auth para login Google.';
    } else if (code === 'auth/operation-not-allowed') {
      message = 'Provedor Google desativado no Firebase Authentication.';
    }
    const authErr = new Error(message) as Error & { code?: string };
    if (code) {
      authErr.code = code;
    }
    throw authErr;
  }

  try {
    return await fetchAdminUsersPage({ filter: 'all', pageSize: ADMIN_PAGE_SIZE });
  } catch (err: any) {
    await signOutAdmin();
    const code = typeof err?.code === 'string' ? err.code : '';
    if (code === 'permission-denied' || String(err?.message || '').includes('permission')) {
      const permErr = new Error(
        'Acesso negado: esta conta Google não está autorizada ou o e-mail não está verificado nas regras.'
      ) as Error & { code?: string };
      permErr.code = code || 'permission-denied';
      throw permErr;
    }
    throw err;
  }
}

async function hydrateProfileRow(db: Firestore, profile: UserProfile): Promise<AdminUserRow> {
  let phoneMasked = '—';
  let phoneHash: string | undefined;

  try {
    const userSnap = await getDoc(doc(db, 'users', profile.uid));
    if (userSnap.exists()) {
      const account = userSnap.data() as UserAccount;
      if (account.phoneMasked) {
        phoneMasked = account.phoneMasked;
      }
      if (account.phoneHash) {
        phoneHash = account.phoneHash;
      }
    }
  } catch {
    // Mantém fallback mascarado caso users/{uid} não tenha telefone associado
  }

  return {
    uid: profile.uid,
    talk2tmId: profile.talk2tmId,
    displayName: profile.displayName || 'Utilizador',
    phoneMasked,
    phoneHash,
    createdAt: profile.createdAt || '',
    plan: profile.plan || DEFAULT_PLAN_NAME,
    active: profile.active !== false,
  };
}

/**
 * Consulta paginada (máximo 20 perfis por página).
 * Não consulta conversationInvites, conversations, messages nem rooms.
 */
export async function fetchAdminUsersPage(params: {
  filter: AdminStatusFilter;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  pageSize?: number;
}): Promise<AdminUsersPageResult> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const pageSize = Math.min(Math.max(params.pageSize || ADMIN_PAGE_SIZE, 1), ADMIN_PAGE_SIZE);
  const baseCol = collection(db, 'userProfiles');

  const constraints = [];
  if (params.filter === 'active') {
    constraints.push(where('active', '==', true));
  } else if (params.filter === 'inactive') {
    constraints.push(where('active', '==', false));
  }
  constraints.push(orderBy('createdAt', 'desc'));
  if (params.cursor) {
    constraints.push(startAfter(params.cursor));
  }
  constraints.push(limit(pageSize));

  const snap = await getDocs(query(baseCol, ...constraints));
  const rawDocs = snap.docs;
  const profiles = rawDocs
    .map((d) => d.data() as UserProfile)
    .filter((p) => p && p.uid && p.talk2tmId && !PROTECTED_LEGACY_UIDS.has(p.uid));

  const rows = await Promise.all(profiles.map((p) => hydrateProfileRow(db, p)));
  const lastCursor = rawDocs.length > 0 ? rawDocs[rawDocs.length - 1] : null;

  return {
    rows,
    lastCursor,
    hasMore: rawDocs.length === pageSize,
  };
}

/**
 * Busca pontual O(1) por número de telefone via hash SHA-256 (3 leituras no total).
 */
export async function lookupAdminUserByPhone(rawPhone: string): Promise<AdminUserRow | null> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const check = normalizePhoneNumber(rawPhone);
  if (!check.valid || !check.e164) {
    throw new Error(check.error || 'Número de telefone inválido para busca.');
  }

  const phoneHash = await hashPhoneNumber(check.e164);
  const lookupSnap = await getDoc(doc(db, 'phoneLookup', phoneHash));
  if (!lookupSnap.exists()) {
    return null;
  }

  const entry = lookupSnap.data() as PhoneDirectoryEntry;
  if (PROTECTED_LEGACY_UIDS.has(entry.uid)) {
    return null;
  }

  const profileSnap = await getDoc(doc(db, 'userProfiles', entry.talk2tmId));
  if (!profileSnap.exists()) {
    return null;
  }

  return await hydrateProfileRow(db, profileSnap.data() as UserProfile);
}

/**
 * Altera o estado operacional (active) de forma atómica em userProfiles e phoneLookup (2 escritas).
 */
export async function setAdminUserActiveState(params: {
  uid: string;
  talk2tmId: string;
  phoneHash?: string;
  active: boolean;
}): Promise<void> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }
  if (PROTECTED_LEGACY_UIDS.has(params.uid)) {
    throw new Error('Contas protegidas do sistema não podem ser desactivadas.');
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', params.talk2tmId), { active: params.active });
  if (params.phoneHash) {
    batch.update(doc(db, 'phoneLookup', params.phoneHash), { active: params.active });
  }
  await batch.commit();
}

/**
 * Consulta paginada de denúncias (/moderationReports) ordenada por createdAt desc.
 */
export async function fetchAdminModerationReportsPage(params: {
  filter: AdminReportFilter;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  pageSize?: number;
}): Promise<AdminModerationReportsPageResult> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const pageSize = Math.min(Math.max(params.pageSize || ADMIN_PAGE_SIZE, 1), ADMIN_PAGE_SIZE);
  const colRef = collection(db, 'moderationReports');

  const constraints = [];
  if (params.filter !== 'all') {
    constraints.push(where('status', '==', params.filter));
  }
  constraints.push(orderBy('createdAt', 'desc'));
  if (params.cursor) {
    constraints.push(startAfter(params.cursor));
  }
  constraints.push(limit(pageSize));

  const snap = await getDocs(query(colRef, ...constraints));
  const rawDocs = snap.docs;
  const rows = rawDocs.map((d) => d.data() as ModerationReport);
  const lastCursor = rawDocs.length > 0 ? rawDocs[rawDocs.length - 1] : null;

  return {
    rows,
    lastCursor,
    hasMore: rawDocs.length === pageSize,
  };
}

/**
 * Atualiza o estado de uma denúncia (resolvida / dispensada / pendente) com registo de revisão.
 */
export async function reviewAdminModerationReport(params: {
  reportId: string;
  status: ReportStatus;
  resolutionAction: 'none' | 'account_suspended' | 'dismissed';
  resolutionNote?: string;
}): Promise<void> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const nowIso = new Date().toISOString();
  const batch = writeBatch(db);
  batch.update(doc(db, 'moderationReports', params.reportId), {
    status: params.status,
    reviewedAt: nowIso,
    reviewedByUid: auth.currentUser.uid,
    resolutionAction: params.resolutionAction,
    ...(params.resolutionNote ? { resolutionNote: params.resolutionNote.slice(0, 200) } : {}),
  });
  await batch.commit();
}

/**
 * Suspende a conta reportada (userProfiles + phoneLookup + datingProfiles se existir)
 * e resolve a denúncia associada numa única escrita atómica.
 */
export async function suspendReportedAccountAndResolve(params: {
  targetUid: string;
  reportId?: string;
  resolutionNote?: string;
}): Promise<void> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }
  if (PROTECTED_LEGACY_UIDS.has(params.targetUid)) {
    throw new Error('Contas protegidas do sistema não podem ser suspensas.');
  }

  const userSnap = await getDoc(doc(db, 'users', params.targetUid));
  const account = userSnap.exists() ? (userSnap.data() as UserAccount) : null;
  const datingSnap = await getDoc(doc(db, 'datingProfiles', params.targetUid)).catch(() => null);

  const nowIso = new Date().toISOString();
  const batch = writeBatch(db);

  if (account?.talk2tmId) {
    batch.update(doc(db, 'userProfiles', account.talk2tmId), { active: false });
  }
  if (account?.phoneHash) {
    batch.update(doc(db, 'phoneLookup', account.phoneHash), { active: false });
  }
  if (datingSnap?.exists()) {
    batch.update(doc(db, 'datingProfiles', params.targetUid), {
      suspended: true,
      updatedAt: nowIso,
    });
  }
  if (params.reportId) {
    batch.update(doc(db, 'moderationReports', params.reportId), {
      status: 'resolved',
      reviewedAt: nowIso,
      reviewedByUid: auth.currentUser.uid,
      resolutionAction: 'account_suspended',
      resolutionNote: (params.resolutionNote || 'Conta suspensa por moderação.').slice(0, 200),
    });
  }

  await batch.commit();
}

function mapDatingProfileToPhotoQueueItem(
  profile: DatingProfile,
  reportMeta?: { reason: string; evidence: string }
): AdminPhotoQueueItem {
  return {
    uid: profile.uid,
    talk2tmId: profile.talk2tmId,
    displayName: profile.displayName || 'Perfil',
    age: profile.age || 18,
    city: profile.city || '',
    countryCode: profile.countryCode || '',
    photoUrl: profile.photoUrl || null,
    photoPath: profile.photoPath || null,
    photoStatus: profile.photoStatus || 'none',
    photoUpdatedAt: profile.photoUpdatedAt || profile.updatedAt || '',
    photoModerationNote: profile.photoModerationNote || null,
    suspended: profile.suspended === true,
    reportReason: reportMeta?.reason,
    reportEvidence: reportMeta?.evidence,
  };
}

/**
 * Consulta paginada da fila de aprovação de fotografias do Dating
 * (pendentes, denunciadas via moderationReports, rejeitadas ou aprovadas).
 */
export async function fetchAdminDatingPhotosPage(params: {
  filter: AdminPhotoFilter;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  pageSize?: number;
}): Promise<AdminDatingPhotosPageResult> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const pageSize = Math.min(Math.max(params.pageSize || ADMIN_PAGE_SIZE, 1), ADMIN_PAGE_SIZE);

  if (params.filter === 'reported') {
    const constraints = [
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc'),
      ...(params.cursor ? [startAfter(params.cursor)] : []),
      limit(pageSize),
    ];
    const repSnap = await getDocs(query(collection(db, 'moderationReports'), ...constraints));
    const rawDocs = repSnap.docs;
    const byTarget = new Map<string, { reason: string; evidence: string }>();

    for (const d of rawDocs) {
      const rep = d.data() as ModerationReport;
      if (
        (rep.sourceType === 'dating_profile' || rep.sourceType === 'dating_match') &&
        rep.targetUid &&
        !PROTECTED_LEGACY_UIDS.has(rep.targetUid) &&
        !byTarget.has(rep.targetUid)
      ) {
        byTarget.set(rep.targetUid, {
          reason: rep.reason,
          evidence: rep.evidenceSnapshot,
        });
      }
    }

    const hydrated = await Promise.all(
      Array.from(byTarget.entries()).map(async ([targetUid, meta]) => {
        const snap = await getDoc(doc(db, 'datingProfiles', targetUid)).catch(() => null);
        if (!snap || !snap.exists()) return null;
        const prof = snap.data() as DatingProfile;
        if (!prof.photoUrl) return null;
        return mapDatingProfileToPhotoQueueItem(prof, meta);
      })
    );

    const rows = hydrated.filter((item): item is AdminPhotoQueueItem => item !== null);
    const lastCursor = rawDocs.length > 0 ? rawDocs[rawDocs.length - 1] : null;
    return {
      rows,
      lastCursor,
      hasMore: rawDocs.length === pageSize,
    };
  }

  const constraints = [
    where('photoStatus', '==', params.filter),
    orderBy('photoUpdatedAt', 'desc'),
    ...(params.cursor ? [startAfter(params.cursor)] : []),
    limit(pageSize),
  ];

  const snap = await getDocs(query(collection(db, 'datingProfiles'), ...constraints));
  const rawDocs = snap.docs;
  const rows = rawDocs
    .map((d) => d.data() as DatingProfile)
    .filter((p) => p && p.uid && !PROTECTED_LEGACY_UIDS.has(p.uid))
    .map((p) => mapDatingProfileToPhotoQueueItem(p));

  const lastCursor = rawDocs.length > 0 ? rawDocs[rawDocs.length - 1] : null;
  return {
    rows,
    lastCursor,
    hasMore: rawDocs.length === pageSize,
  };
}

/**
 * Aprova ou rejeita uma fotografia opcional do Dating no cliente Admin isolado.
 * Em caso de rejeição, limpa photoUrl/photoPath e apaga o ficheiro WebP do Storage.
 */
export async function moderateAdminDatingPhoto(params: {
  targetUid: string;
  decision: 'approved' | 'rejected';
  note?: string;
}): Promise<void> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }
  if (!params.targetUid || PROTECTED_LEGACY_UIDS.has(params.targetUid)) {
    throw new Error('Perfil inválido para moderação de fotografia.');
  }

  const nowIso = new Date().toISOString();
  const batch = writeBatch(db);
  const profileRef = doc(db, 'datingProfiles', params.targetUid);

  if (params.decision === 'approved') {
    batch.update(profileRef, {
      photoStatus: 'approved',
      photoModerationNote: null,
      photoUpdatedAt: nowIso,
      updatedAt: nowIso,
    });
    await batch.commit();
    return;
  }

  batch.update(profileRef, {
    photoStatus: 'rejected',
    photoUrl: null,
    photoPath: null,
    photoModerationNote: (params.note || 'Fotografia removida pela moderação.').slice(0, 160),
    photoUpdatedAt: nowIso,
    updatedAt: nowIso,
  });
  await batch.commit();
  await deleteDatingPhotoFromStorage(params.targetUid, adminApp);
}

/**
 * Carrega indicadores agregados de crescimento (Aquisição, Engajamento, WAU e Cidades)
 * a partir de coleções de telemetria e metadados sem ler chats ou identidades privadas.
 */
export async function fetchAdminGrowthMetrics(): Promise<AdminGrowthMetricsSnapshot> {
  const { auth, db } = await ensureIsolatedAdminClient();
  if (!auth.currentUser) {
    throw new Error('Sessão administrativa não autenticada.');
  }

  const MAX_METRIC_DOCS = 500;
  const [
    userProfilesSnap,
    referralLinksSnap,
    referralStatsSnap,
    referralAttrsSnap,
    datingProfilesSnap,
    datingMatchesSnap,
    growthTelemetrySnap,
  ] = await Promise.all([
    getDocs(query(collection(db, 'userProfiles'), limit(MAX_METRIC_DOCS))),
    getDocs(query(collection(db, 'referralLinks'), limit(MAX_METRIC_DOCS))).catch(() => null),
    getDocs(query(collection(db, 'referralStats'), limit(MAX_METRIC_DOCS))).catch(() => null),
    getDocs(query(collection(db, 'referralAttributions'), limit(MAX_METRIC_DOCS))).catch(() => null),
    getDocs(query(collection(db, 'datingProfiles'), limit(MAX_METRIC_DOCS))).catch(() => null),
    getDocs(query(collection(db, 'datingMatches'), limit(MAX_METRIC_DOCS))).catch(() => null),
    getDocs(query(collection(db, 'growthTelemetry'), limit(MAX_METRIC_DOCS))).catch(() => null),
  ]);

  return computeGrowthMetricsSummary({
    userProfiles: userProfilesSnap.docs.map((d) => d.data() as UserProfile),
    referralLinks: referralLinksSnap ? referralLinksSnap.docs.map((d) => d.data() as ReferralLink) : [],
    referralStats: referralStatsSnap ? referralStatsSnap.docs.map((d) => d.data() as ReferralStats) : [],
    referralAttributions: referralAttrsSnap ? referralAttrsSnap.docs.map((d) => d.data() as ReferralAttribution) : [],
    datingProfiles: datingProfilesSnap ? datingProfilesSnap.docs.map((d) => d.data() as DatingProfile) : [],
    datingMatches: datingMatchesSnap ? datingMatchesSnap.docs.map((d) => d.data() as DatingMatch) : [],
    growthTelemetry: growthTelemetrySnap ? growthTelemetrySnap.docs.map((d) => d.data() as GrowthTelemetryRecord) : [],
  });
}

