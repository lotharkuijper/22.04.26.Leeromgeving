import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import pg from 'pg';
import {
  filterEvidenceByAccess,
  registerConceptEvidenceRoutes,
} from '../conceptEvidence.js';

// ───────────────────────────────────────────────────────────────────────────
// Cursus-isolatie van bron-bewijs (Task #244). Twee verdedigingslagen:
//
//   1. Applicatielaag — GET /api/concepts/evidence draait met de service-role
//      (die RLS omzeilt) en moet daarom zélf de bewijsrijen filteren tot de
//      cursussen waar de beller lid van is. Hier hermetisch getest met
//      dependency-injectie (geen DB), in de stijl van courseInfoAccess.test.js.
//
//   2. Databaselaag — de RLS-policy `concept_evidence_select` moet een directe
//      Supabase-leesactie door een niet-lid blokkeren. Getest tegen een echte
//      Postgres via SUPABASE_DB_URL (overgeslagen als die ontbreekt); alle
//      fixtures lopen binnen een transactie die altijd wordt teruggedraaid.
// ───────────────────────────────────────────────────────────────────────────

// ── Pure helper ─────────────────────────────────────────────────────────────
describe('filterEvidenceByAccess (cross-course filter)', () => {
  it('houdt alleen rijen van cursussen waar de beller toegang toe heeft', async () => {
    const rows = [
      { id: 'a1', course_id: 'A', similarity: 0.9 },
      { id: 'b1', course_id: 'B', similarity: 0.8 },
      { id: 'a2', course_id: 'A', similarity: 0.7 },
    ];
    const out = await filterEvidenceByAccess({
      rows,
      hasCourseAccess: async (courseId) => courseId === 'A',
    });
    expect(out.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('laat rijen zonder course_id altijd door (legacy/global)', async () => {
    const rows = [
      { id: 'g1', course_id: null, similarity: 0.5 },
      { id: 'b1', course_id: 'B', similarity: 0.5 },
    ];
    const out = await filterEvidenceByAccess({
      rows,
      hasCourseAccess: async () => false,
    });
    expect(out.map((r) => r.id)).toEqual(['g1']);
  });

  it('cachet de toegangscheck per course_id (één check per cursus)', async () => {
    const calls = [];
    const rows = [
      { id: 'a1', course_id: 'A' },
      { id: 'a2', course_id: 'A' },
      { id: 'b1', course_id: 'B' },
    ];
    await filterEvidenceByAccess({
      rows,
      hasCourseAccess: async (courseId) => {
        calls.push(courseId);
        return true;
      },
    });
    expect(calls).toEqual(['A', 'B']);
  });

  it('capt het resultaat op de opgegeven limit', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, course_id: 'A' }));
    const out = await filterEvidenceByAccess({ rows, hasCourseAccess: async () => true, limit: 10 });
    expect(out).toHaveLength(10);
  });
});

// ── Applicatielaag: GET /api/concepts/evidence ──────────────────────────────
// Mutabele teststaat per test.
let authState; // null ⇒ requireAuthUser antwoordt 401; anders {user, profile}
let schemaReady;
let allowedCourses; // Set<string> die userHasCourseAccess true teruggeeft
let sbQueues; // per-tabel FIFO-wachtrij met Supabase-resultaten

function queueResult(table, result) {
  (sbQueues[table] ||= []).push(result);
}
function nextResult(table) {
  const q = sbQueues[table];
  if (q && q.length) return q.shift();
  return { data: null, error: null };
}

function makeBuilder(table) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(nextResult(table)),
    single: () => Promise.resolve(nextResult(table)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(nextResult(table)).then(onFulfilled, onRejected),
  };
  return builder;
}

const supabaseAdminMock = { from: (table) => makeBuilder(table) };

const deps = {
  supabaseAdmin: supabaseAdminMock,
  requireAuthUser: async (req, res) => {
    if (!authState) {
      res.status(401).json({ error: 'Niet geauthenticeerd' });
      return null;
    }
    return authState;
  },
  userHasCourseAccess: async (_user, _profile, courseId) => allowedCourses.has(courseId),
  getSchemaReady: () => schemaReady,
};

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerConceptEvidenceRoutes(app, deps);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  if (server) server.close();
});

beforeEach(() => {
  authState = { user: { id: 'user-1' }, profile: { role: 'student', email: 's@vu.nl' } };
  schemaReady = true;
  allowedCourses = new Set(['course-A']);
  sbQueues = {};
});

function api(path) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: 'Bearer tkn', 'Content-Type': 'application/json' },
  });
}

