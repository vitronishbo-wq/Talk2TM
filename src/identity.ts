/**
 * Talk2TM — Gerenciador de Identidade & Cofre Local Criptografado
 *
 * Responsabilidades:
 * 1. Identidade por utilizador único (ex: Truman01), telefone normalizado E.164 (+244 padrão) e e-mail real ativado por link.
 * 2. Geração interna silenciosa de Talk2TM ID (TM-XXXX-XXXX) como vínculo técnico bilateral (nunca exibido ao utilizador).
 * 3. Senha interna do Firebase Auth de alta entropia (32 caracteres aleatórios) totalmente independente do PIN numérico.
 * 4. Cofre local multi-conta encriptado com AES-256-GCM + PBKDF2(PIN) + hash rápido com sal para desbloqueio direto pelo PIN (>= 6 dígitos).
 * 5. Zero armazenamento em Base64/texto simples de PIN ou credencial Auth.
 */

import { PhoneDirectoryEntry, UsernameDirectoryEntry, UserProfile, UserAccount } from './types';
import {
  getFirebaseDB,
  getFirebaseAuth,
  initFirebase,
  syncAuthState,
} from './firebase/firestore';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  sendEmailVerification,
  applyActionCode,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  User,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  collection,
  query,
  where,
  limit,
  writeBatch,
  DocumentReference,
} from 'firebase/firestore';
import {
  normalizePhoneNumber,
  maskPhoneNumber,
  hashPhoneNumber,
} from './utils/phone';
import { t } from './i18n';
import { checkAccountCreationThrottle, recordAccountCreationAttempt } from './safety';
import { clearAccountScopedIndexedDBData } from './storage/indexeddb';
import { deleteDatingPhotoFromStorage } from './media/photo';

const LOCAL_IDENTITY_V1_KEY = 'talk2tm_identity_v1';
const LOCAL_VAULT_V2_KEY = 'talk2tm_identities_v2';
const RESERVED_SYSTEM_PINS = new Set(['852456', '135790']);
const PROTECTED_LEGACY_UIDS = new Set(['uid_truman_852456', 'uid_maezinha_135790']);

export interface LocalIdentity {
  uid: string;
  talk2tmId: string;
  username?: string;
  displayName: string;
  internalEmail: string;
  emailVerified?: boolean;
  /** Usado apenas por legado/testes unitários de migração; contas modernas nunca gravam este campo no disco. */
  internalSecret?: string;
  phoneHash?: string;
  phoneMasked?: string;
  pinLength?: number;
  pinSalt?: string;
  pinFastHash?: string;
  vaultIv?: string;
  vaultCiphertext?: string;
  createdAt: string;
}

interface LocalVaultStore {
  activeUid: string | null;
  accounts: LocalIdentity[];
}

export interface RegisterAccountParams {
  username: string;
  phone: string;
  email: string;
  pin: string;
}

export interface RegisterAccountResult {
  identity: LocalIdentity;
  e164Phone: string;
  email: string;
  emailVerified: boolean;
}

function getWebCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error(t('err.webCryptoUnavailable'));
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0) {
    throw new Error(t('err.corruptedCrypto'));
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Gera um identificador interno de vínculo bilateral no formato estrito TM-XXXX-XXXX.
 */
export function generateTalk2TMId(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const array = getRandomBytes(8);
  const p1 = Array.from(array.slice(0, 4))
    .map((b) => chars[b % chars.length])
    .join('');
  const p2 = Array.from(array.slice(4, 8))
    .map((b) => chars[b % chars.length])
    .join('');
  return `TM-${p1}-${p2}`;
}

/**
 * Gera uma credencial interna de alta entropia (32 caracteres aleatórios) para o Firebase Auth.
 * Totalmente independente do PIN numérico local do utilizador.
 */
export function generateInternalSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const array = getRandomBytes(32);
  return Array.from(array)
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Valida o nome de utilizador público (ex: Truman01), 3 a 24 caracteres alfanuméricos, ponto ou underscore.
 */
export function validateUsername(
  raw: string
): { valid: boolean; username: string; usernameLower: string; error?: string } {
  const trimmed = (raw || '').trim();
  const usernameLower = trimmed.toLowerCase();
  if (!trimmed) {
    return { valid: false, username: '', usernameLower: '', error: t('err.nameRequired') };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._]{2,23}$/.test(trimmed)) {
    return {
      valid: false,
      username: trimmed,
      usernameLower,
      error: t('err.usernameFormat'),
    };
  }
  return { valid: true, username: trimmed, usernameLower };
}

/**
 * Valida o e-mail real obrigatório da conta (rejeita vazio e o domínio interno @talk2tm.internal).
 */
export function validateAccountEmail(
  raw: string
): { valid: boolean; email?: string; error?: string } {
  const trimmed = (raw || '').trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: t('err.emailRequired') };
  }
  if (trimmed.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { valid: false, error: t('err.invalidEmail') };
  }
  if (trimmed.endsWith('@talk2tm.internal')) {
    return { valid: false, error: t('err.emailPersonalRequired') };
  }
  return { valid: true, email: trimmed };
}

/**
 * Hash rápido com sal por conta para verificação instantânea (<2ms) de PIN na calculadora.
 */
export async function hashPinFast(pin: string, pinSalt: string): Promise<string> {
  const webCrypto = getWebCrypto();
  const payload = new TextEncoder().encode(`talk2tm:pin:v1:${pinSalt}:${pin}`);
  const digest = await webCrypto.subtle.digest('SHA-256', toArrayBuffer(payload));
  return bytesToHex(new Uint8Array(digest));
}

