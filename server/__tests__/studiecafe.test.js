import { describe, it, expect, beforeEach } from 'vitest';
import {
  STUDIECAFE_CATEGORIES,
  ALLOWED_REACTION_EMOJI,
  MAX_TITLE_LEN,
  MAX_BODY_LEN,
  MAX_REACTION_USERS,
  sanitizeCategory,
  validateThreadInput,
  validateReplyInput,
  isAllowedEmoji,
  normalizeReactions,
  toggleReaction,
  summarizeReactions,
  canModerate,
  canDeletePost,
  canEditPost,
  canSetResolved,
  canReplyToThread,
  buildSoftDeleteRedaction,
  buildOrphanThreadReadsCleanupSql,
  buildOrphanCourseAccessCleanupSql,
  ORPHAN_CLEANUP_TABLES,
  toggleReactionAtomicPg,
  toggleKudosAtomicPg,
  REACTION_TABLES,
  summarizeUnread,
  isThreadUnread,
  registerStudiecafeRoutes,
  isThreadUnreadFor,
  summarizeUnreadThreads,
} from '../studiecafe.js';

describe('sanitizeCategory', () => {
  it('laat geldige categorieën door', () => {
    for (const c of STUDIECAFE_CATEGORIES) expect(sanitizeCategory(c)).toBe(c);
  });
  it('kent de optie-D categorieën (samenwerken vervangt tip)', () => {
    expect(STUDIECAFE_CATEGORIES).toEqual(['vraag', 'discussie', 'samenwerken']);
    expect(sanitizeCategory('samenwerken')).toBe('samenwerken');
    // 'tip' bestaat niet meer en valt terug op de default.
    expect(sanitizeCategory('tip')).toBe('vraag');
  });
  it('valt terug op vraag bij onbekend/leeg', () => {
    expect(sanitizeCategory('foo')).toBe('vraag');
    expect(sanitizeCategory(undefined)).toBe('vraag');
    expect(sanitizeCategory(null)).toBe('vraag');
    expect(sanitizeCategory(42)).toBe('vraag');
  });
});

describe('validateThreadInput', () => {
  it('accepteert en trimt titel + body', () => {
    const r = validateThreadInput({ title: '  Hallo  ', body: '  wereld  ' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ title: 'Hallo', body: 'wereld' });
  });
  it('weigert lege titel', () => {
    expect(validateThreadInput({ title: '   ', body: 'x' }).ok).toBe(false);
    expect(validateThreadInput({ body: 'x' }).ok).toBe(false);
  });
  it('weigert lege body', () => {
    expect(validateThreadInput({ title: 'x', body: '   ' }).ok).toBe(false);
    expect(validateThreadInput({ title: 'x' }).ok).toBe(false);
  });
  it('weigert te lange titel', () => {
    expect(validateThreadInput({ title: 'a'.repeat(MAX_TITLE_LEN + 1), body: 'x' }).ok).toBe(false);
  });
  it('weigert te lange body', () => {
    expect(validateThreadInput({ title: 'x', body: 'a'.repeat(MAX_BODY_LEN + 1) }).ok).toBe(false);
  });
  it('is defensief tegen ontbrekend object', () => {
    expect(validateThreadInput().ok).toBe(false);
  });
});

describe('validateReplyInput', () => {
  it('accepteert en trimt', () => {
    const r = validateReplyInput({ body: '  hoi  ' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ body: 'hoi' });
  });
  it('weigert leeg + te lang', () => {
    expect(validateReplyInput({ body: '  ' }).ok).toBe(false);
    expect(validateReplyInput({ body: 'a'.repeat(MAX_BODY_LEN + 1) }).ok).toBe(false);
    expect(validateReplyInput().ok).toBe(false);
  });
});

describe('isAllowedEmoji / allowlist', () => {
  it('herkent toegestane emoji', () => {
    for (const e of ALLOWED_REACTION_EMOJI) expect(isAllowedEmoji(e)).toBe(true);
  });
  it('weigert niet-toegestane emoji en rommel', () => {
    expect(isAllowedEmoji('💩')).toBe(false);
    expect(isAllowedEmoji('a')).toBe(false);
    expect(isAllowedEmoji('')).toBe(false);
    expect(isAllowedEmoji(undefined)).toBe(false);
  });
});

describe('normalizeReactions', () => {
  it('strip niet-toegestane emoji, dedupe en lege arrays', () => {
    const out = normalizeReactions({ '👍': ['a', 'a', 'b'], '💩': ['c'], '🎉': [], '❤️': ['d'] });
    expect(out).toEqual({ '👍': ['a', 'b'], '❤️': ['d'] });
  });
  it('is defensief tegen rommel', () => {
    expect(normalizeReactions(null)).toEqual({});
    expect(normalizeReactions('x')).toEqual({});
    expect(normalizeReactions({ '👍': 'nope' })).toEqual({});
    expect(normalizeReactions({ '👍': [1, 2, null, ''] })).toEqual({});
  });
  it('cap op MAX_REACTION_USERS', () => {
    const many = Array.from({ length: MAX_REACTION_USERS + 50 }, (_, i) => `u${i}`);
    const out = normalizeReactions({ '👍': many });
    expect(out['👍'].length).toBe(MAX_REACTION_USERS);
  });
});

describe('toggleReaction', () => {
  it('voegt toe wanneer afwezig', () => {
    expect(toggleReaction({}, '👍', 'u1')).toEqual({ '👍': ['u1'] });
  });
  it('verwijdert wanneer aanwezig en ruimt lege array op', () => {
    expect(toggleReaction({ '👍': ['u1'] }, '👍', 'u1')).toEqual({});
  });
  it('behoudt andere reacties', () => {
    expect(toggleReaction({ '👍': ['u1'], '❤️': ['u2'] }, '👍', 'u3')).toEqual({
      '👍': ['u1', 'u3'],
      '❤️': ['u2'],
    });
  });
  it('null bij niet-toegestane emoji of ontbrekende user', () => {
    expect(toggleReaction({}, '💩', 'u1')).toBeNull();
    expect(toggleReaction({}, '👍', '')).toBeNull();
  });
});

describe('summarizeReactions', () => {
  it('telt en markeert de eigen reactie, in allowlist-volgorde', () => {
    const out = summarizeReactions({ '❤️': ['u1', 'u2'], '👍': ['u1'] }, 'u1');
    expect(out).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '❤️', count: 2, mine: true },
    ]);
  });
  it('mine=false zonder viewer of zonder match', () => {
    const out = summarizeReactions({ '👍': ['u2'] }, 'u1');
    expect(out).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(summarizeReactions({ '👍': ['u2'] }, null)).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });
  it('lege input → lege lijst', () => {
    expect(summarizeReactions({}, 'u1')).toEqual([]);
    expect(summarizeReactions(null, 'u1')).toEqual([]);
  });
});

describe('permissie-predicaten', () => {
  it('canModerate alleen voor staff', () => {
    expect(canModerate({ isStaff: true })).toBe(true);
    expect(canModerate({ isStaff: false })).toBe(false);
    expect(canModerate({})).toBe(false);
  });
  it('canDeletePost voor staff of auteur', () => {
    expect(canDeletePost({ isStaff: true, isAuthor: false })).toBe(true);
    expect(canDeletePost({ isStaff: false, isAuthor: true })).toBe(true);
    expect(canDeletePost({ isStaff: false, isAuthor: false })).toBe(false);
  });
  it('canEditPost voor staff of auteur', () => {
    expect(canEditPost({ isStaff: true, isAuthor: false })).toBe(true);
    expect(canEditPost({ isStaff: false, isAuthor: true })).toBe(true);
    expect(canEditPost({ isStaff: false, isAuthor: false })).toBe(false);
    expect(canEditPost({})).toBe(false);
  });
  it('canSetResolved voor staff of auteur', () => {
    expect(canSetResolved({ isStaff: false, isAuthor: true })).toBe(true);
    expect(canSetResolved({ isStaff: true, isAuthor: false })).toBe(true);
    expect(canSetResolved({ isStaff: false, isAuthor: false })).toBe(false);
  });
  it('canReplyToThread: staff altijd, anders alleen open', () => {
    expect(canReplyToThread({ isStaff: false, isLocked: false })).toBe(true);
    expect(canReplyToThread({ isStaff: false, isLocked: true })).toBe(false);
    expect(canReplyToThread({ isStaff: true, isLocked: true })).toBe(true);
  });
});

describe('buildSoftDeleteRedaction', () => {
  const ts = '2026-06-21T10:00:00.000Z';
  it('wist alle student-zichtbare inhoud van een reply', () => {
    const f = buildSoftDeleteRedaction({ ts, userId: 'mod-1', isThread: false });
    expect(f.deleted_at).toBe(ts);
    expect(f.deleted_by).toBe('mod-1');
    expect(f.body).toBe('');
    expect(f.author_id).toBeNull();
    expect(f.kudos_by).toBeNull();
    expect(f.kudos_at).toBeNull();
    expect(f.reactions).toEqual({});
    // geen titel/updated_at op replies
    expect('title' in f).toBe(false);
  });
  it('wist ook de titel + zet updated_at voor een thread', () => {
    const f = buildSoftDeleteRedaction({ ts, userId: 'mod-1', isThread: true });
    expect(f.title).toBe('');
    expect(f.body).toBe('');
    expect(f.author_id).toBeNull();
    expect(f.reactions).toEqual({});
    expect(f.updated_at).toBe(ts);
  });
  it('laat geen oude inhoud achter (body/auteur/kudos/reacties altijd geredigeerd)', () => {
    const f = buildSoftDeleteRedaction({ ts, userId: 'mod-1', isThread: true });
    for (const k of ['body', 'title']) expect(f[k]).toBe('');
    for (const k of ['author_id', 'kudos_by', 'kudos_at']) expect(f[k]).toBeNull();
    expect(f.reactions).toEqual({});
  });
});

