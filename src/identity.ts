/**
 * Talk2TM — Gerenciador de Identidade Ultraleve
 * 
 * Responsabilidades:
 * 1. Geração de Talk2TM ID no formato estrito TM-XXXX-XXXX (usando crypto.getRandomValues nativo).
 * 2. Geração determinística de credenciais internas no Firebase Auth (sem exigir email do usuário).
 * 3. Criação e persistência do perfil e conta (users/{uid} e userProfiles/{talk2tmId}).
 * 4. Zero bibliotecas externas.
 */

import { UserProfile, UserAccount } from './types';
import { getFirebaseDB, getFirebaseAuth } from './firebase/firestore';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

const LOCAL_IDENTITY_KEY = 'talk2tm_identity_v1';

export interface LocalIdentity {
  uid: string;
  talk2tmId: string;
  displayName: string;
  internalEmail: string;
  internalSecret: string;
  createdAt: string;
}

/**
 * Gera um identificador único de formato TM-XXXX-XXXX.
 * Exemplo: TM-K7P4-X92M
 * Utiliza alfabeto alfanumérico seguro (sem O/0 ou I/1 para evitar ambiguidade visual).
 */
export function generateTalk2TMId(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const array = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < 8; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }

  const p1 = Array.from(array.slice(0, 4))
    .map((b) => chars[b % chars.length])
    .join('');
  const p2 = Array.from(array.slice(4, 8))
    .map((b) => chars[b % chars.length])
    .join('');

  return `TM-${p1}-${p2}`;
}

/**
 * Gera um segredo interno criptográfico seguro de 16 caracteres para a credencial opaca.
 */
export function generateInternalSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const array = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < 16; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(array)
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Converte um Talk2TM ID em um e-mail interno seguro da infraestrutura.
 * Exemplo: TM-K7P4-X92M -> tm_k7p4_x92m@talk2tm.internal
 */
export function talk2tmIdToInternalEmail(talk2tmId: string): string {
  const clean = talk2tmId.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${clean}@talk2tm.internal`;
}

/**
 * Salva identidade no armazenamento local seguro do dispositivo.
 */
export function saveLocalIdentity(identity: LocalIdentity): void {
  try {
    localStorage.setItem(LOCAL_IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Falha silenciosa se armazenamento restrito
  }
}

/**
 * Recupera a identidade ativa configurada no dispositivo.
 */
export function getLocalIdentity(): LocalIdentity | null {
  try {
    const raw = localStorage.getItem(LOCAL_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.talk2tmId && parsed.uid) {
      return parsed as LocalIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Limpa identidade do dispositivo.
 */
export function clearLocalIdentity(): void {
  try {
    localStorage.removeItem(LOCAL_IDENTITY_KEY);
  } catch {
    // Falha silenciosa
  }
}

/**
 * Cria uma nova identidade Talk2TM completa:
 * 1. Gera o código TM-XXXX-XXXX
 * 2. Gera credencial interna e registra no Firebase Auth
 * 3. Salva users/{uid} no Firestore
 * 4. Salva userProfiles/{talk2tmId} no Firestore
 * 5. Persiste localmente para acesso imediato sem re-login
 */
export async function createTalk2TMIdentity(displayName: string): Promise<LocalIdentity> {
  const cleanName = displayName.trim().slice(0, 30);
  if (!cleanName) {
    throw new Error('Nome de exibição é obrigatório.');
  }

  const talk2tmId = generateTalk2TMId();
  const internalEmail = talk2tmIdToInternalEmail(talk2tmId);
  const internalSecret = generateInternalSecret();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();

  if (!auth || !db) {
    throw new Error('Serviço Firebase não inicializado.');
  }

  // 1. Cria conta interna no Firebase Auth
  const userCredential = await createUserWithEmailAndPassword(auth, internalEmail, internalSecret);
  const user = userCredential.user;

  // 2. Atualiza displayName no Auth
  try {
    await updateProfile(user, { displayName: cleanName });
  } catch {
    // Não bloqueia caso falhe
  }

  const now = new Date().toISOString();

  // 3. Salva metadados da conta privada: users/{uid}
  const userAccount: UserAccount = {
    uid: user.uid,
    talk2tmId,
    createdAt: now,
  };
  await setDoc(doc(db, 'users', user.uid), userAccount);

  // 4. Salva índice público de descoberta: userProfiles/{talk2tmId}
  const userProfile: UserProfile = {
    talk2tmId,
    uid: user.uid,
    displayName: cleanName,
    active: true,
    createdAt: now,
  };
  await setDoc(doc(db, 'userProfiles', talk2tmId), userProfile);

  // 5. Persiste a identidade no dispositivo
  const identity: LocalIdentity = {
    uid: user.uid,
    talk2tmId,
    displayName: cleanName,
    internalEmail,
    internalSecret,
    createdAt: now,
  };
  saveLocalIdentity(identity);

  return identity;
}

/**
 * Restaura e autentica silenciosamente a identidade existente armazenada localmente.
 */
export async function restoreLocalIdentity(): Promise<LocalIdentity | null> {
  const identity = getLocalIdentity();
  if (!identity) return null;

  const auth = getFirebaseAuth();
  if (!auth) return identity;

  // Se já está autenticado com este UID, retorna direto
  if (auth.currentUser && auth.currentUser.uid === identity.uid) {
    return identity;
  }

  try {
    await signInWithEmailAndPassword(auth, identity.internalEmail, identity.internalSecret);
  } catch {
    // Se a autenticação falhar temporariamente por falta de rede, mantemos a identidade local
  }

  return identity;
}

/**
 * Consulta um perfil público pelo código Talk2TM ID (ex: TM-K7P4-X92M)
 */
export async function findProfileByTalk2TMId(talk2tmId: string): Promise<UserProfile | null> {
  const cleanId = talk2tmId.trim().toUpperCase();
  const db = getFirebaseDB();
  if (!db) return null;

  const snap = await getDoc(doc(db, 'userProfiles', cleanId));
  if (!snap.exists()) return null;

  return snap.data() as UserProfile;
}
