// Pure beslis-helpers voor de PUT /api/admin/courses/:id/members/:userId
// route. Door deze functies pure te houden (geen DB-calls) zijn ze met
// vitest dekkingsbaar zonder een lopende server of supertest.

/**
 * Bepaalt of de aanroeper member-rollen in een cursus mag wijzigen.
 * Admins mogen altijd; per-cursus docenten alleen binnen hun eigen cursus.
 *
 * @param {object} ctx
 * @param {boolean} ctx.isAdmin
 * @param {boolean} ctx.isCourseTeacher — true wanneer caller course_members.member_role='teacher' is in déze cursus
 * @returns {{ allowed: true } | { allowed: false, status: 403, body: { error: string } }}
 */
export function authorizeMemberRoleChange({ isAdmin, isCourseTeacher }) {
  if (isAdmin) return { allowed: true };
  if (isCourseTeacher) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    body: { error: 'Alleen admin of docent van deze cursus mag rollen wijzigen' },
  };
}

/**
 * Past de laatste-docent-bescherming toe. Wanneer de aanvraag een teacher
 * naar student demoteert én er nog maar 1 docent is, wordt 409 teruggegeven
 * tenzij de caller admin is én ?force=1 meestuurde.
 *
 * @param {object} ctx
 * @param {'student'|'teacher'} ctx.existingMemberRole
 * @param {'student'|'teacher'} ctx.newMemberRole
 * @param {number} ctx.teacherCount — aantal teachers in de cursus vóór de wijziging
 * @param {boolean} ctx.isAdmin
 * @param {boolean} ctx.force
 * @returns {{ ok: true } | { ok: false, status: 409, body: { error: string, code: string } }}
 */
export function checkLastTeacherProtection({ existingMemberRole, newMemberRole, teacherCount, isAdmin, force }) {
  const isDemotion = existingMemberRole === 'teacher' && newMemberRole === 'student';
  if (!isDemotion) return { ok: true };
  if (teacherCount > 1) return { ok: true };
  if (isAdmin && force) return { ok: true };
  return {
    ok: false,
    status: 409,
    body: {
      error: 'Dit is de laatste docent van de cursus. Wijs eerst een andere docent aan, of laat een admin de wijziging forceren.',
      code: 'last_teacher',
    },
  };
}

/**
 * Parseert de ?force query — accepteert "1" of "true" (case-insensitive).
 */
export function parseForceFlag(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true';
}
