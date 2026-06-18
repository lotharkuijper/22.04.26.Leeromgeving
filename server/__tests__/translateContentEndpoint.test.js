import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Integratietest voor de POST /api/translate-content-handler (Task #290). De
// pure helpers zijn al unit-getest (contentTranslation.test.js); hier testen we
// de ORKESTRATIE in de endpoint, waar regressies het lastigst handmatig te zien
// zijn:
//   1. nl-doeltaal → originelen terug ZONDER Azure-call (en zonder 503), ook al
//      ontbreekt Azure.
//   2. cache-hit → gecachte tekst terug ZONDER Azure-call.
//   3. cache-miss → Azure wordt aangeroepen én het resultaat wordt geüpsert.
//   4. Azure-ongeconfigureerd → 503, maar ALLEEN als er echte misses zijn.
//   5. per-item falen (Azure geeft niets terug voor één fragment) → alleen die
//      key valt weg, de rest komt gewoon door.
//
// We mounten de echte Express-app op een efemere poort en mocken global.fetch
// (Azure) + @supabase/supabase-js. De Supabase-mock is configureerbaar via een
// gedeelde state (vi.hoisted) zodat per test de cache-rijen en geüpserte rijen
// te sturen/inspecteren zijn. We laden de app TWEE keer: één instance mét Azure
// (de meeste tests) en één ZONDER Azure (de 503-tests), omdat AZURE_CHAT_READY
// bij module-load uit de env wordt bepaald.
// ───────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  state: {
    cacheRows: [],   // rijen die content_translations-select teruggeeft
    upserts: [],     // opgevangen upsert-payloads
    profile: { role: 'student', email: 'student@vu.nl' },
  },
  reset() {
    this.state.cacheRows = [];
    this.state.upserts = [];
    this.state.profile = { role: 'student', email: 'student@vu.nl' };
  },
}));

// Configureerbare, chainbare Supabase-stub. `from(table)` onthoudt de tabel; de
// keten lost defensief op met { data: null, error: null } behalve voor de
// content_translations-select (geeft de geconfigureerde cache-rijen) en de
// profiles-maybeSingle (geeft het test-profiel zodat requireAuthUser slaagt).
// upsert vangt de payload op in de gedeelde state.
vi.mock('@supabase/supabase-js', () => {
  const makeBuilder = (table) => {
    let op = 'select';
    const builder = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      delete: () => builder,
      upsert: (rows) => { op = 'upsert'; h.state.upserts.push(rows); return builder; },
      eq: () => builder,
      neq: () => builder,
      not: () => builder,
      in: () => builder,
      like: () => builder,
      ilike: () => builder,
      is: () => builder,
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      range: () => builder,
      maybeSingle: async () => {
        if (table === 'profiles') return { data: h.state.profile, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      then: (resolve) => {
        if (op === 'upsert') return resolve({ data: null, error: null });
        if (table === 'content_translations') return resolve({ data: h.state.cacheRows, error: null });
        return resolve({ data: null, error: null });
      },
    };
    return builder;
  };
  const createClient = () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'test-user-id' } }, error: null }),
    },
    from: (table) => makeBuilder(table),
  });
  return { createClient };
});

let appAzure;
let serverAzure;
let appNoAzure;
let serverNoAzure;
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
  'VITE_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_DB_URL',
];

function setSharedEnv() {
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_MODEL = 'gpt-5.2';
  process.env.VITE_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_DB_URL;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  // ── App MÉT Azure (de meeste tests) ──────────────────────────────────────
  setSharedEnv();
  process.env.AZURE_OPENAI_ENDPOINT = 'https://leap-openai-vu.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-5.2';
  vi.resetModules();
  appAzure = (await import('../index.js')).app;
  serverAzure = appAzure.listen(0);
  await new Promise((resolve) => serverAzure.once('listening', resolve));

  // ── App ZONDER Azure (503-pad) ───────────────────────────────────────────
  setSharedEnv();
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  vi.resetModules();
  appNoAzure = (await import('../index.js')).app;
  serverNoAzure = appNoAzure.listen(0);
  await new Promise((resolve) => serverNoAzure.once('listening', resolve));
});

