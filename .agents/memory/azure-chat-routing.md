---
name: Azure chat routing vs OPENAI_MODEL
description: Why chat responses report gpt-5.1 even though OPENAI_MODEL secret is gpt-5.2; Azure routes by deployment-in-URL, not body model.
---

# Azure chat routing vs OPENAI_MODEL

Chat/completions route through Azure OpenAI by putting the **deployment name in the URL**
(`/openai/deployments/<dep>/chat/completions?api-version=...`) with the `api-key:` header.
The request body's `model` field is **ignored** by Azure — routing is purely by the deployment in the URL.

**Gotcha:** the `OPENAI_MODEL` secret can hold a different value (e.g. `gpt-5.2`) than the actual
Azure deployment (`gpt-5.1`, set via `AZURE_OPENAI_DEPLOYMENT` env var). So startup logs print
`Chat-model: gpt-5.2` (from OPENAI_MODEL, used only for the body + `IS_REASONING_MODEL`/`MAX_TOKENS_PARAM`
detection) while actual responses come back as `gpt-5.1-...`. This is expected, not a bug.

**Why:** `AZURE_OPENAI_DEPLOYMENT` is set explicitly so deployment routing does NOT depend on the
`OPENAI_MODEL` secret value. Both gpt-5.x names match `IS_REASONING_MODEL` so reasoning params stay correct.

**How to apply:** to change the actual chat model, change the Azure deployment (env var
`AZURE_OPENAI_DEPLOYMENT` or the deployment in the Azure resource), not `OPENAI_MODEL`. The
api-version `2024-10-21` is verified working with the `gpt-5.1` deployment.
