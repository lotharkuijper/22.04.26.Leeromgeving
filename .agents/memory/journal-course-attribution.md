---
name: Journal course attribution
description: How learning_journal_entries records the course a note was created in, and why course_id is nullable/best-effort.
---

Every `learning_journal_entries` row carries a nullable `course_id` (FK → courses, ON DELETE SET NULL) so the journal UI can show which course a note belongs to.

**Where the course comes from per insert path:**
- Project flows (save-summary, checkpoint, document review, group evaluate) derive it server-side from `projects.course_id` via `courseIdForProject(projectId)` — always a real course, never an FK risk.
- Chat / explain / quiz flows have NO course column on their source tables, so the frontend sends the active course id in the request body. The server validates it with `resolveJournalCourseId()` (uuid-shape + existence check) before insert.
- Manual "Overig" notes (FeedbackPage) insert `activeCourseId` directly via the Supabase client.

**Why course_id is nullable and writes never hard-reject a missing/invalid course:**
- A hard 400 on unresolved course would lose the note entirely, which is worse than recording it without a course.
- `resolveJournalCourseId()` returns null (not throw) for missing/invalid/non-existent ids precisely so a stale client value can never raise an FK error that blocks the save.
- In practice notes still get a course because the app routing forces an active-course selection before any of these flows run.

**How to apply:** when adding a new journal insert site, set `course_id` from the project (server-derived) when a project context exists, otherwise from a frontend-supplied course id passed through `resolveJournalCourseId()`. Keep the column nullable; do not add an FK-breaking required-course rejection. `GET /api/journal` enriches each row with `course_name` by joining courses; the fallback inserts that strip `source_ref` on older DBs must keep `course_id`.
