import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { eagerDicts, loadDict, type Lang, type TranslationKey, type Dict } from './translations';
import { isSupportedLang, detectBrowserLang, getLanguageMeta, FALLBACK_LANG } from './languages';

const STORAGE_KEY = 'lair-vu-lang';

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKey, vars?: Record<string, string>) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'nl',
  setLang: () => {},
  t: (key) => key as string,
});

function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isSupportedLang(stored)) return stored;
  } catch {}
  const browser = detectBrowserLang();
  if (browser) return browser;
  return FALLBACK_LANG;
}

function applyHtmlLang(lang: Lang) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = getLanguageMeta(lang)?.dir ?? 'ltr';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);
  const [dicts, setDicts] = useState<Record<string, Dict>>(() => ({ ...eagerDicts }));

  // Zet <html lang/dir> direct bij elke wijziging (en bij eerste render), zodat
  // de leesrichting (RTL voor Arabisch) klopt vóór het locale-dict geladen is.
  useEffect(() => {
    applyHtmlLang(lang);
  }, [lang]);

  // Laad het actieve woordenboek lazy als het er nog niet is.
  useEffect(() => {
    if (dicts[lang]) return;
    let cancelled = false;
    loadDict(lang).then((d) => {
      if (!cancelled) {
        setDicts((prev) => (prev[lang] ? prev : { ...prev, [lang]: d }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, dicts]);

  const setLang = useCallback((l: Lang) => {
    if (!isSupportedLang(l)) return;
    applyHtmlLang(l);
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {}
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string>): string => {
      const k = key as string;
      const active = dicts[lang];
      let str =
        (active && active[k]) ??
        eagerDicts.en[k] ??
        eagerDicts.nl[k] ??
        k;
      if (vars) {
        for (const [vk, vv] of Object.entries(vars)) {
          str = str.split(`{${vk}}`).join(vv);
        }
      }
      return str;
    },
    [lang, dicts],
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
