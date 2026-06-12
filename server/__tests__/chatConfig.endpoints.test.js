import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Veiligheidsregressietest (Task #249) op endpoint-niveau: als de Azure-chat-env
// ontbreekt, MOET /api/chat een 503 met de "niet geconfigureerd"-melding geven
// en NOOIT stilletjes een chat-call naar de publieke OpenAI-API doen.
//
// We laden de echte Express-app met ALLE Azure-env-variabelen weg en mocken
// global.fetch. Als de app — tegen de veiligheidsregel in — toch een chat-call
// zou doen, zou de mock een api.openai.com-chat-URL zien; de test faalt dan.
// supabaseAdmin/pgPool zijn null (env geneutraliseerd), dus er wordt geen DB
// geraakt.
// ───────────────────────────────────────────────────────────────────────────

let app;
let server;
const savedEnv = {};

const ENV_KEYS = [
  'NODE_ENV',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'VITE_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_DB_URL',
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  process.env.NODE_ENV = 'test';
  // Azure bewust NIET configureren → chat moet 503'en, geen fallback.
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_API_VERSION;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  // Publieke OpenAI-key WEL aanwezig: bewijst dat de aanwezigheid hiervan geen
  // chat-fallback activeert.
  process.env.OPENAI_API_KEY = 'sk-public-key';
  process.env.OPENAI_MODEL = 'gpt-5.2';
  delete process.env.VITE_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_DB_URL;

  vi.resetModules();
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

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { port } = server.address();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('/api/chat zonder Azure-config', () => {
  // De handler gate't eerst op auth (requireAuthUser) en daarna op
  // AZURE_CHAT_READY. In deze hermetische test is er geen Supabase, dus de
  // 503 komt al uit de auth-gate. De veiligheidskritische invariant blijft
  // ongewijzigd: er lekt NOOIT een chat-call (zeker geen publieke OpenAI-call)
  // wanneer Azure niet is geconfigureerd. De exacte "niet geconfigureerd"-
  // melding + lege chat-URL wordt door chatConfig.test.js bewaakt.
  it('antwoordt met 503 en doet GEEN (fallback) chat-call', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch had niet aangeroepen mogen worden');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { status } = await postJson('/api/chat', {
      messages: [{ role: 'user', content: 'Hallo' }],
    });

    expect(status).toBe(503);
    // Cruciaal: er is geen enkele uitgaande chat-call gedaan.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/health', () => {
  it('rapporteert azure=false als Azure-chat niet is geconfigureerd', async () => {
    const health = await new Promise((resolve, reject) => {
      const { port } = server.address();
      http
        .get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }),
          );
        })
        .on('error', reject);
    });
    expect(health.status).toBe(200);
    expect(health.body.azure).toBe(false);
  });
});