async function deriveVaultAesKey(pin: string, pinSalt: string): Promise<CryptoKey> {
  const webCrypto = getWebCrypto();
  const encoder = new TextEncoder();
  const baseKey = await webCrypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(pin)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await webCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(encoder.encode(`talk2tm:vault:v1:${pinSalt}`)),
      iterations: 100_000,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Sela a credencial Auth com o PIN numérico do aparelho via PBKDF2 + AES-256-GCM.
 */
export async function sealAuthSecretWithPin(
  authPassword: string,
  pin: string,
  existingSalt?: string
): Promise<{
  pinSalt: string;
  pinFastHash: string;
  vaultIv: string;
  vaultCiphertext: string;
  pinLength: number;
}> {
  const pinSalt = existingSalt || bytesToHex(getRandomBytes(16));
  const iv = getRandomBytes(12);
  const aesKey = await deriveVaultAesKey(pin, pinSalt);
  const encrypted = await getWebCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(new TextEncoder().encode(authPassword))
  );
  const pinFastHash = await hashPinFast(pin, pinSalt);
  return {
    pinSalt,
    pinFastHash,
    vaultIv: bytesToHex(iv),
    vaultCiphertext: bytesToHex(new Uint8Array(encrypted)),
    pinLength: pin.length,
  };
}

/**
 * Decifra a credencial Auth na memória RAM usando o PIN numérico fornecido.
 * Falha com erro se o PIN estiver incorreto (integridade AES-GCM).
 */
export async function unsealAuthSecretWithPin(
  identity: Pick<LocalIdentity, 'pinSalt' | 'vaultIv' | 'vaultCiphertext' | 'internalSecret'>,
  pin: string
): Promise<string> {
  if (identity.vaultCiphertext && identity.vaultIv && identity.pinSalt) {
    const aesKey = await deriveVaultAesKey(pin, identity.pinSalt);
    try {
      const decrypted = await getWebCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(hexToBytes(identity.vaultIv)) },
        aesKey,
        toArrayBuffer(hexToBytes(identity.vaultCiphertext))
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      throw new Error(t('err.wrongPinAccount'));
    }
  }
  if (identity.internalSecret) {
    return identity.internalSecret;
  }
  throw new Error(t('err.localCredentialUnavailable'));
}

function getStorageOrNull(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return storage || (typeof localStorage !== 'undefined' ? localStorage : null);
}

function readVaultStore(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): LocalVaultStore {
  const s = getStorageOrNull(storage);
  if (!s) return { activeUid: null, accounts: [] };

  try {
    const rawV2 = s.getItem(LOCAL_VAULT_V2_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<LocalVaultStore>;
      const accounts = Array.isArray(parsed?.accounts)
        ? parsed.accounts.filter((a) => a && a.uid && a.talk2tmId)
        : [];
      return {
        activeUid: parsed?.activeUid || accounts[0]?.uid || null,
        accounts,
      };
    }

    // Migração passiva de talk2tm_identity_v1 se existir
    const rawV1 = s.getItem(LOCAL_IDENTITY_V1_KEY);
    if (rawV1) {
      const legacy = JSON.parse(rawV1) as LocalIdentity;
      if (legacy && legacy.uid && legacy.talk2tmId) {
        return {
          activeUid: legacy.uid,
          accounts: [legacy],
        };
      }
    }
  } catch {
    // Falha silenciosa se JSON inválido
  }
  return { activeUid: null, accounts: [] };
}

function writeVaultStore(
  store: LocalVaultStore,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const s = getStorageOrNull(storage);
  if (!s) return;
  try {
    s.setItem(LOCAL_VAULT_V2_KEY, JSON.stringify(store));
  } catch {
    // Falha silenciosa se armazenamento restrito
  }
}

export function getAllLocalIdentities(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): LocalIdentity[] {
  return readVaultStore(storage).accounts;
}

export function getActiveVaultPinLengths(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): number[] {
  const lengths = new Set<number>();
  for (const acc of readVaultStore(storage).accounts) {
    if (typeof acc.pinLength === 'number' && acc.pinLength >= 6) {
      lengths.add(acc.pinLength);
    }
  }
  return Array.from(lengths).sort((a, b) => a - b);
}

export function upsertLocalIdentity(
  identity: LocalIdentity,
  setActive: boolean = true,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const store = readVaultStore(storage);
  // Nunca persiste internalSecret se o cofre criptografado estiver presente
  const sanitized: LocalIdentity = identity.vaultCiphertext
    ? {
        uid: identity.uid,
        talk2tmId: identity.talk2tmId,
        ...(identity.username ? { username: identity.username } : {}),
        displayName: identity.displayName,
        internalEmail: identity.internalEmail,
        ...(typeof identity.emailVerified === 'boolean'
          ? { emailVerified: identity.emailVerified }
          : {}),
        phoneHash: identity.phoneHash,
        phoneMasked: identity.phoneMasked,
        pinLength: identity.pinLength,
        pinSalt: identity.pinSalt,
        pinFastHash: identity.pinFastHash,
        vaultIv: identity.vaultIv,
        vaultCiphertext: identity.vaultCiphertext,
        createdAt: identity.createdAt,
      }
    : identity;

  const idx = store.accounts.findIndex((a) => a.uid === sanitized.uid);
  if (idx >= 0) {
    store.accounts[idx] = sanitized;
  } else {
    store.accounts.push(sanitized);
  }
  if (setActive || !store.activeUid) {
    store.activeUid = sanitized.uid;
  }
  writeVaultStore(store, storage);
}

/**
 * Salva identidade ativa no cofre local do dispositivo (compatível com testes legados).
 */
export function saveLocalIdentity(
  identity: LocalIdentity,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  upsertLocalIdentity(identity, true, storage);
}

/**
 * Recupera a identidade ativa configurada no dispositivo.
 */
export function getLocalIdentity(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): LocalIdentity | null {
  const store = readVaultStore(storage);
  if (store.accounts.length === 0) return null;
  if (store.activeUid) {
    const active = store.accounts.find((a) => a.uid === store.activeUid);
    if (active) return active;
  }
  return store.accounts[0] || null;
}

/**
 * Limpa identidades do dispositivo.
 */
export function clearLocalIdentity(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const s = getStorageOrNull(storage);
  if (!s) return;
  try {
    s.removeItem(LOCAL_VAULT_V2_KEY);
    s.removeItem(LOCAL_IDENTITY_V1_KEY);
  } catch {
    // Falha silenciosa
  }
}

