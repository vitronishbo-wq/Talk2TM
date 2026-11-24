import type { en } from './locales/en';

export const SUPPORTED_LOCALES = ['pt', 'en', 'fr', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = 'auto' | SupportedLocale;

export interface LocaleDescriptor {
  code: SupportedLocale;
  nativeLabel: string;
  intlTag: string;
}

export const LOCALE_REGISTRY: Record<SupportedLocale, LocaleDescriptor> = {
  pt: { code: 'pt', nativeLabel: 'Português', intlTag: 'pt' },
  en: { code: 'en', nativeLabel: 'English', intlTag: 'en' },
  fr: { code: 'fr', nativeLabel: 'Français', intlTag: 'fr' },
  es: { code: 'es', nativeLabel: 'Español', intlTag: 'es' },
};

export const GLOBAL_FALLBACK_LOCALE: SupportedLocale = 'en';

export type TranslationKey = keyof typeof en;
export type TranslationDictionary = Record<TranslationKey, string>;
export type TranslationParams = Record<string, string | number>;