afterAll(async () => {
  if (serverAzure) await new Promise((resolve) => serverAzure.close(resolve));
  if (serverNoAzure) await new Promise((resolve) => serverNoAzure.close(resolve));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
  h.reset();
});

// fetch-Response-achtig object zoals postChatCompletionWithRetry het verwacht
// (.ok/.status + .text(): de body wordt als tekst gelezen en zelf geparsed).
function makeResp(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  };
}

// Eén losse-call-vertaling (translateContentOne leest choices[0].message.content).
function chatCompletion(content) {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

// JSON-mode batch-respons (translateContentBatch verwacht een JSON-string met
// dezelfde t0/t1/…-keys als de payload).
function batchCompletion(obj) {
  return chatCompletion(JSON.stringify(obj));
}

// Mockt global.fetch met een vaste of dynamische respons; geeft de mock terug
// zodat tests de doorgestuurde request-bodies kunnen inspecteren.
function mockFetch(handler) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function post(server, body, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { port } = server.address();
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (auth) headers.Authorization = 'Bearer test-token';
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/translate-content', method: 'POST', headers },
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

describe('POST /api/translate-content — authenticatie', () => {
  it('weigert zonder Authorization-header (401) en doet geen Azure-call', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('zou niet mogen')));
    const res = await post(serverAzure, { items: [{ key: 'a', text: 'Onderzoeksvraag' }], targetLang: 'en' }, { auth: false });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/translate-content — nl-doeltaal short-circuit', () => {
  it('geeft een leeg translations-object terug ZONDER Azure-call, zelfs als Azure ontbreekt', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('niet gebruiken')));
    // Bewust de app ZONDER Azure: nl mag nooit een 503 opleveren.
    const res = await post(serverNoAzure, {
      items: [{ key: 'titel', text: 'Onderzoeksvraag' }],
      targetLang: 'nl',
    });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('slaat niet-vertaalbare/te lange tekst over zonder Azure-call', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('niet gebruiken')));
    const res = await post(serverAzure, {
      items: [
        { key: 'sym', text: '---' },        // geen letters
        { key: 'short', text: 'ab' },       // < 3 tekens
        { key: 'empty', text: '   ' },      // leeg na trim
      ],
      targetLang: 'en',
    });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/translate-content — cache-first', () => {
  it('geeft gecachte tekst terug ZONDER Azure-call bij een volledige cache-hit', async () => {
    // Hash-onafhankelijk: de stub geeft álle gevraagde hashes als hit terug.
    // We zetten daarom de cache-rij met dezelfde hash die de server berekent.
    const { hashContentSource } = await import('../documentTranslation.js');
    const hash = hashContentSource('Onderzoeksvraag', 'plain');
    h.state.cacheRows = [{ source_hash: hash, translated_text: 'Research question' }];
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('niet gebruiken')));

    const res = await post(serverAzure, {
      items: [{ key: 'titel', text: 'Onderzoeksvraag', format: 'plain' }],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ titel: 'Research question' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.upserts).toHaveLength(0); // niets nieuws om te cachen
  });
});