describe('buildOrphanThreadReadsCleanupSql (Task #323)', () => {
  it('verwijdert read-rijen uit studiecafe_thread_reads', () => {
    const sql = buildOrphanThreadReadsCleanupSql(true);
    expect(sql).toContain('DELETE FROM studiecafe_thread_reads');
    expect(sql).toContain('USING courses c');
  });
  it('met student_visible: ruimt verborgen én gearchiveerde cursussen op', () => {
    const sql = buildOrphanThreadReadsCleanupSql(true);
    // Niet-open cursus = verborgen OF inactief.
    expect(sql).toContain('c.student_visible = false OR c.is_active = false');
    // Verborgen cursus: alleen docenten houden toegang.
    expect(sql).toContain("c.student_visible = false AND m.member_role = 'teacher'");
    // Gearchiveerd maar zichtbaar: elk lid houdt toegang.
    expect(sql).toContain('c.student_visible IS DISTINCT FROM false AND c.is_active = false');
  });
  it('spaart admins/superuser via de profiles-uitsluiting', () => {
    const sql = buildOrphanThreadReadsCleanupSql(true);
    expect(sql).toContain('FROM profiles p');
    expect(sql).toContain("p.role = 'admin' OR p.email = $1");
  });
  it('zonder student_visible-kolom: alleen gearchiveerde cursussen, leden behouden', () => {
    const sql = buildOrphanThreadReadsCleanupSql(false);
    expect(sql).toContain('c.is_active = false');
    expect(sql).not.toContain('student_visible');
    // Elk lid (ongeacht rol) blijft gespaard op een oude DB.
    expect(sql).toContain('FROM course_members m');
  });
});

describe('buildOrphanCourseAccessCleanupSql (Task #325)', () => {
  it('ondersteunt studiecafe_last_seen met dezelfde toegangsregels', () => {
    const sql = buildOrphanCourseAccessCleanupSql('studiecafe_last_seen', true);
    expect(sql).toContain('DELETE FROM studiecafe_last_seen');
    expect(sql).toContain('USING courses c');
    expect(sql).toContain('c.student_visible = false OR c.is_active = false');
    expect(sql).toContain("c.student_visible = false AND m.member_role = 'teacher'");
    expect(sql).toContain("p.role = 'admin' OR p.email = $1");
  });
  it('zonder student_visible-kolom: alleen gearchiveerde cursussen voor last_seen', () => {
    const sql = buildOrphanCourseAccessCleanupSql('studiecafe_last_seen', false);
    expect(sql).toContain('DELETE FROM studiecafe_last_seen');
    expect(sql).toContain('c.is_active = false');
    expect(sql).not.toContain('student_visible');
  });
  it('de thread_reads-wrapper produceert identieke SQL als de generieke vorm', () => {
    expect(buildOrphanThreadReadsCleanupSql(true)).toBe(
      buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', true),
    );
    expect(buildOrphanThreadReadsCleanupSql(false)).toBe(
      buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', false),
    );
  });
  it('weigert een niet-gewhiteliste tabelnaam (injectie-bescherming)', () => {
    expect(() => buildOrphanCourseAccessCleanupSql('courses; DROP TABLE x', true)).toThrow();
    expect(() => buildOrphanCourseAccessCleanupSql('profiles', true)).toThrow();
  });
  it('ondersteunt student_course_levels met dezelfde toegangsregels (Task #329)', () => {
    const sql = buildOrphanCourseAccessCleanupSql('student_course_levels', true);
    expect(sql).toContain('DELETE FROM student_course_levels');
    expect(sql).toContain('USING courses c');
    expect(sql).toContain('c.student_visible = false OR c.is_active = false');
    expect(sql).toContain("c.student_visible = false AND m.member_role = 'teacher'");
    expect(sql).toContain("p.role = 'admin' OR p.email = $1");
  });
  it('zonder student_visible-kolom: alleen gearchiveerde cursussen voor student_course_levels', () => {
    const sql = buildOrphanCourseAccessCleanupSql('student_course_levels', false);
    expect(sql).toContain('DELETE FROM student_course_levels');
    expect(sql).toContain('c.is_active = false');
    expect(sql).not.toContain('student_visible');
  });
  it('whitelist bevat alle tabellen', () => {
    expect(ORPHAN_CLEANUP_TABLES).toContain('studiecafe_thread_reads');
    expect(ORPHAN_CLEANUP_TABLES).toContain('studiecafe_last_seen');
    expect(ORPHAN_CLEANUP_TABLES).toContain('student_course_levels');
  });
});

// Fake pgPool die row-level locking (SELECT ... FOR UPDATE) modelleert via een
// per-id FIFO-mutex. Zo kunnen we aantonen dat twee gelijktijdige toggles
// serialiseren: de tweede transactie blokkeert op de FOR UPDATE tot de eerste
// COMMIT, leest dan de verse waarde en verliest de eerste reactie niet meer.
function makeFakePool(rowsObj) {
  const rows = new Map(Object.entries(rowsObj));
  const tails = new Map(); // id -> Promise (mutex-staart)
  let queries = 0;
  function acquire(id) {
    const prev = tails.get(id) || Promise.resolve();
    let release;
    const next = new Promise((res) => { release = res; });
    tails.set(id, prev.then(() => next));
    return prev.then(() => release);
  }
  return {
    rows,
    get queryCount() { return queries; },
    async connect() {
      let release = null;
      return {
        async query(sql, params) {
          queries += 1;
          if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
          if (/^\s*COMMIT/i.test(sql) || /^\s*ROLLBACK/i.test(sql)) {
            if (release) { release(); release = null; }
            return { rows: [] };
          }
          if (/FOR UPDATE/i.test(sql)) {
            const id = params[0];
            release = await acquire(id); // blokkeert tot vorige houder vrijgeeft
            const row = rows.get(id);
            // Diepe kopie zodat de "DB" pas bij UPDATE muteert (zoals echt SQL).
            return { rows: row ? [JSON.parse(JSON.stringify(row))] : [] };
          }
          if (/UPDATE/i.test(sql)) {
            const id = params[0];
            const row = rows.get(id);
            if (row) {
              if (/SET\s+kudos_by/i.test(sql)) {
                row.kudos_by = params[1];
                row.kudos_at = params[2];
              } else {
                row.reactions = JSON.parse(params[1]);
              }
            }
            return { rows: [], rowCount: 1 };
          }
          return { rows: [] };
        },
        release() { if (release) { release(); release = null; } },
      };
    },
  };
}

