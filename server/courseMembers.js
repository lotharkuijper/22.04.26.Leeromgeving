// Pure helpers voor GET /api/admin/courses/:id/members.
//
// course_members.user_id verwijst naar auth.users, niet naar profiles, dus
// PostgREST kent geen directe relatie en kan course_members→profiles niet
// embedden. Daarom haalt de route course_members en profiles los op en voegt
// ze in JS samen. Door die samenvoeg-logica hier pure te houden (geen
// DB-calls) kunnen we het gedrag met vitest bewaken zonder een lopende server.

/**
 * Verzamelt de unieke, niet-lege user_id's uit de course_members-rijen, zodat
 * de route in één `.in('id', ids)`-query de bijbehorende profiles kan ophalen.
 *
 * @param {Array<{ user_id?: string | null }>} rows
 * @returns {string[]}
 */
export function collectMemberUserIds(rows) {
  return [...new Set((rows || []).map((row) => row.user_id).filter(Boolean))];
}

/**
 * Voegt de course_members-rijen samen met hun profiles tot één weergavelijst.
 * De volgorde van `rows` blijft behouden (de route levert ze gesorteerd op
 * joined_at), en een lid zonder bijbehorend profiel valt netjes terug op
 * null (email/full_name) en 'student' (member_role/global_role).
 *
 * @param {Array<{ user_id?: string | null, member_role?: string | null, joined_at?: string | null }>} rows
 * @param {Array<{ id: string, email?: string | null, full_name?: string | null, role?: string | null }>} profiles
 * @returns {Array<{ user_id: string | null | undefined, member_role: string, joined_at: string | null | undefined, email: string | null, full_name: string | null, global_role: string }>}
 */
export function mergeCourseMembers(rows, profiles) {
  const profileMap = new Map();
  for (const p of profiles || []) profileMap.set(p.id, p);

  return (rows || []).map((row) => {
    const p = profileMap.get(row.user_id);
    return {
      user_id: row.user_id,
      member_role: row.member_role || 'student',
      joined_at: row.joined_at,
      email: p?.email || null,
      full_name: p?.full_name || null,
      global_role: p?.role || 'student',
    };
  });
}
