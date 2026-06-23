---
name: Verify a fix is published before re-debugging it
description: When a user insists an already-merged/working feature is still broken, suspect a stale production deploy before touching code.
---

When a user reports that a feature you believe is fixed is "still broken," check whether the fix commit is **newer than the last `Published your App` commit** in `git log`. If so, the dev/main code can be fully correct while the deployed (production) app still runs the pre-fix code.

**Why:** Reports like "docent kan cursusmap niet zien" were reproduced as production-only: the dev server (verified by live API calls as the actual user) returned the correct result, but the last publish predated the fix commit, so the live VU app served old behavior. Rewriting correct code would have introduced regressions and never addressed the real gap (an unpublished deploy).

**How to apply:** Before changing code in response to "still broken," (1) confirm dev works end-to-end (see `live-test-as-user.md`), (2) run `git --no-optional-locks log --oneline` and compare the fix commit position to the latest `Published your App` marker, (3) if the fix is unpublished, recommend re-deploying rather than editing. Also rule out a stale browser bundle/session (hard refresh / re-login) when the user is on the dev preview.
