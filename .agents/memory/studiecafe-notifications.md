---
name: Studiecafé email notifications
description: Design constraints for the Studiecafé digest email feature (reply + announcement notifications)
---

# Studiecafé email notifications

Email digest for two events: someone replies to your thread, and a teacher posts
an announcement. Per-user opt-out, deduplicated, batched by a periodic worker.

## Announcement audience follows the visibility model (not membership)
Course content access is **visibility-based** (`canAccessCourseContent`): an
active + `student_visible` course is open to ALL students (most have NO
`course_members` row). The audience MUST mirror that:
- active + visible ⇒ **all `profiles` where role='student' ∪ `course_members`**;
- hidden (`student_visible=false`) OR inactive ⇒ **only `course_members`** (the
  only non-admins who can see the content).
Poster excluded; capped at `MAX_ANNOUNCE_AUDIENCE` (5000).
**Why:** gating announcements on `course_members` (or engagement like
`studiecafe_last_seen`) silently drops the majority of eligible students — the
same trap as project RLS. A reviewer rejected the membership/engagement-limited
version for exactly this.
**How to apply:** the visibility decision is a pure helper
`computeAnnouncementAudience()` in `server/notifications.js` (unit-tested);
`announcementAudience()` in `studiecafe.js` only fetches the inputs (course
is_active/student_visible via `select('*')` for old-DB safety, members, students)
and calls it. Enqueue is a chunked bulk multi-row INSERT and runs fire-and-forget
(`void`) off the request path so a big audience doesn't stall posting.

## Dedup / anti-flood is enforced at the DB layer
Partial unique index on `studiecafe_notifications(dedup_key) WHERE sent_at IS NULL`.
One open (unsent) notification per (kind, thread, recipient). Insert with
`ON CONFLICT (dedup_key) WHERE sent_at IS NULL DO NOTHING` (needs the partial
predicate in the conflict target). After a digest sends (sent_at set), the row
leaves the index so the next reply starts fresh. Opted-out rows are marked sent
(not deleted) so they don't reprocess forever.

## Email transport is fail-soft (Resend)
`getEmailConfig()` reads the key from the Replit Resend **connector proxy**
(`/api/v2/connection?include_secrets=true&connector_names=resend` with
`X_REPLIT_TOKEN` from `REPL_IDENTITY`/`WEB_REPL_RENEWAL`) OR env `RESEND_API_KEY`,
from = `NOTIFICATION_FROM_EMAIL`. Uses the Resend REST API via fetch (no SDK).
**Why:** the feature ships without blocking on connecting Resend; the queue just
accumulates and flushes automatically once a key exists. If unconfigured, the
worker leaves the queue pending (logs a warning) rather than dropping events.
**How to apply:** to actually send mail, connect the Resend integration or set
`RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL` (Resend needs a verified domain;
`onboarding@resend.dev` works for testing only).
