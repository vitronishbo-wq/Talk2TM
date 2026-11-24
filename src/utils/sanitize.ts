import { CONFIG } from '../config';
import { getCurrentLocale, LOCALE_REGISTRY, t, type SupportedLocale } from '../i18n';

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
    return { valid: false, text: '', error: t('chat.msgEmpty') };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, text: '', error: t('chat.msgWhitespace') };
  }
  if (trimmed.length > CONFIG.MESSAGE_MAX_LENGTH) {
    return {
      valid: false,
      text: '',
      error: t('chat.msgTooLong', { max: CONFIG.MESSAGE_MAX_LENGTH, current: trimmed.length }),
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

function capitalizeWord(value: string): string {
  const clean = value.trim().replace(/\.$/, '');
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function formatDateNumeric(d: Date, locale: SupportedLocale): string {
  const tag = LOCALE_REGISTRY[locale].intlTag;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      return new Intl.DateTimeFormat(tag, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(d);
    }
  } catch {
    // Fallback nativo abaixo
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Formata hora para visualização linear mínima usando Intl.DateTimeFormat com fallback nativo.
 */
export function formatTime(isoString: string, localeOverride?: SupportedLocale): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '--:--';
    const targetLocale = localeOverride ?? getCurrentLocale();
    const tag = LOCALE_REGISTRY[targetLocale].intlTag;

    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      try {
        return new Intl.DateTimeFormat(tag, {
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(d);
      } catch {
        // Fallback nativo abaixo
      }
    }

    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '--:--';
  }
}

/**
 * Retorna chave de data local (YYYY-MM-DD) para agrupar mensagens por dia
 */
export function getLocalDateKey(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return '';
  }
}

function formatRelativeDayLabel(offset: 0 | -1, locale: SupportedLocale): string {
  const tag = LOCALE_REGISTRY[locale].intlTag;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function') {
      const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
      const formatted = capitalizeWord(rtf.format(offset, 'day'));
      if (formatted && !/\d/.test(formatted)) {
        return formatted;
      }
    }
  } catch {
    // Fallback nativo abaixo
  }
  return offset === 0 ? t('date.today', undefined, locale) : t('date.yesterday', undefined, locale);
}

function formatShortWeekday(d: Date, locale: SupportedLocale): string {
  const tag = LOCALE_REGISTRY[locale].intlTag;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      const weekday = capitalizeWord(
        new Intl.DateTimeFormat(tag, { weekday: 'short' }).format(d)
      );
      if (weekday) return weekday;
    }
  } catch {
    // Fallback nativo abaixo
  }
  const list = t('date.weekdays', undefined, locale).split(',');
  return list[d.getDay()] ?? '';
}

/**
 * Formata rótulo discreto para separador de dia usando Intl.RelativeTimeFormat e Intl.DateTimeFormat
 * com fallback nativo (ex.: "Hoje · 15/11/2026", "Today · 11/15/2026", "Hier · 14/11/2026").
 */
export function formatDateSeparatorLabel(
  isoString: string,
  referenceNow: Date = new Date(),
  localeOverride?: SupportedLocale
): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';

    const targetLocale = localeOverride ?? getCurrentLocale();
    const dateStr = formatDateNumeric(d, targetLocale);

    const targetKey = getLocalDateKey(isoString);
    const todayKey = getLocalDateKey(referenceNow.toISOString());

    const yesterday = new Date(
      referenceNow.getFullYear(),
      referenceNow.getMonth(),
      referenceNow.getDate() - 1
    );
    const yesterdayKey = getLocalDateKey(yesterday.toISOString());

    if (targetKey === todayKey) {
      return `${formatRelativeDayLabel(0, targetLocale)} · ${dateStr}`;
    }
    if (targetKey === yesterdayKey) {
      return `${formatRelativeDayLabel(-1, targetLocale)} · ${dateStr}`;
    }
    const weekday = formatShortWeekday(d, targetLocale);
    return `${weekday} · ${dateStr}`;
  } catch {
    return '';
  }
}

/**
 * Formata data e hora completas no fuso local e idioma ativo (ex: "13/11/2026 08:43")
 */
export function formatFullDateTime(isoString: string, localeOverride?: SupportedLocale): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const targetLocale = localeOverride ?? getCurrentLocale();
    return `${formatDateNumeric(d, targetLocale)} ${formatTime(isoString, targetLocale)}`;
  } catch {
    return '';
  }
}