describe('toggleReactionAtomicPg — race-veiligheid', () => {
  it('verliest geen reactie bij twee gelijktijdige toggles op dezelfde post', async () => {
    const pool = makeFakePool({
      t1: { course_id: 'c1', reactions: {}, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_threads', targetId: 't1', courseId: 'c1' };
    // Twee verschillende gebruikers reageren tegelijk met verschillende emoji.
    const [a, b] = await Promise.all([
      toggleReactionAtomicPg({ ...base, emoji: '👍', userId: 'uA' }),
      toggleReactionAtomicPg({ ...base, emoji: '❤️', userId: 'uB' }),
    ]);
    expect(a.next).toBeTruthy();
    expect(b.next).toBeTruthy();
    // Cruciaal: BEIDE reacties overleven in de uiteindelijke DB-staat.
    expect(pool.rows.get('t1').reactions).toEqual({ '👍': ['uA'], '❤️': ['uB'] });
  });

  it('serialiseert dezelfde emoji van twee gebruikers (geen overschrijving)', async () => {
    const pool = makeFakePool({
      r9: { course_id: 'c1', reactions: {}, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_replies', targetId: 'r9', courseId: 'c1' };
    await Promise.all([
      toggleReactionAtomicPg({ ...base, emoji: '🎉', userId: 'uA' }),
      toggleReactionAtomicPg({ ...base, emoji: '🎉', userId: 'uB' }),
    ]);
    const arr = pool.rows.get('r9').reactions['🎉'];
    expect(arr).toHaveLength(2);
    expect([...arr].sort()).toEqual(['uA', 'uB']);
  });

  it('een gebruiker die twee keer dezelfde emoji togglet eindigt zonder reactie', async () => {
    const pool = makeFakePool({
      t2: { course_id: 'c1', reactions: {}, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_threads', targetId: 't2', courseId: 'c1', emoji: '✅', userId: 'uA' };
    await toggleReactionAtomicPg(base); // toevoegen
    await toggleReactionAtomicPg(base); // weer weghalen
    expect(pool.rows.get('t2').reactions).toEqual({});
  });

  it('geeft notFound bij ontbrekende rij, verkeerde cursus of verwijderd doel', async () => {
    const pool = makeFakePool({
      ok: { course_id: 'c1', reactions: {}, deleted_at: null },
      del: { course_id: 'c1', reactions: {}, deleted_at: '2026-01-01T00:00:00Z' },
      other: { course_id: 'c2', reactions: {}, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_threads', courseId: 'c1', emoji: '👍', userId: 'uA' };
    expect(await toggleReactionAtomicPg({ ...base, targetId: 'missing' })).toEqual({ notFound: true });
    expect(await toggleReactionAtomicPg({ ...base, targetId: 'del' })).toEqual({ notFound: true });
    expect(await toggleReactionAtomicPg({ ...base, targetId: 'other' })).toEqual({ notFound: true });
  });

  it('weigert niet-toegestane emoji en onbekende tabel zonder DB-call', async () => {
    const pool = makeFakePool({ t1: { course_id: 'c1', reactions: {}, deleted_at: null } });
    const base = { pgPool: pool, table: 'studiecafe_threads', targetId: 't1', courseId: 'c1', userId: 'uA' };
    expect(await toggleReactionAtomicPg({ ...base, emoji: '💩' })).toEqual({ invalid: true });
    expect(await toggleReactionAtomicPg({ ...base, emoji: '👍', table: 'evil_table' })).toEqual({ invalid: true });
    expect(pool.queryCount).toBe(0);
  });

  it('REACTION_TABLES bevat alleen de twee bekende tabellen', () => {
    expect(REACTION_TABLES).toEqual(['studiecafe_threads', 'studiecafe_replies']);
  });
});

describe('summarizeUnread (Task #307)', () => {
  const threads = [
    { last_activity_at: '2026-06-20T10:00:00Z', is_announcement: false },
    { last_activity_at: '2026-06-21T10:00:00Z', is_announcement: true },
    { last_activity_at: '2026-06-22T10:00:00Z', is_announcement: false },
  ];

  it('telt geen ongelezen zonder lastSeenAt (zachte uitrol)', () => {
    const s = summarizeUnread(threads, null);
    expect(s.count).toBe(0);
    expect(s.announcementCount).toBe(0);
    expect(s.latestActivityAt).toBe('2026-06-22T10:00:00Z');
  });

  it('telt threads met activiteit ná lastSeenAt', () => {
    const s = summarizeUnread(threads, '2026-06-20T12:00:00Z');
    expect(s.count).toBe(2);
    expect(s.announcementCount).toBe(1);
  });

  it('telt niets als lastSeenAt na alle activiteit ligt', () => {
    const s = summarizeUnread(threads, '2026-06-23T00:00:00Z');
    expect(s.count).toBe(0);
    expect(s.announcementCount).toBe(0);
  });

  it('is defensief bij niet-array en lege/ongeldige rijen', () => {
    expect(summarizeUnread(null, '2026-06-20T00:00:00Z')).toEqual({ count: 0, announcementCount: 0, latestActivityAt: null });
    const s = summarizeUnread([{ is_announcement: true }, {}], '2026-06-20T00:00:00Z');
    expect(s.count).toBe(0);
    expect(s.latestActivityAt).toBeNull();
  });
});

describe('isThreadUnread (Task #307)', () => {
  it('null lastSeenAt ⇒ nooit ongelezen', () => {
    expect(isThreadUnread('2026-06-21T10:00:00Z', null)).toBe(false);
  });
  it('null lastActivityAt ⇒ nooit ongelezen', () => {
    expect(isThreadUnread(null, '2026-06-21T10:00:00Z')).toBe(false);
  });
  it('activiteit ná laatste bezoek ⇒ ongelezen', () => {
    expect(isThreadUnread('2026-06-22T10:00:00Z', '2026-06-21T10:00:00Z')).toBe(true);
  });
  it('activiteit gelijk of vóór laatste bezoek ⇒ gelezen', () => {
    expect(isThreadUnread('2026-06-21T10:00:00Z', '2026-06-21T10:00:00Z')).toBe(false);
    expect(isThreadUnread('2026-06-20T10:00:00Z', '2026-06-21T10:00:00Z')).toBe(false);
  });
});

describe('toggleKudosAtomicPg — race-veiligheid', () => {
  it('verliest geen pluim bij twee gelijktijdige toggles op dezelfde post', async () => {
    // Startwaarde: nog geen pluim. Twee docenten togglen tegelijk. Door de
    // FOR UPDATE-serialisatie geeft de eerste de pluim en haalt de tweede hem
    // weer weg (i.p.v. dat beiden los van elkaar 'giving' concluderen en de
    // tweede write de eerste overschrijft). Eindstaat is consistent.
    const pool = makeFakePool({
      t1: { course_id: 'c1', kudos_by: null, kudos_at: null, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_threads', targetId: 't1', courseId: 'c1', ts: '2026-06-21T00:00:00.000Z' };
    const [a, b] = await Promise.all([
      toggleKudosAtomicPg({ ...base, userId: 'uA' }),
      toggleKudosAtomicPg({ ...base, userId: 'uB' }),
    ]);
    // Precies één van de twee gaf de pluim, de ander haalde hem weg.
    expect([a.giving, b.giving].sort()).toEqual([false, true]);
    const row = pool.rows.get('t1');
    // Consistente eindstaat: kudos_by en kudos_at horen bij elkaar (beide null
    // of beide gevuld) — geen half-geschreven, verloren toggle.
    if (row.kudos_at) {
      expect(row.kudos_by).toBeTruthy();
    } else {
      expect(row.kudos_by).toBeNull();
    }
  });

  it('twee gebruikers togglen serieel: gegeven dan weggehaald eindigt leeg', async () => {
    const pool = makeFakePool({
      r9: { course_id: 'c1', kudos_by: null, kudos_at: null, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_replies', targetId: 'r9', courseId: 'c1', ts: '2026-06-21T00:00:00.000Z' };
    const first = await toggleKudosAtomicPg({ ...base, userId: 'uA' });
    expect(first.giving).toBe(true);
    expect(pool.rows.get('r9')).toMatchObject({ kudos_by: 'uA', kudos_at: '2026-06-21T00:00:00.000Z' });
    const second = await toggleKudosAtomicPg({ ...base, userId: 'uB' });
    expect(second.giving).toBe(false);
    expect(pool.rows.get('r9')).toMatchObject({ kudos_by: null, kudos_at: null });
  });

  it('geeft notFound bij ontbrekende rij, verkeerde cursus of verwijderd doel', async () => {
    const pool = makeFakePool({
      ok: { course_id: 'c1', kudos_by: null, kudos_at: null, deleted_at: null },
      del: { course_id: 'c1', kudos_by: null, kudos_at: null, deleted_at: '2026-01-01T00:00:00Z' },
      other: { course_id: 'c2', kudos_by: null, kudos_at: null, deleted_at: null },
    });
    const base = { pgPool: pool, table: 'studiecafe_threads', courseId: 'c1', userId: 'uA', ts: '2026-06-21T00:00:00.000Z' };
    expect(await toggleKudosAtomicPg({ ...base, targetId: 'missing' })).toEqual({ notFound: true });
    expect(await toggleKudosAtomicPg({ ...base, targetId: 'del' })).toEqual({ notFound: true });
    expect(await toggleKudosAtomicPg({ ...base, targetId: 'other' })).toEqual({ notFound: true });
  });

  it('weigert onbekende tabel of ontbrekende user zonder DB-call', async () => {
    const pool = makeFakePool({ t1: { course_id: 'c1', kudos_by: null, kudos_at: null, deleted_at: null } });
    const base = { pgPool: pool, table: 'studiecafe_threads', targetId: 't1', courseId: 'c1', ts: 'x' };
    expect(await toggleKudosAtomicPg({ ...base, userId: 'uA', table: 'evil_table' })).toEqual({ invalid: true });
    expect(await toggleKudosAtomicPg({ ...base, userId: null })).toEqual({ invalid: true });
    expect(pool.queryCount).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Gelijktijdige reacties/pluimen via de ROUTE-handlers (Task #321).
// De helper-tests hierboven bewijzen race-veiligheid op het niveau van
// toggleReactionAtomicPg / toggleKudosAtomicPg. Deze tests sluiten het gat door
// twee gelijktijdige POST's via Promise.all door de échte route-handlers te
// jagen met één gedeelde FIFO-mutex `makeFakePool`. Zo bewijzen we dat de
// BEDRADING (route → atomic pgPool-tak) geen lost-update introduceert.
//
// Aanpak: twee aparte setup()-instanties delen dezelfde pgPool maar hebben elk
// hun eigen `ctx` (zodat de twee calls verschillende gebruikers/rollen kunnen
// voorstellen). De pgPool-tak van de reactie-/kudos-handler raakt de in-memory
// Supabase-store niet; alleen de gedeelde pool muteert de rij.
// ───────────────────────────────────────────────────────────────────────────
describe('studiecafe endpoints — gelijktijdige reacties/pluimen (Task #321)', () => {
  it('twee gelijktijdige POST /reactions (andere user, andere emoji) verliezen geen reactie', async () => {
    const pool = makeFakePool({
      't-1': { course_id: COURSE_A, reactions: {}, deleted_at: null },
    });
    const a = setup({}, { pgPool: pool });
    const b = setup({}, { pgPool: pool });
    a.ctx.userId = 'uA';
    b.ctx.userId = 'uB';
    const [ra, rb] = await Promise.all([
      a.call(R.reaction, {
        params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
      }),
      b.call(R.reaction, {
        params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '❤️' },
      }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    // Cruciaal: BEIDE reacties overleven de race in de uiteindelijke DB-staat.
    expect(pool.rows.get('t-1').reactions).toEqual({ '👍': ['uA'], '❤️': ['uB'] });
  });

  it('twee gelijktijdige POST /reactions (andere user, ZELFDE emoji) tellen beiden mee', async () => {
    const pool = makeFakePool({
      'r-9': { course_id: COURSE_A, reactions: {}, deleted_at: null },
    });
    const a = setup({}, { pgPool: pool });
    const b = setup({}, { pgPool: pool });
    a.ctx.userId = 'uA';
    b.ctx.userId = 'uB';
    const body = { targetType: 'reply', targetId: 'r-9', emoji: '🎉' };
    const [ra, rb] = await Promise.all([
      a.call(R.reaction, { params: { courseId: COURSE_A }, body }),
      b.call(R.reaction, { params: { courseId: COURSE_A }, body }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const arr = pool.rows.get('r-9').reactions['🎉'];
    expect(arr).toHaveLength(2);
    expect([...arr].sort()).toEqual(['uA', 'uB']);
  });

  it('twee gelijktijdige POST /kudos op hetzelfde doel lossen deterministisch op (geen lost update)', async () => {
    const pool = makeFakePool({
      't-1': { course_id: COURSE_A, kudos_by: null, kudos_at: null, deleted_at: null },
    });
    const a = setup({}, { pgPool: pool });
    const b = setup({}, { pgPool: pool });
    a.ctx.userId = 'uA'; a.ctx.isStaff = true;
    b.ctx.userId = 'uB'; b.ctx.isStaff = true;
    const body = { targetType: 'thread', targetId: 't-1' };
    const [ra, rb] = await Promise.all([
      a.call(R.kudos, { params: { courseId: COURSE_A }, body }),
      b.call(R.kudos, { params: { courseId: COURSE_A }, body }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    // Door de FOR UPDATE-serialisatie gaf precies één call de pluim en haalde de
    // ander hem weg — niet twee onafhankelijke "geven"-beslissingen.
    const gaveCount = [ra.body.kudos, rb.body.kudos].filter(Boolean).length;
    expect(gaveCount).toBe(1);
    // Consistente eindstaat: kudos_by en kudos_at horen samen (beide gevuld of
    // beide leeg) — geen half-geschreven, verloren toggle.
    const row = pool.rows.get('t-1');
    if (row.kudos_at) {
      expect(row.kudos_by).toBeTruthy();
    } else {
      expect(row.kudos_by).toBeNull();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Endpoint-tests (Task #305) — bewaken de écht beveiligingskritische
// route-poortwachters van het Studiecafé-forum: cross-course IDOR, staff-only
// moderatie, auteur-of-staff acties, gesloten-thread-blokkade en
// soft-delete-redactie. De pure helpers hierboven dekken de beslislogica; deze
// tests dekken de BEDRADING in de route-handlers (een regressie in een guard
// zou een student uit cursus A in cursus B kunnen laten lezen/muteren of een
// niet-docent laten modereren).
//
// Aanpak: we registreren de échte handlers via registerStudiecafeRoutes op een
// fake `app` die per method+pad de handler vangt, en injecteren een in-memory
// Supabase + gemockte auth-helpers (requireAuthUser / userHasCourseAccess /
// isStaffForCourse). pgPool=null dwingt de testbare fallback-paden af. Geen
// netwerk-, DB- of HTTP-laag nodig.
// ───────────────────────────────────────────────────────────────────────────

const COURSE_A = 'course-A';
const COURSE_B = 'course-B';

// Minimale in-memory Supabase die de query-chains uit studiecafe.js ondersteunt:
// select(...).eq/is/in(...).order(...).limit(...) (await → {data,error}),
// .maybeSingle()/.single(), insert(...).select(...).single(),
// update(...).eq(...)[.is(...)] (await → {error}) en update(...).eq().select().single().
function makeStore(seed = {}) {
  return {
    studiecafe_threads: seed.studiecafe_threads || [],
    studiecafe_replies: seed.studiecafe_replies || [],
    studiecafe_last_seen: seed.studiecafe_last_seen || [],
    studiecafe_thread_reads: seed.studiecafe_thread_reads || [],
    profiles: seed.profiles || [],
    _seq: 1,
  };
}

class Builder {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.mode = 'select';
    this._filters = [];
    this._orders = [];
    this._limit = null;
    this._insert = null;
    this._patch = null;
  }
  select() { return this; }
  insert(row) { this.mode = 'insert'; this._insert = row; return this; }
  update(patch) { this.mode = 'update'; this._patch = patch; return this; }
  eq(c, v) { this._filters.push(['eq', c, v]); return this; }
  is(c, v) { this._filters.push(['is', c, v]); return this; }
  in(c, v) { this._filters.push(['in', c, v]); return this; }
  order(c, o) { this._orders.push([c, o]); return this; }
  limit(n) { this._limit = n; return this; }
  _rows() { return this.store[this.table] || (this.store[this.table] = []); }
  _match(row) {
    return this._filters.every(([op, c, v]) => {
      if (op === 'eq') return row[c] === v;
      if (op === 'is') return v === null ? row[c] === null || row[c] === undefined : row[c] === v;
      if (op === 'in') return v.includes(row[c]);
      return true;
    });
  }
  _apply() {
    if (this.mode === 'insert') {
      const row = { id: `${this.table}-${this.store._seq++}`, ...this._insert };
      this._rows().push(row);
      return [{ ...row }];
    }
    if (this.mode === 'update') {
      const affected = this._rows().filter((r) => this._match(r));
      for (const r of affected) Object.assign(r, this._patch);
      return affected.map((r) => ({ ...r }));
    }
    let rows = this._rows().filter((r) => this._match(r)).map((r) => ({ ...r }));
    for (const [c, o] of [...this._orders].reverse()) {
      const asc = !(o && o.ascending === false);
      rows.sort((a, b) => {
        const av = a[c];
        const bv = b[c];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return rows;
  }
  async maybeSingle() {
    const r = this._apply();
    return { data: r[0] ? { ...r[0] } : null, error: null };
  }
  async single() {
    const r = this._apply();
    return r[0]
      ? { data: { ...r[0] }, error: null }
      : { data: null, error: { message: 'no rows' } };
  }
  then(resolve, reject) {
    try {
      resolve({ data: this._apply(), error: null });
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
}

function makeSupabase(store) {
  return { from: (table) => new Builder(store, table) };
}

// Registreert de echte routes op een fake app en geeft een call-helper terug.
// `ctx` is muteerbaar zodat per test de auth-uitkomst (user, access, staff)
// gestuurd kan worden.
function setup(seed, { pgPool = null } = {}) {
  const store = makeStore(seed);
  const ctx = { userId: 'stu-1', hasAccess: true, isStaff: false };
  const routes = {};
  const reg = (method) => (path, handler) => { routes[`${method} ${path}`] = handler; };
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };

  registerStudiecafeRoutes(app, {
    supabaseAdmin: makeSupabase(store),
    requireAuthUser: async () => ({ user: { id: ctx.userId }, profile: { id: ctx.userId } }),
    userHasCourseAccess: async () => ctx.hasAccess,
    isStaffForCourse: async () => ctx.isStaff,
    pgPool,
  });

  async function call(key, { params = {}, body = {} } = {}) {
    const handler = routes[key];
    if (!handler) throw new Error(`no route registered for ${key}`);
    const res = {
      statusCode: 200,
      body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(obj) { this.body = obj; return this; },
    };
    await handler({ params, body }, res);
    return { status: res.statusCode, body: res.body };
  }

  return { store, ctx, call };
}

const R = {
  feed: 'GET /api/studiecafe/:courseId/threads',
  replies: 'GET /api/studiecafe/:courseId/threads/:threadId/replies',
  createThread: 'POST /api/studiecafe/:courseId/threads',
  createReply: 'POST /api/studiecafe/:courseId/threads/:threadId/replies',
  delThread: 'DELETE /api/studiecafe/:courseId/threads/:threadId',
  delReply: 'DELETE /api/studiecafe/:courseId/replies/:replyId',
  patchReply: 'PATCH /api/studiecafe/:courseId/replies/:replyId',
  patchThread: 'PATCH /api/studiecafe/:courseId/threads/:threadId',
  reaction: 'POST /api/studiecafe/:courseId/reactions',
  kudos: 'POST /api/studiecafe/:courseId/kudos',
  unread: 'GET /api/studiecafe/:courseId/unread',
};

function threadRow(over = {}) {
  return {
    id: 't-1', course_id: COURSE_A, author_id: 'stu-1', title: 'Titel', body: 'Body',
    category: 'vraag', is_pinned: false, is_locked: false, is_announcement: false,
    is_resolved: false, kudos_by: null, kudos_at: null, reactions: {}, reply_count: 0,
    last_activity_at: '2026-06-21T10:00:00.000Z', deleted_at: null, deleted_by: null,
    created_at: '2026-06-21T09:00:00.000Z', updated_at: '2026-06-21T09:00:00.000Z', ...over,
  };
}
function replyRow(over = {}) {
  return {
    id: 'r-1', thread_id: 't-1', course_id: COURSE_A, author_id: 'stu-1', body: 'Reactie',
    kudos_by: null, kudos_at: null, reactions: {}, deleted_at: null, deleted_by: null,
    created_at: '2026-06-21T10:00:00.000Z', ...over,
  };
}

describe('studiecafe endpoints — cursustoegang', () => {
  it('zonder cursustoegang → 403 op de feed', async () => {
    const { ctx, call } = setup();
    ctx.hasAccess = false;
    const res = await call(R.feed, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(403);
  });

  it('feed is gescoped op de cursus en laat verwijderde threads weg', async () => {
    const { call } = setup({
      studiecafe_threads: [
        threadRow({ id: 't-A', course_id: COURSE_A }),
        threadRow({ id: 't-A-del', course_id: COURSE_A, deleted_at: '2026-06-21T11:00:00.000Z' }),
        threadRow({ id: 't-B', course_id: COURSE_B }),
      ],
    });
    const res = await call(R.feed, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    const ids = res.body.threads.map((t) => t.id);
    expect(ids).toEqual(['t-A']);
  });
});

describe('studiecafe endpoints — cross-course IDOR (gelekt id uit andere cursus)', () => {
  // Telkens: de gebruiker heeft toegang tot cursus A, maar het doel-id hoort bij
  // cursus B. De handler moet 404 geven (niet de rij uit B teruggeven/muteren).
  it('GET replies van een thread uit een andere cursus → 404', async () => {
    const { call } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    const res = await call(R.replies, { params: { courseId: COURSE_A, threadId: 't-B' } });
    expect(res.status).toBe(404);
  });

  it('POST reply op een thread uit een andere cursus → 404', async () => {
    const { call, store } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    const res = await call(R.createReply, {
      params: { courseId: COURSE_A, threadId: 't-B' }, body: { body: 'hoi' },
    });
    expect(res.status).toBe(404);
    expect(store.studiecafe_replies).toHaveLength(0);
  });

  it('DELETE thread uit een andere cursus → 404 (geen redactie)', async () => {
    const { call, store } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-B' } });
    expect(res.status).toBe(404);
    expect(store.studiecafe_threads[0].deleted_at).toBeNull();
    expect(store.studiecafe_threads[0].body).toBe('Body');
  });

  it('DELETE reply uit een andere cursus → 404 (geen redactie)', async () => {
    const { call, store } = setup({ studiecafe_replies: [replyRow({ id: 'r-B', course_id: COURSE_B })] });
    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-B' } });
    expect(res.status).toBe(404);
    expect(store.studiecafe_replies[0].deleted_at).toBeNull();
  });

  it('PATCH thread uit een andere cursus → 404 (geen mutatie)', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    ctx.isStaff = true; // zelfs staff mag niet door het IDOR-gat
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-B' }, body: { isPinned: true },
    });
    expect(res.status).toBe(404);
    expect(store.studiecafe_threads[0].is_pinned).toBe(false);
  });

  it('PATCH reply uit een andere cursus → 404', async () => {
    const { call } = setup({ studiecafe_replies: [replyRow({ id: 'r-B', course_id: COURSE_B })] });
    const res = await call(R.patchReply, {
      params: { courseId: COURSE_A, replyId: 'r-B' }, body: { body: 'gewijzigd' },
    });
    expect(res.status).toBe(404);
  });

  it('reactie op een doel uit een andere cursus → 404 (geen mutatie)', async () => {
    const { call, store } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    const res = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-B', emoji: '👍' },
    });
    expect(res.status).toBe(404);
    expect(store.studiecafe_threads[0].reactions).toEqual({});
  });

  it('pluim op een doel uit een andere cursus → 404 (geen mutatie)', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ id: 't-B', course_id: COURSE_B })] });
    ctx.isStaff = true; // staff in cursus A, maar doel hoort bij B
    const res = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-B' },
    });
    expect(res.status).toBe(404);
    expect(store.studiecafe_threads[0].kudos_at).toBeNull();
  });
});

describe('studiecafe endpoints — staff-only moderatie', () => {
  it('pinnen door een niet-docent → 403', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = false;
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isPinned: true },
    });
    expect(res.status).toBe(403);
    expect(store.studiecafe_threads[0].is_pinned).toBe(false);
  });

  it('sluiten (lock) door een niet-docent → 403', async () => {
    const { call, ctx } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = false;
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isLocked: true },
    });
    expect(res.status).toBe(403);
  });

  it('aankondiging beheren door een niet-docent → 403', async () => {
    const { call, ctx } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = false;
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isAnnouncement: true },
    });
    expect(res.status).toBe(403);
  });

  it('pluim (kudos) door een niet-docent → 403', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = false;
    const res = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(res.status).toBe(403);
    expect(store.studiecafe_threads[0].kudos_at).toBeNull();
  });

  it('staff mág pinnen', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = true;
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isPinned: true },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].is_pinned).toBe(true);
  });

  it('staff mág een pluim geven', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow()] });
    ctx.isStaff = true;
    const res = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].kudos_at).toBeTruthy();
    expect(store.studiecafe_threads[0].kudos_by).toBe('stu-1');
  });

  it('niet-docent kan bij thread-creatie geen aankondiging forceren', async () => {
    const { call, ctx, store } = setup();
    ctx.isStaff = false;
    const res = await call(R.createThread, {
      params: { courseId: COURSE_A }, body: { title: 'Hoi', body: 'Tekst', isAnnouncement: true },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].is_announcement).toBe(false);
  });
});

describe('studiecafe endpoints — auteur-of-staff acties', () => {
  it('verwijderen door een vreemde (niet-auteur, niet-staff) → 403', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ author_id: 'stu-1' })] });
    ctx.userId = 'stu-2';
    ctx.isStaff = false;
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(403);
    expect(store.studiecafe_threads[0].deleted_at).toBeNull();
  });

  it('verwijderen door de auteur → ok', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ author_id: 'stu-1' })] });
    ctx.userId = 'stu-1';
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].deleted_at).toBeTruthy();
  });

  it('verwijderen door staff (niet-auteur) → ok', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ author_id: 'stu-1' })] });
    ctx.userId = 'staff-9';
    ctx.isStaff = true;
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].deleted_at).toBeTruthy();
  });

  it('"opgelost"-markering door een vreemde → 403', async () => {
    const { call, ctx } = setup({ studiecafe_threads: [threadRow({ author_id: 'stu-1' })] });
    ctx.userId = 'stu-2';
    ctx.isStaff = false;
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isResolved: true },
    });
    expect(res.status).toBe(403);
  });

  it('"opgelost"-markering door de auteur → ok', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ author_id: 'stu-1' })] });
    ctx.userId = 'stu-1';
    const res = await call(R.patchThread, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { isResolved: true },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].is_resolved).toBe(true);
  });

  it('reactie bewerken door een vreemde → 403', async () => {
    const { call, ctx, store } = setup({ studiecafe_replies: [replyRow({ author_id: 'stu-1' })] });
    ctx.userId = 'stu-2';
    ctx.isStaff = false;
    const res = await call(R.patchReply, {
      params: { courseId: COURSE_A, replyId: 'r-1' }, body: { body: 'gehackt' },
    });
    expect(res.status).toBe(403);
    expect(store.studiecafe_replies[0].body).toBe('Reactie');
  });
});

