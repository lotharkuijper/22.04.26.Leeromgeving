---
name: In-app document rendering (Chat viewer)
description: Durable decisions/gotchas for rendering course-material docs inside the app.
---

# In-app document viewer rendering

**Decision:** course-material docs are shown in-app through a single **pdf.js** viewer. Office formats (docx/pptx/…) are converted to PDF server-side with **headless LibreOffice** and cached; PDFs are served directly; txt/md as text.
**Why:** there is no reliable pure-JS PowerPoint renderer, so LibreOffice→PDF is the only path to high-fidelity slide rendering. It runs headless in the Replit sandbox and carries into deploys.

**Gotchas worth remembering (not obvious from code):**
- LibreOffice headless startup prints `Could not find a Java Runtime Environment` and `Failed to initialize OpenCL` — these are **harmless**; conversion still succeeds. Don't chase them.
- Concurrent `soffice` runs clash on the user profile — each conversion needs its own `-env:UserInstallation` dir and conversions must be serialized.
- **pdfjs-dist v5** worker must be loaded via Vite `?url` from the `.mjs` worker. The older cdnjs `pdf.worker.min.js` pattern elsewhere in the repo is stale for v5 (v5 ships `.mjs`) — don't copy it.