export const TALK2TM_RESET_EPOCH = '2';
const RESET_EPOCH_STORAGE_KEY = 'talk2tm_vault_epoch';
const PRESERVED_LEGACY_EMAILS = new Set([
  'truman@talk2tm.internal',
  'maezinha@talk2tm.internal',
]);

/**
 * Executa uma limpeza única de contas locais criadas antes da época atual (v2),
 * preservando integralmente o acesso e histórico local de Truman e Mãezinha.
 */
export function applyLocalResetEpochIfNeeded(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
    length?: number;
    key?: (index: number) => string | null;
  },
  activeAuthEmail?: string | null
): { cleared: boolean; shouldSignOutAuth: boolean } {
  const s = (storage || (typeof localStorage !== 'undefined' ? localStorage : null)) as
    | (Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
        length?: number;
        key?: (index: number) => string | null;
      })
    | null;
  if (!s) {
    return { cleared: false, shouldSignOutAuth: false };
  }

  try {
    if (s.getItem(RESET_EPOCH_STORAGE_KEY) === TALK2TM_RESET_EPOCH) {
      return { cleared: false, shouldSignOutAuth: false };
    }

    const normalizedEmail = (activeAuthEmail || '').trim().toLowerCase();
    const shouldSignOutAuth = Boolean(normalizedEmail) && !PRESERVED_LEGACY_EMAILS.has(normalizedEmail);

    s.removeItem(LOCAL_VAULT_V2_KEY);
    s.removeItem(LOCAL_IDENTITY_V1_KEY);
    s.removeItem('talk2tm_session');

    // Remove monitorContext apenas se pertencia a uma conversa bilateral (mantém truman-maezinha intacto)
    const rawMonitor = s.getItem('talk2tm_monitor_v1');
    if (rawMonitor) {
      try {
        const parsed = JSON.parse(rawMonitor) as { isConversation?: boolean; channelId?: string };
        if (parsed?.isConversation || (typeof parsed?.channelId === 'string' && parsed.channelId.startsWith('conv_'))) {
          s.removeItem('talk2tm_monitor_v1');
        }
      } catch {
        s.removeItem('talk2tm_monitor_v1');
      }
    }

    if (typeof s.length === 'number' && typeof s.key === 'function') {
      const keysToRemove: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k) continue;
        if (
          k.startsWith('talk2tm_last_conv_') ||
          k.startsWith('ttm_last_read_conv_') ||
          k.startsWith('talk2tm_hidden_conv_')
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => s.removeItem(k));
    }

    s.setItem(RESET_EPOCH_STORAGE_KEY, TALK2TM_RESET_EPOCH);
    return { cleared: true, shouldSignOutAuth };
  } catch {
    return { cleared: false, shouldSignOutAuth: false };
  }
}

/**
 * Valida o PIN numérico local com mínimo de 6 dígitos (sem limite superior, aceita ex. 000000 ou 123456),
 * bloqueando códigos reservados do sistema (852456 / 135790) e colisões no mesmo dispositivo.
 */