describe('studiecafe endpoints — gesloten thread', () => {
  it('reageren op een gesloten thread door een niet-docent → 403', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ is_locked: true })] });
    ctx.isStaff = false;
    const res = await call(R.createReply, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { body: 'mag dit?' },
    });
    expect(res.status).toBe(403);
    expect(store.studiecafe_replies).toHaveLength(0);
  });

  it('staff mág reageren op een gesloten thread', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ is_locked: true })] });
    ctx.isStaff = true;
    const res = await call(R.createReply, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { body: 'docent-reactie' },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_replies).toHaveLength(1);
  });
});

describe('studiecafe endpoints — soft-delete redactie (geen lek van inhoud)', () => {
  it('een verwijderde reply komt als placeholder terug zonder body/auteur', async () => {
    const { call } = setup({
      studiecafe_threads: [threadRow({ id: 't-1' })],
      studiecafe_replies: [
        replyRow({ id: 'r-live', body: 'zichtbaar' }),
        replyRow({
          id: 'r-del', body: 'GEHEIM', author_id: 'stu-7',
          deleted_at: '2026-06-21T12:00:00.000Z', deleted_by: 'staff-1',
        }),
      ],
    });
    const res = await call(R.replies, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);
    const del = res.body.replies.find((r) => r.id === 'r-del');
    expect(del.deleted).toBe(true);
    expect(del.body).toBe('');
    expect(del.authorName).toBeNull();
    expect(del.authorId).toBeUndefined();
    expect(del.reactions).toEqual([]);
    // De levende reply lekt niet mee in de redactie.
    const live = res.body.replies.find((r) => r.id === 'r-live');
    expect(live.body).toBe('zichtbaar');
  });

  it('thread verwijderen redigeert de thread én cascadeert naar alle replies', async () => {
    const { call, ctx, store } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', author_id: 'stu-1', title: 'Geheime titel', body: 'Geheime body', reactions: { '👍': ['x'] }, kudos_by: 'staff-1', kudos_at: 'x' })],
      studiecafe_replies: [
        replyRow({ id: 'r-1', body: 'reply-geheim', author_id: 'stu-3', reactions: { '❤️': ['y'] } }),
        replyRow({ id: 'r-2', body: 'reply-geheim-2', author_id: 'stu-4' }),
      ],
    });
    ctx.userId = 'stu-1';
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);

    const t = store.studiecafe_threads[0];
    expect(t.deleted_at).toBeTruthy();
    expect(t.title).toBe('');
    expect(t.body).toBe('');
    expect(t.author_id).toBeNull();
    expect(t.kudos_by).toBeNull();
    expect(t.kudos_at).toBeNull();
    expect(t.reactions).toEqual({});

    for (const r of store.studiecafe_replies) {
      expect(r.deleted_at).toBeTruthy();
      expect(r.body).toBe('');
      expect(r.author_id).toBeNull();
      expect(r.reactions).toEqual({});
    }
  });

  it('een al verwijderde thread opnieuw verwijderen is idempotent (ok, geen 403)', async () => {
    const { call, ctx } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', author_id: 'stu-1', deleted_at: '2026-06-21T12:00:00.000Z' })],
    });
    ctx.userId = 'stu-2'; // niet-auteur: zou normaal 403 zijn, maar al verwijderd → vroege ok
    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Gedrag-tests (Task #309) — bewaken de NIET-beveiligingskritische, maar wel
// stil-regresseerbare gedragingen van het forum die Task #305 bewust oversloeg:
// de reactie-toggle round-trip (toevoegen → weghalen, met correcte "mine"-vlag
// voor de aanroeper), de pluim-toggle round-trip, en de feed-ordening
// (pinned + aankondigingen bovenaan, daarna op last_activity_at) plus de
// reply_count/last_activity_at-bump bij een nieuwe reactie. Deze draaien op het
// pgPool=null-fallbackpad van de in-memory harness hierboven.
// ───────────────────────────────────────────────────────────────────────────

describe('studiecafe endpoints — reactie-toggle round-trip', () => {
  it('toevoegen dan weghalen van dezelfde emoji keert terug naar leeg', async () => {
    const { call, store } = setup({ studiecafe_threads: [threadRow({ id: 't-1' })] });
    // Toevoegen.
    const add = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
    });
    expect(add.status).toBe(200);
    expect(add.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect(store.studiecafe_threads[0].reactions).toEqual({ '👍': ['stu-1'] });
    // Weghalen (zelfde emoji, zelfde gebruiker).
    const remove = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.reactions).toEqual([]);
    expect(store.studiecafe_threads[0].reactions).toEqual({});
  });

  it('de "mine"-vlag is correct voor de aanroeper naast andermans reactie', async () => {
    const { call, store } = setup({
      // stu-2 heeft al ❤️ gegeven; de aanroeper is stu-1.
      studiecafe_threads: [threadRow({ id: 't-1', reactions: { '❤️': ['stu-2'] } })],
    });
    // stu-1 voegt 👍 toe: zijn eigen reactie is mine=true, de ❤️ van stu-2 mine=false.
    const add = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
    });
    expect(add.status).toBe(200);
    expect(add.body.reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
    expect(store.studiecafe_threads[0].reactions).toEqual({ '❤️': ['stu-2'], '👍': ['stu-1'] });
  });

  it('werkt ook op een reply en telt mede-reageerders mee', async () => {
    const { call, store } = setup({
      studiecafe_replies: [replyRow({ id: 'r-1', reactions: { '🎉': ['stu-2'] } })],
    });
    const add = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1', emoji: '🎉' },
    });
    expect(add.status).toBe(200);
    expect(add.body.reactions).toEqual([{ emoji: '🎉', count: 2, mine: true }]);
    expect([...store.studiecafe_replies[0].reactions['🎉']].sort()).toEqual(['stu-1', 'stu-2']);
  });
});

