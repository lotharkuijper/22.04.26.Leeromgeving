import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import { buildLevelInstructionBlock } from '../learningLevel.js';

// ───────────────────────────────────────────────────────────────────────────
// Endpoint-test (Task #301) die bewaakt dat het adaptieve leerniveau-blok
// (Task #296) daadwerkelijk in de SYSTEEMPROMPT wordt gevouwen voordat de call
// naar het taalmodel gaat — en wel VÓÓR de taal-instructie, zodat de taal-eis
// dominant/laatste blijft. Een regressie (bijv. `learningLevel` uit de body
// laten vallen, of het blok in de verkeerde volgorde t.o.v. de taal-instructie
// injecteren) zou de feature stil uitschakelen zonder een bestaande test te
// breken. We dekken zowel /api/chat als /api/projects/persona-chat.
//
// We mounten de echte Express-app op een efemere poort, mocken global.fetch
// (geen echte Azure-call) en inspecteren de doorgestuurde request-body: de
// system-message daarin bevat de geassembleerde prompt. @supabase/supabase-js
// wordt gemockt zodat auth slaagt en de minimale tabel-lookups voor
// persona-chat data teruggeven; alle overige queries vallen defensief terug op
// { data: null }.
// ───────────────────────────────────────────────────────────────────────────

vi.mock('@supabase/supabase-js', () => {
  // Tabel-bewuste resultaten: alleen de tabellen die persona-chat met de
  // '__default__'-persona nodig heeft geven data terug; de rest is null zodat
  // de defensieve fallback-paden gevolgd worden (geen thread, geen RAG, geen
  // documenten).
  const tableResult = (table) => {
    if (table === 'project_group_members') return { data: { id: 'm1' }, error: null };
    if (table === 'project_groups') return { data: { id: 'g1', project_id: 'p1' }, error: null };
    if (table === 'projects') return { data: { id: 'p1', course_id: null }, error: null };
    return { data: null, error: null };
  };
  const makeBuilder = (table) => {
    const result = tableResult(table);
    const builder = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      delete: () => builder,
      upsert: () => builder,
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
      maybeSingle: async () => result,
      single: async () => result,
      then: (resolve) => resolve(result),
    };
    return builder;
  };
  const createClient = () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'test-user-id' } }, error: null }),
    },
    from: (table) => makeBuilder(table),
    rpc: async () => ({ data: null, error: null }),
  });
  return { createClient };
});

let app;
let server;
const savedEnv = {};

const ENV_KEYS = [
  'NODE_ENV',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'VITE_PUBLIC_SUPABASE_URL',
  'VITE_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_DB_URL',
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  process.env.NODE_ENV = 'test';
  // Azure WEL configureren zodat AZURE_CHAT_READY=true en de chat-handler tot de
  // (gemockte) fetch-call komt. Embeddings bewust NIET configureren zodat de
  // RAG-zoek in persona-chat meteen leeg teruggeeft (geen embedding-call nodig).
  process.env.AZURE_OPENAI_ENDPOINT = 'https://leap-openai-vu.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-5.5';
  process.env.AZURE_OPENAI_API_VERSION = '2024-10-21';
  delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-5.2';
  process.env.VITE_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
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

function makeResp(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  };
}

