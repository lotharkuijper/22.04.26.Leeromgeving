---
name: Soft-delete on RLS-readable tables must redact content
description: Why server-side masking of soft-deleted rows is NOT enough when course readers can SELECT the table directly and it's in supabase_realtime.
---

When a table is readable directly by clients via a permissive SELECT RLS policy
(e.g. visibility-based course access mirroring `canAccessCourseContent`) **and** is
added to the `supabase_realtime` publication, soft-delete must REDACT the
student-visible content columns at delete time — masking only in the Express/
service-role response is insufficient.

**Why:** the browser holds the Supabase anon client and can `SELECT` the row
directly under RLS, and the soft-delete UPDATE is broadcast as a realtime payload
carrying the (still-populated) NEW row. Both bypass the server's response shaping,
so a soft-deleted post's `body`/`title`/`author`/`reactions` leak to course peers.

**How to apply:** on soft-delete, keep only audit columns (`deleted_at`,
`deleted_by`) and blank everything reader-visible — `body=''`, `title=''` (NOT NULL
columns → empty string, never null), `author_id=null`, `kudos_*=null`,
`reactions={}`. Centralize this in one tested helper so both the thread and reply
(or parent/child) delete paths stay in lockstep. Because the redaction is in the
same UPDATE that sets `deleted_at`, the realtime payload is already harmless and
you can leave `deleted_at` out of the SELECT policy so the realtime nudge still
reaches peers (they refetch via the server, which filters deleted rows). Check the
`{error}` of these UPDATEs — a silent failure means content was NOT redacted.

**Parent→child cascade must be atomic (or fail-closed ordered):** when deleting a
parent (thread) whose children (replies) live in their OWN RLS-readable table, the
child redaction is part of the same security boundary — redact children too, or
their content stays directly readable under the deleted parent. Do NOT redact the
parent first then the children in two independent UPDATEs: if the second fails you
get a deleted parent with still-readable children (exactly the leak). Run both in a
single `pgPool` transaction (`BEGIN`/`COMMIT`, `ROLLBACK` on error, `client.release()`
in `finally`). For the no-pgPool fallback (test env), redact CHILDREN FIRST, then the
parent — that ordering is fail-closed because a failed child cascade leaves the parent
not-yet-deleted (no leak window).
