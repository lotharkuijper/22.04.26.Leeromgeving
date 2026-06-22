---
name: Per-course prompt/setting overrides
description: How course-specific overrides are stored without schema changes in chatbot_prompts
---

# Per-course overrides via special-named chatbot_prompts rows

`chatbot_prompts` has NO `course_id` column. Course-specific overrides are stored
as rows with a reserved `name` pattern, not a relational column:
- RAG settings: `__rag_settings_<courseId>__`
- Explain prompt (Uitleg): `__explain_prompt_<courseId>__`
- Tutor-chat prompt: `__chat_prompt_<courseId>__`
- ItemBank source config: `__quiz_itembank_config_<courseId>__` (global stays `__quiz_itembank_config__`)

**Why:** keeps the table schema-free for new per-course features and matches the
established RAG-settings convention; resolver falls back override → global → built-in default.

**How to apply:**
- Reserved rows must be excluded from the admin prompts list (`loadPrompts` `.not('name','like','__..._%')`)
  and from the global section resolver (give them `section='internal'`, `is_active=false`).
- Course-scoped mutating endpoints auth via `requireAuthUser` + `isStaffForCourse`.
- The `*/overrides` listing endpoints intentionally use `isStaffAnywhere` (minor metadata leak,
  consistent across rag-settings and explain-prompt).

**Gotcha — global resolvers must exclude the prefix with LIKE, not exact-eq.** When you add a
NEW per-course reserved family (e.g. `__chat_prompt_<id>__`, `__quiz_itembank_config_<id>__`),
every global chat/quiz/explain prompt resolver that previously did `.neq('name','__quiz_itembank_config__')`
(exact) now needs `.not('name','like','__quiz_itembank_config%')` — the exact-eq misses the
per-course suffix rows. There were MULTIPLE such resolvers (inline `/api/chat`, the debug
active-prompts dump, AND `loadGlobalChatPrompt()`); fix all of them. Belt-and-suspenders: also
insert per-course rows with `is_active=false` + `section='internal'` so the
`eq('is_active',true)`/`eq('section','chat')` filters drop them regardless. Forgetting both = a
per-course config JSON row gets served as the global tutor-chat system prompt.

**Gotcha — a `courseId` read from the request body is untrusted; gate it before loading any
per-course override.** `/api/chat` takes `courseId` from the body to pick `__chat_prompt_<id>__`.
Without an access check, any authenticated user can pass another course's id and force/exfiltrate
that course's system prompt. Gate every body-`courseId`-driven override behind
`userHasCourseAccess(auth.user, auth.profile, courseId)` (or `isStaffForCourse` for staff-only
config) before the override query runs.
