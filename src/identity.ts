/**
 * Talk2TM — Gerenciador de Identidade Zero Custos & Cofre Local Criptografado
 *
 * Responsabilidades:
 * 1. Identidade por telefone normalizado (E.164, padrão +244) + hash SHA-256 para busca exata sem expor número bruto.
 * 2. Geração interna silenciosa de Talk2TM ID (TM-XXXX-XXXX) como vínculo técnico bilateral (nunca exibido ao utilizador).
 * 3. Código de recuperação gratuito (~120 bits de entropia) mostrado uma única vez no cadastro e usado para derivar a senha Auth via PBKDF2-SHA256.
 * 4. Cofre local multi-conta encriptado com AES-256-GCM + PBKDF2(PIN) + hash rápido com sal para desbloqueio direto no teclado numérico da calculadora.
 * 5. Zero armazenamento em Base64/texto simples de PIN, código de recuperação ou credencial Auth.
 */

import { PhoneDirectoryEntry, UserProfile, UserAccount } from './types';
import {
  getFirebaseDB,
  getFirebaseAuth,
  initFirebase,
  syncAuthState,
  handleFirestoreError,
  OperationType,
} from './firebase/firestore';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  updatePassword,
  sendPasswordResetEmail,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  User,
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import {
  normalizePhoneNumber,
  maskPhoneNumber,
  hashPhoneNumber,
  phoneHashToInternalEmail,
} from './utils/phone';

const LOCAL_IDENTITY_V1_KEY = 'talk2tm_identity_v1';
const LOCAL_VAULT_V2_KEY = 'talk2tm_identities_v2';
const RESERVED_SYSTEM_PINS = new Set(['852456', '135790']);