export async function validateLocalPin(
  pin: string,
  checkCollisions: boolean = true,
  excludeUid?: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Promise<{ valid: boolean; error?: string }> {
  const clean = (pin || '').trim();
  if (!/^\d{6,}$/.test(clean)) {
    return { valid: false, error: t('err.pinFormat') };
  }
  if (RESERVED_SYSTEM_PINS.has(clean)) {
    return {
      valid: false,
      error: t('err.pinReserved'),
    };
  }
  if (checkCollisions) {
    const existing = await findLocalIdentityByPin(clean, storage);
    if (existing && existing.uid !== excludeUid) {
      return {
        valid: false,
        error: t('err.pinCollision'),
      };
    }
  }
  return { valid: true };
}

/**
 * Procura no cofre local uma conta cujo PIN numérico (>= 6 dígitos) corresponda ao digitado.
 */
export async function findLocalIdentityByPin(
  pin: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Promise<LocalIdentity | null> {
  const clean = (pin || '').trim();
  if (!/^\d{6,}$/.test(clean)) return null;

  const accounts = getAllLocalIdentities(storage);
  for (const acc of accounts) {
    if (acc.pinLength === clean.length && acc.pinSalt && acc.pinFastHash) {
      try {
        const candidateHash = await hashPinFast(clean, acc.pinSalt);
        if (candidateHash === acc.pinFastHash) {
          return acc;
        }
      } catch {
        // Ignora conta com hash inválido
      }
    }
  }
  return null;
}

export function getAuthActionContinueUrl(flow: 'verifyEmail' | 'resetPassword'): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://talk2tm.web.app';
  return `${origin}/?authFlow=${flow}`;
}

/**
 * Cadastro único:
 * - User (único, ex: Truman01)
 * - Tel (E.164 com +244 predefinido)
 * - E-mail real + envio obrigatório do link de ativação
 * - PIN numérico local (>= 6 dígitos, sem limite máximo) usado apenas no cofre local (nunca como senha do Firebase Auth)
 */
export async function registerAccountWithEmail(
  params: RegisterAccountParams
): Promise<RegisterAccountResult> {
  const usernameCheck = validateUsername(params.username);
  if (!usernameCheck.valid) {
    throw new Error(usernameCheck.error || t('onboarding.errNameRequired'));
  }

  const phoneCheck = normalizePhoneNumber(params.phone);
  if (!phoneCheck.valid || !phoneCheck.e164) {
    throw new Error(phoneCheck.error || t('onboarding.errPhoneInvalid'));
  }

  const emailCheck = validateAccountEmail(params.email);
  if (!emailCheck.valid || !emailCheck.email) {
    throw new Error(emailCheck.error || t('onboarding.errEmailInvalid'));
  }

  const pinCheck = await validateLocalPin(params.pin, true);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || t('onboarding.errPinInvalid'));
  }

  const e164Phone = phoneCheck.e164;
  const phoneHash = await hashPhoneNumber(e164Phone);
  const phoneMasked = maskPhoneNumber(e164Phone);
  const cleanEmail = emailCheck.email;
  const talk2tmId = generateTalk2TMId();
  // Senha interna aleatória de alta entropia — nunca derivada nem igual ao PIN local
  const authPassword = generateInternalSecret();

  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  checkAccountCreationThrottle();

  let user: User;
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, authPassword);
    user = userCredential.user;
    recordAccountCreationAttempt();
  } catch (err: any) {
    if (err?.code === 'auth/email-already-in-use') {
      throw new Error(t('err.emailInUse'));
    }
    if (err?.code === 'auth/invalid-email') {
      throw new Error(t('err.invalidEmail'));
    }
    if (err?.code === 'auth/too-many-requests') {
      throw new Error(t('err.tooManyRequests'));
    }
    throw new Error(err?.message || t('err.createAccountFailed'));
  }

  syncAuthState(user);

  try {
    await updateProfile(user, { displayName: usernameCheck.username }).catch(() => {});
    await user.getIdToken(true).catch(() => {});

    const [existingUsernameSnap, existingPhoneSnap] = await Promise.all([
      getDoc(doc(db, 'usernames', usernameCheck.usernameLower)),
      getDoc(doc(db, 'phoneLookup', phoneHash)),
    ]);

    if (existingUsernameSnap.exists() && existingUsernameSnap.data()?.uid !== user.uid) {
      throw new Error(t('err.usernameInUse'));
    }
    if (existingPhoneSnap.exists() && existingPhoneSnap.data()?.uid !== user.uid) {
      throw new Error(t('err.phoneInUse'));
    }

    const now = new Date().toISOString();

    const userAccount: UserAccount = {
      uid: user.uid,
      talk2tmId,
      username: usernameCheck.username,
      createdAt: now,
      phoneHash,
      phoneMasked,
    };
    await setDoc(doc(db, 'users', user.uid), userAccount);

    const userProfile: UserProfile = {
      talk2tmId,
      uid: user.uid,
      username: usernameCheck.username,
      displayName: usernameCheck.username,
      active: true,
      createdAt: now,
    };
    await setDoc(doc(db, 'userProfiles', talk2tmId), userProfile);

    const directoryEntry: PhoneDirectoryEntry = {
      phoneHash,
      uid: user.uid,
      talk2tmId,
      displayName: usernameCheck.username,
      active: true,
      createdAt: now,
    };
    await setDoc(doc(db, 'phoneLookup', phoneHash), directoryEntry);

    const usernameEntry: UsernameDirectoryEntry = {
      usernameLower: usernameCheck.usernameLower,
      username: usernameCheck.username,
      uid: user.uid,
      talk2tmId,
      createdAt: now,
    };
    await setDoc(doc(db, 'usernames', usernameCheck.usernameLower), usernameEntry);

    // Envia link de ativação da conta (fluxo distinto do link de recuperação)
    await sendEmailVerification(user, {
      url: getAuthActionContinueUrl('verifyEmail'),
    });

    const sealed = await sealAuthSecretWithPin(authPassword, params.pin.trim());
    const identity: LocalIdentity = {
      uid: user.uid,
      talk2tmId,
      username: usernameCheck.username,
      displayName: usernameCheck.username,
      internalEmail: cleanEmail,
      emailVerified: Boolean(user.emailVerified),
      phoneHash,
      phoneMasked,
      pinLength: sealed.pinLength,
      pinSalt: sealed.pinSalt,
      pinFastHash: sealed.pinFastHash,
      vaultIv: sealed.vaultIv,
      vaultCiphertext: sealed.vaultCiphertext,
      createdAt: now,
    };
    upsertLocalIdentity(identity, true);

    return {
      identity,
      e164Phone,
      email: cleanEmail,
      emailVerified: Boolean(user.emailVerified),
    };
  } catch (err: any) {
    // Rollback rigoroso: apaga utilizador Auth recém-criado para não deixar e-mail/número/user preso
    try {
      await user.delete();
    } catch {
      await signOut(auth).catch(() => {});
    }
    syncAuthState(auth.currentUser);
    if (err instanceof Error && err.message) {
      throw err;
    }
    throw new Error(t('err.finalizeSignupFailed'));
  }
}

/**
 * Conclui a ativação de conta por e-mail dentro da app (?mode=verifyEmail&oobCode=...).
 */
export async function completeEmailActivationInApp(oobCode?: string): Promise<{
  verified: boolean;
  email?: string;
  uid?: string;
}> {
  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  if (oobCode) {
    try {
      await applyActionCode(auth, oobCode);
    } catch {
      throw new Error(t('err.activationLinkExpired'));
    }
  }

  if (auth.currentUser) {
    await auth.currentUser.reload().catch(() => {});
    await auth.currentUser.getIdToken(true).catch(() => {});
    syncAuthState(auth.currentUser);
  }

  const user = auth.currentUser;
  const verified = Boolean(oobCode) || Boolean(user?.emailVerified);

  if (verified && user) {
    const existing = getAllLocalIdentities().find(
      (a) =>
        a.uid === user.uid ||
        (user.email && a.internalEmail.toLowerCase() === user.email.toLowerCase())
    );
    if (existing) {
      upsertLocalIdentity({ ...existing, emailVerified: true }, existing.uid === getLocalIdentity()?.uid);
    }
  }

  return {
    verified,
    email: user?.email || undefined,
    uid: user?.uid || undefined,
  };
}

/**
 * Recarrega o utilizador Firebase Auth atual para confirmar se o link de ativação já foi clicado.
 */
export async function checkCurrentEmailActivation(): Promise<{
  verified: boolean;
  email?: string;
  uid?: string;
}> {
  await initFirebase();
  const auth = getFirebaseAuth();
  const user = auth?.currentUser;
  if (!user) {
    return { verified: false };
  }

  await user.reload();
  await user.getIdToken(true).catch(() => {});
  syncAuthState(user);

  const verified = Boolean(user.emailVerified);
  if (verified) {
    const existing = getAllLocalIdentities().find((a) => a.uid === user.uid);
    if (existing) {
      upsertLocalIdentity({ ...existing, emailVerified: true }, true);
    }
  }

  return {
    verified,
    email: user.email || undefined,
    uid: user.uid,
  };
}

/**
 * Reenvia o link de ativação para o e-mail da conta atualmente pendente.
 */
