import { describe, it, expect } from 'vitest';
import { collectMemberUserIds, mergeCourseMembers } from '../courseMembers.js';

// ───────────────────────────────────────────────────────────────────────────
// Tests voor GET /api/admin/courses/:id/members (Task #219).
//
// De route haalt course_members en profiles los op (geen PostgREST-embed
// mogelijk: course_members.user_id → auth.users, niet profiles) en voegt ze
// in JS samen. Deze tests bewaken die samenvoeging zodat een toekomstige
// wijziging de "Beheer leden"-lijst niet stilletjes breekt.
// ───────────────────────────────────────────────────────────────────────────

describe('collectMemberUserIds', () => {
  it('verzamelt unieke, niet-lege user_id\'s', () => {
    const rows = [
      { user_id: 'u1' },
      { user_id: 'u2' },
      { user_id: 'u1' }, // duplicaat
      { user_id: null }, // lege id
      { user_id: undefined },
      {},
    ];
    expect(collectMemberUserIds(rows)).toEqual(['u1', 'u2']);
  });

  it('is defensief tegen null/undefined input', () => {
    expect(collectMemberUserIds(null)).toEqual([]);
    expect(collectMemberUserIds(undefined)).toEqual([]);
    expect(collectMemberUserIds([])).toEqual([]);
  });
});

describe('mergeCourseMembers', () => {
  it('voegt naam, e-mail en rollen samen per lid', () => {
    const rows = [
      { user_id: 'u1', member_role: 'teacher', joined_at: '2026-01-01T00:00:00Z' },
    ];
    const profiles = [
      { id: 'u1', email: 'docent@vu.nl', full_name: 'Dr. Docent', role: 'admin' },
    ];
    const merged = mergeCourseMembers(rows, profiles);
    expect(merged).toEqual([
      {
        user_id: 'u1',
        member_role: 'teacher',
        joined_at: '2026-01-01T00:00:00Z',
        email: 'docent@vu.nl',
        full_name: 'Dr. Docent',
        global_role: 'admin',
      },
    ]);
  });

  it('valt netjes terug op null/\'student\' voor een lid zonder profiel', () => {
    const rows = [
      { user_id: 'ghost', member_role: 'teacher', joined_at: '2026-02-02T00:00:00Z' },
    ];
    const merged = mergeCourseMembers(rows, []); // geen bijbehorend profiel
    expect(merged[0]).toEqual({
      user_id: 'ghost',
      member_role: 'teacher', // member_role uit course_members blijft behouden
      joined_at: '2026-02-02T00:00:00Z',
      email: null,
      full_name: null,
      global_role: 'student', // fallback wanneer profile.role ontbreekt
    });
  });

  it('valt terug op \'student\' wanneer member_role ontbreekt', () => {
    const rows = [{ user_id: 'u1', joined_at: '2026-03-03T00:00:00Z' }];
    const profiles = [{ id: 'u1', email: 'a@vu.nl', full_name: 'A', role: 'student' }];
    expect(mergeCourseMembers(rows, profiles)[0].member_role).toBe('student');
  });

  it('behoudt de volgorde van de rijen (gesorteerd op joined_at door de route)', () => {
    // De route levert rows aan via .order('joined_at', { ascending: true }).
    // De samenvoeging mag die volgorde niet door elkaar gooien, ook niet als
    // de profiles in een andere volgorde binnenkomen.
    const rows = [
      { user_id: 'first', member_role: 'student', joined_at: '2026-01-01T00:00:00Z' },
      { user_id: 'second', member_role: 'student', joined_at: '2026-01-02T00:00:00Z' },
      { user_id: 'third', member_role: 'teacher', joined_at: '2026-01-03T00:00:00Z' },
    ];
    const profiles = [
      { id: 'third', email: 'c@vu.nl', full_name: 'C', role: 'student' },
      { id: 'first', email: 'a@vu.nl', full_name: 'A', role: 'student' },
      { id: 'second', email: 'b@vu.nl', full_name: 'B', role: 'student' },
    ];
    const merged = mergeCourseMembers(rows, profiles);
    expect(merged.map((m) => m.user_id)).toEqual(['first', 'second', 'third']);
    expect(merged.map((m) => m.joined_at)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-03T00:00:00Z',
    ]);
    // de juiste profielen zijn aan de juiste rijen gekoppeld
    expect(merged.map((m) => m.email)).toEqual(['a@vu.nl', 'b@vu.nl', 'c@vu.nl']);
  });

  it('is defensief tegen null/undefined input', () => {
    expect(mergeCourseMembers(null, null)).toEqual([]);
    expect(mergeCourseMembers(undefined, undefined)).toEqual([]);
    expect(mergeCourseMembers([], [{ id: 'x', email: 'x@vu.nl' }])).toEqual([]);
  });
});
