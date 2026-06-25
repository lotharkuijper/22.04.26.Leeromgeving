---
name: RAG retrieval window has two independent gates
description: Why widening match_count alone fails to surface a low-ranked-but-relevant chunk in tutor-chat
---

# RAG retrieval window: two gates, not one

The chat/explain/project RAG path clips the returned chunk set TWICE, and both
gates must be wide enough or a relevant chunk silently disappears:

1. **`match_count`** — per-course (`__rag_settings_<courseId>__`) or global
   (`__rag_settings_global__`) setting, applied as the final `.slice(0, matchCount)`.
2. **`RAG_CONTEXT_MAX_CHUNKS`** in `src/services/rag.service.ts` — a hard client
   cap inside `buildContextWithCap` applied AFTER match_count when assembling the
   LLM context. It was 10 (stale gpt-4o-mini-era comment). Raising a teacher's
   match_count above this cap did nothing — the context was still clipped to 10.

**Why:** A figure-caption chunk that ranks ~13th in its own course folder for a
verbose query (e.g. "wat is DEB's tetrahedron of life?") needs BOTH match_count
≥ its rank AND the cap ≥ its rank to reach the model. The real safety rail
against token blow-up is `RAG_CONTEXT_MAX_CHARS` (18000), not the chunk count;
the chat now runs on Azure gpt-5.5 (large context), so the char cap suffices.

**How to apply:** When a "RAG can't find content that exists" report comes in,
check the resolved match_count AND `RAG_CONTEXT_MAX_CHUNKS` together. Measure the
target chunk's *folder rank* (not just its similarity) — see `.local/top_folder.mjs`
pattern. Widen whichever gate is the binding constraint.

## Companion fixes (same incident)

- **Scope the vector search by document IDs BEFORE the LIMIT.** `match_document_chunks`
  used to pull a global top-N across the whole multi-course corpus, then filter by
  folder in JS — so a small course's own chunks were crowded out by ~1000 sibling
  chunks from other courses and never entered the window. The RPC now takes
  `filter_document_ids uuid[] DEFAULT NULL`; resolve the course's RAG doc IDs first,
  pass them in, and use a generous candidate pool (`match_count * 5`). Also bumps
  `hnsw.ef_search` to 200 inside the function for filtered-scan recall.
- **Embed with a title prefix.** `buildEmbedInput(title, content)` in
  `server/chunking.js` prepends `Document: <title>` to the EMBEDDED text only
  (stored `content` stays clean). Lifts a weak figure-caption chunk's similarity
  (measured 0.31 → ~0.45). Only newly (re-)ingested docs get this; mixed corpus is fine.
- **PDFs are text-extracted via pdf.js, NOT officeparser.** `parseOfficeAsync`
  (officeparser) returned ~15 chars on a 4.8MB DEB PDF; the working path is
  `extractPdfPageTexts` (pdfjs-dist legacy) joined per page, which also drives the
  `assignPdfPages` page-number metadata used for "p. N" source cards.
