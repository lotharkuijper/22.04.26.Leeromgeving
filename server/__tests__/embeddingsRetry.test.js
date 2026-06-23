import { describe, it, expect } from 'vitest';
import {
  embeddingsRequestWithRetry,
  parseRetryWaitMs,
  isRateLimitStatus,
  EMBEDDINGS_RATE_LIMIT_MSG,
} from '../embeddingsRetry.js';

// Bouw een nep-Response met optionele Retry-After-header en JSON-body.
function makeResp({ ok = true, status = 200, body = {}, retryAfter = null }) {
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => body,
  };
}

// fetch-stub die opeenvolgende responses teruggeeft; telt aanroepen.
function makeFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const noWait = () => Promise.resolve();
const baseDeps = (fetchImpl, extra = {}) => ({
  fetchImpl,
  url: 'https://example/embeddings',
  headers: () => ({ 'api-key': 'x' }),
  sleep: noWait,
  ...extra,
});

describe('isRateLimitStatus', () => {
  it('detecteert HTTP 429', () => {
    expect(isRateLimitStatus(429, {})).toBe(true);
  });
  it('detecteert rate_limit_exceeded-code', () => {
    expect(isRateLimitStatus(400, { error: { code: 'rate_limit_exceeded' } })).toBe(true);
  });
  it('is false voor gewone fouten', () => {
    expect(isRateLimitStatus(500, { error: { code: 'server_error' } })).toBe(false);
    expect(isRateLimitStatus(200, {})).toBe(false);
  });
});

describe('parseRetryWaitMs', () => {
  it('leest de Retry-After-header (seconden) met marge', () => {
    const resp = makeResp({ ok: false, status: 429, retryAfter: '10' });
    expect(parseRetryWaitMs(resp, {}, 0)).toBe(10500);
  });

  it('leest de wachttijd uit de Azure-foutmelding ("retry after 56 seconds")', () => {
    const resp = makeResp({ ok: false, status: 429 });
    const errData = { error: { message: 'exceeded the call rate limit. Please retry after 56 seconds.' } };
    expect(parseRetryWaitMs(resp, errData, 0)).toBe(56500);
  });

  it('leest "try again in 5s"', () => {
    const resp = makeResp({ ok: false, status: 429 });
    const errData = { error: { message: 'Rate limit reached. Please try again in 5s.' } };
    expect(parseRetryWaitMs(resp, errData, 0)).toBe(5500);
  });

  it('begrenst op maxWaitMs', () => {
    const resp = makeResp({ ok: false, status: 429, retryAfter: '999' });
    expect(parseRetryWaitMs(resp, {}, 0, { maxWaitMs: 60000 })).toBe(60000);
  });

  it('valt terug op exponentiele backoff zonder hint', () => {
    const resp = makeResp({ ok: false, status: 429 });
    expect(parseRetryWaitMs(resp, {}, 0)).toBe(1500); // 2^0 = 1s + 0.5s
    expect(parseRetryWaitMs(resp, {}, 2)).toBe(4500); // 2^2 = 4s + 0.5s
  });
});

describe('embeddingsRequestWithRetry', () => {
  it('geeft data terug bij succes zonder retry', async () => {
    const fetchImpl = makeFetch([makeResp({ body: { data: [{ embedding: [1, 2, 3] }] } })]);
    const data = await embeddingsRequestWithRetry(['hoi'], baseDeps(fetchImpl));
    expect(data.data).toHaveLength(1);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('probeert opnieuw na een 429 en slaagt daarna', async () => {
    const fetchImpl = makeFetch([
      makeResp({ ok: false, status: 429, body: { error: { message: 'retry after 1 seconds' } } }),
      makeResp({ body: { data: [{ embedding: [0.1] }] } }),
    ]);
    const data = await embeddingsRequestWithRetry(['x'], baseDeps(fetchImpl));
    expect(data.data).toHaveLength(1);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('geeft na uitputten van de pogingen een vriendelijke NL-melding + isRateLimit', async () => {
    const fetchImpl = makeFetch([
      makeResp({ ok: false, status: 429, body: { error: { message: 'rate limit' } } }),
    ]);
    await expect(
      embeddingsRequestWithRetry(['x'], baseDeps(fetchImpl, { maxRetries: 2 })),
    ).rejects.toMatchObject({ isRateLimit: true, status: 429, message: EMBEDDINGS_RATE_LIMIT_MSG });
    // 1e poging + 2 retries = 3 calls
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('herhaalt NIET bij een niet-rate-limit-fout', async () => {
    const fetchImpl = makeFetch([
      makeResp({ ok: false, status: 500, body: { error: { message: 'boom' } } }),
    ]);
    await expect(
      embeddingsRequestWithRetry(['x'], baseDeps(fetchImpl)),
    ).rejects.toMatchObject({ isRateLimit: false, status: 500, message: 'boom' });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('herhaalt bij een netwerkfout en slaagt daarna', async () => {
    const fetchImpl = makeFetch([
      new Error('ECONNRESET'),
      makeResp({ body: { data: [{ embedding: [9] }] } }),
    ]);
    const data = await embeddingsRequestWithRetry(['x'], baseDeps(fetchImpl));
    expect(data.data).toHaveLength(1);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('gooit bij een onverwachte responsvorm', async () => {
    const fetchImpl = makeFetch([makeResp({ body: { unexpected: true } })]);
    await expect(
      embeddingsRequestWithRetry(['x'], baseDeps(fetchImpl)),
    ).rejects.toThrow(/Onverwacht antwoord/);
  });
});
