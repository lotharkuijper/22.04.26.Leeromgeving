import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Integratietests voor de twee website-import-endpoints (Task #234/#236):
//   POST /api/admin/import-web/discover  — ontdek pagina's van een webomgeving
//   POST /api/admin/import-web/import    — importeer pagina's als RAG-bronnen
//
// De pure helpers in webImport.js zijn al los getest; hier toetsen we het
// gedrag van de Express-routes zelf:
//   • auth: 401 zonder header, 403 voor niet-staff (admin||docent bij discover,
//     isStaffForCourse bij import),
//   • SSRF/validatie: ongeldige en interne URL's worden geweigerd,
//   • scope-handhaving: pagina's buiten de baseUrl worden overgeslagen,
//   • idempotentie: opnieuw importeren maakt geen dubbele bronnen.
//
// Aanpak: we mocken `@supabase/supabase-js` met een in-memory query-builder-stub
// (zowel de service-role admin-client als de per-request caller-client voor
// auth.getUser), mocken `node:dns` zodat de SSRF-DNS-guard publieke IP's ziet,
// en mocken global.fetch om zowel webpagina's als OpenAI-embeddings te serveren.
// De echte Express-app draait op een efemere poort; HTTP-verzoeken lopen via
// node:http zodat de gemockte global.fetch alleen de uitgaande calls onderschept.
// ───────────────────────────────────────────────────────────────────────────

// Gedeelde, hoistbare harness — vi.mock-factories mogen alleen naar hier gehoiste
// waarden verwijzen. Bevat de in-memory DB + de huidige geauthenticeerde user.
const harness = vi.hoisted(() => {
  const state = {
    user: null, // wordt per test gezet; null ⇒ caller.auth.getUser() faalt
    db: { tables: {}, counter: 1 },
  };

  function resetDb(tables = {}) {
    state.db = { tables: {}, counter: 1 };
    for (const [name, rows] of Object.entries(tables)) {
      state.db.tables[name] = rows.map((r) => ({ ...r }));
    }
  }

  // Minimalistische PostgREST-achtige query-builder over in-memory arrays.
  class QueryBuilder {
    constructor(db, table) {
      this.db = db;
      this.table = table;
      this.filters = [];
      this._limit = null;
      this._op = 'select';
      this._payload = null;
      this._returnRows = null;
    }
    select() { return this; }
    order() { return this; }
    eq(col, val) { this.filters.push({ type: 'eq', col, val }); return this; }
    in(col, vals) { this.filters.push({ type: 'in', col, vals }); return this; }
    limit(n) { this._limit = n; return this; }

    _rows() {
      return (this.db.tables[this.table] = this.db.tables[this.table] || []);
    }
    _match() {
      let rows = this._rows();
      for (const f of this.filters) {
        if (f.type === 'eq') rows = rows.filter((r) => r[f.col] === f.val);
        else if (f.type === 'in') rows = rows.filter((r) => f.vals.includes(r[f.col]));
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return rows;
    }
    insert(payload) {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((row) => {
        const r = { id: row.id ?? `id-${this.db.counter++}`, ...row };
        this._rows().push(r);
        return r;
      });
      this._op = 'insert';
      this._returnRows = inserted;
      return this;
    }
    update(payload) { this._op = 'update'; this._payload = payload; return this; }
    delete() { this._op = 'delete'; return this; }

    maybeSingle() { return this._single(false); }
    single() { return this._single(true); }
    async _single(strict) {
      const { data, error } = await this._run();
      if (error) return { data: null, error };
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      if (arr.length === 0) {
        return strict ? { data: null, error: { message: 'No rows found' } } : { data: null, error: null };
      }
      return { data: arr[0], error: null };
    }
    then(resolve, reject) { return this._run().then(resolve, reject); }
    async _run() {
      try {
        if (this._op === 'insert') return { data: this._returnRows, error: null };
        if (this._op === 'update') {
          const rows = this._match();
          for (const r of rows) Object.assign(r, this._payload);
          return { data: rows, error: null };
        }
        if (this._op === 'delete') {
          const rows = new Set(this._match());
          this.db.tables[this.table] = this._rows().filter((r) => !rows.has(r));
          return { data: [...rows], error: null };
        }
        return { data: this._match(), error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    }
  }

  function createClientImpl(url, key, opts) {
    // Caller-client (auth): herkenbaar aan de doorgegeven Authorization-header.
    if (opts?.global?.headers?.Authorization) {
      return {
        auth: {
          getUser: async () => state.user
            ? { data: { user: state.user }, error: null }
            : { data: { user: null }, error: { message: 'Invalid token' } },
        },
      };
    }
    // Admin-client (service role): in-memory query-builder.
    return {
      from: (table) => new QueryBuilder(state.db, table),
      rpc: async () => ({ data: [], error: null }),
      auth: { getUser: async () => ({ data: { user: null }, error: { message: 'n/a' } }) },
    };
  }

  return { state, resetDb, createClientImpl };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: harness.createClientImpl,
}));

// SSRF-DNS-guard: laat publieke hostnamen naar een publiek IP resolven zodat de
// happy-path niet afhangt van echte (en in de sandbox onbetrouwbare) DNS.
vi.mock('node:dns', () => ({
  promises: {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  },
}));

let app;
let server;
const savedEnv = {};
const ENV_KEYS = [
  'NODE_ENV', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  'VITE_PUBLIC_SUPABASE_URL', 'VITE_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL',
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
  process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
  process.env.VITE_PUBLIC_SUPABASE_URL = 'http://stub.supabase.local';
  process.env.VITE_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.SUPABASE_DB_URL; // geen pg-pool nodig

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
  harness.state.user = null;
  harness.resetDb();
});

// ── Test-actoren in de in-memory DB ─────────────────────────────────────────
const ADMIN = { id: 'user-admin', role: 'admin', email: 'admin@vu.nl' };
const TEACHER = { id: 'user-teacher', role: 'student', email: 'teacher@vu.nl' };
const STUDENT = { id: 'user-student', role: 'student', email: 'student@vu.nl' };
const COURSE_ID = 'course-1';

// Zet de geauthenticeerde user + zaai de profiel/lidmaatschap-tabellen.
function seed({ user = ADMIN, teacherCourses = [], course = true } = {}) {
  harness.state.user = { id: user.id, email: user.email };
  const tables = {
    profiles: [{ id: user.id, role: user.role, email: user.email }],
    course_members: teacherCourses.map((cid) => ({
      user_id: user.id, course_id: cid, member_role: 'teacher',
    })),
    courses: course ? [{ id: COURSE_ID, name: 'Statistiek 1' }] : [],
    document_folders: [],
    course_folder_assignments: [],
    folder_permissions: [],
    documents: [],
    document_chunks: [],
  };
  harness.resetDb(tables);
}

// ── HTTP-helper via node:http (global.fetch is gemockt) ─────────────────────
function post(path, body, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const { port } = server.address();
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (auth) headers.Authorization = 'Bearer test-token';
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        // De import-route streamt voortgang als NDJSON (één JSON-object per
        // regel: start/progress/done). Validatie-fouten geven daarentegen een
        // gewoon JSON-object terug. Probeer eerst de hele body als één JSON te
        // parsen; lukt dat niet, behandel het als NDJSON en geef het 'done'-
        // event terug (met alle events onder `events` voor rijkere asserts);
        // niet-JSON regels worden defensief overgeslagen.
        let body = null;
        const trimmed = (raw || '').trim();
        if (trimmed) {
          try {
            body = JSON.parse(trimmed);
          } catch {
            const events = [];
            for (const line of trimmed.split('\n').map((s) => s.trim()).filter(Boolean)) {
              try { events.push(JSON.parse(line)); } catch { /* sla niet-JSON regels over */ }
            }
            const picked = events.find((e) => e && e.type === 'done') || events[events.length - 1];
            // Garandeer dat `body` altijd een object is: een NDJSON-regel die naar
            // een primitive parset (of een lege/niet-JSON body) mag nooit een
            // `body.events = ...` TypeError geven, maar moet leiden tot een nette
            // assertion-fout op het lege object.
            body = (picked && typeof picked === 'object') ? picked : {};
            body.events = events;
          }
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Fetch-stub: routeert OpenAI-embeddings vs webpagina-fetches ─────────────
function htmlResponse(html, { status = 200, contentType = 'text/html' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => html,
  };
}
function redirectResponse(location, status = 302) {
  return {
    ok: false,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}

// `pages` is een map url→html (of url→{html,contentType,status}); embeddings
// worden deterministisch teruggegeven (één vector per input-chunk).
// Optie `embeddings` overschrijft het embedding-antwoord (bv. om een falende
// of misvormde respons van de AI-embeddingdienst te simuleren).
function mockFetch(pages, { embeddings } = {}) {
  const fetchMock = vi.fn(async (url, opts) => {
    if (String(url).includes('/embeddings')) {
      if (embeddings) return embeddings(opts);
      const inputs = JSON.parse(opts.body).input;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: inputs.map(() => ({ embedding: [0.01, 0.02, 0.03] })) }),
      };
    }
    const entry = pages[url];
    if (entry === undefined) return htmlResponse('', { status: 404 });
    if (typeof entry === 'string') return htmlResponse(entry);
    if (entry.redirect) return redirectResponse(entry.redirect, entry.status || 302);
    return htmlResponse(entry.html || '', entry);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Lange, schone tekst (> MIN_TEXT_CHARS = 200) zodat de import niet "te weinig
// leesbare tekst" overslaat.
const LONG_TEXT = 'Dit is een uitgebreide alinea over statistische inferentie. '.repeat(12);
function page(title) {
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${LONG_TEXT}</p></main></body></html>`;
}

// ===========================================================================
// DISCOVER
// ===========================================================================
describe('POST /api/admin/import-web/discover', () => {
  it('weigert zonder Authorization-header (401)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/discover', { url: 'https://example.com/book/' }, { auth: false });
    expect(res.status).toBe(401);
  });

  it('weigert een niet-staff gebruiker (403)', async () => {
    seed({ user: STUDENT });
    const res = await post('/api/admin/import-web/discover', { url: 'https://example.com/book/' });
    expect(res.status).toBe(403);
  });

  it('weigert een ongeldige URL (400)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/discover', { url: 'niet-een-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ongeldige url/i);
  });

  it('weigert een interne/SSRF-URL (400)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/discover', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/intern|niet-toegestaan/i);
  });

  it('ontdekt pagina\'s via de sitemap voor een staff-gebruiker', async () => {
    seed({ user: ADMIN });
    mockFetch({
      'https://example.com/book/sitemap.xml': {
        contentType: 'application/xml',
        html: `<urlset>
          <url><loc>https://example.com/book/intro.html</loc></url>
          <url><loc>https://example.com/book/ch1.html</loc></url>
          <url><loc>https://example.com/elders/out.html</loc></url>
        </urlset>`,
      },
    });
    const res = await post('/api/admin/import-web/discover', { url: 'https://example.com/book/' });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('sitemap');
    expect(res.body.baseUrl).toBe('https://example.com/book/');
    const urls = res.body.pages.map((p) => p.url);
    expect(urls).toContain('https://example.com/book/intro.html');
    expect(urls).toContain('https://example.com/book/ch1.html');
    // Pagina buiten de webomgeving wordt gefilterd.
    expect(urls.some((u) => u.includes('elders'))).toBe(false);
  });

  it('staat een docent van een cursus toe te ontdekken', async () => {
    seed({ user: TEACHER, teacherCourses: [COURSE_ID] });
    mockFetch({ 'https://example.com/book/': page('Index') });
    const res = await post('/api/admin/import-web/discover', { url: 'https://example.com/book/' });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('crawl');
  });
});

// ===========================================================================
// IMPORT
// ===========================================================================
describe('POST /api/admin/import-web/import', () => {
  const BASE = 'https://example.com/book/';

  it('weigert zonder Authorization-header (401)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/import',
      { courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }] }, { auth: false });
    expect(res.status).toBe(401);
  });

  it('weigert een gebruiker die geen staff van de cursus is (403)', async () => {
    // Docent in een ándere cursus, maar niet in COURSE_ID.
    seed({ user: TEACHER, teacherCourses: ['andere-cursus'] });
    const res = await post('/api/admin/import-web/import',
      { courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/docent van deze cursus/i);
  });

  it('weigert zonder courseId (400)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/import', { baseUrl: BASE, pages: [{ url: BASE + 'a.html' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/courseid/i);
  });

  it('weigert zonder geselecteerde pagina\'s (400)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/import', { courseId: COURSE_ID, baseUrl: BASE, pages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/geen pagina/i);
  });

  it('weigert een ongeldige/interne baseUrl (400)', async () => {
    seed({ user: ADMIN });
    const res = await post('/api/admin/import-web/import',
      { courseId: COURSE_ID, baseUrl: 'http://127.0.0.1/intern/', pages: [{ url: 'http://127.0.0.1/intern/a.html' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baseurl/i);
  });

  it('weigert wanneer geen enkele pagina binnen de scope valt (400)', async () => {
    seed({ user: ADMIN });
    mockFetch({});
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID,
      baseUrl: BASE,
      pages: [{ url: 'https://example.com/elders/x.html' }, { url: 'https://andere-host.com/book/y.html' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope/i);
  });

  it('importeert pagina\'s binnen de scope en slaat buiten-scope + interne URL\'s over', async () => {
    seed({ user: ADMIN });
    mockFetch({
      [BASE + 'a.html']: page('Hoofdstuk A'),
      [BASE + 'b.html']: page('Hoofdstuk B'),
    });
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID,
      baseUrl: BASE,
      pages: [
        { url: BASE + 'a.html' },
        { url: BASE + 'b.html' },
        { url: 'https://example.com/elders/c.html' }, // buiten scope
        { url: 'http://169.254.169.254/meta' },        // SSRF/intern
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.outOfScope).toBe(2);
    expect(res.body.errors).toBe(0);
    // Precies twee web-documenten aangemaakt in de cursus-RAG-map.
    const docs = harness.state.db.tables.documents;
    expect(docs.length).toBe(2);
    expect(docs.every((d) => d.file_type === 'web')).toBe(true);
  });

  it('is idempotent: opnieuw importeren maakt geen dubbele bronnen', async () => {
    seed({ user: ADMIN });
    mockFetch({ [BASE + 'a.html']: page('Hoofdstuk A') });
    const payload = { courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }] };

    const first = await post('/api/admin/import-web/import', payload);
    expect(first.status).toBe(200);
    expect(first.body.imported).toBe(1);
    const chunksAfterFirst = harness.state.db.tables.document_chunks.length;
    expect(harness.state.db.tables.documents.length).toBe(1);
    expect(chunksAfterFirst).toBeGreaterThan(0);

    const second = await post('/api/admin/import-web/import', payload);
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(1);
    // Nog steeds één document; chunks vervangen, niet verdubbeld.
    expect(harness.state.db.tables.documents.length).toBe(1);
    expect(harness.state.db.tables.document_chunks.length).toBe(chunksAfterFirst);
  });

  it('herbruikt de bestaande RAG-map bij een tweede import (geen dubbele map)', async () => {
    seed({ user: ADMIN });
    mockFetch({ [BASE + 'a.html']: page('Hoofdstuk A'), [BASE + 'b.html']: page('Hoofdstuk B') });

    await post('/api/admin/import-web/import', { courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }] });
    const foldersAfterFirst = harness.state.db.tables.document_folders.length;
    await post('/api/admin/import-web/import', { courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'b.html' }] });

    expect(harness.state.db.tables.document_folders.length).toBe(foldersAfterFirst);
    expect(harness.state.db.tables.documents.length).toBe(2);
  });

  it('weigert een redirect buiten de scope (telt als error, importeert niet)', async () => {
    seed({ user: ADMIN });
    mockFetch({
      [BASE + 'a.html']: { redirect: 'https://example.com/elders/elders.html' },
    });
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(1);
    expect(harness.state.db.tables.documents.length).toBe(0);
  });

  it('telt de pagina als error wanneer de AI-embeddingdienst een non-200 geeft', async () => {
    seed({ user: ADMIN });
    // Webpagina laadt prima, maar de embeddings-call faalt (HTTP 500).
    mockFetch(
      { [BASE + 'a.html']: page('Hoofdstuk A') },
      {
        embeddings: () => ({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Service tijdelijk niet beschikbaar' } }),
        }),
      },
    );
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(1);
    // De pagina is expliciet als 'error' gerapporteerd met de fout-tekst.
    const pageResult = res.body.results.find((x) => x.url === BASE + 'a.html');
    expect(pageResult.status).toBe('error');
    expect(pageResult.message).toMatch(/niet beschikbaar|500/i);
    // Niets gepersisteerd: geen document- of chunk-rijen.
    expect(harness.state.db.tables.documents.length).toBe(0);
    expect(harness.state.db.tables.document_chunks.length).toBe(0);
  });

  it('telt de pagina als error wanneer de embeddingdienst een misvormde respons geeft', async () => {
    seed({ user: ADMIN });
    // HTTP 200, maar het `data`-veld is geen array → embedTextsServer gooit.
    mockFetch(
      { [BASE + 'a.html']: page('Hoofdstuk A') },
      {
        embeddings: () => ({
          ok: true,
          status: 200,
          json: async () => ({ unexpected: 'shape' }),
        }),
      },
    );
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID, baseUrl: BASE, pages: [{ url: BASE + 'a.html' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(1);
    const pageResult = res.body.results.find((x) => x.url === BASE + 'a.html');
    expect(pageResult.status).toBe('error');
    expect(harness.state.db.tables.documents.length).toBe(0);
    expect(harness.state.db.tables.document_chunks.length).toBe(0);
  });

  it('rapporteert per pagina: error bij embedding-fout, skipped bij te weinig tekst', async () => {
    seed({ user: ADMIN });
    // Pagina a: embeddings falen → error. Pagina b: te weinig tekst → skipped.
    // Beide naast elkaar zodat partiële mislukkingen correct geteld worden.
    let embedCalls = 0;
    mockFetch(
      {
        [BASE + 'a.html']: page('Hoofdstuk A'),
        [BASE + 'b.html']: '<html><head><title>Kort</title></head><body><main><p>Te kort.</p></main></body></html>',
      },
      {
        embeddings: () => {
          embedCalls++;
          return { ok: false, status: 503, json: async () => ({ error: 'embeddings down' }) };
        },
      },
    );
    const res = await post('/api/admin/import-web/import', {
      courseId: COURSE_ID, baseUrl: BASE,
      pages: [{ url: BASE + 'a.html' }, { url: BASE + 'b.html' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toBe(1);
    expect(res.body.skipped).toBe(1);
    const aResult = res.body.results.find((x) => x.url === BASE + 'a.html');
    const bResult = res.body.results.find((x) => x.url === BASE + 'b.html');
    expect(aResult.status).toBe('error');
    expect(bResult.status).toBe('skipped');
    // De te-korte pagina bereikt de embedding-call niet (skip vóór embedden).
    expect(embedCalls).toBe(1);
    expect(harness.state.db.tables.documents.length).toBe(0);
    expect(harness.state.db.tables.document_chunks.length).toBe(0);
  });
});
