-- Task #252: Persona-raadpleeglimiet per groep.
-- Docenten stellen per persona een maximum aantal raadplegingen (= hele
-- gesprekken/threads) in. De teller wordt verbruikt bij het OPENEN van een
-- nieuwe thread, per groep. Daarnaast kan een docent per (project, groep)
-- extra raadplegingen toekennen bovenop de persona-standaard. Optioneel
-- sluiten stille open threads na auto_close_hours automatisch af (lui, geen cron).

BEGIN;

-- 1. Limiet- + auto-close-kolommen op project_personas en course_personas.
--    NULL max_consultations = onbeperkt; NULL auto_close_hours = uit.
ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS max_consultations integer,
  ADD COLUMN IF NOT EXISTS auto_close_hours  integer;

ALTER TABLE course_personas
  ADD COLUMN IF NOT EXISTS max_consultations integer,
  ADD COLUMN IF NOT EXISTS auto_close_hours  integer;

-- 2. Per-(project, groep, persona) extra toegekende raadplegingen.
CREATE TABLE IF NOT EXISTS project_persona_consultation_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id)         ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES project_groups(id)   ON DELETE CASCADE,
  persona_id  uuid NOT NULL REFERENCES project_personas(id) ON DELETE CASCADE,
  extra_consultations integer NOT NULL DEFAULT 0
                CHECK (extra_consultations >= 0 AND extra_consultations <= 1000),
  note        text,
  granted_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ppcg_project_group_persona
  ON project_persona_consultation_grants (project_id, group_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_ppcg_group
  ON project_persona_consultation_grants (group_id);

-- 3. RLS: lezen alleen voor staff van de cursus (zelfde patroon als de
--    verstrengde project_persona_relationships-policy). Studenten lezen
--    uitsluitend via server-endpoints die met de service-role draaien.
--    Schrijven gebeurt eveneens uitsluitend via de service-role (geen
--    INSERT/UPDATE/DELETE-policy → standaard geweigerd onder RLS).
ALTER TABLE project_persona_consultation_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ppcg_select_staff ON project_persona_consultation_grants;
CREATE POLICY ppcg_select_staff ON project_persona_consultation_grants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM projects p
        LEFT JOIN course_members cm
               ON cm.course_id = p.course_id AND cm.user_id = auth.uid()
        LEFT JOIN profiles pr ON pr.id = auth.uid()
       WHERE p.id = project_persona_consultation_grants.project_id
         AND (
              pr.role = 'admin'
           OR pr.email = 'l.d.j.kuijper@vu.nl'
           OR cm.member_role = 'teacher'
         )
    )
  );

COMMIT;
