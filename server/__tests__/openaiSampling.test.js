import { describe, it, expect } from 'vitest';
import { isUnsupportedSamplingParamError, isEmptyOrTruncatedCompletion, postChatCompletionWithRetry } from '../openaiSampling.js';

// Bouwt een nep-fetch dat de opgegeven antwoorden (in volgorde) teruggeeft en
// elke aanroep + verstuurde body registreert.
function makeFetchStub(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const next = queue.shift();
    const rawText = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return {
      ok: next.ok,
      status: next.status,
      text: async () => rawText,
    };
  };
  return { fetchImpl, calls };
}

describe('isUnsupportedSamplingParamError', () => {
  it('returns false for empty/ok responses', () => {
    expect(isUnsupportedSamplingParamError(undefined)).toBe(false);
    expect(isUnsupportedSamplingParamError(null)).toBe(false);
    expect(isUnsupportedSamplingParamError({})).toBe(false);
    expect(isUnsupportedSamplingParamError({ choices: [] })).toBe(false);
  });

  it('detects rejection via error.param', () => {
    expect(isUnsupportedSamplingParamError({ error: { param: 'temperature' } })).toBe(true);
    expect(isUnsupportedSamplingParamError({ error: { param: 'top_p' } })).toBe(true);
    expect(isUnsupportedSamplingParamError({ error: { param: 'TOP_P' } })).toBe(true);
  });

  it('detects rejection via error.message', () => {
    expect(
      isUnsupportedSamplingParamError({
        error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." },
      }),
    ).toBe(true);
    expect(
      isUnsupportedSamplingParamError({
        error: { message: 'top_p is not supported with this model.' },
      }),
    ).toBe(true);
  });

  it('does not match unrelated 400 errors', () => {
    expect(
      isUnsupportedSamplingParamError({
        error: { code: 'context_length_exceeded', message: 'maximum context length is 128000 tokens' },
      }),
    ).toBe(false);
    expect(
      isUnsupportedSamplingParamError({
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
      }),
    ).toBe(false);
    // mentions temperature but not as an unsupported-param error
    expect(
      isUnsupportedSamplingParamError({
        error: { message: 'The temperature outside is nice today' },
      }),
    ).toBe(false);
  });
});

describe('isEmptyOrTruncatedCompletion', () => {
  it('treats missing/empty choices as empty', () => {
    expect(isEmptyOrTruncatedCompletion(undefined)).toBe(true);
    expect(isEmptyOrTruncatedCompletion(null)).toBe(true);
    expect(isEmptyOrTruncatedCompletion({})).toBe(true);
    expect(isEmptyOrTruncatedCompletion({ choices: [] })).toBe(true);
  });

  it('treats empty or whitespace content as empty', () => {
    expect(isEmptyOrTruncatedCompletion({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })).toBe(true);
    expect(isEmptyOrTruncatedCompletion({ choices: [{ message: { content: '   \n' }, finish_reason: 'stop' }] })).toBe(true);
    expect(isEmptyOrTruncatedCompletion({ choices: [{ message: {}, finish_reason: 'stop' }] })).toBe(true);
  });

  it('treats finish_reason "length" as truncated even with content', () => {
    expect(isEmptyOrTruncatedCompletion({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })).toBe(true);
  });

  it('returns false for a complete response', () => {
    expect(isEmptyOrTruncatedCompletion({ choices: [{ message: { content: 'volledige feedback' }, finish_reason: 'stop' }] })).toBe(false);
  });
});

describe('postChatCompletionWithRetry', () => {
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = { 'api-key': 'k' };
  const body = {
    model: 'o3-mini',
    messages: [{ role: 'user', content: 'hoi' }],
    temperature: 0.3,
    top_p: 0.9,
    max_completion_tokens: 100,
    response_format: { type: 'json_object' },
  };

  it('retries once without temperature/top_p when the model rejects them', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { ok: false, status: 400, body: { error: { param: 'temperature', message: 'Unsupported value' } } },
      { ok: true, status: 200, body: { choices: [{ message: { content: '{"ok":true}' } }] } },
    ]);

    const resp = await postChatCompletionWithRetry({ url, headers, body, fetchImpl });

    expect(calls).toHaveLength(2);
    // Eerste poging stuurt de sampling-parameters mee.
    expect(calls[0].body.temperature).toBe(0.3);
    expect(calls[0].body.top_p).toBe(0.9);
    // Retry laat temperature/top_p weg maar behoudt response_format en token-limiet.
    expect(calls[1].body).not.toHaveProperty('temperature');
    expect(calls[1].body).not.toHaveProperty('top_p');
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1].body.max_completion_tokens).toBe(100);
    // Het uiteindelijke (geslaagde) antwoord wordt teruggegeven.
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
    expect((await resp.json()).choices[0].message.content).toBe('{"ok":true}');
  });

  it('does not retry on a successful first response', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { ok: true, status: 200, body: { choices: [{ message: { content: 'hallo' } }] } },
    ]);

    const resp = await postChatCompletionWithRetry({ url, headers, body, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.temperature).toBe(0.3);
    expect(resp.ok).toBe(true);
  });

  it('does not retry on an unrelated 400 error', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { ok: false, status: 400, body: { error: { code: 'context_length_exceeded', message: 'too long' } } },
    ]);

    const resp = await postChatCompletionWithRetry({ url, headers, body, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(400);
    expect((await resp.json()).error.code).toBe('context_length_exceeded');
  });

  it('exposes the raw text body even when it is not JSON', async () => {
    const { fetchImpl } = makeFetchStub([
      { ok: false, status: 500, body: 'Internal Server Error' },
    ]);

    const resp = await postChatCompletionWithRetry({ url, headers, body, fetchImpl });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(500);
    expect(await resp.text()).toBe('Internal Server Error');
    expect(await resp.json()).toBeNull();
  });
});
