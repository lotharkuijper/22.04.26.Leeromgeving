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

## Content-table RLS: mirror the courses SELECT policy
The correct hardening for a course-scoped **content** table is to make its non-staff SELECT
branch mirror the `courses` SELECT policy exactly: student sees content only when
`is_active AND student_visible`, the course teacher sees own-course content in any state,
admin sees all. `documents` + `document_chunks` now do this via a SECURITY DEFINER helper
`course_content_is_public(course_id)` (= `is_active AND student_visible`, `SET search_path`),
combined with `is_admin() OR is_course_teacher(auth.uid(), folder_course_id(folder_id))`.
`match_document_chunks` is SECURITY INVOKER so this RLS applies to the student RPC too.

**Why:** content visibility must follow *course* visibility, not `course_members` — students
get content access by the course being active+visible (no enrollment row needed), identical to
how they see the course itself. Gating content on membership would both over-block (visible
courses have no members rows) and under-block (archived courses).

**Still a gap:** other course-scoped content tables (concepts, quiz data, …) remain
membership/folder based and do **not** consult `student_visible`; raw PostgREST reads there can
still leak a hidden/archived course's content. UI + server paths (`userHasCourseAccess`) block
it, but tightening each table's RLS the same way is outstanding.
