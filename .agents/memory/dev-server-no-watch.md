---
name: Dev server has no watch — server changes need a workflow restart
description: npm run dev runs Express via plain node (no nodemon/watch); server-side changes (incl. newly merged endpoints) 404 until the Start application workflow is restarted.
---

`npm run dev` = `concurrently "node server/index.js" "vite"`. Vite hot-reloads the
frontend, but the Express server runs under **plain `node` with no watcher**. Any
change to `server/index.js` (or anything it imports) — including endpoints added by
a just-merged task — does NOT take effect until the **Start application** workflow
is fully restarted.

**Why it bites:** the symptom is a frontend feature that "silently does nothing".
A new server endpoint 404s, and well-behaved clients (e.g. `useContentTranslation`)
treat any non-ok response as a silent fallback to the original — so a translation
feature just kept showing Dutch with no visible error, even though the code,
Azure, and DB were all correct. The frontend looked updated (Vite HMR'd it) while
the server was stale.

**How to apply:** When a server-backed feature appears not to work right after an
edit or a task merge, first check the server isn't stale. Probe the local port
directly: `curl -s -o /dev/null -w '%{http_code}' -X POST
http://localhost:3001/api/<route>` (server listens on `0.0.0.0:3001`). A **404
"Cannot POST /api/..."** with `/api/health` returning 200 = stale server →
`restart_workflow("Start application")`; a live route returns 401/400/200. Always
restart the workflow after editing server code; don't rely on HMR for the backend.