describe('studiecafe endpoints — pluim-toggle round-trip', () => {
  it('geven dan weghalen door dezelfde docent keert terug naar geen pluim', async () => {
    const { call, ctx, store } = setup({ studiecafe_threads: [threadRow({ id: 't-1' })] });
    ctx.isStaff = true;
    ctx.userId = 'staff-1';
    // Geven.
    const give = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(give.status).toBe(200);
    expect(give.body.kudos).toMatchObject({ by: 'staff-1' });
    expect(give.body.kudos.at).toBeTruthy();
    expect(store.studiecafe_threads[0].kudos_by).toBe('staff-1');
    expect(store.studiecafe_threads[0].kudos_at).toBeTruthy();
    // Weghalen.
    const remove = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.kudos).toBeNull();
    expect(store.studiecafe_threads[0].kudos_by).toBeNull();
    expect(store.studiecafe_threads[0].kudos_at).toBeNull();
  });

  it('pluim-toggle werkt ook op een reply', async () => {
    const { call, ctx, store } = setup({ studiecafe_replies: [replyRow({ id: 'r-1' })] });
    ctx.isStaff = true;
    ctx.userId = 'staff-1';
    const give = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1' },
    });
    expect(give.status).toBe(200);
    expect(give.body.kudos).toMatchObject({ by: 'staff-1' });
    expect(store.studiecafe_replies[0].kudos_by).toBe('staff-1');
    const remove = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.kudos).toBeNull();
    expect(store.studiecafe_replies[0].kudos_at).toBeNull();
  });
});

