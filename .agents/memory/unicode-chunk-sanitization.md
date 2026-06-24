---
name: Unicode sanitization at the PostgREST insert boundary
description: Why \u0000 / lone surrogates break Supabase inserts into text/jsonb, where to sanitize, and a write-free way to reproduce the exact error.
---

# Unicode-safe writes into Supabase text/jsonb

Postgres `text`/`jsonb` cannot store NUL (`\u0000`) or lone UTF-16 surrogates. Via
PostgREST (supabase-js) each row is JSON-stringified and Postgres parses the body
JSON→jsonb→text, so a poisoned `content`/metadata value surfaces as
`unsupported Unicode escape sequence` at insert time. This is **not** a client,
embedding, or extraction bug — it is purely the storage boundary.

**Rule:** sanitize at the insert boundary — text values, metadata values, AND
metadata object *keys* (a poisoned jsonb key fails just as hard). Sanitize the
chunk text *before* embedding too, so the stored embedding matches the stored text.

**Where:** the shared sanitizer is `src/lib/sanitizeText.ts` with an identical ESM
mirror `server/sanitizeText.js` (`sanitizeText` + recursive `sanitizeMetadata`).
Keep both mirrors in lockstep; both have test mirrors.

**Why:**
- Lone-surrogate stripping must use a **lookbehind-free** regex
  (`/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g` + replacer that keeps the
  2-char pair, drops the single). Older Safari (<16.4) has no regex lookbehind, so
  a lookbehind literal throws `SyntaxError` at *module load* — the whole bundle
  dies, not just the upload path.
- Do **not** use `String.prototype.toWellFormed()` when you need lone surrogates
  *removed*: it replaces them with U+FFFD (keeps a visible char), which changes
  output semantics.

**Reproduce the exact production error with zero writes** (no FK, no cleanup):
feed `JSON.stringify({ content })` to `SELECT $1::jsonb` over a `pg` connection to
`SUPABASE_DB_URL`. Poisoned content → identical `unsupported Unicode escape
sequence`; the `sanitizeText(content)` version parses fine (NUL + lone surrogate
gone, valid emoji pair preserved). This mirrors the PostgREST JSON→jsonb path
exactly. Note: the JS `code_execution` sandbox has **no** `process.env`, so run
such scripts via `bash`/Node where secrets are available.

**How to apply:** any new code path that inserts user/teacher/LLM-derived text or
jsonb into Supabase must route it through `sanitizeText`/`sanitizeMetadata` first.
For resilient bulk inserts, fall back batch→row-by-row only for genuine
unstorable-character errors and rethrow all other per-row errors (network/RLS/
vector) so chunks are never silently dropped.
