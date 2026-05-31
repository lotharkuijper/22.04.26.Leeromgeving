---
name: RAG document ingestion pipeline
description: Where document ingestion runs (client vs server) and how source citations carry slide provenance.
---

- **Most formats ingest client-side; `.pptx` ingests server-side.** Text/PDF/Word are parsed and embedded in the browser, then chunks are inserted. PowerPoint is the exception: the client creates the doc record and hands off to a server endpoint that parses slides + speaker notes, does LLM semantic chunking with a deterministic fallback, embeds, and replaces the chunks.
  - **Why:** the old client-side pptx path was a raw text/regex decode with no notes/structure and failed on real decks; reliable pptx needs zip parsing + LLM interpretation, which belongs server-side.
  - **How to apply:** when changing ingestion, expect the pipeline to fork by file type. Don't assume one shared path. Keep non-pptx formats untouched unless explicitly asked.

- **Chunk metadata is the contract for richer citations.** Slide provenance lives in `document_chunks.metadata` (`source:'pptx'`, slide range, section title). Source-citation dedup must key on document **plus** slide range so distinct slides from one deck stay separate; collapsing purely by document loses slide references.

- **LLM provider: replit.md is stale.** It says Groq, but the code uses OpenAI chat/completions (`OPENAI_CHAT_URL` + `OPENAI_MODEL`) and OpenAI embeddings. Groq is not used. Trust the code, not replit.md, on the provider.
  - For newer OpenAI models (gpt-5/o-series) the chat body uses `max_completion_tokens`, not `max_tokens` — there's a runtime switch for this; don't hardcode the param name.
