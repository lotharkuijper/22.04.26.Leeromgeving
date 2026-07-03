// Centrale talenlijst voor de hele applicatie (UI + AI-uitvoertaal).
// `native` = naam in eigen schrift (UI-label), `english` = Engelse naam die in
// de AI-instructie ("respond in <english>") gaat, `dir` = leesrichting.
// Deze lijst is de bron van waarheid; src/lib/translationLanguages.ts (bron-
// document-vertaling) en server/documentTranslation.js spiegelen een subset.

export type LanguageDir = 'ltr' | 'rtl';

export interface LanguageMeta {
  code: string;
  native: string;
  english: string;
  dir: LanguageDir;
}

export const SUPPORTED_LANGUAGES: LanguageMeta[] = [
  { code: 'nl', native: 'Nederlands', english: 'Dutch', dir: 'ltr' },
  { code: 'en', native: 'English', english: 'English', dir: 'ltr' },
  { code: 'yue', native: '粵語（廣東話）', english: 'Cantonese (written in Traditional Chinese characters)', dir: 'ltr' },
  { code: 'zh', native: '简体中文', english: 'Mandarin Chinese (written in Simplified Chinese characters)', dir: 'ltr' },
  { code: 'de', native: 'Deutsch', english: 'German', dir: 'ltr' },
  { code: 'fr', native: 'Français', english: 'French', dir: 'ltr' },
  { code: 'es', native: 'Español', english: 'Spanish', dir: 'ltr' },
  { code: 'it', native: 'Italiano', english: 'Italian', dir: 'ltr' },
  { code: 'pt', native: 'Português', english: 'Portuguese', dir: 'ltr' },
  { code: 'pl', native: 'Polski', english: 'Polish', dir: 'ltr' },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', dir: 'ltr' },
  { code: 'ro', native: 'Română', english: 'Romanian', dir: 'ltr' },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', dir: 'ltr' },
  { code: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl' },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr' },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr' },
  { code: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr' },
  { code: 'ko', native: '한국어', english: 'Korean', dir: 'ltr' },
  { code: 'hr', native: 'Hrvatski', english: 'Croatian', dir: 'ltr' },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', dir: 'ltr' },
];

export type Lang = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const SUPPORTED_LANG_CODES: Lang[] = SUPPORTED_LANGUAGES.map((l) => l.code);

// Talen die direct (eager) worden meegebundeld als terugval; de overige worden
// op aanvraag (lazy) geladen. en = universele terugval, nl = bron van waarheid.
export const EAGER_LANGS: Lang[] = ['nl', 'en'];

// Laatste terugval als detectie niets oplevert (taak: val terug op Engels).
export const FALLBACK_LANG: Lang = 'en';
// Bron-taal (meest complete vertaling) — laatste schakel vóór de ruwe sleutel.
export const SOURCE_LANG: Lang = 'nl';

export function isSupportedLang(code: unknown): code is Lang {
  return typeof code === 'string' && SUPPORTED_LANG_CODES.includes(code);
}

export function getLanguageMeta(code: string): LanguageMeta | undefined {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}

export function langDir(code: string): LanguageDir {
  return getLanguageMeta(code)?.dir ?? 'ltr';
}

export function nativeName(code: string): string {
  return getLanguageMeta(code)?.native ?? code;
}

// BCP-47 locale voor Intl-formattering (datum/getal). Engels gebruikt de
// Britse notatie (dag-maand-jaar), net als het Nederlands; overige talen
// gebruiken hun eigen taalcode (Intl valt netjes terug bij onbekende codes).
export function intlLocale(code: string): string {
  if (code === 'en') return 'en-GB';
  if (code === 'nl') return 'nl-NL';
  return code;
}

// Detecteer de voorkeurstaal uit de browser. Matcht het primaire subtag
// (bv. 'en-US' -> 'en', 'zh-CN' -> 'zh') tegen de ondersteunde talen.
export function detectBrowserLang(): Lang | null {
  if (typeof navigator === 'undefined') return null;
  const candidates: string[] = [];
  const navAny = navigator as Navigator & { languages?: string[] };
  if (Array.isArray(navAny.languages)) candidates.push(...navAny.languages);
  if (navigator.language) candidates.push(navigator.language);
  for (const raw of candidates) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (isSupportedLang(lower)) return lower;
    const primary = lower.split('-')[0];
    if (isSupportedLang(primary)) return primary;
  }
  return null;
}
