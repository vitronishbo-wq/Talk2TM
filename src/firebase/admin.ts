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
import { AdminStatusFilter, AdminUserRow, PhoneDirectoryEntry, UserAccount, UserProfile } from '../types';
import { hashPhoneNumber, normalizePhoneNumber } from '../utils/phone';

const ADMIN_APP_NAME = 'talk2tm-admin';
const DEFAULT_PLAN_NAME = 'Base Orgânico';
const PROTECTED_LEGACY_UIDS = new Set(['uid_truman_852456', 'uid_maezinha_135790']);

export const ADMIN_PAGE_SIZE = 20;

export interface AdminUsersPageResult {
  rows: AdminUserRow[];
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
