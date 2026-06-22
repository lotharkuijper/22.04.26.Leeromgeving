// Task #326 — Integratietest die de wees-leesmarkering-opruimer (Task #323)
// end-to-end tegen een echte Postgres draait. De pure SQL-bouwer
// `buildOrphanThreadReadsCleanupSql` is al op string-niveau getest, maar de
// werkelijke DELETE — met de `USING courses` join, het admin/superuser-NOT
// EXISTS en de lidmaatschaps-uitzondering — was nog niet uitgevoerd tegen echte
// tabellen. Deze test seedt representatieve fixtures (open / verborgen /
// gearchiveerde cursussen, studenten, docent-leden, admin en superuser) en
// verifieert PER SCENARIO welke `studiecafe_thread_reads`-rijen overblijven.
//
// Twee paden worden gedekt:
//   • de student_visible-variant (moderne DB met de kolom);
//   • de kolomloze fallback (oude DB) — inclusief de bevestiging dat de
//     student_visible-variant op zo'n DB met een echte 42703 faalt, precies de
//     fout waarop `runOrphanThreadReadsCleanupOnce` terugvalt.
//
// Alles draait in een wegwerp-schema dat in afterAll wordt gedropt. De test
// SKIPt zichzelf wanneer er geen DATABASE_URL is (bijv. CI zonder Postgres),
// zodat de suite daar niet rood wordt.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildOrphanThreadReadsCleanupSql } from '../studiecafe.js';

const { Client } = pg;
const CONN = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const hasDb = Boolean(CONN);

const SUPERUSER_EMAIL = 'superuser@example.com';
const rid = Math.random().toString(36).slice(2, 8);
const SCHEMA = `orphan_reads_test_${rid}`;

// Maakt de minimale tabellen die de cleanup-SQL aanraakt. Met
// `includeStudentVisible=false` ontbreekt de student_visible-kolom op `courses`,
// zodat de moderne SQL er een 42703 op gooit (de fallback-trigger).
async function createSchema(pool, includeStudentVisible) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  // De pool draait met max:1, dus deze ene connectie behoudt het search_path voor
  // alle volgende queries (incl. de ongekwalificeerde cleanup-SQL).
  await pool.query(`SET search_path TO ${SCHEMA}, public`);
  await pool.query(`
    CREATE TABLE profiles (
      id text PRIMARY KEY,
      email text,
      role text
    )`);
  await pool.query(`
    CREATE TABLE courses (
      id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
      ${includeStudentVisible ? ', student_visible boolean NOT NULL DEFAULT true' : ''}
    )`);
  await pool.query(`
    CREATE TABLE course_members (
      course_id text NOT NULL,
      user_id text NOT NULL,
      member_role text
    )`);
  await pool.query(`
    CREATE TABLE studiecafe_thread_reads (
      tag text PRIMARY KEY,
      course_id text NOT NULL,
      user_id text NOT NULL
    )`);
}

async function insertProfiles(pool, rows) {
  for (const p of rows) {
    await pool.query(
      `INSERT INTO ${SCHEMA}.profiles (id, email, role) VALUES ($1, $2, $3)`,
      [p.id, p.email ?? null, p.role ?? null],
    );
  }
}

async function insertCourses(pool, rows, includeStudentVisible) {
  for (const c of rows) {
    if (includeStudentVisible) {
      await pool.query(
        `INSERT INTO ${SCHEMA}.courses (id, is_active, student_visible) VALUES ($1, $2, $3)`,
        [c.id, c.is_active ?? true, c.student_visible ?? true],
      );
    } else {
      await pool.query(
        `INSERT INTO ${SCHEMA}.courses (id, is_active) VALUES ($1, $2)`,
        [c.id, c.is_active ?? true],
      );
    }
  }
}

async function insertMembers(pool, rows) {
  for (const m of rows) {
    await pool.query(
      `INSERT INTO ${SCHEMA}.course_members (course_id, user_id, member_role) VALUES ($1, $2, $3)`,
      [m.course_id, m.user_id, m.member_role ?? 'student'],
    );
  }
}