function chatCompletion(content) {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

// Mockt global.fetch zodat élke call een volledig chat-antwoord teruggeeft
// (geen retry nodig). Geeft de mock terug zodat de test de doorgestuurde
// request-body's kan inspecteren.
function mockChatFetch() {
  const fetchMock = vi.fn(async () =>
    makeResp(200, chatCompletion('Een volledig, niet-leeg antwoord voor de student.')),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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
          Authorization: 'Bearer test-token',
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

// Haalt de system-message-content uit de eerste doorgestuurde chat-call.
function systemPromptOfFirstCall(fetchMock) {
  expect(fetchMock).toHaveBeenCalled();
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  const sys = body.messages.find((m) => m.role === 'system');
  expect(sys).toBeTruthy();
  return sys.content;
}

// Markeringen die uniek het leerniveau-blok resp. de taal-instructie aanduiden.
const LEVEL_MARKER_EN = "STUDENT'S LEARNING LEVEL";
const LEVEL_MARKER_NL = 'LEERNIVEAU VAN DE STUDENT';
const LANG_MARKER = 'IMPORTANT — OUTPUT LANGUAGE';

describe('POST /api/chat — leerniveau-injectie (Task #301)', () => {
  it('vouwt het leerniveau-blok in de systeemprompt VÓÓR de taal-instructie', async () => {
    const fetchMock = mockChatFetch();

    // lang='en' zodat de taal-instructie niet-leeg is (bij 'nl' is hij leeg) en
    // de relatieve volgorde meetbaar wordt.
    const res = await postJson('/api/chat', {
      messages: [{ role: 'user', content: 'Leg de centrale limietstelling uit.' }],
      lang: 'en',
      learningLevel: 1,
    });

    expect(res.status).toBe(200);
    const sys = systemPromptOfFirstCall(fetchMock);

    // Het blok zit erin én is exact het blok dat de pure helper produceert.
    expect(sys).toContain(LEVEL_MARKER_EN);
    expect(sys).toContain(buildLevelInstructionBlock(1, 'en'));

    // Volgorde: leerniveau-blok staat VÓÓR de taal-instructie (taal blijft laatst).
    const levelIdx = sys.indexOf(LEVEL_MARKER_EN);
    const langIdx = sys.indexOf(LANG_MARKER);
    expect(levelIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(-1);
    expect(levelIdx).toBeLessThan(langIdx);
  });

  it('injecteert GEEN blok bij een ontbrekend niveau (neutraal gedrag behouden)', async () => {
    const fetchMock = mockChatFetch();

    const res = await postJson('/api/chat', {
      messages: [{ role: 'user', content: 'Leg de centrale limietstelling uit.' }],
      lang: 'en',
      // geen learningLevel
    });

    expect(res.status).toBe(200);
    const sys = systemPromptOfFirstCall(fetchMock);
    expect(sys).not.toContain(LEVEL_MARKER_EN);
    expect(sys).not.toContain(LEVEL_MARKER_NL);
    // De taal-instructie hoort er wél nog te staan.
    expect(sys).toContain(LANG_MARKER);
  });

  it('injecteert GEEN blok bij een ongeldig niveau (buiten 1..5)', async () => {
    const fetchMock = mockChatFetch();

    const res = await postJson('/api/chat', {
      messages: [{ role: 'user', content: 'Leg de centrale limietstelling uit.' }],
      lang: 'en',
      learningLevel: 'banaan',
    });

    expect(res.status).toBe(200);
    const sys = systemPromptOfFirstCall(fetchMock);
    expect(sys).not.toContain(LEVEL_MARKER_EN);
    expect(sys).not.toContain(LEVEL_MARKER_NL);
  });
});

describe('POST /api/projects/persona-chat — leerniveau-injectie (Task #301)', () => {
  const BASE = { groupId: 'g1', personaId: '__default__', message: 'Hoe begin ik mijn onderzoeksvraag?' };

  it('vouwt het leerniveau-blok in de systeemprompt VÓÓR de langSuffix', async () => {
    const fetchMock = mockChatFetch();

    const res = await postJson('/api/projects/persona-chat', {
      ...BASE,
      lang: 'en',
      learningLevel: 5,
    });

    expect(res.status).toBe(200);
    const sys = systemPromptOfFirstCall(fetchMock);

    expect(sys).toContain(LEVEL_MARKER_EN);
    expect(sys).toContain(buildLevelInstructionBlock(5, 'en'));

    const levelIdx = sys.indexOf(LEVEL_MARKER_EN);
    const langIdx = sys.indexOf(LANG_MARKER);
    expect(levelIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(-1);
    expect(levelIdx).toBeLessThan(langIdx);
  });

  it('injecteert GEEN blok bij een ontbrekend niveau (neutraal gedrag behouden)', async () => {
    const fetchMock = mockChatFetch();

    const res = await postJson('/api/projects/persona-chat', {
      ...BASE,
      lang: 'en',
      // geen learningLevel
    });

    expect(res.status).toBe(200);
    const sys = systemPromptOfFirstCall(fetchMock);
    expect(sys).not.toContain(LEVEL_MARKER_EN);
    expect(sys).not.toContain(LEVEL_MARKER_NL);
    expect(sys).toContain(LANG_MARKER);
  });
});
