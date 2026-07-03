---
name: Adding a supported UI/AI language
description: The full set of independent registries + DB constraint + types that must ALL gain a new language code, or it silently half-works.
---

Adding one language (e.g. Greek `el`) means updating every place that *independently* re-lists the languages — there is no single source that the others derive from at these layers. Miss one and you get a partial, silently-degraded feature.

**All the places (as of the 20-language state):**
1. `src/i18n/languages.ts` → `SUPPORTED_LANGUAGES` (the closest thing to a source of truth; LanguageSelector + DocumentViewer derive from the lists below, so no per-component list to touch).
2. `src/lib/translationLanguages.ts` → `TRANSLATION_LANGUAGES` (document-translation dropdown).
3. `src/i18n/translations.ts` → `lazyLoaders` map (must add a dynamic `import('./locales/<code>.json')`, or the locale never loads — only `nl`/`en` are eager).
4. `server/languages.js` → `LANG_ENGLISH_NAMES` (server AI "respond in <english>" instruction + `normalizeLang` allowlist).
5. `server/documentTranslation.js` → `LANGUAGES` (server-side allowlist for `/api/translate-document` + `/api/translate-content` via `normalizeTargetLang`).
6. `scripts/i18n-generate.mjs` → `TARGET_LANGS` (or the generator won't produce the locale).
7. `src/lib/database.types.ts` → the THREE `profiles.preferred_lang` literal unions (Row/Insert/Update). Not enforced by tsc today (Lang widens to string) but factually wrong otherwise.
8. Create `src/i18n/locales/<code>.json` (start as `{}`), then run i18n-gen to fill.

**The non-obvious gotcha — DB CHECK constraint:**
`profiles.preferred_lang` has a CHECK constraint (`profiles_preferred_lang_check`) listing every allowed code. A new UI language is selectable but **persisting the preference fails at the DB** until you add a migration that drop-and-recreates the CHECK with the new code appended. `document_translations`/`content_translations` have NO such CHECK (allowlist is code-side only) — no migration needed there.
**Why:** the constraint was widened from {nl,en} to the full set in a dedicated migration; each new language needs the same drop+recreate. Additive superset change is safe (existing rows always satisfy it).
**How to apply:** agent applies migrations directly via `psql "$SUPABASE_DB_URL"` (session pooler, 5432), per replit.md.

**Fill translations:** run i18n-gen scoped with `LANGS=<code>` in passes (it self-limits per run, writes after each wave, resumable). ~400 keys/≈110s pass; it only fills MISSING keys and reports `RESTEREND totaal: 0` when done. A stale prior "0 remaining" log refers to the language set *before* you added the new one — ignore it. Some values (brand names, symbols, placeholders) correctly stay non-translated.

**RTL:** only add to `RTL_LANGS` in DocumentViewer if the language is RTL (currently only `ar`).