async function insertReads(pool, rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO ${SCHEMA}.studiecafe_thread_reads (tag, course_id, user_id) VALUES ($1, $2, $3)`,
      [r.tag, r.course_id, r.user_id],
    );
  }
}

async function remainingTags(pool) {
  const res = await pool.query(`SELECT tag FROM ${SCHEMA}.studiecafe_thread_reads ORDER BY tag`);
  return res.rows.map((row) => row.tag).sort();
}

describe.skipIf(!hasDb)('runOrphanThreadReadsCleanupOnce — DELETE tegen echte Postgres', () => {
  let pool;

  beforeAll(async () => {
    // Eén vaste connectie voor de hele suite (geen pool die de connectie bij een
    // query-fout vervangt en zo het search_path verliest), zodat het search_path
    // dat createSchema zet blijft staan voor de ongekwalificeerde cleanup-SQL.
    pool = new Client({ connectionString: CONN });
    await pool.connect();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  describe('student_visible-variant (moderne DB)', () => {
    beforeAll(async () => {
      await createSchema(pool, true);
      await insertProfiles(pool, [
        { id: 'student1' },
        { id: 'student2' },
        { id: 'teacher1' },
        { id: 'admin1', role: 'admin' },
        { id: 'super1', email: SUPERUSER_EMAIL },
      ]);
      await insertCourses(pool, [
        { id: 'open', is_active: true, student_visible: true },
        { id: 'hidden', is_active: true, student_visible: false },
        { id: 'archived', is_active: false, student_visible: true },
      ], true);
      await insertMembers(pool, [
        // Docent-lid van de verborgen cursus: houdt toegang.
        { course_id: 'hidden', user_id: 'teacher1', member_role: 'teacher' },
        // Student-lid van de verborgen cursus: verliest tóch toegang.
        { course_id: 'hidden', user_id: 'student2', member_role: 'student' },
        // Gewoon lid van de gearchiveerde cursus: houdt toegang.
        { course_id: 'archived', user_id: 'student2', member_role: 'student' },
      ]);
      await insertReads(pool, [
        // Open cursus → nooit opgeruimd.
        { tag: 'open-student1', course_id: 'open', user_id: 'student1' },
        { tag: 'open-admin1', course_id: 'open', user_id: 'admin1' },
        // Verborgen cursus.
        { tag: 'hidden-student1-nonmember', course_id: 'hidden', user_id: 'student1' },
        { tag: 'hidden-teacher1-member', course_id: 'hidden', user_id: 'teacher1' },
        { tag: 'hidden-student2-member', course_id: 'hidden', user_id: 'student2' },
        { tag: 'hidden-admin1', course_id: 'hidden', user_id: 'admin1' },
        { tag: 'hidden-super1', course_id: 'hidden', user_id: 'super1' },
        // Gearchiveerde cursus.
        { tag: 'archived-student1-nonmember', course_id: 'archived', user_id: 'student1' },
        { tag: 'archived-student2-member', course_id: 'archived', user_id: 'student2' },
        { tag: 'archived-admin1', course_id: 'archived', user_id: 'admin1' },
      ]);

      const res = await pool.query(buildOrphanThreadReadsCleanupSql(true), [SUPERUSER_EMAIL]);
      // 3 wees-rijen verwacht: student in verborgen cursus (non-member + member),
      // en student-non-member in gearchiveerde cursus.
      expect(res.rowCount).toBe(3);
    });

    it('laat leesmarkeringen in een open, zichtbare cursus ongemoeid', async () => {
      const tags = await remainingTags(pool);
      expect(tags).toContain('open-student1');
      expect(tags).toContain('open-admin1');
    });

    it('verwijdert de leesmarkering van een student zonder toegang tot een verborgen cursus', async () => {
      const tags = await remainingTags(pool);
      expect(tags).not.toContain('hidden-student1-nonmember');
      // Een student-LID houdt evenmin toegang tot een verborgen cursus.
      expect(tags).not.toContain('hidden-student2-member');
    });

    it('spaart docent-leden van een verborgen cursus', async () => {
      const tags = await remainingTags(pool);
      expect(tags).toContain('hidden-teacher1-member');
    });

    it('verwijdert non-leden uit een gearchiveerde cursus maar spaart leden', async () => {
      const tags = await remainingTags(pool);
      expect(tags).not.toContain('archived-student1-nonmember');
      expect(tags).toContain('archived-student2-member');
    });

    it('behoudt admins en de superuser in elke afgeschermde cursus', async () => {
      const tags = await remainingTags(pool);
      expect(tags).toContain('hidden-admin1');
      expect(tags).toContain('hidden-super1');
      expect(tags).toContain('archived-admin1');
    });

    it('houdt exact de verwachte verzameling rijen over', async () => {
      const tags = await remainingTags(pool);
      expect(tags).toEqual([
        'archived-admin1',
        'archived-student2-member',
        'hidden-admin1',
        'hidden-super1',
        'hidden-teacher1-member',
        'open-admin1',
        'open-student1',
      ]);
    });
  });

  describe('kolomloze fallback (oude DB zonder student_visible)', () => {
    beforeAll(async () => {
      await createSchema(pool, false);
      await insertProfiles(pool, [
        { id: 'student1' },
        { id: 'student2' },
        { id: 'admin1', role: 'admin' },
        { id: 'super1', email: SUPERUSER_EMAIL },
      ]);
      await insertCourses(pool, [
        { id: 'active', is_active: true },
        { id: 'archived', is_active: false },
      ], false);
      await insertMembers(pool, [
        // Elk lid (ongeacht rol) houdt toegang in de fallback-variant.
        { course_id: 'archived', user_id: 'student2', member_role: 'student' },
      ]);
      await insertReads(pool, [
        { tag: 'active-student1', course_id: 'active', user_id: 'student1' },
        { tag: 'archived-student1-nonmember', course_id: 'archived', user_id: 'student1' },
        { tag: 'archived-student2-member', course_id: 'archived', user_id: 'student2' },
        { tag: 'archived-admin1', course_id: 'archived', user_id: 'admin1' },
        { tag: 'archived-super1', course_id: 'archived', user_id: 'super1' },
      ]);
    });

    it('faalt met 42703 wanneer de student_visible-variant op een kolomloze DB draait', async () => {
      // Dit bevestigt dat de fallback-trigger in runOrphanThreadReadsCleanupOnce
      // op de échte Postgres-foutcode reageert.
      let code = null;
      try {
        await pool.query(buildOrphanThreadReadsCleanupSql(true), [SUPERUSER_EMAIL]);
      } catch (err) {
        code = err.code;
      }
      expect(code).toBe('42703');
    });

    it('ruimt alleen non-leden uit gearchiveerde cursussen op; actieve cursus en leden blijven', async () => {
      const res = await pool.query(buildOrphanThreadReadsCleanupSql(false), [SUPERUSER_EMAIL]);
      // Alleen archived-student1-nonmember moet weg.
      expect(res.rowCount).toBe(1);
      const tags = await remainingTags(pool);
      expect(tags).toEqual([
        'active-student1',
        'archived-admin1',
        'archived-student2-member',
        'archived-super1',
      ]);
    });
  });
});
