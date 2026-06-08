---
name: Defensive missing-column fallbacks (Supabase 42703)
description: How to write chained insert/update retries that strip optional newer columns when a legacy DB lacks them, without reintroducing earlier-stripped columns.
---

Several `server/index.js` write paths (project_personas create / from-library / patch / bulk copy-from-library) retry inserts/updates when a column is missing (Postgres `42703`), because the agent applies migrations out of band and an older DB may lack newly-added optional columns.

Rule: each successive fallback must be **cumulative** — strip the newly-failing column AND every optional column stripped by earlier fallbacks in the same chain. Build the reduced payload from the original object but destructure out the full accumulated set.

**Why:** fallbacks were written independently, each stripping only its own column from the original payload. When a legacy DB lacked *multiple* newer columns at once (e.g. Task #252 `max_consultations`/`auto_close_hours`/`cue_emission_enabled` AND Task #253 `badge_award_mode`), the last retry still re-included the earlier columns and failed again with 42703. Order of `if` checks doesn't help because each rebuilds from the unmodified source.

**How to apply:** the last fallback in a chain should remove the union of all optional columns: e.g. `const { badge_award_mode:_b, cue_emission_enabled:_c, max_consultations:_m, auto_close_hours:_a, ...rest } = row;`. course_personas library rows only carry `badge_award_mode` (no consultation/cue fields), so a single-column fallback is correct there — match the strip set to what the row actually sets.
