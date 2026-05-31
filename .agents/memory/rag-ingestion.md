---
name: RAG document ingestion pipeline
description: How uploaded documents become RAG chunks; which formats are client- vs server-side.
---

- Most RAG ingestion is CLIENT-side: `src/services/document-upload.service.ts` (`uploadDocument` / `retryFailedDocument`) → `processDocument` (pdf.js/mammoth/regex) → `/api/embeddings` → insert `document_chunks`.
- EXCEPTION: `.pptx` is processed SERVER-side via `POST /api/admin/process-pptx` (server downloads the file from storage by documentId, parses slides + speaker notes, does windowed LLM semantic chunking with a deterministic per-window fallback, embeds, replaces `document_chunks`, sets `documents.processing_status`). The client just creates the doc record then calls the endpoint.
  - **Why:** the old client-side pptx path was a raw `<a:t>` regex with no notes/structure and failed often; pptx needs zip parsing + LLM interpretation that belongs on the server.
  - **How to apply:** when touching ingestion, remember pptx and other formats diverge at the `isPptx` branch. Pure pptx helpers live in `server/pptxExtract.js` (unit-tested); endpoint orchestration lives in `server/index.js`.
- Chunk slide provenance is stored in `document_chunks.metadata` (`slideStart/slideEnd/sectionTitle/source:'pptx'/chunkingMode`) but is NOT yet rendered in the UI.

- [LLM/Groq note] replit.md still says the LLM is Groq `llama-3.3-70b-versatile`, but the code uses OpenAI chat/completions (`OPENAI_CHAT_URL` + `OPENAI_MODEL`, default `gpt-4o-mini`; running env was `gpt-5.2`). Groq is NOT used. Trust the code, not replit.md, on the LLM provider.
- Model max-tokens param: `MAX_TOKENS_PARAM` switches to `max_completion_tokens` for `gpt-5/o1/o3/o4`; use it instead of hardcoding `max_tokens` in OpenAI chat bodies.
