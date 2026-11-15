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
export const USER_AUTH_CREDENTIALS: Record<AllowedUser, { email: string; pass: string; pinPass: string; fallbackUid: string }> = {
  Truman: {
    email: 'truman@talk2tm.internal',
    pass: 'Truman#852456!Sec',
    pinPass: '852456',
    fallbackUid: 'uid_truman_852456',
  },
  Mãezinha: {
    email: 'maezinha@talk2tm.internal',
    pass: 'Maezinha#135790!Sec',
    pinPass: '135790',
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
  inactivityLockSeconds: number; // 0 = desativado, 60 = 1 min, 300 = 5 min (padrão), etc.
  version?: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sessionTimeoutMinutes: 5, // Padrão pré-definido de 5 minutos
  inactivityLockSeconds: 300, // Padrão pré-definido de 5 minutos (300 segundos sem teclar bloqueia)
  version: 2,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('ttm_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migração automática transparente apenas para versões legadas (< 2):
      // Garante que instalações antigas com 5s legado migrem para o padrão seguro de 5 minutos (300s),
      // mas preserva qualquer escolha explícita em segundos ou minutos feita após a v2.
      if (!parsed.version || parsed.version < 2) {
        const migrated: AppSettings = {
          sessionTimeoutMinutes: typeof parsed.sessionTimeoutMinutes === 'number' && parsed.sessionTimeoutMinutes > 0 ? parsed.sessionTimeoutMinutes : DEFAULT_SETTINGS.sessionTimeoutMinutes,
          inactivityLockSeconds: DEFAULT_SETTINGS.inactivityLockSeconds,
          version: 2,
        };
        saveSettings(migrated);
        return migrated;
      }

      return {
        sessionTimeoutMinutes: typeof parsed.sessionTimeoutMinutes === 'number' ? parsed.sessionTimeoutMinutes : DEFAULT_SETTINGS.sessionTimeoutMinutes,
        inactivityLockSeconds: typeof parsed.inactivityLockSeconds === 'number' ? parsed.inactivityLockSeconds : DEFAULT_SETTINGS.inactivityLockSeconds,
        version: 2,
      };
    }
  } catch (err) {
    console.warn('Erro ao carregar configurações locais:', err);
  }
  const initial = { ...DEFAULT_SETTINGS };
  saveSettings(initial);
  return initial;
}

export function saveSettings(settings: AppSettings): void {
  try {
    const payload: AppSettings = {
      ...settings,
      version: settings.version ?? DEFAULT_SETTINGS.version,
    };
    localStorage.setItem('ttm_settings', JSON.stringify(payload));
  } catch (err) {
    console.warn('Erro ao salvar configurações locais:', err);
  }
}