export async function resendEmailActivationLink(): Promise<{
  alreadyVerified: boolean;
  email: string;
}> {
  await initFirebase();
  const auth = getFirebaseAuth();
  const user = auth?.currentUser;
  if (!user) {
    throw new Error(t('err.authNonAnonRequired'));
  }

  await user.reload().catch(() => {});
  if (user.emailVerified) {
    const existing = getAllLocalIdentities().find((a) => a.uid === user.uid);
    if (existing) {
      upsertLocalIdentity({ ...existing, emailVerified: true }, true);
    }
    return { alreadyVerified: true, email: user.email || '' };
  }

  try {
    await sendEmailVerification(user, {
      url: getAuthActionContinueUrl('verifyEmail'),
    });
    return { alreadyVerified: false, email: user.email || '' };
  } catch (err: any) {
    if (err?.code === 'auth/too-many-requests') {
      throw new Error(t('err.tooManyRequests'));
    }
    throw new Error(err?.message || t('err.sendConfirmEmailFailed'));
  }
}

/**
 * Autentica no Firebase Auth uma conta local já cadastrada usando seu PIN para decifrar o cofre em RAM.
 */
export async function authenticateVaultIdentity(
  identity: LocalIdentity,
  pin?: string
): Promise<{ user: User | null; displayName: string; identity: LocalIdentity }> {
  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth) {
    return { user: null, displayName: identity.displayName, identity };
  }

  let currentIdentity = identity;

  if (!auth.currentUser || auth.currentUser.uid !== currentIdentity.uid) {
    let secret: string | null = null;
    if (pin) {
      secret = await unsealAuthSecretWithPin(currentIdentity, pin);
    } else if (currentIdentity.internalSecret) {
      secret = currentIdentity.internalSecret;
    }

    if (secret) {
      const cred = await signInWithEmailAndPassword(auth, currentIdentity.internalEmail, secret);
      syncAuthState(cred.user);
    }
  } else {
    syncAuthState(auth.currentUser);
  }

  const isLegacyAccount = currentIdentity.internalEmail.toLowerCase().endsWith('@talk2tm.internal');
  if (auth.currentUser && auth.currentUser.uid === currentIdentity.uid) {
    if (!isLegacyAccount && !auth.currentUser.emailVerified && typeof navigator !== 'undefined' && navigator.onLine) {
      await auth.currentUser.reload().catch(() => {});
    }
    const activeEmail = auth.currentUser.email?.toLowerCase();
    const nextEmailVerified = isLegacyAccount ? true : Boolean(auth.currentUser.emailVerified);
    if (
      (activeEmail && activeEmail !== currentIdentity.internalEmail.toLowerCase()) ||
      currentIdentity.emailVerified !== nextEmailVerified
    ) {
      currentIdentity = {
        ...currentIdentity,
        ...(activeEmail ? { internalEmail: activeEmail } : {}),
        emailVerified: nextEmailVerified,
      };
    }
  }

  upsertLocalIdentity(currentIdentity, true);

  let latestDisplayName = currentIdentity.displayName;
  if (db && auth.currentUser && auth.currentUser.uid === currentIdentity.uid) {
    try {
      const profileSnap = await getDoc(doc(db, 'userProfiles', currentIdentity.talk2tmId));
      if (profileSnap.exists()) {
        const profile = profileSnap.data() as UserProfile;
        const nextUsername = profile.username || currentIdentity.username;
        if (
          (profile.displayName && profile.displayName !== currentIdentity.displayName) ||
          (nextUsername && nextUsername !== currentIdentity.username)
        ) {
          latestDisplayName = profile.displayName || latestDisplayName;
          currentIdentity = {
            ...currentIdentity,
            displayName: latestDisplayName,
            ...(nextUsername ? { username: nextUsername } : {}),
          };
          upsertLocalIdentity(currentIdentity, true);
        }
      }
    } catch {
      // Offline ou timeout — mantém nome local
    }
  }

  return { user: auth.currentUser, displayName: latestDisplayName, identity: currentIdentity };
}

/**
 * Altera o PIN numérico local deste aparelho (sem custo de rede e sem alterar o Firebase Auth).
 */
export async function updateLocalPinForAccount(
  uid: string,
  currentPin: string,
  newPin: string
): Promise<void> {
  const identity = getAllLocalIdentities().find((a) => a.uid === uid);
  if (!identity) {
    throw new Error(t('err.localAccountNotFound'));
  }

  const authPassword = await unsealAuthSecretWithPin(identity, currentPin.trim());
  const pinCheck = await validateLocalPin(newPin, true, uid);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || t('onboarding.errPinInvalid'));
  }

  const sealed = await sealAuthSecretWithPin(authPassword, newPin.trim());
  upsertLocalIdentity(
    {
      ...identity,
      pinLength: sealed.pinLength,
      pinSalt: sealed.pinSalt,
      pinFastHash: sealed.pinFastHash,
      vaultIv: sealed.vaultIv,
      vaultCiphertext: sealed.vaultCiphertext,
    },
    true
  );
}

/**
 * Envia o link de recuperação de acesso exclusivamente para o e-mail associado à conta.
 */
export async function sendRecoveryEmailLink(rawEmail: string): Promise<{ email: string }> {
  const emailCheck = validateAccountEmail(rawEmail);
  if (!emailCheck.valid || !emailCheck.email) {
    throw new Error(emailCheck.error || t('connect.emailValidRequired'));
  }

  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  try {
    await sendPasswordResetEmail(auth, emailCheck.email, {
      url: getAuthActionContinueUrl('resetPassword'),
    });
    return { email: emailCheck.email };
  } catch (err: any) {
    if (err?.code === 'auth/invalid-email') {
      throw new Error(t('err.invalidEmail'));
    }
    if (err?.code === 'auth/too-many-requests') {
      throw new Error(t('err.tooManyRequests'));
    }
    throw new Error(err?.message || t('err.sendResetFailed'));
  }
}

/**
 * Valida o código oobCode de recuperação quando aberto na aplicação.
 */
