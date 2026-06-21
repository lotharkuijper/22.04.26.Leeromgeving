import { describe, it, expect } from 'vitest';
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
  toggleReactionAtomicPg,
  REACTION_TABLES,
  summarizeUnread,
  isThreadUnread,
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
            return { rows: row ? [{ ...row, reactions: JSON.parse(JSON.stringify(row.reactions)) }] : [] };
          }
          if (/UPDATE/i.test(sql)) {
            const id = params[0];
            const row = rows.get(id);
            if (row) row.reactions = JSON.parse(params[1]);
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
