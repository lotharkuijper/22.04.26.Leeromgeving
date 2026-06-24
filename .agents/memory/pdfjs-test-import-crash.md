---
name: pdfjs test-import crash
description: Why pure PDF helpers live in pdf-pages.ts and not in document-processor.service.ts
---

`src/services/document-processor.service.ts` imports `pdfjs-dist` at module top
level (and sets `GlobalWorkerOptions.workerSrc`). Importing that module from a
vitest test running in the Node environment crashes with `ReferenceError:
DOMMatrix is not defined` (pdfjs canvas.js touches DOM globals at import time).

**Rule:** any pure, unit-testable helper that conceptually belongs to PDF/document
processing must live in a pdfjs-free module (currently `src/services/pdf-pages.ts`)
and be re-exported from `document-processor.service.ts` for back-compat. Tests
import from the pure module, never from the service.

**Why:** a test that imports the service to reach a pure function will fail the
whole suite at import time, not at assertion time — and the error (DOMMatrix) looks
unrelated to your function.

**How to apply:** when adding logic like `assignPdfPages`/`normalizeForMatch`, put
it in `pdf-pages.ts`. If you must test something that genuinely needs pdfjs, mock
`pdfjs-dist` (and the `?url` worker import) instead.
