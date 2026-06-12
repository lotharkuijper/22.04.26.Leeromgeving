// ───────────────────────────────────────────────────────────────────────────
// Begrip ↔ bron-bewijs (Task #243/#244) — `concept_evidence` koppelt elk begrip
// aan zijn ondersteunende RAG-bronfragmenten. Het lees-endpoint is hierheen
// verplaatst uit server/index.js zodat de cursus-isolatie (een begrip kan in de
// key_points-fallback gedeeld zijn tussen cursussen) geautomatiseerd getest kan
// worden via dependency-injectie.
//
// `registerConceptEvidenceRoutes(app, deps)` mount het endpoint op een
// Express-app; alle externe afhankelijkheden (Supabase, auth-helpers,
// schema-detectie) komen via `deps` binnen.
// ───────────────────────────────────────────────────────────────────────────

// Pure(re) filter: behoudt alleen bewijsrijen waar de beller cursustoegang toe
// heeft. Rijen zonder course_id worden altijd toegelaten (legacy/global). De
// toegang wordt per course_id gecachet zodat herhaalde checks worden vermeden.
// `hasCourseAccess` is een async predikaat (courseId) => boolean. Het resultaat
// wordt gecapt op `limit` rijen.
export async function filterEvidenceByAccess({ rows, hasCourseAccess, limit = 10 }) {
  const accessCache = new Map();
  const allowed = [];
  for (const r of rows || []) {
    if (!r.course_id) {
      allowed.push(r);
      continue;
    }
    if (!accessCache.has(r.course_id)) {
      accessCache.set(r.course_id, await hasCourseAccess(r.course_id));
    }
    if (accessCache.get(r.course_id)) allowed.push(r);
  }
  return allowed.slice(0, limit);
}

export function registerConceptEvidenceRoutes(app, deps) {
  const {
    supabaseAdmin,
    requireAuthUser,
    userHasCourseAccess,
    getSchemaReady,
  } = deps;

  app.get('/api/concepts/evidence', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { conceptId } = req.query;
    if (!conceptId) {
      return res.status(400).json({ error: 'conceptId is required' });
    }
    if (!getSchemaReady()) {
      return res.json({ evidence: [] });
    }
    try {
      const { data: allRows, error } = await supabaseAdmin
        .from('concept_evidence')
        .select('id, chunk_id, document_id, snippet, similarity, course_id')
        .eq('concept_id', conceptId)
        .order('similarity', { ascending: false })
        .limit(20);
      if (error) {
        console.error('[concepts/evidence] query error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      // Autorisatie: begrippen kunnen (in de key_points-fallback) gedeeld zijn
      // tussen cursussen, dus filteren we de bewijsrijen tot de cursussen waar de
      // beller toegang toe heeft. Zo lekt een willekeurig concept-id geen
      // cursusmateriaal van een andere cursus.
      const rows = await filterEvidenceByAccess({
        rows: allRows,
        hasCourseAccess: (courseId) =>
          userHasCourseAccess(auth.user, auth.profile, courseId),
        limit: 10,
      });
      const docIds = [...new Set((rows || []).map((r) => r.document_id).filter(Boolean))];
      const titleById = new Map();
      const metaById = new Map();
      if (docIds.length > 0) {
        const { data: docs } = await supabaseAdmin
          .from('documents')
          .select('id, title')
          .in('id', docIds);
        for (const d of docs || []) titleById.set(d.id, d.title);
        // Dia-reeks-metadata van de chunk meenemen wanneer beschikbaar.
        const chunkIds = [...new Set((rows || []).map((r) => r.chunk_id).filter(Boolean))];
        if (chunkIds.length > 0) {
          const { data: chunkMeta } = await supabaseAdmin
            .from('document_chunks')
            .select('id, metadata')
            .in('id', chunkIds);
          for (const c of chunkMeta || []) metaById.set(c.id, c.metadata);
        }
      }
      const evidence = (rows || []).map((r) => ({
        id: r.chunk_id || r.id,
        content: r.snippet || '',
        documentTitle: titleById.get(r.document_id) || 'Cursusmateriaal',
        documentId: r.document_id || undefined,
        similarity: typeof r.similarity === 'number' ? r.similarity : 0,
        metadata: (r.chunk_id && metaById.get(r.chunk_id)) || null,
      }));
      return res.json({ evidence });
    } catch (err) {
      console.error('[concepts/evidence] Unexpected error:', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
