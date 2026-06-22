// Task #334 — pure helper voor het veilig hergebruiken van een RAG-map.
//
// Achtergrond: /api/admin/create-rag-folder en ensureCourseRagFolder zochten een
// bestaande map op via `name = 'RAG - <cursusnaam>'`. Omdat de cursusnaam (en dus
// de mapnaam) niet uniek per cursus is, kon een docent van cursus A — door een
// gemanipuleerde of toevallig botsende naam — een map die al aan cursus B hangt
// laten hergebruiken en aan cursus A koppelen (cross-course mutatie). Deze helper
// maakt de hergebruik-beslissing deterministisch en afdwingbaar: een map mag
// ALLEEN hergebruikt worden als ze nergens aan hangt, of uitsluitend aan déze
// cursus. Hangt ze (ook) aan een andere cursus, dan komt ze NOOIT in aanmerking.

/**
 * Kies een veilig herbruikbare RAG-map voor een cursus.
 *
 * @param {Object} params
 * @param {Array<{id:string}>} params.folders - kandidaat-mappen (naam+type-match).
 * @param {Object<string, Array<string>>} params.assignmentsByFolderId - per
 *   folder-id de lijst van course_id's waaraan de map gekoppeld is.
 * @param {string} params.courseId - de cursus waarvoor we een map zoeken.
 * @returns {string|null} folder-id die veilig hergebruikt mag worden, of null
 *   (dan moet de aanroeper een nieuwe map aanmaken).
 */
export function pickReusableRagFolder({ folders, assignmentsByFolderId, courseId }) {
  if (!courseId) return null;
  for (const f of folders || []) {
    if (!f || !f.id) continue;
    const assigned = (assignmentsByFolderId && assignmentsByFolderId[f.id]) || [];
    // Veilig als de map nergens hangt, of uitsluitend aan déze cursus.
    if (assigned.length === 0 || assigned.every((c) => c === courseId)) {
      return f.id;
    }
  }
  return null;
}
