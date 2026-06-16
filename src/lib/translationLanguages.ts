// Doeltalen voor de bron-document vertaalfunctie. Spiegelt de allowlist in
// server/documentTranslation.js (de server valideert altijd; deze lijst voedt
// alleen de keuze-dropdown). `native` toont de taal in haar eigen schrift.
export interface TranslationLanguage {
  code: string;
  native: string;
}

export const TRANSLATION_LANGUAGES: TranslationLanguage[] = [
  { code: 'nl', native: 'Nederlands' },
  { code: 'en', native: 'English' },
  { code: 'yue', native: '粵語（廣東話）' },
  { code: 'zh', native: '简体中文' },
  { code: 'de', native: 'Deutsch' },
  { code: 'fr', native: 'Français' },
  { code: 'es', native: 'Español' },
  { code: 'it', native: 'Italiano' },
  { code: 'pt', native: 'Português' },
  { code: 'pl', native: 'Polski' },
  { code: 'uk', native: 'Українська' },
  { code: 'ro', native: 'Română' },
  { code: 'tr', native: 'Türkçe' },
  { code: 'ar', native: 'العربية' },
  { code: 'hi', native: 'हिन्दी' },
  { code: 'id', native: 'Bahasa Indonesia' },
];

export const TRANSLATION_LANGUAGE_CODES = TRANSLATION_LANGUAGES.map((l) => l.code);

export function nativeLangName(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.native || code;
}
