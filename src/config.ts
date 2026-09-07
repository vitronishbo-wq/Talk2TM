import { ChatConfig } from './types';

/**
 * Talk2TM — Configurações e Credenciais
 * Truman: senha 852456
 * Mãezinha: senha 135790
 */
export const CONFIG: ChatConfig = {
  ROOM_MAX_LENGTH: 32,
  NAME_MAX_LENGTH: 30,
  MESSAGE_MAX_LENGTH: 2000,
  HISTORY_LIMIT: 50,
  MAX_PARTICIPANTS: 2,
};

export const ALLOWED_USERS = ['Truman', 'Mãezinha'] as const;
export type AllowedUser = (typeof ALLOWED_USERS)[number];

export const ACCESS_CONFIG = {
  DEFAULT_ROOM: 'truman-maezinha',
  USERS: ALLOWED_USERS,
  CREDENTIALS: {
    '852456': 'Truman',
    '135790': 'Mãezinha',
  } as Record<string, AllowedUser>,
};

/**
 * Credenciais pré-provisionadas para autenticação silenciosa no Firebase Auth
 * Mapeadas de forma opaca aos PINs de entrada.
 */
export const USER_AUTH_CREDENTIALS: Record<AllowedUser, { email: string; pass: string; fallbackUid: string }> = {
  Truman: {
    email: 'truman@talk2tm.internal',
    pass: 'Truman#852456!Sec',
    fallbackUid: 'uid_truman_852456',
  },
  Mãezinha: {
    email: 'maezinha@talk2tm.internal',
    pass: 'Maezinha#135790!Sec',
    fallbackUid: 'uid_maezinha_135790',
  },
};

export function getCredentialsByUser(user: AllowedUser) {
  return USER_AUTH_CREDENTIALS[user];
}

export function getUserByPin(pin: string): AllowedUser | null {
  const cleanPin = pin.trim();
  if (cleanPin in ACCESS_CONFIG.CREDENTIALS) {
    return ACCESS_CONFIG.CREDENTIALS[cleanPin];
  }
  return null;
}

export interface AppSettings {
  sessionTimeoutMinutes: number; // 0 = desativado, ou 1, 5, 15, 30, 60
  inactivityLockSeconds: number; // 0 = desativado, 5 = 5 segundos sem teclar, 10, 30, etc.
}

export const DEFAULT_SETTINGS: AppSettings = {
  sessionTimeoutMinutes: 15,
  inactivityLockSeconds: 5, // Padrão conforme solicitado pelo usuário (5 segundos sem teclar bloqueia)
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('ttm_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        sessionTimeoutMinutes: typeof parsed.sessionTimeoutMinutes === 'number' ? parsed.sessionTimeoutMinutes : DEFAULT_SETTINGS.sessionTimeoutMinutes,
        inactivityLockSeconds: typeof parsed.inactivityLockSeconds === 'number' ? parsed.inactivityLockSeconds : DEFAULT_SETTINGS.inactivityLockSeconds,
      };
    }
  } catch (err) {
    console.warn('Erro ao carregar configurações locais:', err);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem('ttm_settings', JSON.stringify(settings));
  } catch (err) {
    console.warn('Erro ao salvar configurações locais:', err);
  }
}
