---
name: server auth helpers (requireAuthUser vs requireAdminOrDocent)
description: Gotcha — only requireAdminOrDocent returns a `role` field; never gate on auth.role after requireAuthUser.
---

# Server auth helper return shapes (server/index.js)

- `requireAuthUser(req,res)` returns `{ user, profile }` — **no `role` field**. `profile` has `{ role, email }`.
- `requireAdminOrDocent(req,res)` returns `{ user, profile, role }` where `role` is `'admin'` (admin/superuser) or `'teacher'`.

## The trap
Per-course staff guards are written inline as `if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId)))`.
That pattern is **only valid after `requireAdminOrDocent`**. After `requireAuthUser`, `auth.role` is `undefined`, so the
condition is always true and it falls through to `isCourseTeacher` — which returns false for an admin/superuser who is not a
`course_members` teacher of that course → spurious 403.

**Why:** caused a real bug — `GET /api/quiz-sources-mix/:courseId` used `requireAuthUser` + `auth.role`, so the superuser got
403 on load and the Quiz-bronnen admin UI silently fell back to the default mix (50:0:50), masking the correctly-saved value.

**How to apply:** for per-course staff checks use `isStaffForCourse(auth.user, auth.profile, courseId)` (checks
`profile.role==='admin'` / `profile.email===SUPERUSER_EMAIL`, else `isCourseTeacher`). Reserve `auth.role` checks for handlers
that authenticate via `requireAdminOrDocent`. When a frontend silently shows defaults, suspect a swallowed non-200 (the client
keeps its initial state on `!res.ok`).
