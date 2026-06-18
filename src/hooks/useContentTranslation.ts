import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';

// Generieke client-hook voor het op-aanvraag vertalen van door docenten/admins
// geschreven, student-zichtbare DB-tekst naar de actieve UI-taal (Task #288).
// Spiegelt het patroon van DocumentViewer: een module-cache + een monotone
// seq-guard, géén react-query (zit niet in dit project). Bij nl of een fout valt
// de hook stil terug op de originele tekst.

export type ContentFormat = 'markdown' | 'plain';

export interface TranslatableItem {
  text: string | null | undefined;
  format?: ContentFormat;
}

export interface ContentTranslationResult {
  /** Per key: de vertaling (indien getoond) of anders de originele tekst. */
  values: Record<string, string>;
  /** Loopt er een vertaalverzoek? */
  isTranslating: boolean;
  /** Bestaat er ≥1 daadwerkelijke vertaling die afwijkt van het origineel? */
  isTranslated: boolean;
  showOriginal: boolean;
  setShowOriginal: (v: boolean) => void;
}

// Module-cache, gedeeld over alle hook-instanties: identieke tekst hoeft maar één
// keer per taal opgehaald te worden. Sleutel = taal \0 formaat \0 genormaliseerd.
const cache = new Map<string, string>();

// Spiegelt server `normalizeSourceText` EXACT (CRLF→LF, 3+ lege regels inklappen,
// trimmen — trailing spaces binnen een regel blijven staan). Moet identiek zijn,
// anders verschilt de client-module-cache-sleutel van de server-bron-hash en kan
// de client twee server-verschillende teksten samenvoegen.
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function cacheKey(lang: string, format: ContentFormat, text: string): string {
  return `${lang}\u0000${format}\u0000${normalize(text)}`;
}

export function useContentTranslation(items: Record<string, TranslatableItem>): ContentTranslationResult {
  const { lang } = useLanguage();
  const [showOriginal, setShowOriginal] = useState(false);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const seqRef = useRef(0);

  // Stabiele lijst van te vertalen fragmenten (lege tekst eruit gefilterd).
  const entries = Object.entries(items)
    .map(([key, it]) => ({
      key,
      format: (it?.format === 'markdown' ? 'markdown' : 'plain') as ContentFormat,
      text: typeof it?.text === 'string' ? it.text : '',
    }))
    .filter((e) => e.text.trim().length > 0);

  // Signatuur voor de effect-dependency: verandert alleen bij taal of inhoud.
  const sig = JSON.stringify({ lang, e: entries.map((e) => [e.key, e.format, e.text]) });

  useEffect(() => {
    if (lang === 'nl') {
      setTranslations({});
      setIsTranslating(false);
      return;
    }
    const seq = ++seqRef.current;

    // Vul eerst alles wat al in de module-cache zit.
    const fromCache: Record<string, string> = {};
    const missing: { key: string; format: ContentFormat; text: string }[] = [];
    for (const e of entries) {
      const hit = cache.get(cacheKey(lang, e.format, e.text));
      if (hit != null) fromCache[e.key] = hit;
      else missing.push(e);
    }
    setTranslations(fromCache);

    if (missing.length === 0) {
      setIsTranslating(false);
      return;
    }
    setIsTranslating(true);

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
        const res = await fetch('/api/translate-content', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            targetLang: lang,
            items: missing.map((m) => ({ key: m.key, text: m.text, format: m.format })),
          }),
        });
        if (seq !== seqRef.current) return; // verouderd antwoord
        if (!res.ok) {
          setIsTranslating(false);
          return; // stille terugval op origineel
        }
        const data = await res.json();
        const got: Record<string, unknown> = (data && data.translations) || {};
        const merged: Record<string, string> = { ...fromCache };
        for (const m of missing) {
          const tr = got[m.key];
          if (typeof tr === 'string' && tr) {
            cache.set(cacheKey(lang, m.format, m.text), tr);
            merged[m.key] = tr;
          }
        }
        if (seq !== seqRef.current) return;
        setTranslations(merged);
      } catch {
        /* stille terugval op origineel */
      } finally {
        if (seq === seqRef.current) setIsTranslating(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const values: Record<string, string> = {};
  let anyTranslated = false;
  for (const [key, it] of Object.entries(items)) {
    const original = typeof it?.text === 'string' ? it.text : '';
    const tr = translations[key];
    const hasTr = lang !== 'nl' && typeof tr === 'string' && !!tr && tr !== original;
    if (hasTr) anyTranslated = true;
    values[key] = !showOriginal && hasTr ? (tr as string) : original;
  }

  return { values, isTranslating, isTranslated: anyTranslated, showOriginal, setShowOriginal };
}
