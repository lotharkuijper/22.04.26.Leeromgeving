import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Beveiligingsregressietest (Task #334) voor de cursus-specifieke tutor-chat-
// override op POST /api/chat.
//
// De handler laadt een cursus-eigen system-prompt (`__chat_prompt_<courseId>__`)
// ALLEEN als de beller daadwerkelijk toegang tot die cursus heeft. courseId komt
// uit de request-body, dus zonder deze poort zou elke ingelogde gebruiker de
// prompt van een willekeurige cursus kunnen afdwingen/uitlezen (cross-course-lek).
//
// We mounten de echte Express-app en gebruiken een QUERY-BEWUSTE Supabase-mock:
//  * courses-lookup → bepaalt of de gebruiker toegang heeft (actief+zichtbaar = ja;
//    geen rij = nee). userHasCourseAccess hangt hierop.
//  * chatbot_prompts-lookup op exact `__chat_prompt_<courseId>__` → levert de
//    override-content. De globale fallback-query (zonder die naam) levert null,
//    zodat de handler terugvalt op FALLBACK_SYSTEM_PROMPT.
// global.fetch is gemockt zodat geen echte Azure-call wordt gedaan; we inspecteren
// de doorgestuurde system-message om te bewijzen welke prompt is gebruikt.
// ───────────────────────────────────────────────────────────────────────────

const COURSE_ID = '11111111-1111-1111-1111-111111111111';
const OVERRIDE_NAME = `__chat_prompt_${COURSE_ID}__`;
const OVERRIDE_MARKER = 'CURSUS-SPECIFIEKE-OVERRIDE-PROMPT-MARKER-XYZ';

vi.mock('@supabase/supabase-js', () => {
  function resolve(table, filters) {
    const st = globalThis.__chatOverrideState || {};
    if (table === 'chatbot_prompts' && filters.name === OVERRIDE_NAME) {
      return { data: { id: 'override-1', content: OVERRIDE_MARKER }, error: null };
    }
    if (table === 'courses' && filters.id === COURSE_ID) {
      return {
        data: st.courseAccess ? { is_active: true, student_visible: true } : null,
        error: null,
      };
    }
    return { data: null, error: null };
  }
  const makeBuilder = (table) => {
    const filters = {};
    const builder = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      delete: () => builder,
      upsert: () => builder,
      eq: (col, val) => { filters[col] = val; return builder; },
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
      maybeSingle: async () => resolve(table, filters),
      single: async () => resolve(table, filters),
      then: (r) => r(resolve(table, filters)),
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

let app;
let server;
const savedEnv = {};

const ENV_KEYS = [
  'NODE_ENV',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
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
  // Azure expliciet configureren zodat AZURE_CHAT_READY waar is (deterministisch,
  // ongeacht ambient secrets). fetch is gemockt → er gaat geen echte call uit.
  process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-5.5';
  process.env.AZURE_OPENAI_API_VERSION = '2024-10-21';
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
  delete globalThis.__chatOverrideState;
});

beforeEach(() => {
  vi.restoreAllMocks();
  delete globalThis.__chatOverrideState;
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

function mockFetchOnce(content) {
  const fetchMock = vi.fn(async () => makeResp(200, chatCompletion(content)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

function systemMessageOf(fetchMock) {
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  const sys = sent.messages.find((m) => m.role === 'system');
  return sys ? sys.content : '';
}

const REQUEST = (courseId) => ({
  messages: [{ role: 'user', content: 'Leg de centrale limietstelling uit.' }],
  max_tokens: 256,
  courseId,
});

describe('POST /api/chat — cursus-override toegangspoort (Task #334)', () => {
  it('gebruikt de cursus-override wanneer de beller toegang tot die cursus heeft', async () => {
    globalThis.__chatOverrideState = { courseAccess: true };
    const fetchMock = mockFetchOnce('Antwoord met cursus-prompt.');

    const res = await postChat(REQUEST(COURSE_ID));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // De override-content moet in de system-message terechtkomen.
    expect(systemMessageOf(fetchMock)).toContain(OVERRIDE_MARKER);
  });

  it('negeert de cursus-override wanneer de beller GEEN toegang tot die cursus heeft', async () => {
    globalThis.__chatOverrideState = { courseAccess: false };
    const fetchMock = mockFetchOnce('Antwoord met fallback-prompt.');

    const res = await postChat(REQUEST(COURSE_ID));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Zonder toegang mag de cursus-prompt NIET lekken; fallback wordt gebruikt.
    expect(systemMessageOf(fetchMock)).not.toContain(OVERRIDE_MARKER);
  });
});
