---
name: Azure embeddings migration
description: Embeddings run on the same VU Azure OpenAI resource as chat, fail-closed, no public-OpenAI fallback ever.
---

# Embeddings on VU Azure OpenAI

Both chat AND embeddings must run exclusively on the VU Azure OpenAI key. Public OpenAI (`api.openai.com`) is FORBIDDEN and there must be NO fallback path, ever — this is a hard, user-confirmed institutional requirement (VU data-governance), not a preference.

**How embeddings are wired (mirrors the chat setup):**
- Auth is the Azure `api-key` header via `embeddingAuthHeaders()` — NOT a Bearer token. Routing is deployment-in-URL (`OPENAI_EMBEDDINGS_URL` built from `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`), same as chat routes by deployment-in-URL.
- Readiness gate: `AZURE_EMBEDDINGS_READY` (endpoint + key + embedding-deployment all present). When not ready, `OPENAI_EMBEDDINGS_URL` is `''` so there is structurally nothing to call — every embedding/ingestion/extraction entry point returns 503 (RAG search returns empty matches). This is intentional fail-closed behavior.

**Key decision — `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` has NO default.**
**Why:** a wrong/guessed deployment name yields a 404 from Azure (confusing) instead of a clean 503; and a silent default could mask a misconfiguration and (worse) imply a fallback. Forcing the env var to be set keeps the system honestly fail-closed until an admin provisions the Azure embedding deployment.
**How to apply:** if RAG/ingestion/concept-extraction is returning 503 in an environment, check that `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` is set — that is the expected gate, not a bug.

**No wipe / no re-embed:** Azure `text-embedding-3-small` is the same 1536-dim space as the previously-used public OpenAI embeddings, so existing vectors stay valid — migrating the call path does not require re-embedding stored chunks.

**Leftover `process.env.OPENAI_API_KEY` reads in chat paths are dead/harmless:** they are never used to build a request header (no `Bearer ${apiKey}` anywhere) and every chat site gates on `AZURE_CHAT_READY`. Removing the `OPENAI_API_KEY` secret later will not break chat or embeddings. `/api/health` still returns a legacy `openai` boolean from that secret, but the client reads `azureEmbeddings` instead.

**Diagnostic heuristic — "everything scores 0":** when extract-concepts (or any RAG search) returns `max=0.000, kandidaten=0` for EVERY query, the query-side embedding call is failing — it is NOT a low-similarity/threshold problem. Most common cause: the Azure embedding *deployment* does not actually exist yet on the resource (404), even though the env var name is correct and `AZURE_EMBEDDINGS_READY` is true (readiness only checks the var is set, not that the deployment exists). `AZURE_EMBEDDINGS_READY` passing just means the URL is built; the deployment can still 404 at call time.
**Why this was invisible:** `searchChunksServerSide` used to swallow a non-ok embedding response and return empty with no log. It now logs HTTP status + body on embed failure, missing-vector, and RPC error. To confirm the deployment exists, curl `POST {endpoint}/openai/deployments/{dep}/embeddings?api-version=...` with the `api-key` header and check for HTTP 200 + 1536-dim vector; stored vectors being intact (`select count(embedding), vector_dims(embedding) from document_chunks`) rules out the storage side.
