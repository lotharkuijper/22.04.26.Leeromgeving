---
name: Project RLS course scoping
description: Why project RLS must scope by course membership, not global docent role; the cross-course leak pattern.
---

# Projects must be strictly course-scoped in RLS

**Rule:** A project belongs to exactly one course. Direct-client (browser Supabase) access to a project (and its personas/groups) must be gated by membership of *that* course, by admin/superuser, or by group membership within the project — never by the **global** `profiles.role='docent'` flag.

**Why:** RLS historically used `OR EXISTS (... profiles.role='docent')` as a blanket grant on the `projects` table and inside the helper `pr_user_has_course_access()`. That let any global docent (and `is_public=true`) read/manage *every* project across *all* courses — so e.g. a teacher of "Multilevel Analyse" could see a project owned by course "MenS1". Real teaching authority is per-course (`course_members`), not the broad global `profiles.role`.

**How to apply:**
- `pr_user_has_course_access(course_id)` = `pr_is_admin()` OR `course_members` membership of that course OR group-member of a project in that course. No blanket docent.
- `projects` SELECT = `pr_is_course_teacher(course_id)` OR `pr_user_has_course_access(course_id)`; manage (FOR ALL) = `pr_is_course_teacher(course_id)` USING+WITH CHECK.
- `pr_is_course_teacher(course_id)` = `pr_is_admin()` OR (`profiles.role='docent'` AND `course_members` of that course). Note: in current data many course teachers have `profiles.role='student'` with `course_members.role/member_role='teacher'`, so they do NOT pass `pr_is_course_teacher` — project *management* via direct RLS is effectively admin/superuser only. Server endpoints bypass RLS (service role) and gate with their own `isStaffForCourse`, so staff UI still works.
- Verify RLS changes with impersonation: `BEGIN; SET LOCAL role authenticated; SELECT set_config('request.jwt.claims', json_build_object('sub','<userId>','role','authenticated')::text, true); SELECT ... ; ROLLBACK;`
- Sharing a project to another course is by COPYING (no copy-to-course feature exists yet); do not widen RLS to emulate sharing.

**Still leaky (deferred, deeper hardening):** `group_chat_messages.gcm_select`, `group_checkpoints.gcp_select`, `student_project_sessions` reads, and `learning_journal_entries` "Docents can view all" still carry blanket-docent reads. Cross-course, but they expose student *work* to staff, not the project entity; tightening risks breaking teacher dashboards.
