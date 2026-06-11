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
