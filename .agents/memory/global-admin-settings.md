---
name: Global admin settings enforcement
description: Where the admin-only rule lives for each truly-global LEAP-VU admin setting, and what teachers may still edit.
---

There are three "truly global" admin settings (one row changes ALL courses).
Their admin-only write enforcement lives in different layers — don't assume a
missing server check means it's unprotected:

- **Global chat prompt** (`chatbot_prompts` section='chat'), **global explain prompt**,
  and **global project-agent prompts**: written client-side via the supabase client.
  Admin-only is enforced by `chatbot_prompts` RLS (INSERT/UPDATE/DELETE require
  `profiles.role = 'admin'`). The superuser is forced to role='admin', so RLS covers them.
- **ItemBank GitHub config** `__quiz_itembank_config__` (owner/repo/branch): also a
  `chatbot_prompts` row → same RLS guards writes (saveShareStatsConfig). Post-import
  `last_synced_at` save is wrapped in try/catch so a teacher's import doesn't break.
- **Global RAG defaults** `__rag_settings_global__`: written via server PUT
  `/api/rag-settings`, which checks admin/superuser when `courseId` is absent
  (course overrides use `isStaffForCourse`).

**Rule:** teachers (course_members.member_role='teacher', NOT profiles.role) may edit
ONLY their per-course overrides — the per-course explain prompt and per-course RAG
settings. They must not see/edit any global editor. So the UI gates global editors to
`isAdmin` and, for RAG, hides the "Global default" dropdown option for non-admins
(auto-selecting their first course instead).

**Why:** RLS / server already block the writes, but ungated global editors showed
teachers controls that silently 403'd — confusing and risked accidental global edits.
**How to apply:** when adding a new global admin control, gate its editor to `isAdmin`
in the UI AND back it with an admin-only write check (RLS row or server endpoint).
