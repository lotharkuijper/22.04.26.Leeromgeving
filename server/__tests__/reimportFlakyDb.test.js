import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Regressietests voor "her-imports falen veilig op een flaky database"
// (Task #399). Eerder maskeerden de re-import-paden een echte Supabase-
// query-fout als "niet gevonden"/"geen koppeling" — waardoor een transiënte
// DB-hapering stilletjes een dubbel document of een dubbele RAG-map/koppeling
// kon aanmaken. De handlers surfacen die fout nu (500 / throw). Deze tests
// vergrendelen dat gedrag zodat een latere refactor de duplicaat-bug niet
// ongemerkt terugbrengt.
//
// We toetsen:
//   • POST /api/admin/process-pptx — documents-by-id lookup geeft een error →
//     500 (NIET 404) en er worden GEEN chunks verwerkt.
//   • POST /api/admin/process-docx — idem voor .docx.
//   • POST /api/admin/create-rag-folder (→ ensureCourseRagFolder):
//       - de eerste course_folder_assignments-lookup faalt → 500, GEEN map/koppeling.
//       - de "bestaande gekoppelde RAG-map"-lookup (document_folders) faalt → 500,
//         GEEN nieuwe map/koppeling.
//       - de "bestaande koppeling"-lookup (course_folder_assignments op folder_id)
//         faalt → 500, GEEN koppeling aangemaakt.
//
// Aanpak: identiek aan importWebEndpoints.test.js — we mocken
// `@supabase/supabase-js` met een in-memory query-builder-stub, maar breiden die
// uit met een fout-injectie (`harness.failOn`) zodat we een specifieke
// tabel/operatie/filter-combinatie een `{ data:null, error }` laten teruggeven.
// ───────────────────────────────────────────────────────────────────────────

