---
name: Course content access = visibility-based, not membership
description: How server-side course content access is decided (canAccessCourseContent) and why it mirrors the courses RLS instead of requiring course_members.
---

Course **content** access (projects list/start/join/restart, course-info, itembank quiz, concept evidence) is decided by the pure predicate `canAccessCourseContent` in `server/courseAvailability.js`, used by `userHasCourseAccess` in `server/index.js`. It is **visibility-based**, NOT membership-based:

- admin/superuser → always
- `student_visible === false` (hidden) → teacher-of-course only (preserves the "hidden = teacher-only" rule, even for enrolled students)
- `is_active === true` (active + visible) → **any logged-in user** (no `course_members` row needed)
- inactive but visible (archived) → member OR teacher

**Why:** Two notions of "a student's courses" had drifted apart. The courses RLS (course visibility migration) lets any logged-in student SELECT/browse/select any `is_active AND student_visible` course with no enrollment row, and self-registration was later restored — so self-registered students have no `course_members` rows. The old `userHasCourseAccess`/`student-overview` required membership, so those students could pick a visible course but saw zero projects / got 403 on its content. Aligning content access to the courses RLS fixes this in one place.

**How to apply:**
- Do NOT reintroduce a `course_members` requirement for *content read* or *student-initiated* endpoints on active+visible courses. Membership/teacher lookups belong only on the hidden and inactive branches (look them up lazily).
- `student-overview` resolves its course set as the union of all active(+visible) courses and member courses that pass the same predicate — never just `course_members`. Frontend `ProjectsPage` filters by the active course, so returning all open courses is fine and matches `ChooseCoursePage` (which also uses `.eq('is_active', true)`).
- Keep the `coursesHasStudentVisible`/42703 defensive handling: when the column is missing, treat every course as visible.
- Staff/write endpoints (role changes, availability, bulk provision, admin downloads) still gate on `isCourseTeacher`/`isStaffForCourse`/admin — that is unchanged and must stay strict.

**Corollary — per-student-per-course preferences:** because students often have NO `course_members` row, any *per-student, per-course* setting must live in its own table keyed on `(user_id, course_id)` with own-row RLS (`auth.uid() = user_id`), NOT in `course_members` and NOT in `profiles` (which is global per-user only, e.g. language/last-active-course).
