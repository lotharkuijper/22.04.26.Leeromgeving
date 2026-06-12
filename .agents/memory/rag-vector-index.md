---
name: RAG vector index (document_chunks.embedding)
description: Why the embedding index is HNSW, and the ivfflat zero-recall trap that motivated it.
---

The `document_chunks.embedding` index is **HNSW** (`vector_cosine_ops`), not ivfflat.

**Why:** The original index was `ivfflat (... ) WITH (lists=100)`. ivfflat only scans
`ivfflat.probes` clusters per query (default **1**). With ~100 clusters over only a few
hundred chunks, each cluster holds a handful of vectors, so an arbitrary query vector
almost always probes a near-empty cluster and `match_document_chunks` returns **ZERO**
rows — even though an exact seqscan finds relevant chunks (similarity up to ~0.58). This
made RAG search (chat/explain/quiz/project) fail *silently* — no error, just "0 results".

**How to apply:**
- Symptom to recognize: RAG/explain/quiz returns no course material, but a direct
  `SELECT ... 1-(embedding <=> q) ORDER BY embedding <=> q LIMIT n` aggregate (seqscan)
  DOES find matches. The gap between seqscan recall and `ORDER BY ... LIMIT` (index) recall
  = an approximate-index recall problem, not an embeddings problem.
- Quick confirm: `SET ivfflat.probes = 10;` then re-run — if rows appear, it was the index.
- Fix used: drop ivfflat, `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`.
  HNSW gives high recall with defaults, no probe tuning, scales with corpus growth.
  Vector space unchanged (1536-dim cosine) so no re-embed.
- pgvector here is 0.8.0 (HNSW available). Migration: `20260612100000_document_chunks_hnsw_index.sql`.
- Don't mistake this for an Azure-embedding failure: Azure `text-embedding-3-small`
  returns 1536-dim vectors identical in space to the old public-OpenAI ones; the embed
  call and dimension were fine — only the index recall was broken.