export interface LocalIdentity {
  uid: string;
  talk2tmId: string;
  displayName: string;
  internalEmail: string;
  recoveryEmail?: string;
  pendingRecoveryEmail?: string;
  /** Usado apenas por legado/testes unitários de migração; contas Zero-Cost nunca gravam este campo no disco. */
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

export interface RegisterPhoneIdentityParams {
  displayName: string;
  phone: string;
  pin: string;
  recoveryCode?: string;
  recoveryEmail?: string;
}

export interface RegisterPhoneIdentityResult {
  identity: LocalIdentity;
  recoveryCode: string;
  e164Phone: string;
}

export interface RecoverPhoneIdentityParams {
  phone?: string;
  recoveryEmail?: string;
  recoveryCode: string;
  newPin: string;
}

function getWebCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error('Web Crypto API indisponível neste navegador.');
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
    throw new Error('Dados criptográficos corrompidos.');
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
 * Mantido para compatibilidade retroativa com diagnóstico e testes legados.
 */
export function generateInternalSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const array = getRandomBytes(16);
  return Array.from(array)
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Mantido para compatibilidade retroativa com fluxo legado TM-XXXX-XXXX.
 */
export function talk2tmIdToInternalEmail(talk2tmId: string): string {
  const clean = talk2tmId.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${clean}@talk2tm.internal`;
}

/**
 * Gera um código de recuperação de alta entropia (24 chars, ~120 bits) sem caracteres ambíguos.
 * Exibido uma única vez ao utilizador; nunca armazenado em texto simples ou Base64.
 */
export function generateRecoveryCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = getRandomBytes(24);
  const raw = Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
  return raw.match(/.{1,4}/g)!.join('-');
}

export function normalizeRecoveryCode(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const WEAK_RECOVERY_KEYS = new Set([
  '123456',
  '654321',
  '1234567',
  '12345678',
  '87654321',
  '123456789',
  '012345',
  '543210',
  'ABCDEF',
  'QWERTY',
  'SENHA1',
  'PASSWORD',
  'TALK2TM',
]);

/**
 * Valida uma chave pessoal de recuperação (mínimo 6 caracteres após normalização),
 * garantindo que não seja idêntica ao PIN da calculadora nem trivialmente previsível.
 */
export function validateRecoverySecret(
  rawSecret: string,
  pin?: string
): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeRecoveryCode(rawSecret);
  if (normalized.length < 6) {
    return {
      valid: false,
      normalized,
      error: 'A chave pessoal deve ter pelo menos 6 caracteres (letras ou números).',
    };
  }
  if (normalized.length > 40) {
    return {
      valid: false,
      normalized,
      error: 'A chave pessoal deve ter no máximo 40 caracteres.',
    };
  }
  if (pin && normalized === pin.trim().toUpperCase()) {
    return {
      valid: false,
      normalized,
      error: 'Por segurança, a chave pessoal não pode ser igual ao PIN da calculadora.',
    };
  }
  if (/^(.)\1+$/.test(normalized) || WEAK_RECOVERY_KEYS.has(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Escolha uma chave pessoal menos óbvia (evite sequências como 123456 ou caracteres repetidos).',
    };
  }
  return { valid: true, normalized };
}

/**
 * Valida o e-mail de recuperação opcional (nunca obrigatório).
 */
export function validateOptionalRecoveryEmail(
  raw?: string
): { valid: boolean; email?: string; error?: string } {
  const trimmed = (raw || '').trim().toLowerCase();
  if (!trimmed) {
    return { valid: true, email: undefined };
  }
  if (trimmed.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { valid: false, error: 'Informe um e-mail válido ou deixe o campo em branco.' };
  }
  if (trimmed.endsWith('@talk2tm.internal')) {
    return { valid: false, error: 'Use um endereço de e-mail pessoal válido.' };
  }
  return { valid: true, email: trimmed };
}

/**
 * Deriva deterministicamente a senha do Firebase Auth a partir da chave pessoal / código de recuperação + phoneHash.
 * Permite recuperar ou entrar na mesma conta (mesmo UID) em qualquer dispositivo sem SMS, e-mail ou Cloud Functions.
 */
export async function deriveAuthPassword(recoveryCode: string, phoneHash: string): Promise<string> {
  const normalizedCode = normalizeRecoveryCode(recoveryCode);
  if (normalizedCode.length < 6) {
    throw new Error('Chave de recuperação inválida (mínimo 6 caracteres).');
  }
  const webCrypto = getWebCrypto();
  const encoder = new TextEncoder();
  const baseKey = await webCrypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(normalizedCode)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await webCrypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(encoder.encode(`talk2tm:auth:v1:${phoneHash}`)),
      iterations: 100_000,
    },
    baseKey,
    256
  );
  return `T2M$${bytesToHex(new Uint8Array(bits))}`;
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
      throw new Error('PIN incorreto para esta conta.');
    }
  }
  if (identity.internalSecret) {
    return identity.internalSecret;
  }
  throw new Error('Credencial local indisponível. Use "Recuperar conta" com seu código.');
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
    if (typeof acc.pinLength === 'number' && acc.pinLength >= 4 && acc.pinLength <= 8) {
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
        displayName: identity.displayName,
        internalEmail: identity.internalEmail,
        ...(identity.recoveryEmail ? { recoveryEmail: identity.recoveryEmail } : {}),
        ...(identity.pendingRecoveryEmail ? { pendingRecoveryEmail: identity.pendingRecoveryEmail } : {}),
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
 * Valida o PIN numérico de 4 a 8 dígitos, bloqueando códigos reservados do sistema (852456 / 135790)
 * e colisões com outras contas salvas no mesmo dispositivo.
 */
export async function validateLocalPin(
  pin: string,
  checkCollisions: boolean = true,
  excludeUid?: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Promise<{ valid: boolean; error?: string }> {
  const clean = (pin || '').trim();
  if (!/^\d{4,8}$/.test(clean)) {
    return { valid: false, error: 'O PIN deve ter entre 4 e 8 dígitos numéricos.' };
  }
  if (RESERVED_SYSTEM_PINS.has(clean)) {
    return {
      valid: false,
      error: 'Este PIN é reservado pelo sistema. Escolha outro código de 4 a 8 dígitos.',
    };
  }
  if (checkCollisions) {
    const existing = await findLocalIdentityByPin(clean, storage);
    if (existing && existing.uid !== excludeUid) {
      return {
        valid: false,
        error: 'Este PIN já está em uso por outra conta neste aparelho. Escolha um PIN diferente.',
      };
    }
  }
  return { valid: true };
}

/**
 * Procura no cofre local uma conta cujo PIN numérico corresponda ao digitado na calculadora ou na tela DEG.
 */
export async function findLocalIdentityByPin(
  pin: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Promise<LocalIdentity | null> {
  const clean = (pin || '').trim();
  if (!/^\d{4,8}$/.test(clean)) return null;

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

/**
 * Cadastro Zero Custos (4 campos: Nome, Telefone, PIN, Confirmar PIN):
 * - Normaliza telefone E.164 (padrão +244) e calcula phoneHash SHA-256
 * - Impede duplicação de número no Auth + phoneLookup
 * - Gera recoveryCode (~120 bits) mostrado uma única vez ao utilizador
 * - Deriva senha Auth via PBKDF2-SHA256(recoveryCode, phoneHash)
 * - Cria users/{uid}, userProfiles/{talk2tmId} e phoneLookup/{phoneHash} com rollback em caso de falha
 * - Sela credencial localmente com AES-256-GCM + PIN
 */
export async function registerPhoneIdentity(
  params: RegisterPhoneIdentityParams
): Promise<RegisterPhoneIdentityResult> {
  const cleanName = (params.displayName || '').trim().slice(0, 30);
  if (!cleanName) {
    throw new Error('Informe seu nome ou apelido (até 30 caracteres).');
  }

  const phoneCheck = normalizePhoneNumber(params.phone);
  if (!phoneCheck.valid || !phoneCheck.e164) {
    throw new Error(phoneCheck.error || 'Número de telefone inválido.');
  }

  const pinCheck = await validateLocalPin(params.pin, true);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || 'PIN inválido.');
  }

  let recoveryCode: string;
  if (params.recoveryCode && params.recoveryCode.trim()) {
    const recCheck = validateRecoverySecret(params.recoveryCode, params.pin);
    if (!recCheck.valid) {
      throw new Error(recCheck.error || 'Chave de recuperação inválida.');
    }
    recoveryCode = params.recoveryCode.trim();
  } else {
    recoveryCode = generateRecoveryCode();
  }

  const emailCheck = validateOptionalRecoveryEmail(params.recoveryEmail);
  if (!emailCheck.valid) {
    throw new Error(emailCheck.error || 'E-mail de recuperação inválido.');
  }

  const e164Phone = phoneCheck.e164;
  const phoneHash = await hashPhoneNumber(e164Phone);
  const phoneMasked = maskPhoneNumber(e164Phone);
  const internalEmail = emailCheck.email || phoneHashToInternalEmail(phoneHash);
  const talk2tmId = generateTalk2TMId();
  const authPassword = await deriveAuthPassword(recoveryCode, phoneHash);

  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error('Serviço Firebase indisponível no momento. Verifique sua conexão.');
  }

  let user: User;
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, internalEmail, authPassword);
    user = userCredential.user;
  } catch (err: any) {
    if (err?.code === 'auth/email-already-in-use') {
      if (emailCheck.email) {
        throw new Error(
          'Este e-mail de recuperação já está associado a outra conta. Use outro e-mail ou entre em "Entrar / Recuperar Conta".'
        );
      }
      throw new Error('Este número de telefone já possui conta cadastrada. Use "Entrar / Recuperar Conta" se necessário.');
    }
    throw new Error(err?.message || 'Não foi possível criar a conta.');
  }

  syncAuthState(user);

  try {
    await updateProfile(user, { displayName: cleanName }).catch(() => {});
    await user.getIdToken(true).catch(() => {});

    // Verifica antes se phoneLookup já está ocupado por outra conta (evita escrita parcial)
    const existingPhoneSnap = await getDoc(doc(db, 'phoneLookup', phoneHash));
    if (existingPhoneSnap.exists() && existingPhoneSnap.data()?.uid !== user.uid) {
      throw new Error('Este número de telefone já está associado a outra conta.');
    }

    const now = new Date().toISOString();

    const userAccount: UserAccount = {
      uid: user.uid,
      talk2tmId,
      createdAt: now,
      phoneHash,
      phoneMasked,
    };
    await setDoc(doc(db, 'users', user.uid), userAccount);

    const userProfile: UserProfile = {
      talk2tmId,
      uid: user.uid,
      displayName: cleanName,
      active: true,
      createdAt: now,
    };
    await setDoc(doc(db, 'userProfiles', talk2tmId), userProfile);

    const directoryEntry: PhoneDirectoryEntry = {
      phoneHash,
      uid: user.uid,
      talk2tmId,
      displayName: cleanName,
      active: true,
      createdAt: now,
    };
    await setDoc(doc(db, 'phoneLookup', phoneHash), directoryEntry);

    const sealed = await sealAuthSecretWithPin(authPassword, params.pin.trim());
    const identity: LocalIdentity = {
      uid: user.uid,
      talk2tmId,
      displayName: cleanName,
      internalEmail,
      ...(emailCheck.email ? { recoveryEmail: emailCheck.email } : {}),
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

    return { identity, recoveryCode, e164Phone };
  } catch (err: any) {
    // Rollback rigoroso: apaga o usuário Auth recém-criado para não deixar número preso sem perfil no Firestore
    try {
      await user.delete();
    } catch {
      await signOut(auth).catch(() => {});
    }
    syncAuthState(auth.currentUser);
    if (err instanceof Error && err.message) {
      throw err;
    }
    throw new Error('Falha ao finalizar o cadastro no banco de dados.');
  }
}

/**
 * Recuperação / entrada noutro aparelho (100% gratuita):
 * - Via Telefone + Chave Pessoal (ou código gerado)
 * - Ou via E-mail de recuperação opcional (+ Telefone opcional), incluindo compatibilidade
 *   automática após redefinição de senha pelo link nativo do Firebase Auth.
 */
export async function recoverPhoneIdentity(
  params: RecoverPhoneIdentityParams
): Promise<LocalIdentity> {
  const rawPhone = (params.phone || '').trim();
  const emailCheck = validateOptionalRecoveryEmail(params.recoveryEmail);
  if (!emailCheck.valid) {
    throw new Error(emailCheck.error || 'E-mail de recuperação inválido.');
  }

  if (!rawPhone && !emailCheck.email) {
    throw new Error('Informe o número de telefone cadastrado (ou o e-mail de recuperação associado).');
  }

  let phoneHash: string | null = null;
  let phoneMasked: string | undefined;
  if (rawPhone) {
    const phoneCheck = normalizePhoneNumber(rawPhone);
    if (!phoneCheck.valid || !phoneCheck.e164) {
      throw new Error(phoneCheck.error || 'Número de telefone inválido.');
    }
    phoneHash = await hashPhoneNumber(phoneCheck.e164);
    phoneMasked = maskPhoneNumber(phoneCheck.e164);
  }

  const rawRecoverySecret = (params.recoveryCode || '').trim();
  const normalizedCode = normalizeRecoveryCode(rawRecoverySecret);
  if (normalizedCode.length < 6 && rawRecoverySecret.length < 6) {
    throw new Error('Informe sua chave pessoal (mínimo 6 caracteres) ou senha redefinida.');
  }

  const existingLocal = getAllLocalIdentities().find(
    (a) =>
      (phoneHash && a.phoneHash === phoneHash) ||
      (emailCheck.email && a.internalEmail.toLowerCase() === emailCheck.email)
  );
  const pinCheck = await validateLocalPin(params.newPin, true, existingLocal?.uid);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || 'Novo PIN inválido.');
  }

  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error('Serviço Firebase indisponível no momento.');
  }

  const loginEmail = emailCheck.email || phoneHashToInternalEmail(phoneHash!);
  const derivedPassword =
    phoneHash && normalizedCode.length >= 6
      ? await deriveAuthPassword(normalizedCode, phoneHash)
      : null;

  let user: User | null = null;
  let usedRawResetPassword = false;

  if (derivedPassword) {
    try {
      const cred = await signInWithEmailAndPassword(auth, loginEmail, derivedPassword);
      user = cred.user;
    } catch (err: any) {
      const isCredErr =
        err?.code === 'auth/invalid-credential' ||
        err?.code === 'auth/wrong-password' ||
        err?.code === 'auth/user-not-found';
      if (!isCredErr) {
        throw new Error(err?.message || 'Não foi possível autenticar a recuperação.');
      }
    }
  }

  // Fallback transparente: se o utilizador acabou de redefinir a senha no link nativo do Firebase Auth,
  // a senha no Auth está em texto simples; autenticamos com ela e convertemos imediatamente para PBKDF2.
  if (!user && emailCheck.email && rawRecoverySecret.length >= 6) {
    try {
      const cred = await signInWithEmailAndPassword(auth, emailCheck.email, rawRecoverySecret);
      user = cred.user;
      usedRawResetPassword = true;
    } catch (err: any) {
      const isCredErr =
        err?.code === 'auth/invalid-credential' ||
        err?.code === 'auth/wrong-password' ||
        err?.code === 'auth/user-not-found';
      if (!isCredErr) {
        throw new Error(err?.message || 'Não foi possível autenticar a recuperação.');
      }
    }
  }

  if (!user) {
    if (!rawPhone && emailCheck.email) {
      throw new Error(
        'Não foi possível entrar apenas com e-mail. Informe também o número de telefone cadastrado ou use [esqueci a chave — recuperar por e-mail].'
      );
    }
    if (rawPhone && !emailCheck.email) {
      throw new Error(
        'Telefone ou chave pessoal incorretos. Se associou um e-mail de recuperação à conta, informe-o também acima.'
      );
    }
    throw new Error('Telefone, e-mail ou chave pessoal de recuperação incorretos.');
  }

  syncAuthState(user);
  await user.getIdToken(true).catch(() => {});

  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (!userSnap.exists()) {
    throw new Error('Metadados da conta não encontrados.');
  }
  const accountData = userSnap.data() as UserAccount;
  const talk2tmId = accountData.talk2tmId;
  const resolvedPhoneHash = accountData.phoneHash || phoneHash || undefined;

  if (phoneHash && accountData.phoneHash && accountData.phoneHash !== phoneHash) {
    await signOut(auth).catch(() => {});
    syncAuthState(null);
    throw new Error('O telefone informado não corresponde a este e-mail de recuperação.');
  }

  // Se entrou usando a senha redefinida via link do Firebase, promove-a imediatamente para a chave derivada PBKDF2
  let finalAuthPassword = derivedPassword || rawRecoverySecret;
  if (usedRawResetPassword && resolvedPhoneHash && normalizedCode.length >= 6) {
    const upgradedPassword = await deriveAuthPassword(normalizedCode, resolvedPhoneHash);
    try {
      await updatePassword(user, upgradedPassword);
      finalAuthPassword = upgradedPassword;
    } catch (upgradeErr) {
      console.warn('Talk2TM: Não foi possível atualizar derivação PBKDF2 após reset:', upgradeErr);
    }
  }

  const profileSnap = await getDoc(doc(db, 'userProfiles', talk2tmId));
  const profileData = profileSnap.exists() ? (profileSnap.data() as UserProfile) : null;
  const displayName = profileData?.displayName || user.displayName || 'Utilizador';
  const effectiveAuthEmail = (user.email || loginEmail).toLowerCase();
  const recoveryEmail = effectiveAuthEmail.endsWith('@talk2tm.internal')
    ? undefined
    : effectiveAuthEmail;

  const sealed = await sealAuthSecretWithPin(finalAuthPassword, params.newPin.trim());
  const identity: LocalIdentity = {
    uid: user.uid,
    talk2tmId,
    displayName,
    internalEmail: effectiveAuthEmail,
    ...(recoveryEmail ? { recoveryEmail } : {}),
    phoneHash: resolvedPhoneHash,
    phoneMasked: accountData.phoneMasked || phoneMasked,
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
      try {
        const cred = await signInWithEmailAndPassword(auth, currentIdentity.internalEmail, secret);
        syncAuthState(cred.user);
      } catch (err: any) {
        const canRetryPending =
          Boolean(currentIdentity.pendingRecoveryEmail) &&
          (err?.code === 'auth/invalid-credential' ||
            err?.code === 'auth/user-not-found' ||
            err?.code === 'auth/wrong-password');
        if (!canRetryPending) {
          throw err;
        }
        const cred = await signInWithEmailAndPassword(
          auth,
          currentIdentity.pendingRecoveryEmail!,
          secret
        );
        syncAuthState(cred.user);
        currentIdentity = {
          ...currentIdentity,
          internalEmail: currentIdentity.pendingRecoveryEmail!,
          recoveryEmail: currentIdentity.pendingRecoveryEmail!,
          pendingRecoveryEmail: undefined,
        };
        upsertLocalIdentity(currentIdentity, true);
      }
    }
  } else {
    syncAuthState(auth.currentUser);
  }

  // Sincroniza eventual alteração de e-mail confirmada fora desta sessão (verifyBeforeUpdateEmail)
  if (auth.currentUser && auth.currentUser.uid === currentIdentity.uid && auth.currentUser.email) {
    const activeEmail = auth.currentUser.email.toLowerCase();
    if (activeEmail !== currentIdentity.internalEmail.toLowerCase()) {
      currentIdentity = {
        ...currentIdentity,
        internalEmail: activeEmail,
        recoveryEmail: activeEmail.endsWith('@talk2tm.internal') ? undefined : activeEmail,
        pendingRecoveryEmail: undefined,
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
        if (profile.displayName && profile.displayName !== currentIdentity.displayName) {
          latestDisplayName = profile.displayName;
          currentIdentity = { ...currentIdentity, displayName: latestDisplayName };
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
 * Gera um novo código de recuperação para uma conta já autenticada/presente no aparelho,
 * atualizando a senha no Firebase Auth e re-selando o cofre local sem custos.
 */
export async function regenerateRecoveryCodeWithPin(
  uid: string,
  currentPin: string,
  customRecoveryCode?: string
): Promise<{ recoveryCode: string }> {
  const identity = getAllLocalIdentities().find((a) => a.uid === uid);
  if (!identity || !identity.phoneHash) {
    throw new Error('Esta conta não suporta alteração de chave de recuperação.');
  }

  const oldAuthPassword = await unsealAuthSecretWithPin(identity, currentPin.trim());
  let newRecoveryCode: string;
  if (customRecoveryCode && customRecoveryCode.trim()) {
    const check = validateRecoverySecret(customRecoveryCode, currentPin);
    if (!check.valid) {
      throw new Error(check.error || 'Chave pessoal inválida.');
    }
    newRecoveryCode = customRecoveryCode.trim();
  } else {
    newRecoveryCode = generateRecoveryCode();
  }
  const newAuthPassword = await deriveAuthPassword(newRecoveryCode, identity.phoneHash);

  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Serviço Firebase Auth indisponível.');
  }

  let user = auth.currentUser;
  if (!user || user.uid !== uid) {
    const cred = await signInWithEmailAndPassword(auth, identity.internalEmail, oldAuthPassword);
    user = cred.user;
    syncAuthState(user);
  } else {
    const emailCred = EmailAuthProvider.credential(identity.internalEmail, oldAuthPassword);
    await reauthenticateWithCredential(user, emailCred);
  }

  await updatePassword(user, newAuthPassword);

  const sealed = await sealAuthSecretWithPin(newAuthPassword, currentPin.trim(), identity.pinSalt);
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

  return { recoveryCode: newRecoveryCode };
}

/**
 * Altera o PIN numérico local deste aparelho (sem custo de rede).
 */
export async function updateLocalPinForAccount(
  uid: string,
  currentPin: string,
  newPin: string
): Promise<void> {
  const identity = getAllLocalIdentities().find((a) => a.uid === uid);
  if (!identity) {
    throw new Error('Conta local não encontrada.');
  }

  const authPassword = await unsealAuthSecretWithPin(identity, currentPin.trim());
  const pinCheck = await validateLocalPin(newPin, true, uid);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || 'Novo PIN inválido.');
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
 * Associa ou atualiza o e-mail de recuperação opcional na conta usando apenas o fluxo nativo
 * gratuito do Firebase Auth (verifyBeforeUpdateEmail).
 */
export async function associateRecoveryEmailWithPin(
  uid: string,
  currentPin: string,
  rawEmail: string
): Promise<{ status: 'already_active' | 'verification_sent'; email: string }> {
  const emailCheck = validateOptionalRecoveryEmail(rawEmail);
  if (!emailCheck.valid || !emailCheck.email) {
    throw new Error(emailCheck.error || 'Informe um endereço de e-mail válido.');
  }

  const cleanEmail = emailCheck.email;
  const identity = getAllLocalIdentities().find((a) => a.uid === uid);
  if (!identity) {
    throw new Error('Conta local não encontrada.');
  }

  const authPassword = await unsealAuthSecretWithPin(identity, currentPin.trim());

  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Serviço Firebase Auth indisponível.');
  }

  let user = auth.currentUser;
  if (!user || user.uid !== uid) {
    const cred = await signInWithEmailAndPassword(auth, identity.internalEmail, authPassword);
    user = cred.user;
    syncAuthState(user);
  } else {
    const activeAuthEmail = (user.email || identity.internalEmail).toLowerCase();
    const emailCred = EmailAuthProvider.credential(activeAuthEmail, authPassword);
    await reauthenticateWithCredential(user, emailCred);
  }

  if (user.email && user.email.toLowerCase() === cleanEmail) {
    upsertLocalIdentity(
      {
        ...identity,
        internalEmail: cleanEmail,
        recoveryEmail: cleanEmail,
        pendingRecoveryEmail: undefined,
      },
      true
    );
    return { status: 'already_active', email: cleanEmail };
  }

  const continueUrl =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://talk2tm.web.app';

  try {
    await verifyBeforeUpdateEmail(user, cleanEmail, { url: continueUrl });
  } catch (err: any) {
    if (err?.code === 'auth/email-already-in-use') {
      throw new Error('Este e-mail já está associado a outra conta.');
    }
    if (err?.code === 'auth/invalid-email') {
      throw new Error('Endereço de e-mail inválido.');
    }
    if (err?.code === 'auth/too-many-requests') {
      throw new Error('Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.');
    }
    throw new Error(err?.message || 'Não foi possível enviar o e-mail de confirmação.');
  }

  upsertLocalIdentity(
    {
      ...identity,
      pendingRecoveryEmail: cleanEmail,
    },
    true
  );

  return { status: 'verification_sent', email: cleanEmail };
}

/**
 * Envia o link gratuito nativo do Firebase Auth para redefinição de senha/chave pessoal.
 */
export async function sendPasswordResetForRecoveryEmail(rawEmail: string): Promise<{ email: string }> {
  const emailCheck = validateOptionalRecoveryEmail(rawEmail);
  if (!emailCheck.valid || !emailCheck.email) {
    throw new Error(emailCheck.error || 'Informe o e-mail de recuperação associado à conta.');
  }

  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Serviço Firebase Auth indisponível no momento.');
  }

  const continueUrl =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://talk2tm.web.app';

  try {
    await sendPasswordResetEmail(auth, emailCheck.email, { url: continueUrl });
    return { email: emailCheck.email };
  } catch (err: any) {
    if (err?.code === 'auth/invalid-email') {
      throw new Error('Endereço de e-mail inválido.');
    }
    if (err?.code === 'auth/too-many-requests') {
      throw new Error('Muitos pedidos em sequência. Aguarde alguns minutos antes de tentar novamente.');
    }
    throw new Error(err?.message || 'Não foi possível enviar o link de redefinição.');
  }
}

/**
 * Valida o código oobCode de redefinição quando aberto diretamente na aplicação.
 */
export async function verifyInAppPasswordResetCode(oobCode: string): Promise<string> {
  await initFirebase();
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Serviço Firebase Auth indisponível.');
  }
  try {
    return await verifyPasswordResetCode(auth, oobCode);
  } catch {
    throw new Error('O link de redefinição expirou ou já foi utilizado. Peça um novo link.');
  }
}

/**
 * Conclui a redefinição nativa (oobCode -> nova Chave Pessoal derivada PBKDF2 -> PIN local).
 */
export async function completePasswordResetInApp(params: {
  oobCode: string;
  recoveryCode: string;
  newPin: string;
}): Promise<LocalIdentity> {
  const recCheck = validateRecoverySecret(params.recoveryCode, params.newPin);
  if (!recCheck.valid) {
    throw new Error(recCheck.error || 'Nova chave pessoal inválida.');
  }

  const pinCheck = await validateLocalPin(params.newPin, true);
  if (!pinCheck.valid) {
    throw new Error(pinCheck.error || 'PIN inválido.');
  }

  await initFirebase();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();
  if (!auth || !db) {
    throw new Error('Serviço Firebase indisponível.');
  }

  const rawSecret = params.recoveryCode.trim();
  const email = await verifyInAppPasswordResetCode(params.oobCode);
  await confirmPasswordReset(auth, params.oobCode, rawSecret);

  const cred = await signInWithEmailAndPassword(auth, email, rawSecret);
  const user = cred.user;
  syncAuthState(user);
  await user.getIdToken(true).catch(() => {});

  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (!userSnap.exists()) {
    throw new Error('Metadados da conta não encontrados.');
  }
  const accountData = userSnap.data() as UserAccount;
  const talk2tmId = accountData.talk2tmId;

  let finalAuthPassword = rawSecret;
  if (accountData.phoneHash) {
    finalAuthPassword = await deriveAuthPassword(recCheck.normalized, accountData.phoneHash);
    await updatePassword(user, finalAuthPassword).catch(() => {});
  }

  const profileSnap = await getDoc(doc(db, 'userProfiles', talk2tmId));
  const profileData = profileSnap.exists() ? (profileSnap.data() as UserProfile) : null;
  const displayName = profileData?.displayName || user.displayName || 'Utilizador';
  const cleanEmail = email.toLowerCase();

  const sealed = await sealAuthSecretWithPin(finalAuthPassword, params.newPin.trim());
  const identity: LocalIdentity = {
    uid: user.uid,
    talk2tmId,
    displayName,
    internalEmail: cleanEmail,
    ...(cleanEmail.endsWith('@talk2tm.internal') ? {} : { recoveryEmail: cleanEmail }),
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
 * Compatibilidade retroativa (diagnóstico / fluxos sem telefone).
 */
export async function createTalk2TMIdentity(displayName: string): Promise<LocalIdentity> {
  const cleanName = displayName.trim().slice(0, 30);
  if (!cleanName) {
    throw new Error('Nome de exibição é obrigatório.');
  }

  await initFirebase();
  const talk2tmId = generateTalk2TMId();
  const internalEmail = talk2tmIdToInternalEmail(talk2tmId);
  const internalSecret = generateInternalSecret();
  const auth = getFirebaseAuth();
  const db = getFirebaseDB();

  if (!auth || !db) {
    throw new Error('Serviço Firebase não inicializado.');
  }

  const userCredential = await createUserWithEmailAndPassword(auth, internalEmail, internalSecret);
  const user = userCredential.user;
  syncAuthState(user);

  try {
    await updateProfile(user, { displayName: cleanName });
  } catch {
    // Não bloqueia caso falhe
  }

  try {
    await user.getIdToken(true);
  } catch {
    // Segue mesmo se refresh falhar em ambiente emulado
  }

  const now = new Date().toISOString();

  const userAccount: UserAccount = {
    uid: user.uid,
    talk2tmId,
    createdAt: now,
  };
  try {
    await setDoc(doc(db, 'users', user.uid), userAccount);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}`);
  }

  const userProfile: UserProfile = {
    talk2tmId,
    uid: user.uid,
    displayName: cleanName,
    active: true,
    createdAt: now,
  };
  try {
    await setDoc(doc(db, 'userProfiles', talk2tmId), userProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `userProfiles/${talk2tmId}`);
  }

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
    if (auth.currentUser.email && auth.currentUser.email.toLowerCase() !== identity.internalEmail.toLowerCase()) {
      const activeEmail = auth.currentUser.email.toLowerCase();
      const updated: LocalIdentity = {
        ...identity,
        internalEmail: activeEmail,
        recoveryEmail: activeEmail.endsWith('@talk2tm.internal') ? undefined : activeEmail,
        pendingRecoveryEmail: undefined,
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
    throw new Error(phoneCheck.error || 'Número de telefone inválido.');
  }

  const { db, configured } = await initFirebase();
  if (!configured || !db) return null;

  const phoneHash = await hashPhoneNumber(phoneCheck.e164);
  const snap = await getDoc(doc(db, 'phoneLookup', phoneHash));
  if (!snap.exists()) return null;

  return snap.data() as PhoneDirectoryEntry;
}
