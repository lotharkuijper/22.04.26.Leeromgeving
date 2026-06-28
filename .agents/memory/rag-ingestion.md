---
name: RAG document ingestion pipeline
description: Where document ingestion runs (client vs server) and how source citations carry slide provenance.
---

- **RAG ingestion is server-side for ALL real formats (pdf/txt/docx/pptx).** The client only uploads the file to storage + creates the `documents` record, then hands off to a per-type server endpoint (`process-pptx`, `process-docx`, `process-rag-document` for pdf/txt/plain) that extracts text, chunks, embeds, and persists. The browser no longer parses, embeds, or inserts chunks for any format.
  - **Why:** client-side parse+embed+insert had weaker extraction AND a non-atomic delete→insert window (a browser close / network drop / RLS failure between the delete and the inserts could leave a doc with 0 or partial chunks). The server path is the only one with a real DB transaction.
  - **How to apply:** when changing ingestion, expect the pipeline to fork by file type into server endpoints. Never reintroduce client-side chunk INSERT/DELETE. All three endpoints share `persistChunksAtomic`; pptx/docx are handled before the pdf/txt/plain catch-all branch.

- **Chunk metadata is the contract for richer citations.** Slide provenance lives in `document_chunks.metadata` (`source:'pptx'`, slide range, section title). Source-citation dedup must key on document **plus** slide range so distinct slides from one deck stay separate; collapsing purely by document loses slide references.

- **LLM provider: replit.md is stale.** It says Groq, but the code uses OpenAI chat/completions (`OPENAI_CHAT_URL` + `OPENAI_MODEL`) and OpenAI embeddings. Groq is not used. Trust the code, not replit.md, on the provider.
  - For newer OpenAI models (gpt-5/o-series) the chat body uses `max_completion_tokens`, not `max_tokens` — there's a runtime switch for this; don't hardcode the param name.

- **Embeddings hit Azure via TWO independent paths — any embedding-behavior change must cover both.** (1) Client-side: browser ingestion → `/api/embeddings` (the path teachers see in upload errors). (2) Server-side: `embedTextsServer` (pptx core, plain-RAG processing, web-import). Both share the retry helper in `server/embeddingsRetry.js` (DI/testable).
  - **Why:** a 429-retry fix wired into only one path silently leaves the other failing. The Azure S0 tier throttles bursts of embedding calls; the resulting HTTP 429 ("retry after N seconds") is a RATE LIMIT, not an auth/key/permission error — don't chase it as a credential bug.
  - **How to apply:** retries are per-batch, not globally coordinated; concurrent multi-file uploads can still exhaust the limit. If 429s persist under load, add a process-level embeddings queue/concurrency limiter rather than raising per-batch retries.

- **Server-side PDF text extraction goes through pdf.js (`extractPdfPageTexts`), NOT officeparser; officeparser is a last-resort fallback only.** The plain-RAG path tries pdf.js first (gives per-page text + page assignment like DOCX), and only falls back to officeparser when pdf.js yields nothing.
  - **Why:** officeparser can "succeed" on some PDFs while returning only a handful of junk characters, so ingest completes with garbage and silently overwrites good chunks. A PDF whose extracted text is `< MIN_PDF_TEXT_CHARS` (20) now throws 422 ("extractie leverde vrijwel niets op") and fails-closed. This guard is PDF-only — docx/xlsx/etc. can legitimately be short, so don't widen it to all binary formats (doing so breaks the docx officeparser fallback).
  - **How to apply:** scanned/image-only PDFs (no text layer) are out of scope — they hit the 422 and need OCR to ingest.

- **Chunk re-ingest must be ATOMIC or it can leave a document with 0 chunks.** `persistChunksAtomic({documentId, rows, deps})` in `server/ragProcessing.js` runs DELETE-old → batched INSERT-new → `UPDATE documents ... status='completed'` in ONE `pgPool` transaction (ROLLBACK on any error, `client.release()` in finally). All three core fns (pptx/docx/plain) build their rows BEFORE calling it.
  - **Why:** the old delete-then-insert was two separate ops; an insert failure (e.g. embeddings/429 mid-way, constraint) left the old chunks deleted and nothing inserted → the doc had 0 chunks and disappeared from RAG. Status must flip to `completed` only after real chunks exist.
  - **How to apply:** without `pgPool` (test env) it falls back to the old supabase delete→insert→update, setting `completed` only after a successful insert (not truly atomic, but acceptable for tests). Embedding is cast `$n::vector` from `'['+arr.join(',')+']'`, metadata `$n::jsonb`, rows batched at `INSERT_BATCH=100` to stay under the param limit.

- **Both upload AND reprocess of pdf/txt delegate to the server atomic path — no client-side swap remains.** The client functions call `POST /api/admin/process-rag-document` (auth mirrors process-pptx/docx: admin/superuser or teacher of a course linked to the doc's folder), which runs `persistChunksAtomic`. The old client embed-all→delete→insert swap and its `destructiveStarted` flag are gone.
  - **Why:** the client has no DB transaction, so any failure between a client delete and insert could empty a doc; only the server's pgPool `persistChunksAtomic` is truly atomic. On failure the server preserves the old chunks (atomic), so the client just restores the document's prior status (`originalStatusForRestore || 'failed'`).
  - **How to apply:** never reintroduce client-side chunk DELETE/INSERT for ingest or reprocess. Atomicity depends on the server having `pgPool`/`SUPABASE_DB_URL` — the Supabase fallback in `persistChunksAtomic` (no pgPool, e.g. tests) is NOT transactional, so production must keep `SUPABASE_DB_URL` set for the guarantee to hold.
