---
name: Concept ↔ course scoping
description: How concepts are scoped to a course when the concepts table has no course_id column
---

# Concept ↔ course scoping

The `concepts` table has **no real `course_id` column** in the live DB (startup logs:
`concepts.course_id: niet gemigreerd — key_points fallback actief`). Course membership
is encoded as a marker string `course_id:<uuid>` inside the `key_points` text[] array.

Server gates on a runtime flag `conceptsHasCourseId` (set by schema detection at startup):
- **flag true** → filter `.eq('course_id', courseId)`, fallback `.is('course_id', null)`.
- **flag false** (current reality) → filter `.contains('key_points', ['course_id:<uuid>'])`;
  global fallback = concepts whose `key_points` contain NO element starting with `course_id:`.

`/api/concepts?courseId=` semantics: if the course has its own concepts → return only those;
else fall back to global concepts. Any new course-scoped query over concepts (e.g.
`/api/explain/history`) must mirror this exact fallback or it will diverge from the concept list.

**Why:** scoping by a column that doesn't exist silently 500s or returns nothing. A PostgREST
embedded select like `concepts!inner(name, course_id)` will error because the column is absent.

**How to apply:** never assume `concepts.course_id` exists — resolve concept IDs first via the
flag/`key_points` logic, then filter the dependent table with `.in('concept_id', ids)`.
Note: the Dashboard "Ik Leg Uit" card historically uses `concepts!inner(..., course_id)` and is
a latent bug from this mismatch.