export async function verifyInAppPasswordResetCode(oobCode: string): Promise<string> {
  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error(t('err.firebaseUnavailable'));
  }
  try {
    return await verifyPasswordResetCode(auth, oobCode);
  } catch {
    throw new Error(t('err.resetLinkExpired'));
  }
}

/**
 * Conclui a recuperação de acesso via link de e-mail:
 * - Valida o oobCode e o novo PIN numérico local (>= 6 dígitos)
 * - Gera internamente uma nova senha Auth aleatória de 32 caracteres (PIN nunca é senha Auth)
 * - Confirma reset, entra silenciosamente, carrega perfil e sela a nova credencial Auth com o novo PIN
 */
export async function completePasswordResetInApp(params: {
  oobCode: string;
  newPin: string;
}): Promise<LocalIdentity> {
  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  const email = await verifyInAppPasswordResetCode(params.oobCode);
  const cleanEmail = email.trim().toLowerCase();
  const existingLocal = getAllLocalIdentities().find(
    (a) => a.internalEmail.toLowerCase() === cleanEmail
  );

  const pinCheck = await validateLocalPin(params.newPin, true, existingLocal?.uid);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || t('onboarding.errPinInvalid'));
  }

  const newAuthPassword = generateInternalSecret();
  await confirmPasswordReset(auth, params.oobCode, newAuthPassword);

  const cred = await signInWithEmailAndPassword(auth, cleanEmail, newAuthPassword);
  const user = cred.user;
  syncAuthState(user);
  await user.getIdToken(true).catch(() => {});

  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (!userSnap.exists()) {
    throw new Error(t('err.accountMetadataMissing'));
  }
  const accountData = userSnap.data() as UserAccount;
  const talk2tmId = accountData.talk2tmId;

  const profileSnap = await getDoc(doc(db, 'userProfiles', talk2tmId));
  const profileData = profileSnap.exists() ? (profileSnap.data() as UserProfile) : null;
  const username = accountData.username || profileData?.username || user.displayName || undefined;
  const displayName = profileData?.displayName || username || user.displayName || 'Utilizador';

  const sealed = await sealAuthSecretWithPin(newAuthPassword, params.newPin.trim());
  const identity: LocalIdentity = {
    uid: user.uid,
    talk2tmId,
    ...(username ? { username } : {}),
    displayName,
    internalEmail: cleanEmail,
    emailVerified: Boolean(user.emailVerified),
    phoneHash: accountData.phoneHash,
    phoneMasked: accountData.phoneMasked,
    pinLength: sealed.pinLength,
    pinSalt: sealed.pinSalt,
    pinFastHash: sealed.pinFastHash,
    vaultIv: sealed.vaultIv,
    vaultCiphertext: sealed.vaultCiphertext,
    createdAt: accountData.createdAt || new Date().toISOString(),
  };

  upsertLocalIdentity(identity, true);
  return identity;
}

/**
 * Restaura silenciosamente a identidade existente (via persistência nativa do Firebase Auth ou legado).
 */
export async function restoreLocalIdentity(): Promise<LocalIdentity | null> {
  const identity = getLocalIdentity();
  if (!identity) return null;

  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) return identity;

  if (auth.currentUser && auth.currentUser.uid === identity.uid) {
    syncAuthState(auth.currentUser);
    const activeEmail = auth.currentUser.email?.toLowerCase();
    const isLegacy = identity.internalEmail.toLowerCase().endsWith('@talk2tm.internal');
    const nextEmailVerified = isLegacy ? true : Boolean(auth.currentUser.emailVerified);
    if (
      (activeEmail && activeEmail !== identity.internalEmail.toLowerCase()) ||
      identity.emailVerified !== nextEmailVerified
    ) {
      const updated: LocalIdentity = {
        ...identity,
        ...(activeEmail ? { internalEmail: activeEmail } : {}),
        emailVerified: nextEmailVerified,
      };
      upsertLocalIdentity(updated, true);
      return updated;
    }
    return identity;
  }

  if (identity.internalSecret) {
    try {
      const cred = await signInWithEmailAndPassword(auth, identity.internalEmail, identity.internalSecret);
      syncAuthState(cred.user);
    } catch {
      // Offline ou indisponível: mantém metadados locais
    }
  }

  return identity;
}

/**
 * Consulta um perfil público interno pelo código Talk2TM ID (ex: TM-K7P4-X92M)
 */
export async function findProfileByTalk2TMId(talk2tmId: string): Promise<UserProfile | null> {
  const cleanId = talk2tmId.trim().toUpperCase();
  const db = getFirebaseDB();
  if (!db) return null;

  const snap = await getDoc(doc(db, 'userProfiles', cleanId));
  if (!snap.exists()) return null;

  return snap.data() as UserProfile;
}

/**
 * Consulta exata de utilizador por número de telefone declarado (via SHA-256 phoneHash em phoneLookup).
 * Não expõe números brutos nem permite enumeração/listagem.
 */
export async function findProfileByPhone(rawPhone: string): Promise<PhoneDirectoryEntry | null> {
  const phoneCheck = normalizePhoneNumber(rawPhone);
  if (!phoneCheck.valid || !phoneCheck.e164) {
    throw new Error(phoneCheck.error || t('onboarding.errPhoneInvalid'));
  }

  const { db, configured } = await initFirebase();
  if (!configured || !db) return null;

  const phoneHash = await hashPhoneNumber(phoneCheck.e164);
  const snap = await getDoc(doc(db, 'phoneLookup', phoneHash));
  if (!snap.exists()) return null;

  return snap.data() as PhoneDirectoryEntry;
}

/**
 * Remove exclusivamente os rastros locais de um UID do cofre e do localStorage,
 * preservando integralmente outras contas no cofre multi-conta e dados do par legado Truman/Mãezinha.
 */