const harness = vi.hoisted(() => {
  const state = {
    user: null,
    db: { tables: {}, counter: 1, errors: [] },
  };

  function resetDb(tables = {}) {
    state.db = { tables: {}, counter: 1, errors: [] };
    for (const [name, rows] of Object.entries(tables)) {
      state.db.tables[name] = rows.map((r) => ({ ...r }));
    }
  }

  // Registreer een fout-injectie. matcher: { table, op?, match?(filters), message, once? }
  function failOn(matcher) {
    state.db.errors.push({ op: 'select', once: false, ...matcher });
  }

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
    // Zoek een geregistreerde fout die matcht op tabel + operatie (+ optioneel
    // een predicaat over de actieve filters). Simuleert een transiënte
    // PostgREST-fout op precies één lookup.
    _injectedError() {
      const errs = this.db.errors || [];
      for (let i = 0; i < errs.length; i++) {
        const m = errs[i];
        if (m.table !== this.table) continue;
        if (m.op && m.op !== this._op) continue;
        if (m.match && !m.match(this.filters)) continue;
        if (m.once) errs.splice(i, 1);
        return { message: m.message || 'simulated transient db error' };
      }
      return null;
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
        const injected = this._injectedError();
        if (injected) return { data: null, error: injected };
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
    if (opts?.global?.headers?.Authorization) {
      return {
        auth: {
          getUser: async () => state.user
            ? { data: { user: state.user }, error: null }
            : { data: { user: null }, error: { message: 'Invalid token' } },
        },
      };
    }
    return {
      from: (table) => new QueryBuilder(state.db, table),
      rpc: async () => ({ data: [], error: null }),
      auth: { getUser: async () => ({ data: { user: null }, error: { message: 'n/a' } }) },
    };
  }

  return { state, resetDb, failOn, createClientImpl };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: harness.createClientImpl,
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

  const mod = await import('../index.js');
  app = mod.app;
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

const ADMIN = { id: 'user-admin', role: 'admin', email: 'admin@vu.nl' };
const COURSE_ID = 'course-1';

// Zet de admin-user + zaai de minimaal benodigde tabellen.
function seedAdmin(extra = {}) {
  harness.state.user = { id: ADMIN.id, email: ADMIN.email };
  harness.resetDb({
    profiles: [{ id: ADMIN.id, role: ADMIN.role, email: ADMIN.email }],
    courses: [{ id: COURSE_ID, name: 'Statistiek 1' }],
    documents: [],
    document_chunks: [],
    document_folders: [],
    course_folder_assignments: [],
    folder_permissions: [],
    ...extra,
  });
}

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
        let parsed = null;
        const trimmed = (raw || '').trim();
        if (trimmed) {
          try { parsed = JSON.parse(trimmed); } catch { parsed = { raw: trimmed }; }
        }
        resolve({ status: res.statusCode, body: parsed || {} });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ===========================================================================
// process-pptx / process-docx: documents-by-id lookup faalt
// ===========================================================================
describe('POST /api/admin/process-pptx — flaky documents-lookup', () => {
  it('surfaced een lookup-fout als 500 (geen 404) en verwerkt geen chunks', async () => {
    seedAdmin({
      documents: [{
        id: 'doc-1', title: 'Deck', filename: 'deck.pptx', file_path: 'f/deck.pptx',
        bucket: 'rag_sources', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        file_type: 'pptx', folder_id: 'folder-1', processing_status: 'completed',
      }],
    });
    // De documents-by-id lookup geeft een transiënte fout terug.
    harness.failOn({ table: 'documents', op: 'select', message: 'transient PostgREST timeout' });

    const res = await post('/api/admin/process-pptx', { documentId: 'doc-1' });

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(404);
    expect(res.body.error).toMatch(/opzoeken/i);
    // Geen chunks aangemaakt; status onaangeroerd (niet stilletjes op 'failed').
    expect(harness.state.db.tables.document_chunks.length).toBe(0);
    expect(harness.state.db.tables.documents[0].processing_status).toBe('completed');
  });
});

describe('POST /api/admin/process-docx — flaky documents-lookup', () => {
  it('surfaced een lookup-fout als 500 (geen 404) en verwerkt geen chunks', async () => {
    seedAdmin({
      documents: [{
        id: 'doc-2', title: 'Notitie', filename: 'notitie.docx', file_path: 'f/notitie.docx',
        bucket: 'rag_sources', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        file_type: 'docx', folder_id: 'folder-1', processing_status: 'completed',
      }],
    });
    harness.failOn({ table: 'documents', op: 'select', message: 'transient PostgREST timeout' });

    const res = await post('/api/admin/process-docx', { documentId: 'doc-2' });

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(404);
    expect(res.body.error).toMatch(/opzoeken/i);
    expect(harness.state.db.tables.document_chunks.length).toBe(0);
    expect(harness.state.db.tables.documents[0].processing_status).toBe('completed');
  });
});

// ===========================================================================
// ensureCourseRagFolder via /api/admin/create-rag-folder
// ===========================================================================
describe('POST /api/admin/create-rag-folder — flaky ensureCourseRagFolder-lookups', () => {
  const PAYLOAD = { courseId: COURSE_ID, courseName: 'Statistiek 1' };

  it('eerste cursuskoppeling-lookup faalt → 500, geen map/koppeling aangemaakt', async () => {
    seedAdmin();
    // De allereerste course_folder_assignments-lookup (heeft de cursus al een map?)
    // faalt. Zonder de guard zou dit als "geen koppeling" gelezen worden en een
    // tweede RAG-map aanmaken.
    harness.failOn({ table: 'course_folder_assignments', op: 'select', message: 'transient timeout' });

    const res = await post('/api/admin/create-rag-folder', PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/cursuskoppelingen niet opzoeken/i);
    expect(harness.state.db.tables.document_folders.length).toBe(0);
    expect(harness.state.db.tables.course_folder_assignments.length).toBe(0);
  });

  it('bestaande-gekoppelde-RAG-map-lookup faalt → 500, geen nieuwe map/koppeling', async () => {
    // Een bestaande koppeling zorgt dat assignedIds>0, zodat de document_folders-
    // lookup (de bestaande gekoppelde RAG-map) wordt geraakt.
    seedAdmin({
      course_folder_assignments: [{ id: 'cfa-1', course_id: COURSE_ID, folder_id: 'folder-existing' }],
    });
    harness.failOn({ table: 'document_folders', op: 'select', message: 'transient timeout' });

    const res = await post('/api/admin/create-rag-folder', PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/gekoppelde RAG-map niet opzoeken/i);
    // Geen NIEUWE map en geen NIEUWE koppeling (de bestaande blijft staan).
    expect(harness.state.db.tables.document_folders.length).toBe(0);
    expect(harness.state.db.tables.course_folder_assignments.length).toBe(1);
  });

  it('bestaande-koppeling-lookup faalt → 500, geen koppeling aangemaakt', async () => {
    seedAdmin();
    // Geen bestaande koppeling/naam-match → de flow maakt een nieuwe map en
    // controleert dan op een bestaande koppeling (course_folder_assignments op
    // course_id ÉN folder_id). Laat juist die lookup falen.
    harness.failOn({
      table: 'course_folder_assignments',
      op: 'select',
      match: (filters) => filters.some((f) => f.col === 'folder_id'),
      message: 'transient timeout',
    });

    const res = await post('/api/admin/create-rag-folder', PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/bestaande koppeling niet opzoeken/i);
    // Cruciaal: GEEN koppeling aangemaakt (de duplicaat-koppeling-bug).
    expect(harness.state.db.tables.course_folder_assignments.length).toBe(0);
  });
});
