---
name: Per-course prompt/setting overrides
description: How course-specific overrides are stored without schema changes in chatbot_prompts
---

# Per-course overrides via special-named chatbot_prompts rows

`chatbot_prompts` has NO `course_id` column. Course-specific overrides are stored
as rows with a reserved `name` pattern, not a relational column:
- RAG settings: `__rag_settings_<courseId>__`
- Explain prompt (Uitleg): `__explain_prompt_<courseId>__`

**Why:** keeps the table schema-free for new per-course features and matches the
established RAG-settings convention; resolver falls back override → global → built-in default.

**How to apply:**
- Reserved rows must be excluded from the admin prompts list (`loadPrompts` `.not('name','like','__..._%')`)
  and from the global section resolver (give them `section='internal'`, `is_active=false`).
- Course-scoped mutating endpoints auth via `requireAuthUser` + `isStaffForCourse`.
- The `*/overrides` listing endpoints intentionally use `isStaffAnywhere` (minor metadata leak,
  consistent across rag-settings and explain-prompt).
