---
name: Studiecafé unread model
description: How "new"/unread is computed for the studiecafe forum — soft-rollout floor + per-thread reads + manual-unread override.
---

# Studiecafé unread model

Three layers decide whether a thread shows as "Nieuw" for a reader. They are
deliberately separate; changing one without the others creates inconsistencies
between the in-page highlight and the nav badge.

1. **Soft-rollout floor** (`studiecafe_last_seen`, per user+course). Frozen on
   first visit. Any thread with `last_activity_at <= floor` is treated as read
   (backlog suppression) so introducing the feature doesn't flood everyone with
   "new" markers for old content. The client freezes this baseline once per visit
   and does NOT bump it on every visit (that was the old #307 behaviour).
2. **Per-thread reads** (`studiecafe_thread_reads.read_at`, per user+thread).
   Opening a thread marks only that thread read.
3. **Manual-unread override** (`studiecafe_thread_reads.manual_unread` boolean).
   Lets a student re-flag ANY thread as new, including backlog before the floor.

**Why manual_unread is a column, not a deleted read-row:** the original
"mark unread" just deleted the read-row, which only re-surfaced post-floor
threads (the floor check still suppressed backlog). The marker bypasses the floor
*and* read checks (`isThreadUnreadFor(..., manualUnread)` short-circuits to true
when there's activity). Opening the thread or "mark all read" sets it back to
false.

**How to apply:**
- The unread decision lives in pure helpers `isThreadUnreadFor` /
  `summarizeUnreadThreads` (server/studiecafe.js), mirrored client-side in
  `StudiecafePage.isUnread` / `unreadStats`. Keep server and client in lockstep.
- The nav badge is fed by `GET /unread` (summarizeUnreadThreads); the in-page
  highlight by the client helper. Both must consider all three layers.
- New optional columns on studiecafe_thread_reads need a defensive retry-without-
  column path (old DBs); see getThreadReads / markThreadRead / markThreadUnread.