describe('GET /api/concepts/evidence (cursus-scoped)', () => {
  it('weigert niet-geauthenticeerde gebruiker met 401', async () => {
    authState = null;
    const res = await api('/api/concepts/evidence?conceptId=c1');
    expect(res.status).toBe(401);
  });

  it('eist conceptId (400 zonder)', async () => {
    const res = await api('/api/concepts/evidence');
    expect(res.status).toBe(400);
  });

  it('geeft lege lijst als de migratie nog niet is toegepast', async () => {
    schemaReady = false;
    const res = await api('/api/concepts/evidence?conceptId=c1');
    expect(res.status).toBe(200);
    expect((await res.json()).evidence).toEqual([]);
  });

  it('filtert bewijsrijen van cursussen waar de beller GEEN lid van is weg', async () => {
    // Beller is lid van course-A, niet van course-B. Een gedeeld begrip heeft
    // bewijs uit beide cursussen; alleen course-A mag terugkomen.
    queueResult('concept_evidence', {
      data: [
        { id: 'ev-a', chunk_id: 'ch-a', document_id: 'doc-a', snippet: 'A-materiaal', similarity: 0.9, course_id: 'course-A' },
        { id: 'ev-b', chunk_id: 'ch-b', document_id: 'doc-b', snippet: 'B-materiaal (geheim)', similarity: 0.95, course_id: 'course-B' },
      ],
      error: null,
    });
    queueResult('documents', { data: [{ id: 'doc-a', title: 'Hoorcollege A' }], error: null });
    queueResult('document_chunks', { data: [{ id: 'ch-a', metadata: { slide: 3 } }], error: null });

    const res = await api('/api/concepts/evidence?conceptId=shared-concept');
    expect(res.status).toBe(200);
    const { evidence } = await res.json();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].id).toBe('ch-a');
    expect(evidence[0].content).toBe('A-materiaal');
    expect(evidence[0].documentTitle).toBe('Hoorcollege A');
    // Cruciaal: geen enkel fragment uit de andere cursus lekt door.
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('B-materiaal');
    expect(serialized).not.toContain('course-B');
  });

  it('geeft lege lijst als de beller geen toegang heeft tot enige bron-cursus', async () => {
    allowedCourses = new Set(); // lid van niets
    queueResult('concept_evidence', {
      data: [
        { id: 'ev-b', chunk_id: 'ch-b', document_id: 'doc-b', snippet: 'B-materiaal', similarity: 0.9, course_id: 'course-B' },
      ],
      error: null,
    });
    const res = await api('/api/concepts/evidence?conceptId=c1');
    expect(res.status).toBe(200);
    expect((await res.json()).evidence).toEqual([]);
  });
});

// ── Databaselaag: RLS-policy concept_evidence_select ────────────────────────
const DB_URL = process.env.SUPABASE_DB_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe('RLS: directe lezing van concept_evidence door niet-lid', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it('niet-lid (authenticated) en anon krijgen 0 rijen; service-role ziet de rij wél', async () => {
    await client.query('BEGIN');
    try {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const { rows: cr } = await client.query(
        'INSERT INTO courses (name, folder_name) VALUES ($1, $2) RETURNING id',
        [`__rls_test_course_${suffix}`, `__rls_test_folder_${suffix}`],
      );
      const courseId = cr[0].id;
      const { rows: cn } = await client.query(
        "INSERT INTO concepts (name, category) VALUES ($1, 'biostatistiek') RETURNING id",
        [`__rls_test_concept_${suffix}`],
      );
      const conceptId = cn[0].id;
      await client.query(
        'INSERT INTO concept_evidence (concept_id, course_id, snippet, similarity) VALUES ($1, $2, $3, 0.9)',
        [conceptId, courseId, 'geheim cursusmateriaal'],
      );

      // Controle: als postgres (RLS-bypass) bestaat de rij echt.
      const asAdmin = await client.query(
        'SELECT count(*)::int AS n FROM concept_evidence WHERE concept_id = $1',
        [conceptId],
      );
      expect(asAdmin.rows[0].n).toBe(1);

      // Een willekeurige uid die zeker geen lid is van de cursus.
      const { rows: ur } = await client.query('SELECT gen_random_uuid() AS uid');
      const outsiderUid = ur[0].uid;

      // Lees als authenticated niet-lid: RLS-policy moet 0 rijen geven.
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: outsiderUid, role: 'authenticated' }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');
      const asOutsider = await client.query(
        'SELECT id FROM concept_evidence WHERE concept_id = $1',
        [conceptId],
      );
      expect(asOutsider.rows.length).toBe(0);
      await client.query('RESET ROLE');

      // Lees als anon (geen claims): eveneens 0 rijen.
      await client.query("SELECT set_config('request.jwt.claims', '', true)");
      await client.query('SET LOCAL ROLE anon');
      const asAnon = await client.query(
        'SELECT id FROM concept_evidence WHERE concept_id = $1',
        [conceptId],
      );
      expect(asAnon.rows.length).toBe(0);
      await client.query('RESET ROLE');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
