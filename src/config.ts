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
