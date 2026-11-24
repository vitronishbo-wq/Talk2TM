import { en } from './locales/en';
import {
  GLOBAL_FALLBACK_LOCALE,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALES,
  type LanguagePreference,
  type SupportedLocale,
  type TranslationDictionary,
  type TranslationKey,
  type TranslationParams,
} from './types';

export {
  GLOBAL_FALLBACK_LOCALE,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALES,
  type LanguagePreference,
  type LocaleDescriptor,
  type SupportedLocale,
  type TranslationDictionary,
  type TranslationKey,
  type TranslationParams,
} from './types';

const dictionaries: Partial<Record<SupportedLocale, TranslationDictionary>> = {
  en,
};

const pendingLoads = new Map<SupportedLocale, Promise<TranslationDictionary>>();
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();
const listeners = new Set<(locale: SupportedLocale) => void>();

let currentPreference: LanguagePreference = 'auto';
let activeLocale: SupportedLocale = GLOBAL_FALLBACK_LOCALE;
let prefetchScheduled = false;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  if (value === 'auto') return 'auto';
  if (isSupportedLocale(value)) return value;
  return 'auto';
}

export function matchSupportedLocaleTag(tag: unknown): SupportedLocale | null {
  if (typeof tag !== 'string') return null;
  const clean = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!clean) return null;
  const base = clean.split('-')[0];
  return isSupportedLocale(base) ? base : null;
}

/**
 * Detecta o idioma preferido do sistema seguindo a ordem:
 * navigator.languages -> navigator.language -> fallback global ('en').
 */
export function detectSystemLocale(overrides?: {
  languages?: readonly string[];
  language?: string;
}): SupportedLocale {
  const candidates: string[] = [];

  if (overrides) {
    if (Array.isArray(overrides.languages)) candidates.push(...overrides.languages);
    if (overrides.language) candidates.push(overrides.language);
  } else if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  }

  for (const tag of candidates) {
    const matched = matchSupportedLocaleTag(tag);
    if (matched) return matched;
  }

  return GLOBAL_FALLBACK_LOCALE;
}

/**
 * Resolve o idioma efetivo com prioridade absoluta:
 * preferência manual explícita > idioma do sistema > fallback global ('en').
 */
export function resolveEffectiveLocale(
  preference: LanguagePreference = 'auto',
  overrides?: { languages?: readonly string[]; language?: string }
): SupportedLocale {
  if (preference !== 'auto' && isSupportedLocale(preference)) {
    return preference;
  }
  return detectSystemLocale(overrides);
}

export function registerLocaleDictionary(locale: SupportedLocale, dict: TranslationDictionary): void {
  dictionaries[locale] = dict;
}

export async function loadLocaleDictionary(locale: SupportedLocale): Promise<TranslationDictionary> {
  const existing = dictionaries[locale];
  if (existing) return existing;

  const inflight = pendingLoads.get(locale);
  if (inflight) return inflight;

  const loader = (async () => {
    try {
      let loaded: TranslationDictionary;
      switch (locale) {
        case 'pt': {
          const mod = await import('./locales/pt');
          loaded = mod.pt;
          break;
        }
        case 'fr': {
          const mod = await import('./locales/fr');
          loaded = mod.fr;
          break;
        }
        case 'es': {
          const mod = await import('./locales/es');
          loaded = mod.es;
          break;
        }
        case 'en':
        default: {
          loaded = en;
          break;
        }
      }
      dictionaries[locale] = loaded;
      return loaded;
    } catch (err) {
      console.warn(`[i18n] Falha ao carregar dicionário "${locale}", usando fallback "en":`, err);
      return en;
    } finally {
      pendingLoads.delete(locale);
    }
  })();

  pendingLoads.set(locale, loader);
  return loader;
}

function syncDocumentLang(locale: SupportedLocale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = LOCALE_REGISTRY[locale].intlTag;
  }
}

export async function initI18n(
  preference: LanguagePreference = 'auto',
  overrides?: { languages?: readonly string[]; language?: string }
): Promise<SupportedLocale> {
  currentPreference = normalizeLanguagePreference(preference);
  const resolved = resolveEffectiveLocale(currentPreference, overrides);
  await loadLocaleDictionary(resolved);
  activeLocale = resolved;
  syncDocumentLang(activeLocale);
  return activeLocale;
}

export async function setAppLocale(preference: LanguagePreference): Promise<SupportedLocale> {
  currentPreference = normalizeLanguagePreference(preference);
  const resolved = resolveEffectiveLocale(currentPreference);
  await loadLocaleDictionary(resolved);
  const changed = resolved !== activeLocale;
  activeLocale = resolved;
  syncDocumentLang(activeLocale);
  if (changed) {
    for (const cb of listeners) {
      try {
        cb(activeLocale);
      } catch {
        // Ignora erro de listener isolado
      }
    }
  }
  return activeLocale;
}

/**
 * Define o idioma de forma síncrona quando o dicionário já estiver carregado (ex.: testes).
 */
export function setAppLocaleSync(locale: SupportedLocale): void {
  currentPreference = locale;
  activeLocale = locale;
  syncDocumentLang(locale);
}

export function getCurrentLocale(): SupportedLocale {
  return activeLocale;
}

export function getLanguagePreference(): LanguagePreference {
  return currentPreference;
}

export function onLocaleChange(listener: (locale: SupportedLocale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const val = params[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

export function t(key: TranslationKey, params?: TranslationParams, localeOverride?: SupportedLocale): string {
  const targetLocale = localeOverride ?? activeLocale;
  const dict = dictionaries[targetLocale];
  const raw = (dict && dict[key]) || en[key] || String(key);
  return interpolate(raw, params);
}

/**
 * Obtém o nome localizado de um território/país usando Intl.DisplayNames nativo do navegador,
 * com cache por idioma e fallback seguro para navegadores incompatíveis.
 */
export function getLocalizedCountryName(
  iso: string,
  localeOverride?: SupportedLocale,
  fallbackName?: string
): string {
  const cleanIso = (iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cleanIso)) return fallbackName ?? cleanIso;

  const targetLocale = localeOverride ?? activeLocale;
  const tag = LOCALE_REGISTRY[targetLocale].intlTag;

  let formatter = displayNamesCache.get(tag);
  if (formatter === undefined) {
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
        formatter = new Intl.DisplayNames([tag], { type: 'region' });
      } else {
        formatter = null;
      }
    } catch {
      formatter = null;
    }
    displayNamesCache.set(tag, formatter);
  }

  if (formatter) {
    try {
      const resolved = formatter.of(cleanIso);
      if (resolved && resolved.toUpperCase() !== cleanIso) {
        return resolved;
      }
    } catch {
      // Fallback abaixo
    }
  }

  return fallbackName ?? cleanIso;
}

/**
 * Pré-carrega os restantes micro-dicionários em segundo plano quando online para que o Service Worker
 * os armazene em cache e permita troca de idioma 100% offline.
 */
export function prefetchLocaleChunks(): void {
  if (prefetchScheduled) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  prefetchScheduled = true;

  const run = () => {
    for (const loc of SUPPORTED_LOCALES) {
      if (!dictionaries[loc]) {
        void loadLocaleDictionary(loc);
      }
    }
  };

  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(run, { timeout: 2500 });
      return;
    }
    window.setTimeout(run, 1500);
  }
}
