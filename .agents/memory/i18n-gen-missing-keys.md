---
name: i18n-gen only fills missing keys
description: After adding new i18n keys to nl.json, the i18n-gen workflow/script must be re-run or non-nl/en locales stay empty for those keys.
---

The `i18n-gen` workflow (`scripts/i18n-generate.mjs`) translates `nl.json` (source
of truth) into the other 18 locale files in `src/i18n/locales/`, but it is
**resumable / incremental**: per language it only translates keys that are
MISSING from that locale file. It does not re-translate or detect changed values.

**Why:** A run that "finished" with "RESTEREND totaal: 0 (alle talen compleet)"
only means every locale matched the nl key set *at that moment*. Add new keys to
nl.json (and optionally en.json) afterward and those 17 other locales silently
stay without them until the script runs again — the UI then falls back to the key
string for non-nl/en users while NL/EN look fine.

**How to apply:** Any task that adds i18n keys must end by running i18n-gen again
(directly: `TIME_BUDGET_MS=110000 node scripts/i18n-generate.mjs`, or the
workflow) and verifying coverage, e.g. `rg -l 'content\.<newKey>' src/i18n/locales
| wc -l` should equal 19. The script needs the VU Azure chat env vars; it exits 1
if Azure chat is not configured.
