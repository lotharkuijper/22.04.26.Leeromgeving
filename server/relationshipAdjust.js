// ───────────────────────────────────────────────────────────────────────────
// Staff-correctie op de persona-verstandhouding (Task #167 / #178).
//
// `POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust`
// is een staff-only handmatige correctie van de relatie-score. De route en
// haar afhankelijkheden zijn hierheen verplaatst uit server/index.js zodat de
// autorisatie (alleen staff van de cursus) én de wiring naar
// applyRelationshipDelta geautomatiseerd getest kunnen worden via
// dependency-injectie. `registerRelationshipAdjustRoute(app, deps)` mount de
// endpoint op een Express-app; alle externe afhankelijkheden (Supabase,
// auth-helper, staff-check, delta-applier, score→bucket) komen via `deps`
// binnen.
// ───────────────────────────────────────────────────────────────────────────

export function registerRelationshipAdjustRoute(app, deps) {
  const {
    supabaseAdmin,
    authUser,
    isStaffForCourse,
    applyRelationshipDelta,
    scoreToBucket,
  } = deps;

  // POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust
  // — staff-only handmatige correctie van de relatie. `delta` in -10..+10
  // (wordt na clamp toegepast); `note` is een verplichte korte motivatie.
  app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, groupId, personaId } = req.params;
    const { delta, note } = req.body || {};
    const deltaNum = Math.round(Number(delta));
    if (!Number.isFinite(deltaNum) || deltaNum === 0) {
      return res.status(400).json({ error: 'delta moet een geheel getal ≠ 0 zijn' });
    }
    if (deltaNum > 10 || deltaNum < -10) {
      return res.status(400).json({ error: 'delta moet tussen -10 en +10 liggen' });
    }
    const noteStr = typeof note === 'string' ? note.trim() : '';
    if (noteStr.length === 0) {
      return res.status(400).json({ error: 'note (korte motivatie) is verplicht' });
    }
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff) return res.status(403).json({ error: 'Alleen staff van deze cursus mag de relatie aanpassen' });

      const { data: groupCheck } = await supabaseAdmin
        .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
      if (!groupCheck || groupCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }
      const { data: personaCheck } = await supabaseAdmin
        .from('project_personas').select('id, project_id').eq('id', personaId).maybeSingle();
      if (!personaCheck || personaCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
      }

      const refId = `staff_adjust:${auth.user.id}:${Date.now()}`;
      let updated;
      try {
        updated = await applyRelationshipDelta({
          projectId, groupId, personaId,
          delta: deltaNum,
          event: { source: 'staff_adjust', refId, by: auth.user.id, delta: deltaNum, note: noteStr },
        });
      } catch (e) {
        if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Migratie 20260529100000_project_persona_relationships.sql is nog niet toegepast in Supabase.',
          });
        }
        throw e;
      }
      if (!updated) {
        return res.status(503).json({
          error: 'Migratie 20260529100000_project_persona_relationships.sql is nog niet toegepast in Supabase.',
        });
      }
      return res.json({
        relationship: {
          score: updated.score,
          bucket: scoreToBucket(updated.score),
          history: updated.history,
          updated_at: updated.updated_at,
        },
      });
    } catch (err) {
      console.error('[relationship-adjust]', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
