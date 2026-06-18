---
name: Language bootstrap (browser-first, single source of truth)
description: How the active UI/AI language is resolved and why it must not default to Dutch
---

The active language is resolved in ONE place (`src/i18n/activeLang.ts`,
`getActiveLang`): explicit set -> stored (`lair-vu-lang`) -> browser detect ->
English fallback. Both the React provider AND the AI client (llm.service
`_getLang`) read this single holder; the provider also persists the resolved
language on first render so the AI never lags behind the UI.

**Why:** Two independent defaults previously broke "browser language first,
fallback English":
1. `llm.service` read localStorage directly and defaulted to `'nl'` when empty,
   so the AI could answer in Dutch while the UI showed the browser language.
2. `profiles.preferred_lang` had a DB column DEFAULT `'nl'`; the new-user
   trigger omits the column, so every new account got `'nl'` and
   ProfileLangSync applied it, overriding browser detection.

**How to apply:** Never give `preferred_lang` a non-null DB default and never
add a second localStorage/`'nl'` language default. New accounts must get NULL
(no explicit choice) so detection wins; the client backfills the detected lang
once. A saved, non-null profile pref is an explicit choice and wins across
devices.
