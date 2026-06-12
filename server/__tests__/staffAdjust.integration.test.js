// Task #178 — Integratietest voor de staff-correctie op de persona-
// verstandhouding. De route wordt op een echte Express-app gemount; alle
// externe afhankelijkheden komen via dependency-injectie binnen als
// testdoubles. We sturen echte HTTP-verzoeken (via fetch tegen app.listen(0))
// zodat routing + middleware meelopen, en gebruiken de echte
// applyRelationshipDeltaImpl (pgPool=null-pad) bovenop een in-memory supabase
// zodat de wiring naar history/score end-to-end gedekt is.
//
// De regels die we bewaken:
//   - staff van de cursus mag corrigeren: delta wordt toegepast, history-event
//     bevat source='staff_adjust', by=<userId> en de motivatie (note);
//   - niet-staff krijgt 403;
//   - lege motivatie wordt geweigerd met 400.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { registerRelationshipAdjustRoute } from '../relationshipAdjust.js';
import { applyRelationshipDeltaImpl } from '../threadClose.js';
import { scoreToBucket } from '../personaRelationship.js';

// ───────────────────────────────────────────────────────────────────────────
// Mutabele teststaat: per test stellen we het gedrag van de auth-/staff-doubles
// en de Supabase-rijen in.
// ───────────────────────────────────────────────────────────────────────────
let authState; // null ⇒ authUser antwoordt 401; anders { user: {...} }
let staffState; // resultaat van isStaffForCourse
let projectRow; // rij voor `projects`
let groupRow; // rij voor `project_groups`
let personaRow; // rij voor `project_personas`
let profileRow; // rij voor `profiles`
let relationshipRows; // in-memory project_persona_relationships

const PROJECT_ID = 'proj-1';
const GROUP_ID = 'group-1';
const PERSONA_ID = 'persona-1';
const STAFF_ID = 'user-staff';

// In-memory supabase die exact de chains ondersteunt die de route + de echte
// applyRelationshipDeltaImpl (pgPool=null) gebruiken.
function makeFakeSupabase() {
  let nextId = 1;

  function singleTableSelect(getRow) {
    return {
      select() {
        const chain = {
          eq() { return chain; },
          async maybeSingle() { return { data: getRow(), error: null }; },
        };
        return chain;
      },
    };
  }

  function relationshipsTable() {
    return {
      select() {
        const filters = {};
        const chain = {
          eq(col, val) { filters[col] = val; return chain; },
          async maybeSingle() {
            const found = relationshipRows.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v));
            return { data: found ? { ...found } : null, error: null };
          },
        };
        return chain;
      },
      update(patch) {
        const filters = {};
        const chain = {
          eq(col, val) { filters[col] = val; return chain; },
          select() {
            return {
              async single() {
                const idx = relationshipRows.findIndex((r) =>
                  Object.entries(filters).every(([k, v]) => r[k] === v));
                if (idx === -1) return { data: null, error: { message: 'not found' } };
                relationshipRows[idx] = { ...relationshipRows[idx], ...patch };
                return { data: { ...relationshipRows[idx] }, error: null };
              },
            };
          },
        };
        return chain;
      },
      insert(row) {
        return {
          select() {
            return {
              async single() {
                const newRow = {
                  id: `rel-${nextId++}`,
                  score: 0,
                  history: [],
                  updated_at: new Date().toISOString(),
                  ...row,
                };
                relationshipRows.push(newRow);
                return { data: { ...newRow }, error: null };
              },
            };
          },
        };
      },
    };
  }

  return {
    from(table) {
      switch (table) {
        case 'projects': return singleTableSelect(() => projectRow);
        case 'profiles': return singleTableSelect(() => profileRow);
        case 'project_groups': return singleTableSelect(() => groupRow);
        case 'project_personas': return singleTableSelect(() => personaRow);
        case 'project_persona_relationships': return relationshipsTable();
        default: throw new Error(`fake supabase: unsupported table ${table}`);
      }
    },
  };
}

const fakeSupabase = makeFakeSupabase();

