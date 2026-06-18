---
name: Multilingual LLM JSON-mode key/enum preservation
description: When a response_format json_object call also gets a "respond in language X" instruction, the instruction must preserve JSON keys + enum/structural values or parsing/validation silently degrades.
---

# Rule
Any LLM call that (a) uses `response_format: { type: 'json_object' }` and is parsed by
**fixed keys or validated enums**, AND (b) carries a non-Dutch/English output-language
instruction, MUST also tell the model to keep JSON property names and fixed
enum/structural values EXACTLY as written and translate only the human-readable string
values. Server: pass `{ json: true }` to `buildLanguageInstruction` (server/languages.js)
or inline an equivalent key-preservation sentence. Client quiz generation: the
`outputLanguageDirective` carries the same clause, and the parser additionally clamps the
`type` field to the valid enum (falling back to the requested questionType).

**Why:** Without the clause, for the 17 lazily-added languages the model translates keys
(e.g. Dutch keys `overeenstemming`/`samenvatting`, or quiz `type: "mcq"` → a translated
word) and enums (doc-review `verdict: accepted|conditional|rejected`). Then parse-by-key
returns empty arrays / `validateReviewResponse` rejects → 502 or silently-empty UI. It only
shows up in non-NL/EN, so NL/EN tests stay green and hide it.

**How to apply:** Audit every `response_format: json_object` site whenever you touch
output-language behavior. NL returns empty from `buildLanguageInstruction` (no force), so
the clause is a no-op for Dutch and preserves existing behavior. Document-review output is
multilingual: the client sends `lang`, the server normalizes it and appends
`buildLanguageInstruction(reviewLang, { json: true })` to the (teacher-editable) system
template; the verdict enum + grade stay structural.

# Known remaining gap
Deterministic journal-mirror **labels/titles** (e.g. `Cijfer`/`Oordeel`, verdict/badge
labels) are persisted as literal Dutch strings at entry-creation time, so they stay Dutch
even for other-language users. Making them multilingual needs stored stable codes +
client-side rendering (the established "stable code, translate client-side" pattern), not a
prompt tweak — a separate refactor, not done here.
