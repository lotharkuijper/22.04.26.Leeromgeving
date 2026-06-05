---
name: concept-extraction-replace-ordering
description: Replace/regenerate mode in /api/admin/extract-concepts must write concepts BEFORE cleaning up old ones, and cleanup must be keep-aware.
---

# Concept extraction replace-mode ordering

In replace/regenerate mode, `/api/admin/extract-concepts` both writes new
concepts and deletes the course's stale RAG concepts. The order and the cleanup
filter are load-bearing.

**The rule:** write (insert + update) first, return 500 on any write error
*before* cleanup, then run the cleanup keep-aware — every concept name produced
in this run (`keepNames`, lowercased/trimmed) must be retained. Cleanup only
deletes RAG-tagged concepts of the course whose names are NOT in `keepNames`.

**Why:** the original bug ran cleanup BEFORE insert and matched on
course+RAG marker, so it deleted the concepts the same request had just
inserted — net zero persisted while the UI still reported "N added" and the
Begrippen tab stayed empty. A naive "cleanup first to free names" also leaves an
empty-window data-loss risk if the subsequent write fails.

**Two correctness traps that bit us:**
- Cleanup must be keep-aware, not just course-scoped — otherwise re-proposed
  concepts get deleted right after being (re-)written.
- On the shared-concept update path, only add the RAG marker if the existing row
  was already RAG-tagged. Blindly adding it relabels manually-authored shared
  concepts as RAG and makes them deletable by a later cleanup.

**How to apply:** the persistence logic lives in pure helpers
`server/conceptExtraction.js` (`planConceptWrites`, `planConceptReplace`,
`courseMarkerFor`, `RAG_MARKER`) so it is unit-testable without a DB. This DB has
no `concepts.course_id` column — course membership is encoded as a
`course_id:<uuid>` string inside the `key_points` array (key_points fallback
path). If you touch this endpoint, keep writes-fatal-before-cleanup and keep
cleanup keep-aware.
