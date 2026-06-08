---
name: Consultation/quota limit enforcement
description: How to enforce per-group persona consultation limits without silently failing open or skipping the confirm gate.
---

# Consultation limit enforcement (per-group persona quota)

A "raadpleging" (consultation) = one whole persona thread, counted at thread OPEN, per group. Effective limit = `persona.max_consultations` + per-(project,group,persona) extra grant; `null` max = unlimited.

## Fail-open vs defensive-unlimited — they are NOT the same
**Rule:** missing *schema* (column/table absent on old DB) → treat as unlimited (intended defensive behavior, e.g. grants table 42P01 → extra=0, null max → no block). A *transient* error on a **core** table (`group_persona_threads` always exists) → fail **closed** (return 503), do NOT default `used=0`, or the limit is silently bypassed.

**How to apply:** in persona-chat new-thread enforcement, wrap the consultation COUNT in its own try/catch that returns 503 on failure; keep the optional grant-load in a separate try/catch that defaults to `extra=0` (stricter = safe). Never lump count+grant into one catch that defaults both to 0.

## Client gate staleness
The "confirm before starting a new consultation" modal gates on `!activeThreadId && !consultation.hasOpenThread`. After closing a thread the client nulls `activeThreadId` but `hasOpenThread` from the last room fetch stays stale `true`, so the next message would start (and consume) a new consultation WITHOUT the confirm prompt.
**How to apply:** after any thread close (and after persona-chat returns a consultation change), reload room state (`loadRoom()`) so `hasOpenThread`/`used`/`remaining` are fresh before the gate re-evaluates.

**Why:** both gaps were caught in code review, not by tests — enforcement/gating logic that depends on cached server flags or fail-open catches passes unit tests but breaks in the real close→reopen flow.
