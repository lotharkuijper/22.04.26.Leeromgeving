---
name: Vite mid-session dep re-optimization crash
description: Heavy deps used only behind React.lazy routes must be pre-bundled or they crash the app mid-session in dev.
---

# Vite mid-session dep re-optimization crash

A heavy third-party dep that is imported ONLY behind a `React.lazy(() => import(...))`
route (i.e. not reachable from the initial/login bundle) is not always pre-bundled by
Vite's startup scan. The first time the browser visits such a route, Vite discovers the
dep and **re-optimizes mid-session**, which changes the `?v=<hash>` query on every
optimized chunk. The already-loaded tab still holds the OLD-hash chunk URLs, so:

- dynamic import 404s → `Failed to fetch dynamically imported module: .../SomePage.tsx`
- React gets loaded twice (old hash + new hash) → `Invalid hook call ... more than one
  copy of React` and `Cannot read properties of null (reading 'useState')`.

The app appears to "not start" and the error surfaces through `LazyChunkErrorBoundary`.

**Why:** Vite dev only re-bundles deps lazily; lazy-route-only deps slip past the
initial scan and trigger a disruptive re-optimization on first visit.

**How to apply:**
- Put every heavy dep that lives ONLY behind a lazy route into
  `optimizeDeps.include` in `vite.config.ts` so it is pre-bundled at server start.
  Currently includes the markdown/KaTeX stack (`react-markdown`, `remark-gfm`,
  `remark-math`, `rehype-katex`, `katex`), the Tiptap editor (`@tiptap/react`,
  `@tiptap/starter-kit`, `tiptap-markdown`) and `mammoth`.
- `pdfjs-dist` and `lucide-react` use the opposite mitigation: kept in
  `optimizeDeps.exclude` (pre-bundling the pdf.worker `?url` caused the same re-opt).
- After changing the list, restart the workflow and verify the deps appear in
  `node_modules/.vite/deps/` and that a fresh page load is clean — transient errors
  from the still-open stale tab during the restart are expected; judge by a fresh load.
- When adding any new heavy dep to a lazy page in the future, add it here too.
