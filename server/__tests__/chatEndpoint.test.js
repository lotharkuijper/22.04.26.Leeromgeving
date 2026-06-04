import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Integratietest voor de /api/chat-handler (Task #231). De handler beschermt
// tegen reasoning-modellen (zoals gpt-5.2) die een HTTP 200 met lege of
// afgekapte content teruggeven: bij een lege/afgekapte eerste respons volgt één
// retry met ruimer tokenbudget; blijft het leeg, dan een duidelijke HTTP 502
// met code "empty_response" i.p.v. een misleidende lege 200.
//
// We mounten de echte Express-app op een efemere poort en mocken global.fetch
// zodat geen echte OpenAI-call wordt gedaan. supabaseAdmin/pgPool zijn null
// (env geneutraliseerd vóór import), dus de handler gebruikt de fallback-prompt
// en raakt geen database. De HTTP-verzoeken lopen via het node:http-pad zodat
// de gemockte global.fetch alleen de OpenAI-calls onderschept.
// ───────────────────────────────────────────────────────────────────────────

let app;
let server;
const savedEnv = {};

const ENV_KEYS = [
  'NODE_ENV',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'VITE_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_DB_URL',
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  // Hermetische module-load: geen poort, geen Supabase/pg, vaste reasoning-model.
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-5.2';
  delete process.env.VITE_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_DB_URL;

  ({ app } = await import('../index.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// Bouwt een fetch-Response-achtig object zoals server/index.js het verwacht
// (alleen .ok/.status/.json() worden gebruikt).
function makeResp(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  };
}

function chatCompletion({ content, finish = 'stop' }) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
  };
}

// Mockt global.fetch met een opeenvolging van antwoorden; geeft de mock terug
// zodat tests de doorgestuurde request-bodies kunnen inspecteren.
function mockFetchSequence(responses) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// POST /api/chat via node:http (niet via fetch — dat is gemockt voor OpenAI).
function postChat(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { port } = server.address();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function bodyOfCall(fetchMock, callIndex) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

const REQUEST = {
  messages: [{ role: 'user', content: 'Leg het centrale-limietstelling uit.' }],
  max_tokens: 512,
};

describe('POST /api/chat — bescherming tegen lege/afgekapte reasoning-respons', () => {
  it('retryt met groter budget bij afgekapte eerste respons en geeft de volledige tekst terug', async () => {
    const fetchMock = mockFetchSequence([
      makeResp(200, chatCompletion({ content: '', finish: 'length' })),
      makeResp(200, chatCompletion({ content: 'Het volledige, gestructureerde antwoord.', finish: 'stop' })),
    ]);

    const res = await postChat(REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Het volledige, gestructureerde antwoord.');

    // Precies twee OpenAI-calls: origineel + één retry met ruimer budget.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = bodyOfCall(fetchMock, 0);
    const second = bodyOfCall(fetchMock, 1);
    // gpt-5.2 is een reasoning-model → max_completion_tokens i.p.v. max_tokens.
    expect(first.max_completion_tokens).toBe(512);
    expect(second.max_completion_tokens).toBeGreaterThan(first.max_completion_tokens);
    expect(second.max_completion_tokens).toBe(2000);
  });

  it('retryt ook bij een lege content (geen finish_reason "length")', async () => {
    const fetchMock = mockFetchSequence([
      makeResp(200, chatCompletion({ content: '   ', finish: 'stop' })),
      makeResp(200, chatCompletion({ content: 'Nu wel een echt antwoord.', finish: 'stop' })),
    ]);

    const res = await postChat(REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Nu wel een echt antwoord.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('geeft HTTP 502 met code "empty_response" als het na de retry leeg blijft', async () => {
    const fetchMock = mockFetchSequence([
      makeResp(200, chatCompletion({ content: '', finish: 'length' })),
      makeResp(200, chatCompletion({ content: '', finish: 'length' })),
    ]);

    const res = await postChat(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('empty_response');
  });

  it('geeft HTTP 502 met code "length" als de retry niet-leeg maar nog steeds afgekapt is', async () => {
    const fetchMock = mockFetchSequence([
      makeResp(200, chatCompletion({ content: '', finish: 'length' })),
      makeResp(200, chatCompletion({ content: 'Begin van het antwoord dat halverwege', finish: 'length' })),
    ]);

    const res = await postChat(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('length');
  });

  it('retryt niet wanneer de eerste respons al volledig is', async () => {
    const fetchMock = mockFetchSequence([
      makeResp(200, chatCompletion({ content: 'Direct een compleet antwoord.', finish: 'stop' })),
    ]);

    const res = await postChat(REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Direct een compleet antwoord.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
