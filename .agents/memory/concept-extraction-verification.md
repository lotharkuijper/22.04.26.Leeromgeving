---
name: concept-extraction-verification
description: Why /api/admin/extract-concepts can silently save zero concepts (cross-language embedding mismatch in the verification gate).
---

# Concept extraction verification gate

`/api/admin/extract-concepts` runs a two-stage pipeline: (1) an LLM proposes
concept candidates from RAG chunks, then (2) a **verification gate** embeds each
candidate's `name` and vector-searches it against the course's chunks. A
candidate is only saved if it gets `>= min_evidence_chunks` matches at
`>= similarity_threshold` (extraction defaults: 0.55 threshold, 1 chunk). Settings
live in the reserved `__rag_settings_<courseId>__` chatbot_prompts row under the
`extraction` key.

**The trap:** if the LLM names concepts in a different language than the source
chunks (e.g. Dutch names against English course material), `text-embedding-3-small`
cross-language similarity stays below 0.55, so **every** candidate is rejected and
nothing is saved — looking like a silent no-op.

**Why:** the prompt used to hardcode Dutch output. Fix added a `language` param
(`nl`|`en`|`auto`, default `auto`) so the concept name/definition language matches
the material, keeping the candidate name and the chunks in the same embedding space.

**How to apply:** when extraction "saves nothing," suspect a language mismatch
first, not a broken LLM call. The response now exposes `candidatesFromLLM`,
`verificationThreshold`, `minEvidenceChunks`, and `rejected:[{name,maxScore}]` —
if `maxScore` clusters just under the threshold, lower the threshold or switch the
extraction language; if candidates are 0, the LLM genuinely found nothing.
