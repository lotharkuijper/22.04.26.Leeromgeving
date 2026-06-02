---
name: In-app document rendering (Chat viewer)
description: How course-material docs are rendered in-app, and the pdf.js v5 / LibreOffice gotchas.
---

# In-app document viewer rendering

Course-material sources can be viewed inside Chat via a unified **pdf.js** viewer.
- PDF → served as a signed URL of the original.
- docx/pptx (and odt/odp/doc/ppt) → converted server-side to PDF with **LibreOffice headless** (`soffice`), cached in Supabase Storage under `__renditions__/<documentId>-<updated_at_ms>.pdf` in the `rag_sources` bucket.
- txt/md → returned as plain text.

**Why LibreOffice:** it is the only reliable way to get high-fidelity PowerPoint/Word rendering; there is no good pure-JS pptx renderer. It is installed as a Nix system dependency (`installSystemDependencies(["libreoffice"])`).

**How to apply / gotchas:**
- `soffice` runs headless fine in the Replit sandbox and carries into deploys. The startup warnings `Could not find a Java Runtime Environment` and `Failed to initialize OpenCL` are **harmless** — conversion still succeeds. Do not chase them.
- Each conversion must use a unique `-env:UserInstallation=file://<tmpdir>` profile, and conversions are serialized (one soffice process at a time) to avoid profile-lock clashes / memory spikes.
- **pdfjs-dist v5 worker must be wired via Vite `?url`**: `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`. The older cdnjs `pdf.worker.min.js` URL pattern (still present in `document-processor.service.ts`) is wrong for v5 (v5 ships `.mjs`, not `.js`) — don't copy that pattern for new code.
- Always `pdf.destroy()` the pdfjs document on unmount/doc-switch, and `renderTask.cancel()` before re-rendering, or workers/memory accumulate in long sessions.
- The rendition cache key includes the document's `updated_at` so a replaced source produces a fresh PDF instead of serving a stale one.