export function removeAccountFromLocalVault(
  uid: string,
  conversationIds: string[] = [],
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const storeRef = storage || (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!storeRef || !uid || PROTECTED_LEGACY_UIDS.has(uid)) return;

  const vault = readVaultStore(storeRef);
  const remaining = vault.accounts.filter((a) => a.uid !== uid);
  if (remaining.length === 0) {
    try {
      storeRef.removeItem(LOCAL_VAULT_V2_KEY);
      storeRef.removeItem(LOCAL_IDENTITY_V1_KEY);
    } catch {
      // ignora erro de storage
    }
  } else {
    const nextActiveUid = vault.activeUid === uid ? remaining[0].uid : vault.activeUid;
    writeVaultStore({ activeUid: nextActiveUid, accounts: remaining }, storeRef);
    const activeAcc = remaining.find((a) => a.uid === nextActiveUid) || remaining[0];
    if (activeAcc) {
      try {
        storeRef.setItem(LOCAL_IDENTITY_V1_KEY, JSON.stringify(activeAcc));
      } catch {
        // ignora erro
      }
    }
  }

  // Limpa sessão ativa apenas se pertencer ao UID apagado
  try {
    const rawSession = storeRef.getItem('talk2tm_session');
    if (rawSession) {
      const parsed = JSON.parse(rawSession) as { userId?: string };
      if (!parsed?.userId || parsed.userId === uid) {
        storeRef.removeItem('talk2tm_session');
      }
    }
  } catch {
    try {
      storeRef.removeItem('talk2tm_session');
    } catch {
      // ignora
    }
  }

  // Limpa contexto de monitor em segundo plano apenas se pertencer ao UID apagado ou às suas conversas
  try {
    const rawMonitor = storeRef.getItem('talk2tm_monitor_v1');
    if (rawMonitor) {
      const parsed = JSON.parse(rawMonitor) as { userId?: string; channelId?: string };
      if (
        parsed?.userId === uid ||
        (parsed?.channelId &&
          parsed.channelId !== 'truman-maezinha' &&
          conversationIds.includes(parsed.channelId))
      ) {
        storeRef.removeItem('talk2tm_monitor_v1');
      }
    }
  } catch {
    // ignora
  }

  const perUidKeys = [
    `talk2tm_last_conv_${uid}`,
    `talk2tm_dating_profile_v1_${uid}`,
    `talk2tm_dating_filters_v1_${uid}`,
    `talk2tm_dating_evals_v1_${uid}`,
    `talk2tm_dating_blocks_v1_${uid}`,
    `talk2tm_dating_matches_v1_${uid}`,
    `talk2tm_blocks_v1_${uid}`,
    `talk2tm_ratelimit_v1_${uid}`,
    `talk2tm_ref_summary_v1_${uid}`,
    `talk2tm_activity_ping_v1_${uid}`,
  ];
  for (const key of perUidKeys) {
    try {
      storeRef.removeItem(key);
    } catch {
      // ignora
    }
  }

  for (const rawCid of conversationIds) {
    const cid = (rawCid || '').trim();
    if (!cid || cid === 'truman-maezinha' || !cid.startsWith('conv_')) continue;
    for (const cKey of [
      `talk2tm_hidden_${cid}`,
      `ttm_last_read_${cid}_${uid}`,
      `ttm_last_read_${cid}`,
    ]) {
      try {
        storeRef.removeItem(cKey);
      } catch {
        // ignora
      }
    }
  }
}

async function commitBatchDeletionsInChunks(
  db: NonNullable<ReturnType<typeof getFirebaseDB>>,
  refs: DocumentReference[]
): Promise<void> {
  const seen = new Map<string, DocumentReference>();
  for (const ref of refs) {
    seen.set(ref.path, ref);
  }
  const unique = Array.from(seen.values());
  const CHUNK_SIZE = 380;
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const batch = writeBatch(db);
    const slice = unique.slice(i, i + CHUNK_SIZE);
    for (const ref of slice) {
      batch.delete(ref);
    }
    await batch.commit();
  }
}

/**
 * Eliminação Real de Conta (Hard Delete):
 * - Exige PIN local válido para decifrar a credencial Auth e reautenticar o utilizador.
 * - Marca users/{uid}.accountStatus = 'deleting' para autorizar a cascata nas regras de segurança.
 * - Apaga avaliações Dating, bloqueios, likes, matches, convites, conversas bilaterais e mensagens.
 * - Apaga num batch atômico final: userRateLimits/{uid}, datingProfiles/{uid}, phoneLookup/{phoneHash}, userProfiles/{talk2tmId} e users/{uid}.
 * - Elimina o utilizador no Firebase Auth (user.delete()) e limpa apenas os dados locais daquela conta.
 */
