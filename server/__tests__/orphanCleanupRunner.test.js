// Task #330 — Unit-tests voor de omhullende opruim-runner zelf
// (`createOrphanCourseAccessCleanupRunner` in server/studiecafe.js). De pure
// DELETE-SQL is al string- én Postgres-getest (Task #323/#325/#326); hier testen
// we het GEDRAG van de runner met een mock-pgPool, zonder echte database:
//   • 42703 (student_visible-kolom ontbreekt) → terugval op de kolomloze SQL;
//   • 42P01 (tabel ontbreekt, ook na fallback) → stille no-op (null);
//   • pgPool=null → no-op (geen query);
//   • de overlap-gate voorkomt een tweede gelijktijdige run.
//
// De getters worden hier expres als functies geleverd zodat we ook bevestigen
// dat de runner de ACTUELE waarde leest (zoals de module-state in index.js die
// pas na startup-detectie wijzigt).

import { describe, it, expect, vi } from 'vitest';
import {
  createOrphanCourseAccessCleanupRunner,
  cleanupOrphanCourseAccessTableOnce,
  buildOrphanCourseAccessCleanupSql,
  ORPHAN_CLEANUP_TABLE_LABELS,
} from '../studiecafe.js';

const SUPERUSER = 'superuser@example.com';

// Mini-pgPool-mock: `query(sql, params)` raadpleegt een handler-functie zodat
// elke test per (sql) kan beslissen of er een fout met code X gegooid wordt of
// een rowCount-resultaat teruggegeven wordt. Houdt de aanroepen bij.
function makePool(handler) {
  const calls = [];
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
  };
}

function pgError(code) {
  const err = new Error(`pg error ${code}`);
  err.code = code;
  return err;
}

// Stille logger zodat verwachte waarschuwingen de testoutput niet vervuilen; we
// kunnen wel asserten op de aanroepen.
function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe('cleanupOrphanCourseAccessTableOnce — fallback per tabel', () => {
  it('42703 → draait de kolomloze SQL en geeft die rowCount terug', async () => {
    const modernSql = buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', true);
    const legacySql = buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', false);
    const pool = makePool((sql) => {
      if (sql === modernSql) throw pgError('42703');
      if (sql === legacySql) return { rowCount: 4 };
      throw new Error(`onverwachte SQL: ${sql}`);
    });
    const logger = makeLogger();

    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: true,
      superuserEmail: SUPERUSER,
      logger,
    });

    expect(count).toBe(4);
    // Eerst de moderne SQL (faalt), dan exact de kolomloze fallback-SQL.
    expect(pool.calls.map((c) => c.sql)).toEqual([modernSql, legacySql]);
    expect(pool.calls[1].params).toEqual([SUPERUSER]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('42703 → 42P01 op de fallback geeft stil null (geen waarschuwing)', async () => {
    const pool = makePool((sql) => {
      if (/student_visible/.test(sql)) throw pgError('42703');
      throw pgError('42P01'); // fallback-tabel ontbreekt ook
    });
    const logger = makeLogger();

    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: true,
      superuserEmail: SUPERUSER,
      logger,
    });

    expect(count).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('42P01 op de eerste poging geeft stil null (tabel ontbreekt)', async () => {
    const pool = makePool(() => { throw pgError('42P01'); });
    const logger = makeLogger();

    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: true,
      superuserEmail: SUPERUSER,
      logger,
    });

    expect(count).toBeNull();
    expect(pool.calls).toHaveLength(1); // geen fallback bij 42P01
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('een onverwachte fout waarschuwt en geeft null (breekt niet af)', async () => {
    const pool = makePool(() => { throw pgError('08006'); }); // connection failure
    const logger = makeLogger();

    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: true,
      superuserEmail: SUPERUSER,
      logger,
    });

    expect(count).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('een onverwachte fout op de kolomloze fallback waarschuwt en geeft null', async () => {
    const pool = makePool((sql) => {
      if (/student_visible/.test(sql)) throw pgError('42703');
      throw pgError('08006'); // fallback faalt op iets anders dan 42P01
    });
    const logger = makeLogger();

    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: true,
      superuserEmail: SUPERUSER,
      logger,
    });

    expect(count).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/fallback/);
  });

  it('rowCount-loos resultaat telt als 0', async () => {
    const pool = makePool(() => ({}));
    const count = await cleanupOrphanCourseAccessTableOnce({
      pgPool: pool,
      table: 'studiecafe_thread_reads',
      hasStudentVisible: false,
      superuserEmail: SUPERUSER,
      logger: makeLogger(),
    });
    expect(count).toBe(0);
  });
});

