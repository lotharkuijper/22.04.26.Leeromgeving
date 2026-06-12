// Pure beslis-helpers voor de PATCH /api/courses/:id/availability route
// (Task #270 — cursus op "niet beschikbaar" zetten). Door deze functies pure
// te houden (geen DB-calls) zijn ze met vitest dekkbaar zonder een lopende
// server of supertest. De route zelf combineert ze met isStaffForCourse /
// isCourseTeacher en de supabaseAdmin-update.

/**
 * Bepaalt of de aanroeper de beschikbaarheid (student_visible) van een cursus
 * mag wijzigen. Admins mogen elke cursus; per-cursus docenten alleen hun eigen
 * cursus(sen).
 *
 * @param {object} ctx
 * @param {boolean} ctx.isAdmin
 * @param {boolean} ctx.isCourseTeacher — true wanneer caller course_members.member_role='teacher' is in déze cursus
 * @returns {{ allowed: true } | { allowed: false, status: 403, body: { error: string } }}
 */
export function authorizeAvailabilityChange({ isAdmin, isCourseTeacher }) {
  if (isAdmin) return { allowed: true };
  if (isCourseTeacher) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    body: { error: 'Alleen admin of docent van deze cursus mag de beschikbaarheid wijzigen' },
  };
}

/**
 * Valideert en parseert de request-body. Verwacht een strikt boolean veld
 * `student_visible`. Niet-boolean (ook geen "true"/1-coercion) → 400, zodat een
 * cursus nooit per ongeluk verborgen of zichtbaar wordt door een vage waarde.
 *
 * @param {any} body
 * @returns {{ ok: true, value: boolean } | { ok: false, status: 400, body: { error: string } }}
 */
export function parseStudentVisible(body) {
  if (!body || typeof body.student_visible !== 'boolean') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Veld "student_visible" (boolean) is verplicht' },
    };
  }
  return { ok: true, value: body.student_visible };
}

/**
 * Bepaalt of een niet-admin lid een cursus nog mag betreden gegeven de
 * beschikbaarheid. Een verborgen cursus (student_visible=false) blijft enkel
 * toegankelijk voor de docent(en) van die cursus; studenten worden geweerd.
 * Wordt server-side gebruikt naast de RLS-policy zodat "verborgen" niet louter
 * cosmetisch is voor reeds-ingeschreven studenten.
 *
 * @param {object} ctx
 * @param {boolean} ctx.studentVisible — courses.student_visible
 * @param {boolean} ctx.isCourseTeacher — caller is docent van déze cursus
 * @returns {boolean} true = toegang toegestaan
 */
export function memberCanAccessCourse({ studentVisible, isCourseTeacher }) {
  if (studentVisible) return true;
  return !!isCourseTeacher;
}

/**
 * Centrale toegangsregel voor cursus-inhoud (projecten, cursus-info, itembank).
 * Spiegelt bewust de courses-RLS van Task #270: een actieve, zichtbare cursus is
 * voor élke ingelogde student toegankelijk (géén course_members-rij nodig),
 * zodat zelf-geregistreerde studenten (Task #272) een cursus kunnen kiezen én de
 * inhoud ervan zien. De membership-eis gold vroeger overal, maar week af van de
 * RLS waardoor zelf-geregistreerde studenten niets zagen.
 *
 * Regels (strikt additief — niemand verliest bestaande toegang):
 *   - admin/superuser           → altijd toegang.
 *   - verborgen (student_visible=false) → alléén docent van de cursus
 *     (preserve Task #270: verborgen blijft verborgen, óók voor ingeschreven
 *     studenten).
 *   - actief + zichtbaar        → iedereen (de nieuwe open route, = courses-RLS).
 *   - inactief + zichtbaar      → lid óf docent (gearchiveerde cursus blijft
 *     leesbaar voor wie er al bij hoort).
 *
 * @param {object} ctx
 * @param {boolean} ctx.isAdmin
 * @param {boolean} ctx.isCourseTeacher — caller is docent van déze cursus
 * @param {boolean} ctx.isMember — caller heeft een course_members-rij in déze cursus
 * @param {boolean} ctx.isActive — courses.is_active
 * @param {boolean} ctx.studentVisible — courses.student_visible (true als kolom ontbreekt)
 * @returns {boolean} true = toegang toegestaan
 */
export function canAccessCourseContent({ isAdmin, isCourseTeacher, isMember, isActive, studentVisible }) {
  if (isAdmin) return true;
  if (studentVisible === false) return !!isCourseTeacher;
  if (isActive === true) return true;
  return !!(isMember || isCourseTeacher);
}
