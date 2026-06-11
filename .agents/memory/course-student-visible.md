---
name: Course visibility (student_visible)
description: How "hide a course from students" works — separate flag, RLS embedded-join gotcha, layered enforcement, and the content-table RLS gap.
---

# Course visibility: `student_visible`

Hiding a course from students is a **separate boolean** `courses.student_visible`
(default true), distinct from `is_active`. `is_active` = archived/active lifecycle;
`student_visible` = temporarily hidden for maintenance/building while the teacher keeps
working in it. Do not overload `is_active` for "hide from students".

**Why:** product needs "prepare a course without students stumbling onto it" without
archiving it. Conflating the two would make a hidden course also look archived to staff.

**How to apply (enforce in all three layers — UI alone is not enough):**
- RLS SELECT on `courses`: `((is_active AND student_visible) OR is_course_teacher(auth.uid(), id))`.
  `is_course_teacher` is SECURITY DEFINER over `course_members` (no RLS recursion).
- Server `userHasCourseAccess`: admin bypass → membership required → hidden course is
  teacher-only. Read errors fail **closed**; only a missing-column 42703 falls back to "visible".
- Clients rely on RLS for the lists.

## PostgREST embedded-join null gotcha (the crash this caused)
When a parent row is RLS-hidden but the child row still exists, a PostgREST embedded
join returns the parent as **null**, not an omitted row. A still-enrolled student querying
`course_members` with embedded `courses(...)` gets rows where `row.courses === null`.
Always **filter out null-embed rows client-side** (CourseAccessContext) or you both crash
on `row.courses.id` and risk showing a ghost entry. Teachers keep the join (RLS exception),
so they still see their hidden course.

## Active-course edge case
`ActiveCourseContext` flags `activeCourseUnavailable` **only** on `.single()` PGRST116
(0 rows = hidden/removed), never on network errors (avoids spurious redirects). A guard in
AppRoutes redirects to `/choose-course`; the flag resets on `setActiveCourse`. Teachers/admins
never hit PGRST116 for their own hidden course, so no false redirect for them.

## Known gap (defense-in-depth, not yet done)
RLS on course-scoped **content** tables (documents, concepts, quiz data, …) is
membership/folder based and does **not** consult `student_visible`. A still-enrolled student
issuing raw PostgREST queries could read a hidden course's content. All UI + all server API
paths (via `userHasCourseAccess`) are blocked, which meets the acceptance criteria; tightening
content-table RLS to check `student_visible` is a follow-up hardening task.
