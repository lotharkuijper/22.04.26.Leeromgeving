// Eén bron van waarheid voor de actieve taal, gedeeld door de UI-provider
// (LanguageProvider) en de AI-client (llm.service). Zo praten interface en AI
// gegarandeerd in dezelfde taal — ook bij de allereerste render, vóórdat de
// gebruiker iets kiest. Volgorde: expliciet gezet -> opgeslagen voorkeur ->
// browserdetectie -> Engelse terugval. NOOIT hardcoded 'nl'.
import { isSupportedLang, detectBrowserLang, FALLBACK_LANG, type Lang } from './languages';

export const LANG_STORAGE_KEY = 'lair-vu-lang';

let _active: Lang | null = null;

export function setActiveLang(l: Lang): void {
  if (!isSupportedLang(l)) return;
  _active = l;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, l);
  } catch {}
}

export function getActiveLang(): Lang {
  if (_active) return _active;
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (isSupportedLang(stored)) return stored;
  } catch {}
  return detectBrowserLang() ?? FALLBACK_LANG;
}
