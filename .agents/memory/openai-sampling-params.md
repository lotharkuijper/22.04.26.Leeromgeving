---
name: OpenAI sampling params & reasoning-model handling
description: How the app must shape OpenAI requests for the configured reasoning model (temperature/top_p, reasoning_effort, token budget, empty/truncated output) — read before any "Explain/Chat AI broken" or "temperature rejection" task.
---

# OpenAI sampling & reasoning-model handling

The configured `OPENAI_MODEL` is a **reasoning model** (`gpt-5.2`, served as
`gpt-5.2-2025-12-11`). Verified live (dev + production logs): it **rejects** a
non-default `temperature`/`top_p` with an HTTP 400 ("only the default (1) value is
supported"). An earlier note claimed it accepted custom temperature — that was wrong
(or the served snapshot changed). Do not trust that anymore.

**gpt-5.5 (Azure deployment) is also strict — probe each deployment.** Confirmed live
on the VU Azure resource (`leap-openai-vu`, deployment `gpt-5.5`): it rejects (HTTP 400)
a custom `temperature` ("only the default (1)"), `top_p`, AND the legacy `max_tokens`
(must use `max_completion_tokens`); it accepts `reasoning_effort` + `response_format:
json_object`. Param-strictness is NOT guaranteed identical across gpt-5.x minor versions,
so probe the actual deployment before switching, don't assume from the model name.
**Azure routing is by deployment in the URL — the body `model` field is ignored** (a
mismatched `model: gpt-5.2` on the gpt-5.5 deployment still returns 200), so the
`OPENAI_MODEL` secret only drives `IS_REASONING_MODEL`/`MAX_TOKENS_PARAM`, not which model
answers. The routing knob is `AZURE_OPENAI_DEPLOYMENT` (note: it can exist as BOTH a
shared env var and a mirrored secret; the shared env var value wins at runtime — verify
via the startup log line).

**Both the central `/api/chat` path AND every "satellite" call site must shape params.**
The central handler had the reasoning-safe logic; the satellite calls (quiz, grading,
summaries, project-evaluations, document-reviews, cue-emission, pptx-chunking) sent
hardcoded `temperature: 0.x` and only worked because the old gpt-5.1 deployment was
lenient. They now all build sampling params via `chatModelParams({ temperature, maxTokens })`
in `server/index.js` (reasoning ⇒ omit temperature/top_p, add `reasoning_effort`; else
pass temperature; always set the right max-tokens key). When migrating models, audit
EVERY `fetch(OPENAI_CHAT_URL` site, not just `/api/chat`.

**Rule — request shaping for reasoning models** (`/^(gpt-5|o1|o3|o4)/i`, the same
`IS_REASONING_MODEL` regex used for `MAX_TOKENS_PARAM`):
- Do NOT send custom `temperature`/`top_p` at all. Omit them so OpenAI uses the default;
  this avoids a guaranteed 400 + retry on every single call. Only non-reasoning models
  get the caller's `temperature`/`top_p`.
- DO send `reasoning_effort: 'low'`. Reasoning tokens count toward
  `max_completion_tokens`; without a low effort they can eat the whole budget.
- Use a generous token budget. `max_tokens` maps to `max_completion_tokens` for these
  models. A tight budget (e.g. 1500) on a heavy structured prompt yielded an HTTP 200
  with EMPTY content (`finish_reason: "length"`) — see below.
- Keep the runtime 400-retry (`isUnsupportedSamplingParamError` in
  `server/openaiSampling.js`) as a safety net for other models, but it should rarely fire
  now that reasoning models omit the params proactively.

**Why:** the published "Ik leg uit" (Explain) feedback failed while Chat worked. Both hit
the same `/api/chat` (server always uses `OPENAI_MODEL`). Chat asks short answers (default
budget 512) so it fit; Explain sent a heavy 4-part structured prompt with a 1500 budget,
so reasoning consumed the budget and OpenAI returned a 200 with empty/truncated content.
The client surfaced that as a misleading 502/403-style "lege reactie"/"weigerde toegang".

## Empty / truncated completion handling
`isEmptyOrTruncatedCompletion(data)` (pure helper in `server/openaiSampling.js`, tested):
empty/whitespace content OR `finish_reason === "length"` ⇒ true. The `/api/chat` handler,
after a successful HTTP response, retries ONCE with a larger budget (`max(base*2, 2000)`);
if content is still empty it returns 502 `{error:{code:"empty_response"}}`, and if still
truncated (`finish_reason === "length"`) it returns 502 `{error:{code:"length"}}` instead
of passing partial/empty text through as success.

## Error-message mapping (frontend)
`llmErrorToDutch` in `src/services/llm.service.ts` is the single source of the Dutch/EN
error text shown by Explain/Quiz/Chat (the `llm.err.*` i18n keys are NOT used for it).
It has dedicated branches: quota/billing (`insufficient_quota`/402), rate limit (429),
auth (401/403 → "weigerde de toegang"), and now `empty_response`/`length` → a clear
"antwoord paste niet in de beschikbare tokenruimte" message (placed BEFORE the generic
`status >= 500` branch, since these errors carry status 502).

## Debugging a "published Explain is broken" report
- A real OpenAI 4xx/5xx is logged server-side as `[/api/chat] OpenAI error status=...`
  with the full body. An empty 200 logs nothing by itself — that's why the original bug
  left no error line in production logs.
- If a console screenshot shows a 403 + "weigerde toegang" but production logs show
  `/api/chat` succeeding (and an OLD client bundle hash like `llm.service-DX-XXXX.js`),
  suspect a STALE cached client bundle — have the user republish and hard-refresh rather
  than chasing a server bug that isn't there.
