---
name: course_members dual role columns
description: The course_members table has two role columns; the legacy one is NOT NULL and must be kept in sync on every write.
---

# course_members has two role columns

`course_members` carries BOTH:
- `member_role` ('student' | 'teacher', default 'student') — the **authoritative** per-course
  role used by all current logic (teacher detection, RLS, UI).
- `role` ('superuser' | 'teacher' | 'student') — a **legacy NOT NULL** compatibility column
  (CHECK-constrained). It has a `DEFAULT 'student'` (migration applied to the live DB), but
  it is still NOT NULL.

**The trap:** any INSERT/UPSERT that omits `role` on a DB without the default, or any UPDATE
that changes `member_role` but not `role`, leaves it NULL or drifted →
`null value in column "role" of relation "course_members" violates not-null constraint`,
or a `role=teacher` / `member_role=student` mismatch after a demotion.

**Why:** the role concept moved into `member_role`, but the old column was never dropped to
preserve backward compatibility; it still enforces NOT NULL.

**How to apply:**
- On every write to `course_members`, set `role` too. Mirror `member_role` into `role`,
  **except** preserve `role='superuser'` (superuser is a global marker; their `member_role`
  is 'student'). Pattern: `role = CASE WHEN role = 'superuser' THEN role ELSE <member_role> END`.
- Both the add path (`POST /api/admin/courses/:id/members/:userId`) and the
  promote/demote path (`PUT .../:userId`, both its pgPool and supabaseAdmin branches) do this.
- Allowed legacy `role` values are only superuser/teacher/student — never write 'member' or NULL.

## RLS: writes are service-role-only, by design

`course_members` once shipped with **RLS disabled** while anon/authenticated still held full
INSERT/UPDATE/DELETE grants — a privilege-escalation hole: any logged-in user could self-promote
to `member_role='teacher'` of any course straight from the Supabase client. The lockdown:
- RLS is ENABLED with a single SELECT policy `USING (user_id = auth.uid() OR pr_is_admin())`
  (`pr_is_admin()` is SECURITY DEFINER: profiles.role='admin' OR email=superuser).
- **No INSERT/UPDATE/DELETE policies on purpose.** All writes go through the server with the
  service-role key, which bypasses RLS. Teacher↔course linking is therefore an admin-only server
  operation.

**Why:** the frontend reads own membership directly (AuthContext/CourseAccessContext, own rows)
and admin UI reads all teacher rows (pr_is_admin) — so SELECT must allow own-or-admin; but no
client should ever write this table directly.

**How to apply:** never add a client-facing write policy here. New write paths must use
`supabaseAdmin` (service role) behind an admin/superuser check, not the caller's anon client.