describe('POST /api/translate-content — cache-miss roept Azure aan en upsert', () => {
  it('vertaalt een korte plain-miss via de batch-call en upsert het resultaat', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, batchCompletion({ t0: 'Research question' })));

    const res = await post(serverAzure, {
      items: [{ key: 'titel', text: 'Onderzoeksvraag', format: 'plain' }],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ titel: 'Research question' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Upsert bevat exact één rij met de juiste taal + vertaling.
    expect(h.state.upserts).toHaveLength(1);
    const rows = h.state.upserts[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_lang: 'en', translated_text: 'Research question' });
    expect(rows[0].source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('vertaalt een markdown-miss via een losse call (geen batch-JSON)', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('# Vertaalde kop')));

    const res = await post(serverAzure, {
      items: [{ key: 'body', text: '# Een kop met inhoud', format: 'markdown' }],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ body: '# Vertaalde kop' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Losse markdown-call gebruikt GEEN json_object response_format.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.response_format).toBeUndefined();
    expect(h.state.upserts[0]).toHaveLength(1);
  });

  it('dedupliceert identieke tekst over meerdere keys: één vertaling, beide keys gevuld', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, batchCompletion({ t0: 'Research question' })));

    const res = await post(serverAzure, {
      items: [
        { key: 'a', text: 'Onderzoeksvraag', format: 'plain' },
        { key: 'b', text: 'Onderzoeksvraag', format: 'plain' },
      ],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ a: 'Research question', b: 'Research question' });
    // Eén unieke hash → één batch-call → één upsert-rij.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.state.upserts[0]).toHaveLength(1);
  });

  it('combineert cache-hits met verse misses in één antwoord', async () => {
    const { hashContentSource } = await import('../documentTranslation.js');
    const cachedHash = hashContentSource('Onderzoeksvraag', 'plain');
    h.state.cacheRows = [{ source_hash: cachedHash, translated_text: 'Research question' }];
    const fetchMock = mockFetch(async () => makeResp(200, batchCompletion({ t0: 'Briefing' })));

    const res = await post(serverAzure, {
      items: [
        { key: 'titel', text: 'Onderzoeksvraag', format: 'plain' },   // cache-hit
        { key: 'brief', text: 'Briefingtekst', format: 'plain' },     // miss
      ],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ titel: 'Research question', brief: 'Briefing' });
    // Alleen de miss ging naar Azure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.state.upserts[0]).toHaveLength(1);
    expect(h.state.upserts[0][0].translated_text).toBe('Briefing');
  });
});

describe('POST /api/translate-content — per-item falen', () => {
  it('laat alleen de niet-vertaalde key weg, de rest komt door', async () => {
    // Batch geeft maar één van de twee fragmenten terug → de andere key valt weg.
    const fetchMock = mockFetch(async () => makeResp(200, batchCompletion({ t0: 'First' })));

    const res = await post(serverAzure, {
      items: [
        { key: 'one', text: 'Eerste fragment', format: 'plain' },
        { key: 'two', text: 'Tweede fragment', format: 'plain' },
      ],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toHaveProperty('one', 'First');
    expect(res.body.translations).not.toHaveProperty('two');
    // Alleen de geslaagde vertaling wordt geüpsert.
    expect(h.state.upserts[0]).toHaveLength(1);
    expect(h.state.upserts[0][0].translated_text).toBe('First');
  });
});

describe('POST /api/translate-content — 503 alleen bij echte misses', () => {
  it('geeft 503 wanneer Azure ontbreekt én er echte misses zijn', async () => {
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('niet bereikbaar')));
    const res = await post(serverNoAzure, {
      items: [{ key: 'titel', text: 'Onderzoeksvraag', format: 'plain' }],
      targetLang: 'en',
    });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('geeft 200 (geen 503) wanneer Azure ontbreekt maar alles uit cache komt', async () => {
    const { hashContentSource } = await import('../documentTranslation.js');
    const hash = hashContentSource('Onderzoeksvraag', 'plain');
    h.state.cacheRows = [{ source_hash: hash, translated_text: 'Research question' }];
    const fetchMock = mockFetch(async () => makeResp(200, chatCompletion('niet gebruiken')));

    const res = await post(serverNoAzure, {
      items: [{ key: 'titel', text: 'Onderzoeksvraag', format: 'plain' }],
      targetLang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ titel: 'Research question' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/translate-content — invoervalidatie', () => {
  it('geeft 400 bij een onbekende doeltaal', async () => {
    const res = await post(serverAzure, { items: [{ key: 'a', text: 'Onderzoeksvraag' }], targetLang: 'xx' });
    expect(res.status).toBe(400);
  });

  it('geeft een leeg translations-object bij een lege items-lijst', async () => {
    const res = await post(serverAzure, { items: [], targetLang: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({});
  });
});