describe('createOrphanCourseAccessCleanupRunner — gedrag van de runner', () => {
  it('pgPool=null → no-op (geen query, geen fout)', async () => {
    const logger = makeLogger();
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => null,
      getHasStudentVisible: () => true,
      getSuperuserEmail: () => SUPERUSER,
      logger,
    });
    await expect(run()).resolves.toBeUndefined();
    expect(run.isRunning()).toBe(false);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('ruimt alle standaardtabellen op en logt alleen niet-nul resultaten', async () => {
    // Per tabel een rowCount terug: thread_reads=2, last_seen=0, levels=3.
    const perTable = {
      studiecafe_thread_reads: 2,
      studiecafe_last_seen: 0,
      student_course_levels: 3,
    };
    const pool = makePool((sql) => {
      const table = ORPHAN_CLEANUP_TABLE_LABELS.find((t) =>
        new RegExp(`DELETE FROM ${t.name}\\b`).test(sql),
      );
      return { rowCount: perTable[table.name] };
    });
    const logger = makeLogger();
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => pool,
      getHasStudentVisible: () => true,
      getSuperuserEmail: () => SUPERUSER,
      logger,
    });

    await run();

    // Eén query per tabel (geen fallback nodig).
    expect(pool.query).toHaveBeenCalledTimes(3);
    // Alleen de twee niet-nul tellingen worden gelogd.
    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.log.mock.calls[0][0]).toMatch(/2 wees-leesmarkering/);
    expect(logger.log.mock.calls[1][0]).toMatch(/3 wees-leerniveau/);
    expect(run.isRunning()).toBe(false);
  });

  it('per tabel de juiste fallback: 42703 valt terug, andere tabel blijft draaien', async () => {
    const modernReads = buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', true);
    const legacyReads = buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', false);
    const pool = makePool((sql) => {
      if (sql === modernReads) throw pgError('42703');
      if (sql === legacyReads) return { rowCount: 1 };
      // last_seen ontbreekt als tabel; levels werkt normaal.
      if (/DELETE FROM studiecafe_last_seen\b/.test(sql)) throw pgError('42P01');
      if (/DELETE FROM student_course_levels\b/.test(sql)) return { rowCount: 5 };
      throw new Error(`onverwachte SQL: ${sql}`);
    });
    const logger = makeLogger();
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => pool,
      getHasStudentVisible: () => true,
      getSuperuserEmail: () => SUPERUSER,
      logger,
    });

    await run();

    // thread_reads: modern (faalt) + legacy (slaagt); last_seen: 1 (42P01);
    // levels: 1 → totaal 4 query-aanroepen.
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(2); // reads=1, levels=5 (last_seen=null)
    expect(logger.log.mock.calls[0][0]).toMatch(/1 wees-leesmarkering/);
    expect(logger.log.mock.calls[1][0]).toMatch(/5 wees-leerniveau/);
  });

  it('de overlap-gate blokkeert een tweede gelijktijdige run', async () => {
    // Laat de eerste query hangen tot we hem handmatig oplossen, zodat de runner
    // "bezig" blijft terwijl we een tweede run starten.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let queryCount = 0;
    const pool = {
      query: vi.fn(async () => {
        queryCount += 1;
        await gate;
        return { rowCount: 0 };
      }),
    };
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => pool,
      getHasStudentVisible: () => true,
      getSuperuserEmail: () => SUPERUSER,
      logger: makeLogger(),
    });

    const first = run(); // start, blijft hangen op de eerste query
    expect(run.isRunning()).toBe(true);
    await run(); // tweede run moet meteen terugkeren (gate dicht)
    expect(queryCount).toBe(1); // geen extra query door de tweede run

    release();
    await first;
    expect(run.isRunning()).toBe(false);

    // Na afronding kan een nieuwe run wél weer draaien.
    await run();
    expect(queryCount).toBeGreaterThan(1);
  });

  it('leest de actuele getters (pgPool dat later beschikbaar komt)', async () => {
    let pool = null;
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => pool,
      getHasStudentVisible: () => true,
      getSuperuserEmail: () => SUPERUSER,
      logger: makeLogger(),
    });

    await run(); // pgPool nog null → no-op

    pool = makePool(() => ({ rowCount: 0 }));
    await run(); // nu wel beschikbaar
    expect(pool.query).toHaveBeenCalledTimes(ORPHAN_CLEANUP_TABLE_LABELS.length);
  });

  it('geeft hasStudentVisible=false door zodat meteen de kolomloze SQL draait', async () => {
    const seenSql = [];
    const pool = makePool((sql) => { seenSql.push(sql); return { rowCount: 0 }; });
    const run = createOrphanCourseAccessCleanupRunner({
      getPgPool: () => pool,
      getHasStudentVisible: () => false,
      getSuperuserEmail: () => SUPERUSER,
      logger: makeLogger(),
    });

    await run();

    // Geen enkele query mag de student_visible-tak bevatten.
    expect(seenSql.every((sql) => !/student_visible/.test(sql))).toBe(true);
    // Eén query per tabel (geen 42703-fallback nodig).
    expect(pool.query).toHaveBeenCalledTimes(ORPHAN_CLEANUP_TABLE_LABELS.length);
  });
});
