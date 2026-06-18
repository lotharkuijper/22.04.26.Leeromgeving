---
name: Test environment flakiness (sandbox)
description: Why vitest failures in this sandbox are often environmental timeouts, not regressions
---

In the shared sandbox, vitest failures that are **timeouts** or **partial
userEvent input** (e.g. an email input that only received "je@" of
"je@vu.nl") are almost always the box being CPU/memory-starved — not a logic
regression. Common trigger: the dev server plus a heavy generator workflow
running while vitest also runs; the import phase alone hits 60–85s and a
direct `npx vitest` gets OOM-killed (exit -1, no output).

**Why:** Vitest defaults (testTimeout 5s / hookTimeout 10s) are too tight
under load. The server endpoint suites' `beforeAll` boots the **entire
Express app** (`await import('../index.js')` + `app.listen`), which is the
single slowest step and the first to blow its hook budget.

**How to apply:** Before treating such failures as bugs: (1) confirm the
implicated source/test files are unchanged vs HEAD; (2) re-run via the `test`
workflow, not direct bash — the workflow runner has more headroom; (3) on a
quiet box the full suite passes in ~20s. `testTimeout: 15000` /
`hookTimeout: 30000` in vite.config absorb the load without masking real bugs
(assertions and product behavior are unchanged).