// Injecteer de echte applyRelationshipDeltaImpl bovenop de in-memory supabase
// (pgPool=null) zodat we de échte score-/history-mutatie testen.
async function applyRelationshipDelta(args) {
  return applyRelationshipDeltaImpl({ supabaseAdmin: fakeSupabase, pgPool: null }, args);
}

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRelationshipAdjustRoute(app, {
    supabaseAdmin: fakeSupabase,
    authUser: async () => (authState
      ? { user: authState.user }
      : { error: { status: 401, body: { error: 'Niet geauthenticeerd' } } }),
    isStaffForCourse: async () => staffState,
    applyRelationshipDelta,
    scoreToBucket,
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  authState = { user: { id: STAFF_ID, email: 'docent@vu.nl' } };
  staffState = true;
  projectRow = { id: PROJECT_ID, course_id: 'course-1' };
  groupRow = { id: GROUP_ID, project_id: PROJECT_ID };
  personaRow = { id: PERSONA_ID, project_id: PROJECT_ID };
  profileRow = { role: 'teacher', email: 'docent@vu.nl' };
  relationshipRows = [];
});

function adjust(body, { headers } = {}) {
  return fetch(
    `${baseUrl}/api/projects/${PROJECT_ID}/groups/${GROUP_ID}/personas/${PERSONA_ID}/relationship-adjust`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...headers },
      body: JSON.stringify(body),
    },
  );
}

describe('staff relationship-adjust integratie', () => {
  it('past een staff-correctie toe en schrijft een staff_adjust-history-event', async () => {
    const res = await adjust({ delta: 4, note: 'Goede voortgang besproken' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.relationship.score).toBe(4);
    expect(json.relationship.bucket).toBe(scoreToBucket(4));
    expect(json.relationship.history).toHaveLength(1);

    const evt = json.relationship.history[0];
    expect(evt.source).toBe('staff_adjust');
    expect(evt.by).toBe(STAFF_ID);
    expect(evt.delta).toBe(4);
    expect(evt.note).toBe('Goede voortgang besproken');
    expect(evt.refId).toMatch(new RegExp(`^staff_adjust:${STAFF_ID}:\\d+$`));

    // De mutatie is echt gepersisteerd in de relatie-rij.
    expect(relationshipRows).toHaveLength(1);
    expect(relationshipRows[0].score).toBe(4);
  });

  it('clampt de score binnen -10..+10 en stapelt op bestaande score', async () => {
    relationshipRows.push({
      id: 'rel-existing', project_id: PROJECT_ID, group_id: GROUP_ID,
      persona_id: PERSONA_ID, score: 8, history: [],
    });
    const res = await adjust({ delta: 5, note: 'Extra correctie' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.relationship.score).toBe(10); // 8 + 5 → geclampt op 10
  });

  it('weigert een niet-staff gebruiker met 403', async () => {
    staffState = false;
    profileRow = { role: 'student', email: 'student@vu.nl' };
    const res = await adjust({ delta: 3, note: 'Mag niet' });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/staff/i);
    // Geen relatie-rij aangemaakt.
    expect(relationshipRows).toHaveLength(0);
  });

  it('weigert een lege motivatie met 400', async () => {
    const res = await adjust({ delta: 3, note: '   ' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/motivatie/i);
    expect(relationshipRows).toHaveLength(0);
  });

  it('weigert een ontbrekende motivatie met 400', async () => {
    const res = await adjust({ delta: 3 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/motivatie/i);
  });

  it('weigert delta=0 met 400', async () => {
    const res = await adjust({ delta: 0, note: 'Nul' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/≠ 0/);
  });

  it('weigert een delta buiten -10..+10 met 400', async () => {
    const res = await adjust({ delta: 11, note: 'Te groot' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tussen -10 en \+10/);
  });

  it('weigert een ongeauthenticeerde gebruiker met 401', async () => {
    authState = null;
    const res = await adjust({ delta: 3, note: 'Niet ingelogd' });
    expect(res.status).toBe(401);
  });

  it('geeft 404 als het project niet bestaat', async () => {
    projectRow = null;
    const res = await adjust({ delta: 3, note: 'Geen project' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/project/i);
  });

  it('geeft 404 als de groep niet bij het project hoort', async () => {
    groupRow = { id: GROUP_ID, project_id: 'ander-project' };
    const res = await adjust({ delta: 3, note: 'Verkeerde groep' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/groep/i);
  });

  it('geeft 404 als de persona niet bij het project hoort', async () => {
    personaRow = { id: PERSONA_ID, project_id: 'ander-project' };
    const res = await adjust({ delta: 3, note: 'Verkeerde persona' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/persona/i);
  });
});
