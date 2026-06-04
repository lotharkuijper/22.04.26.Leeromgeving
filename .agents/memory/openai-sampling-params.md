---
name: OpenAI sampling params & model rejection
description: Which OpenAI models reject custom temperature/top_p, and how the app handles it — read before "fix temperature rejection" tasks.
---

# OpenAI sampling-parameter rejection

The configured `OPENAI_MODEL` (currently `gpt-5.2`) **accepts** custom `temperature` /
`top_p` / `max_completion_tokens` fine (verified live: HTTP 200 with temp 0.3/0.5).
Only true reasoning models (`o1`, `o3`, `o4`, and some bare `gpt-5` variants) reject a
non-default `temperature`/`top_p` with a 400.

**Rule:** do NOT blanket-strip `temperature`/`top_p` by model-name regex. The existing
`MAX_TOKENS_PARAM` name-regex pattern (`/^(gpt-5|o1|o3|o4)/`) matches gpt-5.2 too —
reusing it to strip temperature would force gpt-5.2 to default randomness (1.0) and
silently degrade the tuned 0.3/0.7 outputs across chat/explain/quiz.

**Why:** Task framed the ExplainPage "Het taalmodel weigerde het verzoek." failure as a
gpt-5.2 temperature rejection. That hypothesis was disproven — gpt-5.2 works; the real
failure was almost certainly a transient provider event (quota/limit/capacity).

**How to apply:** handle the rejection at runtime — if OpenAI returns a 400 that
specifically names `temperature`/`top_p` as unsupported, retry once without them. Pure
detector lives in `server/openaiSampling.js` (`isUnsupportedSamplingParamError`); the
`/api/chat` handler uses it. Other AI call sites (quiz/eval) don't have the retry yet.

## Error-message mapping (frontend)
`llmErrorToDutch` in `src/services/llm.service.ts` is the single source of the Dutch/EN
error text shown by Explain/Quiz/Chat (the `llm.err.*` i18n keys are NOT used for it).
"Het taalmodel weigerde het verzoek." = a 4xx that is not 429 / not context-length /
not (now) quota-or-auth. Quota/billing (`insufficient_quota`/402) and auth (401/403)
have their own clearer branches.
