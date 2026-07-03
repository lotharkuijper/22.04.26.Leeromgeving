// Façade over de per-taal locale-JSON-bestanden in ./locales.
// nl = bron van waarheid, en = beoordeelde universele terugval; beide worden
// direct (eager) meegebundeld. De overige talen worden op aanvraag (lazy)
// geladen via dynamische imports zodat de bundel klein blijft.
import nl from './locales/nl.json';
import en from './locales/en.json';
import { type Lang } from './languages';

export type { Lang } from './languages';
export type Dict = Record<string, string>;
export type TranslationKey = keyof typeof nl;

// Altijd beschikbare terugval-woordenboeken.
export const eagerDicts: Record<string, Dict> = { nl, en };

// Module-cache van reeds geladen woordenboeken (eager + lazy). De provider
// vult dit impliciet via `loadDict`. Niet-React code (bijv. llm.service) kan
// hierdoor synchroon vertalen met `tStatic` zónder de React-context.
const loadedDicts: Record<string, Dict> = { ...eagerDicts };

// Compat: sommige modules verwachten nog `translations.nl` / `translations.en`.
export const translations = { nl, en } as const;

// Lazy-loaders voor de overige talen (JSON, op aanvraag geladen).
const lazyLoaders: Partial<Record<Lang, () => Promise<Dict>>> = {
  yue: () => import('./locales/yue.json').then((m) => m.default as Dict),
  zh: () => import('./locales/zh.json').then((m) => m.default as Dict),
  de: () => import('./locales/de.json').then((m) => m.default as Dict),
  fr: () => import('./locales/fr.json').then((m) => m.default as Dict),
  es: () => import('./locales/es.json').then((m) => m.default as Dict),
  it: () => import('./locales/it.json').then((m) => m.default as Dict),
  pt: () => import('./locales/pt.json').then((m) => m.default as Dict),
  pl: () => import('./locales/pl.json').then((m) => m.default as Dict),
  uk: () => import('./locales/uk.json').then((m) => m.default as Dict),
  ro: () => import('./locales/ro.json').then((m) => m.default as Dict),
  tr: () => import('./locales/tr.json').then((m) => m.default as Dict),
  ar: () => import('./locales/ar.json').then((m) => m.default as Dict),
  hi: () => import('./locales/hi.json').then((m) => m.default as Dict),
  id: () => import('./locales/id.json').then((m) => m.default as Dict),
  ja: () => import('./locales/ja.json').then((m) => m.default as Dict),
  ko: () => import('./locales/ko.json').then((m) => m.default as Dict),
  hr: () => import('./locales/hr.json').then((m) => m.default as Dict),
  el: () => import('./locales/el.json').then((m) => m.default as Dict),
};

// Laadt het woordenboek voor een taal. Eager talen komen direct terug; lazy
// talen worden geïmporteerd. Bij een fout valt het terug op het Engelse dict.
export async function loadDict(lang: Lang): Promise<Dict> {
  if (eagerDicts[lang]) return eagerDicts[lang];
  if (loadedDicts[lang]) return loadedDicts[lang];
  const loader = lazyLoaders[lang];
  if (!loader) return eagerDicts.en;
  try {
    const dict = await loader();
    loadedDicts[lang] = dict;
    return dict;
  } catch {
    return eagerDicts.en;
  }
}

// Synchrone vertaling voor niet-React code (bijv. llm.service) die buiten de
// LanguageProvider draait. Gebruikt dezelfde fallback-keten (actief -> en ->
// nl -> key) en placeholder-interpolatie (`{var}`) als de React-`t`. Een lazy
// taal die nog niet via `loadDict` geladen is, valt automatisch terug op en/nl
// — in de praktijk heeft de provider de actieve taal al geladen.
export function tStatic(
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const active = loadedDicts[lang];
  let str = (active && active[key]) ?? eagerDicts.en[key] ?? eagerDicts.nl[key] ?? key;
  if (vars) {
    for (const [vk, vv] of Object.entries(vars)) {
      str = str.split(`{${vk}}`).join(String(vv));
    }
  }
  return str;
}