// De bovenstaande round-trips draaien op het pgPool=null fallback-pad. In productie
// gaat de live deployment door het atomaire pad (toggleReactionAtomicPg /
// toggleKudosAtomicPg) zodra er een directe Postgres-verbinding (pgPool) is. De
// helpers zijn los getest, maar de bedrading van de route-handlers naar die helpers
// (de `if (pgPool)`-tak) heeft eigen dekking nodig: hier voeren we de reactie- en
// pluim-routes uit met een fake pgPool zodat de atomaire tak end-to-end loopt.
describe('studiecafe endpoints — atomair pgPool-pad (reactie/pluim)', () => {
  it('reactie toevoegen dan weghalen via het pgPool-pad keert terug naar leeg', async () => {
    const pool = makeFakePool({
      't-1': { course_id: COURSE_A, reactions: {}, deleted_at: null },
    });
    const { call } = setup(undefined, { pgPool: pool });
    // Toevoegen.
    const add = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
    });
    expect(add.status).toBe(200);
    expect(add.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    // De mutatie landt in de pgPool-"DB", niet in de supabase-store.
    expect(pool.rows.get('t-1').reactions).toEqual({ '👍': ['stu-1'] });
    expect(pool.queryCount).toBeGreaterThan(0);
    // Weghalen (zelfde emoji, zelfde gebruiker).
    const remove = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1', emoji: '👍' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.reactions).toEqual([]);
    expect(pool.rows.get('t-1').reactions).toEqual({});
  });

  it('reactie via het pgPool-pad werkt ook op een reply en telt mede-reageerders mee', async () => {
    const pool = makeFakePool({
      'r-1': { course_id: COURSE_A, reactions: { '🎉': ['stu-2'] }, deleted_at: null },
    });
    const { call } = setup(undefined, { pgPool: pool });
    const add = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1', emoji: '🎉' },
    });
    expect(add.status).toBe(200);
    expect(add.body.reactions).toEqual([{ emoji: '🎉', count: 2, mine: true }]);
    expect([...pool.rows.get('r-1').reactions['🎉']].sort()).toEqual(['stu-1', 'stu-2']);
  });

  it('reactie via het pgPool-pad op een doel uit een andere cursus → 404 (geen mutatie)', async () => {
    const pool = makeFakePool({
      't-B': { course_id: COURSE_B, reactions: {}, deleted_at: null },
    });
    const { call } = setup(undefined, { pgPool: pool });
    const res = await call(R.reaction, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-B', emoji: '👍' },
    });
    expect(res.status).toBe(404);
    expect(pool.rows.get('t-B').reactions).toEqual({});
  });

  it('pluim geven dan weghalen via het pgPool-pad keert terug naar geen pluim', async () => {
    const pool = makeFakePool({
      't-1': { course_id: COURSE_A, kudos_at: null, kudos_by: null, deleted_at: null },
    });
    const { call, ctx } = setup(undefined, { pgPool: pool });
    ctx.isStaff = true;
    ctx.userId = 'staff-1';
    // Geven.
    const give = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(give.status).toBe(200);
    expect(give.body.kudos).toMatchObject({ by: 'staff-1' });
    expect(give.body.kudos.at).toBeTruthy();
    expect(pool.rows.get('t-1').kudos_by).toBe('staff-1');
    expect(pool.rows.get('t-1').kudos_at).toBeTruthy();
    expect(pool.queryCount).toBeGreaterThan(0);
    // Weghalen.
    const remove = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-1' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.kudos).toBeNull();
    expect(pool.rows.get('t-1').kudos_by).toBeNull();
    expect(pool.rows.get('t-1').kudos_at).toBeNull();
  });

  it('pluim via het pgPool-pad werkt ook op een reply', async () => {
    const pool = makeFakePool({
      'r-1': { course_id: COURSE_A, kudos_at: null, kudos_by: null, deleted_at: null },
    });
    const { call, ctx } = setup(undefined, { pgPool: pool });
    ctx.isStaff = true;
    ctx.userId = 'staff-1';
    const give = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1' },
    });
    expect(give.status).toBe(200);
    expect(give.body.kudos).toMatchObject({ by: 'staff-1' });
    expect(pool.rows.get('r-1').kudos_by).toBe('staff-1');
    const remove = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'reply', targetId: 'r-1' },
    });
    expect(remove.status).toBe(200);
    expect(remove.body.kudos).toBeNull();
    expect(pool.rows.get('r-1').kudos_at).toBeNull();
  });

  it('pluim via het pgPool-pad op een doel uit een andere cursus → 404 (geen mutatie)', async () => {
    const pool = makeFakePool({
      't-B': { course_id: COURSE_B, kudos_at: null, kudos_by: null, deleted_at: null },
    });
    const { call, ctx } = setup(undefined, { pgPool: pool });
    ctx.isStaff = true; // staff in cursus A, maar doel hoort bij B
    const res = await call(R.kudos, {
      params: { courseId: COURSE_A }, body: { targetType: 'thread', targetId: 't-B' },
    });
    expect(res.status).toBe(404);
    expect(pool.rows.get('t-B').kudos_at).toBeNull();
  });
});

