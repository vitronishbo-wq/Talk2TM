/**
 * Talk2TM — Fase 5: Notificações Web Push Discretas
 *
 * Princípios de privacidade e custo zero:
 * - Zero exposição de dados sensíveis no ecrã bloqueado (nunca inclui nome, telefone, TM-ID ou prévia de texto).
 * - Textos estritamente genéricos via i18n: "Nova atividade na conta" ou "Novo Match".
 * - Disparo via ServiceWorkerRegistration.showNotification() (ou Notification fallback), sem servidor pago.
 * - Controlado por preferências locais por dispositivo e proteção anti-spam/deduplicação.
 */

import type { AppSettings } from './config';
import { normalizeNotificationSettings } from './config';
import { t } from './i18n';
import type { DiscreetNotificationKind } from './types';

export type WebNotificationPermissionState = NotificationPermission | 'unsupported';

export interface DiscreetNotificationPayload {
  title: 'Talk2TM';
  body: string;
  tag: 'talk2tm-activity' | 'talk2tm-match';
  icon: '/icon-talk2tm.svg';
  badge: '/icon-talk2tm.svg';
  renotify: false;
  silent: false;
  data: { url: '/'; kind: DiscreetNotificationKind };
}

const NOTIF_COOLDOWN_MS = 12_000;
const NOTIF_STORAGE_PREFIX = 'talk2tm_notif_last_';
const dispatchedEventKeys = new Set<string>();
const lastKindSentAtMs: Record<DiscreetNotificationKind, number> = {
  message: 0,
  match: 0,
};

export function canUseWebNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getWebNotificationPermission(): WebNotificationPermissionState {
  if (!canUseWebNotifications()) return 'unsupported';
  return Notification.permission;
}

export async function requestWebNotificationPermission(): Promise<WebNotificationPermissionState> {
  if (!canUseWebNotifications()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return getWebNotificationPermission();
  }
}

export function buildDiscreetNotificationPayload(
  kind: DiscreetNotificationKind,
  customBodies?: { messageBody?: string; matchBody?: string }
): DiscreetNotificationPayload {
  const isMatch = kind === 'match';
  const body = isMatch
    ? (customBodies?.matchBody || t('notifications.discreetMatchBody')).trim() || 'Novo Match'
    : (customBodies?.messageBody || t('notifications.discreetMessageBody')).trim() || 'Nova atividade na conta';

  return {
    title: 'Talk2TM',
    body,
    tag: isMatch ? 'talk2tm-match' : 'talk2tm-activity',
    icon: '/icon-talk2tm.svg',
    badge: '/icon-talk2tm.svg',
    renotify: false,
    silent: false,
    data: { url: '/', kind },
  };
}

export function isNotificationKindEnabled(
  settings: Partial<AppSettings> | null | undefined,
  kind: DiscreetNotificationKind
): boolean {
  const prefs = normalizeNotificationSettings(settings);
  if (!prefs.pushEnabled) return false;
  return kind === 'match' ? prefs.pushMatchEnabled : prefs.pushMessageEnabled;
}

export function shouldNotifyDiscreetly(params: {
  kind: DiscreetNotificationKind;
  settings: Partial<AppSettings> | null | undefined;
  permission: WebNotificationPermissionState;
  eventKey?: string;
  nowMs?: number;
  cooldownMs?: number;
  isAppForegroundContext?: boolean;
}): boolean {
  if (params.permission !== 'granted') return false;
  if (!isNotificationKindEnabled(params.settings, params.kind)) return false;
  if (params.isAppForegroundContext) return false;

  const eventKey = (params.eventKey || '').trim();
  if (eventKey && dispatchedEventKeys.has(`${params.kind}:${eventKey}`)) {
    return false;
  }

  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const cooldownMs = typeof params.cooldownMs === 'number' ? params.cooldownMs : NOTIF_COOLDOWN_MS;
  const lastMem = lastKindSentAtMs[params.kind] || 0;
  if (lastMem > 0 && nowMs - lastMem < cooldownMs) {
    return false;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      if (eventKey && localStorage.getItem(`${NOTIF_STORAGE_PREFIX}key_${params.kind}`) === eventKey) {
        return false;
      }
      const rawLast = localStorage.getItem(`${NOTIF_STORAGE_PREFIX}${params.kind}`);
      const storedMs = rawLast ? Number(rawLast) : 0;
      if (storedMs > 0 && nowMs - storedMs < cooldownMs) {
        return false;
      }
    }
  } catch {
    // Ignora falha de leitura de localStorage em contexto restrito
  }

  return true;
}

export function markDiscreetNotificationSent(
  kind: DiscreetNotificationKind,
  eventKey?: string,
  nowMs: number = Date.now()
): void {
  const cleanKey = (eventKey || '').trim();
  if (cleanKey) {
    dispatchedEventKeys.add(`${kind}:${cleanKey}`);
  }
  lastKindSentAtMs[kind] = nowMs;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${NOTIF_STORAGE_PREFIX}${kind}`, String(nowMs));
      if (cleanKey) {
        localStorage.setItem(`${NOTIF_STORAGE_PREFIX}key_${kind}`, cleanKey);
      }
    }
  } catch {
    // Ignora falha de escrita local
  }
}

export function clearNotificationMemoryStateForTests(): void {
  dispatchedEventKeys.clear();
  lastKindSentAtMs.message = 0;
  lastKindSentAtMs.match = 0;
}

export async function dispatchDiscreetNotification(params: {
  kind: DiscreetNotificationKind;
  settings: Partial<AppSettings> | null | undefined;
  eventKey?: string;
  isAppForegroundContext?: boolean;
}): Promise<boolean> {
  const permission = getWebNotificationPermission();
  const allowed = shouldNotifyDiscreetly({
    kind: params.kind,
    settings: params.settings,
    permission,
    eventKey: params.eventKey,
    isAppForegroundContext: params.isAppForegroundContext,
  });

  if (!allowed) return false;

  const payload = buildDiscreetNotificationPayload(params.kind);

  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          icon: payload.icon,
          badge: payload.badge,
          data: payload.data,
          silent: payload.silent,
        });
        markDiscreetNotificationSent(params.kind, params.eventKey);
        return true;
      }
    }

    if (canUseWebNotifications()) {
      const notif = new Notification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        icon: payload.icon,
        silent: payload.silent,
      });
      notif.onclick = () => {
        try {
          window.focus();
          notif.close();
        } catch {
          // ignora
        }
      };
      markDiscreetNotificationSent(params.kind, params.eventKey);
      return true;
    }
  } catch (err) {
    console.debug('Talk2TM [Notif]: Falha discreta ao exibir alerta local:', err);
  }

  return false;
}