export async function deleteOwnAccountCompletely(params: {
  uid: string;
  currentPin: string;
  conversationIds?: string[];
}): Promise<{ deletedConversationIds: string[] }> {
  const { uid } = params;
  const cleanPin = (params.currentPin || '').trim();
  if (!uid || PROTECTED_LEGACY_UIDS.has(uid)) {
    throw new Error(t('safety.errCannotDeleteLegacy'));
  }

  const identity = getAllLocalIdentities().find((a) => a.uid === uid);
  if (!identity) {
    throw new Error(t('err.localAccountNotFound'));
  }

  const authPassword = await unsealAuthSecretWithPin(identity, cleanPin);

  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error(t('err.firebaseUnavailable'));
  }

  let user = auth.currentUser;
  if (!user || user.uid !== uid) {
    const cred = await signInWithEmailAndPassword(auth, identity.internalEmail, authPassword);
    user = cred.user;
    syncAuthState(user);
  } else {
    const activeEmail = (user.email || identity.internalEmail).toLowerCase();
    const emailCred = EmailAuthProvider.credential(activeEmail, authPassword);
    await reauthenticateWithCredential(user, emailCred);
  }

  await user.getIdToken(true).catch(() => {});

  const userRef = doc(db, 'users', uid);
  const userSnap = await getDoc(userRef);
  const accountData = userSnap.exists() ? (userSnap.data() as UserAccount) : null;
  const talk2tmId = accountData?.talk2tmId || identity.talk2tmId;
  const phoneHash = accountData?.phoneHash || identity.phoneHash;
  const usernameLower = (accountData?.username || identity.username || '').trim().toLowerCase();

  const nowIso = new Date().toISOString();
  if (userSnap.exists() && accountData?.accountStatus !== 'deleting') {
    await updateDoc(userRef, {
      accountStatus: 'deleting',
      deletionRequestedAt: nowIso,
    });
  }

  const deletedConversationIds = new Set<string>(
    (params.conversationIds || []).filter((id) => Boolean(id) && id !== 'truman-maezinha')
  );
  const batchDeleteRefs: DocumentReference[] = [];

  // 1. Avaliações Dating (subcoleção privada)
  const evalSnap = await getDocs(query(collection(db, 'datingProfiles', uid, 'evaluations'), limit(500)));
  evalSnap.forEach((d) => batchDeleteRefs.push(d.ref));

  // 2. Bloqueios em que a conta participa
  const [blocksOut, blocksIn] = await Promise.all([
    getDocs(query(collection(db, 'userBlocks'), where('blockerUid', '==', uid), limit(300))),
    getDocs(query(collection(db, 'userBlocks'), where('blockedUid', '==', uid), limit(300))),
  ]);
  blocksOut.forEach((d) => batchDeleteRefs.push(d.ref));
  blocksIn.forEach((d) => batchDeleteRefs.push(d.ref));

  // 3. Likes secretos enviados (nota: datingLikes allow list restringe fromUid == auth.uid)
  const likesOut = await getDocs(query(collection(db, 'datingLikes'), where('fromUid', '==', uid), limit(300)));
  likesOut.forEach((d) => batchDeleteRefs.push(d.ref));

  // 4. Matches Dating + eventual like recíproco conhecido via participantA/B
  const [matchesA, matchesB] = await Promise.all([
    getDocs(query(collection(db, 'datingMatches'), where('participantA', '==', uid), limit(300))),
    getDocs(query(collection(db, 'datingMatches'), where('participantB', '==', uid), limit(300))),
  ]);
  for (const d of [...matchesA.docs, ...matchesB.docs]) {
    const m = d.data() as { participantA?: string; participantB?: string; conversationId?: string };
    const peerUid = m.participantA === uid ? m.participantB : m.participantA;
    if (peerUid) {
      batchDeleteRefs.push(doc(db, 'datingLikes', `${peerUid}_${uid}`));
    }
    if (m.conversationId && m.conversationId.startsWith('conv_')) {
      deletedConversationIds.add(m.conversationId);
    }
    batchDeleteRefs.push(d.ref);
  }

  // 5. Convites bilaterais
  const [invOut, invIn] = await Promise.all([
    getDocs(query(collection(db, 'conversationInvites'), where('fromUid', '==', uid), limit(300))),
    getDocs(query(collection(db, 'conversationInvites'), where('toUid', '==', uid), limit(300))),
  ]);
  invOut.forEach((d) => batchDeleteRefs.push(d.ref));
  invIn.forEach((d) => batchDeleteRefs.push(d.ref));

  // 6. Conversas bilaterais + suas mensagens (preservando truman-maezinha intacta)
  const [convsA, convsB] = await Promise.all([
    getDocs(query(collection(db, 'conversations'), where('participantA', '==', uid), limit(200))),
    getDocs(query(collection(db, 'conversations'), where('participantB', '==', uid), limit(200))),
  ]);
  const convDocs = [...convsA.docs, ...convsB.docs];
  for (const convDoc of convDocs) {
    const cid = convDoc.id;
    if (!cid.startsWith('conv_') || cid === 'truman-maezinha') continue;
    deletedConversationIds.add(cid);

    let hasMoreMsgs = true;
    while (hasMoreMsgs) {
      const msgSnap = await getDocs(
        query(collection(db, 'conversations', cid, 'messages'), limit(350))
      );
      if (msgSnap.empty) {
        hasMoreMsgs = false;
      } else {
        await commitBatchDeletionsInChunks(
          db,
          msgSnap.docs.map((m) => m.ref)
        );
        if (msgSnap.size < 350) {
          hasMoreMsgs = false;
        }
      }
    }
    batchDeleteRefs.push(convDoc.ref);
  }

  // 6b. Links de convite gerados pela conta
  const refLinksSnap = await getDocs(
    query(collection(db, 'referralLinks'), where('referrerUid', '==', uid), limit(20))
  ).catch(() => null);
  if (refLinksSnap) {
    refLinksSnap.forEach((d) => batchDeleteRefs.push(d.ref));
  }

  // Executa todas as deleções de relacionamento e histórico antes da remoção final da raiz da conta
  await commitBatchDeletionsInChunks(db, batchDeleteRefs);

  // 7. Deleção final atômica de userRateLimits, datingProfiles, referralStats, referralAttributions, usernames, phoneLookup, userProfiles e users/{uid}
  const finalBatch = writeBatch(db);
  const optionalRefs: DocumentReference[] = [
    doc(db, 'userRateLimits', uid),
    doc(db, 'datingProfiles', uid),
    doc(db, 'referralStats', uid),
    doc(db, 'referralAttributions', uid),
    doc(db, 'growthTelemetry', uid),
    ...(usernameLower ? [doc(db, 'usernames', usernameLower)] : []),
    ...(phoneHash ? [doc(db, 'phoneLookup', phoneHash)] : []),
    ...(talk2tmId ? [doc(db, 'userProfiles', talk2tmId)] : []),
  ];
  const existenceSnaps = await Promise.all(
    optionalRefs.map((r) => getDoc(r).catch(() => null))
  );
  existenceSnaps.forEach((snap, idx) => {
    if (snap && snap.exists()) {
      finalBatch.delete(optionalRefs[idx]);
    }
  });
  if (userSnap.exists()) {
    finalBatch.delete(userRef);
  }
  await finalBatch.commit();

  // 7b. Remove eventual fotografia Dating no Firebase Storage (antes de apagar o utilizador no Auth)
  await deleteDatingPhotoFromStorage(uid);

  // 8. Elimina o registo no Firebase Auth
  await user.delete();
  syncAuthState(null);
  await signOut(auth).catch(() => {});

  // 9. Limpa cofre local e IndexedDB exclusivamente para esta conta
  const deletedList = Array.from(deletedConversationIds);
  removeAccountFromLocalVault(uid, deletedList);
  await clearAccountScopedIndexedDBData(deletedList);

  return { deletedConversationIds: deletedList };
}