describe('studiecafe endpoints — feed-ordening', () => {
  it('zet pinned + aankondigingen bovenaan, daarna op last_activity_at aflopend', async () => {
    const { call } = setup({
      studiecafe_threads: [
        threadRow({ id: 't-old', last_activity_at: '2026-06-20T10:00:00.000Z' }),
        threadRow({ id: 't-new', last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-ann', is_announcement: true, last_activity_at: '2026-06-21T10:00:00.000Z' }),
        threadRow({ id: 't-pin', is_pinned: true, last_activity_at: '2026-06-19T10:00:00.000Z' }),
      ],
    });
    const res = await call(R.feed, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    // Pinned eerst (ondanks oudste activiteit), dan aankondiging, dan de rest op
    // recentste activiteit.
    expect(res.body.threads.map((t) => t.id)).toEqual(['t-pin', 't-ann', 't-new', 't-old']);
  });

  it('een gepinde aankondiging blijft bovenaan boven een niet-gepinde aankondiging', async () => {
    const { call } = setup({
      studiecafe_threads: [
        threadRow({ id: 't-ann', is_announcement: true, last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-pin-ann', is_pinned: true, is_announcement: true, last_activity_at: '2026-06-18T10:00:00.000Z' }),
        threadRow({ id: 't-plain', last_activity_at: '2026-06-23T10:00:00.000Z' }),
      ],
    });
    const res = await call(R.feed, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t) => t.id)).toEqual(['t-pin-ann', 't-ann', 't-plain']);
  });
});

describe('studiecafe endpoints — reply-bump (reply_count + last_activity_at)', () => {
  it('een nieuwe reactie verhoogt reply_count en verschuift last_activity_at', async () => {
    const oldActivity = '2026-06-21T10:00:00.000Z';
    const { call, store } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', reply_count: 2, last_activity_at: oldActivity })],
    });
    const res = await call(R.createReply, {
      params: { courseId: COURSE_A, threadId: 't-1' }, body: { body: 'nieuwe reactie' },
    });
    expect(res.status).toBe(200);
    expect(store.studiecafe_replies).toHaveLength(1);
    const t = store.studiecafe_threads[0];
    expect(t.reply_count).toBe(3);
    expect(t.last_activity_at).not.toBe(oldActivity);
    expect(typeof t.last_activity_at).toBe('string');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE thread — transactioneel pgPool-pad (Task #310). In productie loopt de
// thread-redactie + reply-cascade in één BEGIN/UPDATE/UPDATE/COMMIT-transactie
// via pgPool; faalt er iets midden in, dan moet ALLES terugrollen (fail-closed,
// geen half-geredigeerde staat die de inhoud van een verwijderde thread
// cursus-breed leesbaar laat). Task #305 dekte alleen het fallback-pad
// (pgPool=null). Hier injecteren we een mock pg-client die de echte SQL-mutaties
// op de in-memory store toepast én de query-volgorde vastlegt.
// ───────────────────────────────────────────────────────────────────────────

// Mock pg-pool die de twee UPDATE's uit het transactie-pad echt uitvoert op de
// store. `failOnSql` (regex) laat een query midden in de transactie falen zodat
// we de ROLLBACK + 500 kunnen aantonen. `log` bevat de volgorde van commando's.
function makeTxPool(store, { failOnSql = null } = {}) {
  const log = [];
  const tables = {
    studiecafe_threads: store.studiecafe_threads,
    studiecafe_replies: store.studiecafe_replies,
  };
  function applyReplyCountUpdate(sql, params) {
    // UPDATE studiecafe_threads SET reply_count = GREATEST(reply_count - 1, 0) ...
    const [threadId] = params;
    for (const r of tables.studiecafe_threads) {
      if (r.id === threadId) {
        r.reply_count = Math.max((r.reply_count || 0) - 1, 0);
      }
    }
  }
  return {
    log,
    released: 0,
    // Top-level pgPool.query — gebruikt door het reply-delete-pad voor de
    // reply_count-decrement (geen connect()/transactie zoals het thread-pad).
    async query(sql, params) {
      log.push(/UPDATE\s+studiecafe_threads/i.test(sql) ? 'UPDATE_REPLY_COUNT' : 'OTHER');
      if (failOnSql && failOnSql.test(sql)) {
        throw new Error('tx boom');
      }
      if (/UPDATE\s+studiecafe_threads/i.test(sql)) applyReplyCountUpdate(sql, params);
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      const self = this;
      return {
        async query(sql, params) {
          const trimmed = sql.trim();
          const verb = /^(BEGIN|COMMIT|ROLLBACK)/i.test(trimmed)
            ? trimmed.split(/\s+/)[0].toUpperCase()
            : (/UPDATE\s+studiecafe_threads/i.test(sql) ? 'UPDATE_THREADS'
              : /UPDATE\s+studiecafe_replies/i.test(sql) ? 'UPDATE_REPLIES'
              : /DELETE\s+FROM\s+studiecafe_thread_reads/i.test(sql) ? 'DELETE_READS' : 'OTHER');
          log.push(verb);
          if (failOnSql && failOnSql.test(sql)) {
            throw new Error('tx boom');
          }
          if (verb === 'UPDATE_THREADS') {
            const [threadId, ts, userId] = params;
            for (const r of tables.studiecafe_threads) {
              if (r.id === threadId) {
                Object.assign(r, {
                  deleted_at: ts, deleted_by: userId, body: '', title: '',
                  author_id: null, kudos_by: null, kudos_at: null, reactions: {}, updated_at: ts,
                });
              }
            }
          } else if (verb === 'UPDATE_REPLIES') {
            const [threadId, ts, userId] = params;
            for (const r of tables.studiecafe_replies) {
              if (r.thread_id === threadId && (r.deleted_at === null || r.deleted_at === undefined)) {
                Object.assign(r, {
                  deleted_at: ts, deleted_by: userId, body: '',
                  author_id: null, kudos_by: null, kudos_at: null, reactions: {},
                });
              }
            }
          }
          return { rows: [], rowCount: 1 };
        },
        release() { self.released += 1; },
      };
    },
  };
}

describe('studiecafe endpoints — DELETE thread transactioneel pgPool-pad (Task #310)', () => {
  function seedThreadWithReplies() {
    return {
      studiecafe_threads: [threadRow({
        id: 't-1', author_id: 'stu-1', title: 'Geheime titel', body: 'Geheime body',
        reactions: { '👍': ['x'] }, kudos_by: 'staff-1', kudos_at: 'x',
      })],
      studiecafe_replies: [
        replyRow({ id: 'r-1', thread_id: 't-1', body: 'reply-geheim', author_id: 'stu-3', reactions: { '❤️': ['y'] } }),
        replyRow({ id: 'r-2', thread_id: 't-1', body: 'reply-geheim-2', author_id: 'stu-4', kudos_by: 'staff-2', kudos_at: 'x' }),
      ],
    };
  }

  it('redigeert thread én replies in één transactie (BEGIN→UPDATE threads→UPDATE replies→COMMIT)', async () => {
    const seed = seedThreadWithReplies();
    const store = makeStore(seed);
    const pool = makeTxPool(store);
    const { call, ctx } = setup(seed, { pgPool: pool });
    // setup() maakt zijn eigen store; we willen dat pool en handler dezelfde
    // store delen. Daarom wijzen we de pool-tabellen naar de store van setup.
    // (makeTxPool kreeg `store` met dezelfde array-referenties als `seed`.)
    ctx.userId = 'stu-1';

    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Transactie-volgorde: open, beide updates, leesmarkeringen opruimen (Task
    // #315), dan pas commit. Geen rollback.
    expect(pool.log).toEqual(['BEGIN', 'UPDATE_THREADS', 'UPDATE_REPLIES', 'DELETE_READS', 'COMMIT']);
    expect(pool.released).toBe(1);

    const t = seed.studiecafe_threads[0];
    expect(t.deleted_at).toBeTruthy();
    expect(t.title).toBe('');
    expect(t.body).toBe('');
    expect(t.author_id).toBeNull();
    expect(t.kudos_by).toBeNull();
    expect(t.kudos_at).toBeNull();
    expect(t.reactions).toEqual({});

    for (const r of seed.studiecafe_replies) {
      expect(r.deleted_at).toBeTruthy();
      expect(r.body).toBe('');
      expect(r.author_id).toBeNull();
      expect(r.kudos_by).toBeNull();
      expect(r.kudos_at).toBeNull();
      expect(r.reactions).toEqual({});
    }
  });

  it('faalt de reply-cascade midden in de transactie → ROLLBACK + 500, geen partiële redactie', async () => {
    const seed = seedThreadWithReplies();
    const store = makeStore(seed);
    const pool = makeTxPool(store, { failOnSql: /UPDATE\s+studiecafe_replies/i });
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.userId = 'stu-1';

    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('tx boom');

    // Na de fout op de replies-update moet er een ROLLBACK volgen, geen COMMIT.
    expect(pool.log).toEqual(['BEGIN', 'UPDATE_THREADS', 'UPDATE_REPLIES', 'ROLLBACK']);
    expect(pool.released).toBe(1);
  });

  it('faalt de thread-update meteen → ROLLBACK + 500, replies onaangeroerd', async () => {
    const seed = seedThreadWithReplies();
    const store = makeStore(seed);
    const pool = makeTxPool(store, { failOnSql: /UPDATE\s+studiecafe_threads/i });
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.userId = 'stu-1';

    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('tx boom');

    expect(pool.log).toEqual(['BEGIN', 'UPDATE_THREADS', 'ROLLBACK']);
    expect(pool.released).toBe(1);
    // Geen enkele rij is geredigeerd (de mutaties draaiden niet door de fout).
    for (const r of seed.studiecafe_replies) {
      expect(r.deleted_at).toBeNull();
      expect(r.body).not.toBe('');
    }
  });

  it('slaat reeds verwijderde replies over in de cascade (audit blijft intact)', async () => {
    const seed = {
      studiecafe_threads: [threadRow({ id: 't-1', author_id: 'stu-1' })],
      studiecafe_replies: [
        replyRow({ id: 'r-live', thread_id: 't-1', body: 'leeft', author_id: 'stu-3' }),
        replyRow({
          id: 'r-old', thread_id: 't-1', body: '', author_id: null,
          deleted_at: '2026-06-20T08:00:00.000Z', deleted_by: 'staff-9',
        }),
      ],
    };
    const store = makeStore(seed);
    const pool = makeTxPool(store);
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.userId = 'stu-1';

    const res = await call(R.delThread, { params: { courseId: COURSE_A, threadId: 't-1' } });
    expect(res.status).toBe(200);

    const live = seed.studiecafe_replies.find((r) => r.id === 'r-live');
    const old = seed.studiecafe_replies.find((r) => r.id === 'r-old');
    expect(live.deleted_at).toBeTruthy();
    expect(live.body).toBe('');
    // De al verwijderde reply behoudt zijn oorspronkelijke deleted_by/at (niet overschreven).
    expect(old.deleted_at).toBe('2026-06-20T08:00:00.000Z');
    expect(old.deleted_by).toBe('staff-9');
  });
});

describe('studiecafe endpoints — reply-delete-bump (reply_count omlaag)', () => {
  it('een reply verwijderen verlaagt reply_count van de parent-thread', async () => {
    const { call, store } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', reply_count: 3 })],
      studiecafe_replies: [replyRow({ id: 'r-1', thread_id: 't-1', author_id: 'stu-1' })],
    });
    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // De reply is geredigeerd (soft-delete) ...
    expect(store.studiecafe_replies[0].deleted_at).toBeTruthy();
    // ... en de teller is met 1 gedaald.
    expect(store.studiecafe_threads[0].reply_count).toBe(2);
  });

  it('verlaagt nooit onder 0 (GREATEST/Math.max-bescherming bij ontspoorde teller)', async () => {
    const { call, store } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', reply_count: 0 })],
      studiecafe_replies: [replyRow({ id: 'r-1', thread_id: 't-1', author_id: 'stu-1' })],
    });
    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(store.studiecafe_threads[0].reply_count).toBe(0);
  });

  it('een al verwijderde reply opnieuw verwijderen laat reply_count ongemoeid (idempotent)', async () => {
    const { call, store } = setup({
      studiecafe_threads: [threadRow({ id: 't-1', reply_count: 2 })],
      studiecafe_replies: [
        replyRow({ id: 'r-1', thread_id: 't-1', author_id: 'stu-1', deleted_at: '2026-06-21T12:00:00.000Z' }),
      ],
    });
    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Vroege terugkeer bij reeds-verwijderd: de teller mag NIET dubbel dalen.
    expect(store.studiecafe_threads[0].reply_count).toBe(2);
  });
});

describe('isThreadUnreadFor (Task #312)', () => {
  const FLOOR = '2026-06-20T00:00:00Z';
  it('null floor ⇒ nooit ongelezen (zachte uitrol)', () => {
    expect(isThreadUnreadFor('2026-06-21T10:00:00Z', null, null)).toBe(false);
  });
  it('null activiteit ⇒ nooit ongelezen', () => {
    expect(isThreadUnreadFor(null, FLOOR, null)).toBe(false);
  });
  it('activiteit ≤ floor ⇒ gelezen (backlog onderdrukt)', () => {
    expect(isThreadUnreadFor('2026-06-19T10:00:00Z', FLOOR, null)).toBe(false);
    expect(isThreadUnreadFor(FLOOR, FLOOR, null)).toBe(false);
  });
  it('activiteit ná floor zonder read ⇒ ongelezen', () => {
    expect(isThreadUnreadFor('2026-06-21T10:00:00Z', FLOOR, null)).toBe(true);
  });
  it('geopend ná activiteit ⇒ gelezen', () => {
    expect(isThreadUnreadFor('2026-06-21T10:00:00Z', FLOOR, '2026-06-21T10:00:00Z')).toBe(false);
    expect(isThreadUnreadFor('2026-06-21T10:00:00Z', FLOOR, '2026-06-21T12:00:00Z')).toBe(false);
  });
  it('nieuwe activiteit ná de read ⇒ opnieuw ongelezen', () => {
    expect(isThreadUnreadFor('2026-06-22T10:00:00Z', FLOOR, '2026-06-21T10:00:00Z')).toBe(true);
  });
  it('manualUnread ⇒ altijd ongelezen, ook backlog vóór de vloer (Task #327)', () => {
    // Backlog vóór de vloer zou normaal onderdrukt worden, maar de bewust-
    // ongelezen marker omzeilt de vloer- én read-checks.
    expect(isThreadUnreadFor('2026-06-19T10:00:00Z', FLOOR, null, true)).toBe(true);
    expect(isThreadUnreadFor('2026-06-19T10:00:00Z', FLOOR, '2026-06-19T12:00:00Z', true)).toBe(true);
    expect(isThreadUnreadFor('2026-06-21T10:00:00Z', null, null, true)).toBe(true);
  });
  it('manualUnread doet niets zonder activiteit (Task #327)', () => {
    expect(isThreadUnreadFor(null, FLOOR, null, true)).toBe(false);
  });
});

describe('summarizeUnreadThreads (Task #312)', () => {
  const FLOOR = '2026-06-20T00:00:00Z';
  const threads = [
    { id: 'a', last_activity_at: '2026-06-21T10:00:00Z', is_announcement: true },
    { id: 'b', last_activity_at: '2026-06-22T10:00:00Z' },
    { id: 'c', last_activity_at: '2026-06-19T10:00:00Z' },
  ];
  it('telt alleen ongelezen threads ná de floor', () => {
    const s = summarizeUnreadThreads(threads, FLOOR, {});
    expect(s.count).toBe(2);
    expect(s.announcementCount).toBe(1);
    expect(s.latestActivityAt).toBe('2026-06-22T10:00:00Z');
  });
  it('per-thread read sluit alleen die thread uit', () => {
    const s = summarizeUnreadThreads(threads, FLOOR, { a: '2026-06-21T12:00:00Z' });
    expect(s.count).toBe(1);
    expect(s.announcementCount).toBe(0);
  });
  it('accepteert een Map als readMap', () => {
    const s = summarizeUnreadThreads(threads, FLOOR, new Map([['b', '2026-06-23T00:00:00Z']]));
    expect(s.count).toBe(1);
    expect(s.announcementCount).toBe(1);
  });
  it('null floor ⇒ niets ongelezen maar latestActivityAt nog gezet', () => {
    const s = summarizeUnreadThreads(threads, null, {});
    expect(s.count).toBe(0);
    expect(s.latestActivityAt).toBe('2026-06-22T10:00:00Z');
  });
  it('niet-array ⇒ lege samenvatting', () => {
    expect(summarizeUnreadThreads(null, FLOOR, {})).toEqual({ count: 0, announcementCount: 0, latestActivityAt: null });
  });
  it('manualUnreadSet telt backlog vóór de vloer mee (Task #327)', () => {
    // Thread c ligt vóór de vloer (normaal gelezen), maar staat in de manual-set.
    const s = summarizeUnreadThreads(threads, FLOOR, {}, new Set(['c']));
    expect(s.count).toBe(3);
  });
  it('manualUnreadSet accepteert ook een array (Task #327)', () => {
    const s = summarizeUnreadThreads(threads, FLOOR, { a: '2026-06-21T12:00:00Z', b: '2026-06-23T00:00:00Z' }, ['c']);
    // a en b zijn gelezen, c is bewust ongelezen ⇒ 1.
    expect(s.count).toBe(1);
  });
  it('manualUnread heft een read-markering op dezelfde thread op (Task #327)', () => {
    // b is gelezen ná zijn activiteit maar staat in de manual-set ⇒ telt mee.
    const s = summarizeUnreadThreads(threads, FLOOR, { b: '2026-06-23T00:00:00Z' }, ['b']);
    expect(s.count).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE reply — transactioneel pgPool-pad (Task #320). In productie wordt de
// reply EERST volledig geredigeerd (body/auteur/kudos/reacties gewist via
// supabaseAdmin — de beveiligingskritische stap), en pas DAARNA decrementeert
// het pgPool-pad de reply_count van de parent-thread met één atomaire
// `UPDATE ... GREATEST(reply_count - 1, 0)`. Task #305 dekte alleen het
// fallback-pad (pgPool=null, select+update). Hier injecteren we makeTxPool zodat
// de top-level pgPool.query de echte decrement op de in-memory store uitvoert.
// Fail-volgorde is bewust: de inhoud is altijd gewist vóór de cosmetische teller
// wordt geraakt, zodat een falende decrement nooit leesbare inhoud achterlaat.
// ───────────────────────────────────────────────────────────────────────────
describe('studiecafe endpoints — DELETE reply transactioneel pgPool-pad (Task #320)', () => {
  function seedThreadWithReply(over = {}) {
    return {
      studiecafe_threads: [threadRow({ id: 't-1', reply_count: 3 })],
      studiecafe_replies: [
        replyRow({
          id: 'r-1', thread_id: 't-1', author_id: 'stu-1', body: 'reply-geheim',
          reactions: { '❤️': ['y'] }, kudos_by: 'staff-2', kudos_at: '2026-06-21T11:00:00.000Z',
          ...over,
        }),
      ],
    };
  }

  it('redigeert de reply volledig én decrementeert reply_count via pgPool', async () => {
    const seed = seedThreadWithReply();
    const pool = makeTxPool(makeStore(seed));
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.userId = 'stu-1';

    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // De reply-inhoud is cursus-breed onleesbaar gemaakt.
    const r = seed.studiecafe_replies[0];
    expect(r.deleted_at).toBeTruthy();
    expect(r.deleted_by).toBe('stu-1');
    expect(r.body).toBe('');
    expect(r.author_id).toBeNull();
    expect(r.kudos_by).toBeNull();
    expect(r.kudos_at).toBeNull();
    expect(r.reactions).toEqual({});

    // De parent-thread-teller is precies met 1 verlaagd via het pgPool-pad.
    expect(pool.log).toEqual(['UPDATE_REPLY_COUNT']);
    expect(seed.studiecafe_threads[0].reply_count).toBe(2);
  });

  it('decrement vloert op 0 (GREATEST) bij een reeds-nul reply_count', async () => {
    const seed = seedThreadWithReply();
    seed.studiecafe_threads[0].reply_count = 0;
    const pool = makeTxPool(makeStore(seed));
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.isStaff = true; // staff mag andermans reply verwijderen

    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(seed.studiecafe_threads[0].reply_count).toBe(0);
  });

  it('een falende reply_count-update → 500, maar de inhoud is al gewist (fail-closed)', async () => {
    const seed = seedThreadWithReply();
    const pool = makeTxPool(makeStore(seed), { failOnSql: /UPDATE\s+studiecafe_threads/i });
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.userId = 'stu-1';

    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('tx boom');

    // Beveiligingskritisch: de redactie liep VÓÓR de teller, dus zelfs als de
    // decrement faalt blijft er geen leesbare reply-inhoud achter.
    const r = seed.studiecafe_replies[0];
    expect(r.deleted_at).toBeTruthy();
    expect(r.body).toBe('');
    expect(r.author_id).toBeNull();
    // De teller bleef onaangeroerd (de update gooide vóór de mutatie).
    expect(seed.studiecafe_threads[0].reply_count).toBe(3);
  });

  it('een reeds verwijderde reply → 200 zonder her-redactie of decrement', async () => {
    const seed = seedThreadWithReply({
      deleted_at: '2026-06-20T08:00:00.000Z', deleted_by: 'staff-9', body: '', author_id: null,
    });
    const pool = makeTxPool(makeStore(seed));
    const { call, ctx } = setup(seed, { pgPool: pool });
    ctx.isStaff = true;

    const res = await call(R.delReply, { params: { courseId: COURSE_A, replyId: 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Geen pgPool-decrement en de audit blijft intact.
    expect(pool.log).toEqual([]);
    expect(seed.studiecafe_threads[0].reply_count).toBe(3);
    expect(seed.studiecafe_replies[0].deleted_by).toBe('staff-9');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /unread — server-side nav-badge telling (Task #337). De client-hook
// (useStudiecafeUnread) toont alleen wat dit endpoint berekent, dus de combinatie
// van zachte-uitrol-vloer (lastSeenAt), per-thread leesstatus (reads) en de
// handmatige manual_unread-override moet hier kloppen, anders toont de badge een
// verkeerd getal terwijl de hook-test groen blijft.
// ───────────────────────────────────────────────────────────────────────────
describe('studiecafe endpoints — GET /unread telling', () => {
  const FLOOR = '2026-06-21T00:00:00.000Z';

  function lastSeenRow(over = {}) {
    return { user_id: 'stu-1', course_id: COURSE_A, last_seen_at: FLOOR, ...over };
  }
  function readRow(over = {}) {
    return {
      user_id: 'stu-1', course_id: COURSE_A, thread_id: 't-1',
      read_at: null, manual_unread: false, ...over,
    };
  }

  it('zonder cursustoegang → 403', async () => {
    const { ctx, call } = setup();
    ctx.hasAccess = false;
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(403);
  });

  it('zonder lastSeenAt (nooit bezocht) → count 0 (zachte uitrol onderdrukt backlog)', async () => {
    const { call } = setup({
      studiecafe_threads: [
        threadRow({ id: 't-new', last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-old', last_activity_at: '2026-06-20T10:00:00.000Z' }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.announcementCount).toBe(0);
    expect(res.body.lastSeenAt).toBeNull();
    expect(res.body.latestActivityAt).toBe('2026-06-22T10:00:00.000Z');
  });

  it('telt threads/replies met activiteit ná de vloer; backlog vóór de vloer telt niet', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        threadRow({ id: 't-after', last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-after2', last_activity_at: '2026-06-21T12:00:00.000Z' }),
        // Activiteit vóór de vloer (backlog) → onderdrukt.
        threadRow({ id: 't-before', last_activity_at: '2026-06-20T10:00:00.000Z' }),
        // Activiteit precies op de vloer → gelezen (≤ floor).
        threadRow({ id: 't-on-floor', last_activity_at: FLOOR }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.lastSeenAt).toBe(FLOOR);
  });

  it('een geopende (gelezen) thread telt niet meer mee', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        threadRow({ id: 't-read', last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-unread', last_activity_at: '2026-06-22T11:00:00.000Z' }),
      ],
      // t-read is na zijn laatste activiteit geopend → gelezen.
      studiecafe_thread_reads: [
        readRow({ thread_id: 't-read', read_at: '2026-06-22T10:30:00.000Z' }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('een read ouder dan de activiteit (nieuwe reply na openen) telt weer mee', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        threadRow({ id: 't-1', last_activity_at: '2026-06-22T12:00:00.000Z' }),
      ],
      // Gelezen vóór de nieuwste activiteit → opnieuw ongelezen.
      studiecafe_thread_reads: [
        readRow({ thread_id: 't-1', read_at: '2026-06-22T09:00:00.000Z' }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('een manual_unread-override dwingt een backlog-thread tóch tot ongelezen', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        // Backlog vóór de vloer: normaal onderdrukt...
        threadRow({ id: 't-backlog', last_activity_at: '2026-06-20T10:00:00.000Z' }),
      ],
      // ...maar bewust weer als ongelezen gemarkeerd → telt mee, vloer omzeild.
      studiecafe_thread_reads: [
        readRow({ thread_id: 't-backlog', read_at: '2026-06-22T09:00:00.000Z', manual_unread: true }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('announcementCount wordt apart geteld binnen de ongelezen-telling', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        threadRow({ id: 't-ann', is_announcement: true, last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-norm', is_announcement: false, last_activity_at: '2026-06-22T11:00:00.000Z' }),
        // Aankondiging vóór de vloer → telt niet mee (ook niet in announcementCount).
        threadRow({ id: 't-ann-old', is_announcement: true, last_activity_at: '2026-06-20T10:00:00.000Z' }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.announcementCount).toBe(1);
  });

  it('is gescoped op de cursus en negeert verwijderde threads', async () => {
    const { call } = setup({
      studiecafe_last_seen: [lastSeenRow()],
      studiecafe_threads: [
        threadRow({ id: 't-A', course_id: COURSE_A, last_activity_at: '2026-06-22T10:00:00.000Z' }),
        threadRow({ id: 't-A-del', course_id: COURSE_A, last_activity_at: '2026-06-22T11:00:00.000Z', deleted_at: '2026-06-22T11:30:00.000Z' }),
        threadRow({ id: 't-B', course_id: COURSE_B, last_activity_at: '2026-06-22T12:00:00.000Z' }),
      ],
    });
    const res = await call(R.unread, { params: { courseId: COURSE_A } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});
