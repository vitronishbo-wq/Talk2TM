import { CONFIG } from '../config';

/**
 * Sanitiza e normaliza o nome da sala (Camada 03.1)
 * Regra: string min 1 max 32, alfanumérico, hífen e sublinhado.
 */
export function sanitizeRoom(raw: string): string {
  if (!raw) return '';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, CONFIG.ROOM_MAX_LENGTH);
  return normalized;
}

/**
 * Sanitiza e normaliza o nome do usuário (Camada 03.2)
 * Regra: string min 1 max 30, sem caracteres de controle.
 */
export function sanitizeName(raw: string): string {
  if (!raw) return '';
  const clean = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, CONFIG.NAME_MAX_LENGTH);
  return clean;
}

/**
 * Sanitiza e valida o texto da mensagem (Camada 03.3)
 * Regra: texto min 1 max 2000, rejeita vazio.
 */
export function sanitizeMessageText(raw: string): { valid: boolean; text: string; error?: string } {
  if (!raw) {
    return { valid: false, text: '', error: 'Mensagem vazia' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, text: '', error: 'Mensagem não pode conter apenas espaços' };
  }
  if (trimmed.length > CONFIG.MESSAGE_MAX_LENGTH) {
    return {
      valid: false,
      text: '',
      error: `Mensagem excede limite de ${CONFIG.MESSAGE_MAX_LENGTH} caracteres (atual: ${trimmed.length})`,
    };
  }
  // Remove caracteres nulos indesejados mas preserva quebras de linha e caracteres válidos
  const safeText = trimmed.replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return { valid: true, text: safeText };
}

/**
 * Gera identificador único para cliente / idempotência (Camada 09)
 */
export function generateId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${randomPart}`;
}

/**
 * Formata hora para visualização linear mínima
 */
export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '--:--';
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '--:--';
  }
}
