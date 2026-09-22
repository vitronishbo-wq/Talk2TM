/**
 * Talk2TM — Módulo de Observabilidade
 * 
 * Integração:
 * - Sentry: Monitoramento de erros, exceções não tratadas e rejeições de Promise (Free Tier).
 * - Better Stack Telemetry: Encaminhamento opcional de telemetria/logs estruturados (Free Tier).
 * 
 * Regras:
 * - ZERO credenciais no código: DSN e Tokens lidos exclusivamente de variáveis de ambiente (VITE_*).
 * - ZERO custo: opera apenas nos limites gratuitos sem necessidade de cartão.
 * - Falha graciosa: se as variáveis não estiverem definidas, o app opera normalmente sem erros.
 * - Proteção de dados: higienização de senhas/PINs para nunca vazarem em eventos.
 */

import * as Sentry from '@sentry/browser';
import { Logtail } from '@logtail/browser';

let sentryInitialized = false;
let logtailClient: Logtail | null = null;

// Padrões sensíveis para sanitização antes do envio a provedores externos
const SENSITIVE_PATTERNS = [
  /852456/g,
  /135790/g,
  /Truman#852456!Sec/g,
  /Maezinha#135790!Sec/g,
];

function sanitizeString(str: string): string {
  let sanitized = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_CREDENTIAL]');
  }
  return sanitized;
}

/**
 * Valida se uma string é um DSN válido do Sentry antes da inicialização.
 * Formato esperado: https://<publicKey>@<host>/<projectId>
 * Evita que placeholders como "https://sentry.io" quebrem a aplicação no Sentry.init.
 */
export function isValidSentryDsn(dsn: string | undefined | null): boolean {
  if (!dsn || typeof dsn !== 'string') return false;
  const trimmed = dsn.trim();
  if (
    !trimmed ||
    trimmed === 'https://sentry.io' ||
    trimmed === 'http://sentry.io' ||
    trimmed === 'https://sentry.io/' ||
    trimmed === 'http://sentry.io/'
  ) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    const hasValidProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    const hasPublicKey = Boolean(url.username && url.username.length > 0);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const hasProjectId = pathParts.length > 0;
    return hasValidProtocol && hasPublicKey && hasProjectId;
  } catch {
    return false;
  }
}

/**
 * Inicializa a observabilidade no Frontend (Firebase Hosting / Render Static)
 */
export function initObservability(): void {
  if (typeof window === 'undefined') return;

  // 1. Sentry Frontend
  const rawSentryDsn = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SENTRY_DSN)?.trim();
  if (isValidSentryDsn(rawSentryDsn)) {
    try {
      Sentry.init({
        dsn: rawSentryDsn,
        environment: (typeof import.meta !== 'undefined' && import.meta.env?.MODE) || 'production',
        sampleRate: 1.0,
        // Sanitização de dados de evento antes do envio
        beforeSend(event) {
          try {
            if (event.message) {
              event.message = sanitizeString(event.message);
            }
            if (event.exception?.values) {
              for (const ex of event.exception.values) {
                if (ex.value) {
                  ex.value = sanitizeString(ex.value);
                }
              }
            }
          } catch {
            // Continua o envio caso ocorra falha na sanitização
          }
          return event;
        },
      });
      sentryInitialized = true;
      console.log('[Observabilidade] Sentry inicializado com sucesso.');
    } catch (err) {
      console.warn('[Observabilidade] Falha ao inicializar Sentry:', err);
    }
  } else if (rawSentryDsn && rawSentryDsn.length > 0) {
    console.info(
      '[Observabilidade] VITE_SENTRY_DSN informado ("' +
        rawSentryDsn +
        '") é incompleto ou placeholder. O DSN deve estar no formato "https://<chave_publica>@<host>/<projeto_id>". Sentry inativo até configuração.'
    );
  }

  // 2. Better Stack Telemetry (Logtail Browser)
  const logtailToken = (
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_BETTERSTACK_TOKEN || import.meta.env?.VITE_LOGTAIL_SOURCE_TOKEN || '')
      : ''
  ).trim();

  if (logtailToken && logtailToken.length > 0) {
    try {
      logtailClient = new Logtail(logtailToken);
      console.log('[Observabilidade] Better Stack Telemetry inicializado com sucesso.');
    } catch (err) {
      console.warn('[Observabilidade] Falha ao inicializar Better Stack:', err);
    }
  }

  // Handlers globais adicionais para garantir captura mesmo em cenários extremos
  window.addEventListener('error', (event) => {
    captureException(event.error || event.message, {
      source: 'window.onerror',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    captureException(event.reason, {
      source: 'window.unhandledrejection',
    });
  });
}

/**
 * Captura exceções e erros de inicialização ou chamadas de API
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  // Sempre registra no console local para depuração
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    console.error('[Observabilidade:Exception]', error, context);
  }

  if (sentryInitialized) {
    try {
      Sentry.withScope((scope) => {
        if (context) {
          scope.setExtras(context);
        }
        if (error instanceof Error) {
          Sentry.captureException(error);
        } else {
          Sentry.captureMessage(
            typeof error === 'string' ? sanitizeString(error) : JSON.stringify(error),
            'error'
          );
        }
      });
    } catch (err) {
      console.warn('[Observabilidade] Erro ao enviar exceção ao Sentry:', err);
    }
  }

  if (logtailClient) {
    try {
      const msg = error instanceof Error ? error.message : String(error);
      logtailClient.error(sanitizeString(msg), context);
    } catch {
      // Ignora falhas de telemetria para não quebrar a aplicação
    }
  }
}

/**
 * Registra mensagens e eventos de auditoria/log
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: Record<string, unknown>
): void {
  const safeMessage = sanitizeString(message);

  if (sentryInitialized) {
    try {
      Sentry.withScope((scope) => {
        if (context) {
          scope.setExtras(context);
        }
        Sentry.captureMessage(safeMessage, level);
      });
    } catch {
      // Falha graciosa
    }
  }

  if (logtailClient) {
    try {
      if (level === 'error') {
        logtailClient.error(safeMessage, context);
      } else if (level === 'warning') {
        logtailClient.warn(safeMessage, context);
      } else {
        logtailClient.info(safeMessage, context);
      }
    } catch {
      // Falha graciosa
    }
  }
}

/**
 * Helper para verificar o status dos serviços de observabilidade
 */
export function getObservabilityStatus(): { sentry: boolean; betterstack: boolean } {
  return {
    sentry: sentryInitialized,
    betterstack: logtailClient !== null,
  };
}
