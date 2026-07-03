// ───────────────────────────────────────────────────────────────────────────
// Server-side locale-loader voor de Studiecafé-digest-e-mails (Task #409).
//
// De digest-worker draaide voorheen alleen in nl/en; elke andere taal viel terug
// op Nederlands. Studenten kunnen hun UI/AI-taal uit 20 talen kiezen, dus de
// e-mails moeten mee. In plaats van de vertalingen dubbel in de server te
// onderhouden, hergebruiken we de bestaande frontend-locale-dictionaries
// (src/i18n/locales/<code>.json), die via de i18n-gen-workflow al voor alle 20
// talen worden gevuld. Deze module leest die JSON-bestanden (fs, gecachet) en
// biedt getDigestStrings(lang) — een taal-specifiek opmaakobject met dezelfde
// vorm als de oude T[lang] in notifications.js.
//
// Per-sleutel fallback: doeltaal → en → nl → key. Zo krijgt een taal waarvoor
// i18n-gen nog niet is gedraaid nette Engelse (en anders Nederlandse) tekst i.p.v.
// een lege string. Interpolatie ({count}, {name}, {title}) gebeurt hier.
// ───────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLang } from './languages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '../src/i18n/locales');

const dictCache = new Map();

function loadDict(code) {
  if (dictCache.has(code)) return dictCache.get(code);
  let dict = {};
  try {
    dict = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));
  } catch {
    dict = {};
  }
  dictCache.set(code, dict);
  return dict;
}

// Vervang {token}-placeholders door de meegegeven waarden.
function interpolate(str, vars) {
  let out = String(str == null ? '' : str);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v == null ? '' : v));
    }
  }
  return out;
}

// Resolveer één sleutel met fallback doeltaal → en → nl → key en interpoleer.
export function translate(lang, key, vars) {
  const code = normalizeLang(lang);
  const active = loadDict(code);
  const en = loadDict('en');
  const nl = loadDict('nl');
  const pick = (d) => (d && typeof d[key] === 'string' && d[key].trim() !== '' ? d[key] : null);
  const raw = pick(active) ?? pick(en) ?? pick(nl) ?? key;
  return interpolate(raw, vars);
}

// Levert het taal-specifieke opmaakobject dat buildDigestEmail verwacht. Dezelfde
// vorm als de oude, hardgecodeerde T[lang] — functies voor pluralisatie/counts.
export function getDigestStrings(lang) {
  const code = normalizeLang(lang);
  const t = (key, vars) => translate(code, key, vars);
  const plural = (n, base, vars) =>
    t(`${base}.${n === 1 ? 'one' : 'other'}`, { count: n, ...(vars || {}) });
  return {
    subjectReplies: (n) => plural(n, 'email.digest.subject.replies'),
    subjectAnnounce: (n) => plural(n, 'email.digest.subject.announce'),
    subjectBoth: t('email.digest.subject.both'),
    greeting: (name) =>
      name
        ? t('email.digest.greeting', { name })
        : t('email.digest.greetingNoName'),
    repliesHeading: t('email.digest.repliesHeading'),
    announceHeading: t('email.digest.announceHeading'),
    replyLine: (count, title) => plural(count, 'email.digest.replyLine', { title }),
    announceLine: (title) => String(title || t('email.digest.untitled')),
    cta: t('email.digest.cta'),
    footer: t('email.digest.footer'),
    untitled: t('email.digest.untitled'),
  };
}
