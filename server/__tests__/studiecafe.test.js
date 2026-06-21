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
