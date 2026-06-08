-- Task #253: Beoordelaar — cijfer, rubrics & badges.
-- Breidt de document-beoordelingsloop uit met (1) een numeriek cijfer 0–10 en
-- feed-forward op de review zelf, (2) een per-persona keuze of de behaalde badge
-- per individuele student of per hele groep geldt, (3) een per-rubric instelling
-- of die rubric zichtbaar is voor studenten, en (4) een aparte tabel waarin
-- behaalde badges idempotent (per review × ontvanger) worden vastgelegd.

BEGIN;

-- 1. Cijfer + feed-forward op de review. NULL voor oude reviews zonder cijfer.
ALTER TABLE project_document_reviews
  ADD COLUMN IF NOT EXISTS grade        numeric(4,2)
                            CHECK (grade IS NULL OR (grade >= 0 AND grade <= 10)),
  ADD COLUMN IF NOT EXISTS feed_forward text;

-- 2. Toekenningsmodus per beoordelaar-persona (individueel vs hele groep).
ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS badge_award_mode text NOT NULL DEFAULT 'individual'
                            CHECK (badge_award_mode IN ('individual', 'group'));

ALTER TABLE course_personas
  ADD COLUMN IF NOT EXISTS badge_award_mode text NOT NULL DEFAULT 'individual'
                            CHECK (badge_award_mode IN ('individual', 'group'));

-- 3. Rubric-zichtbaarheid voor studenten. Verborgen rubrics (is_hidden_rubric)
--    blijven altijd input voor de beoordeling; visible_to_students bepaalt enkel
--    of studenten het bestand zien/kunnen downloaden.
ALTER TABLE project_persona_documents
  ADD COLUMN IF NOT EXISTS visible_to_students boolean NOT NULL DEFAULT false;

-- 4. Behaalde badges. Eén rij per (review, ontvanger). Bij groepsmodus krijgt
--    elk groepslid een rij; bij individueel alleen de indienende student.
CREATE TABLE IF NOT EXISTS project_review_badges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES project_document_reviews(id) ON DELETE CASCADE,
  persona_id  uuid NOT NULL REFERENCES project_personas(id)         ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES project_groups(id)           ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id)                 ON DELETE CASCADE,
  grade       numeric(4,2) NOT NULL CHECK (grade >= 0 AND grade <= 10),
  badge       text NOT NULL CHECK (badge IN ('platina', 'goud', 'zilver', 'brons')),
  award_mode  text NOT NULL DEFAULT 'individual'
               CHECK (award_mode IN ('individual', 'group')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prb_review_user ON project_review_badges (review_id, user_id);
CREATE INDEX IF NOT EXISTS idx_prb_group ON project_review_badges (group_id);
CREATE INDEX IF NOT EXISTS idx_prb_user  ON project_review_badges (user_id);

ALTER TABLE project_review_badges ENABLE ROW LEVEL SECURITY;

-- Lezen: groepsleden + staff van de cursus van het project. Schrijven enkel via
-- de service-role (server), dus geen INSERT/UPDATE/DELETE-policy.
DROP POLICY IF EXISTS prb_select ON project_review_badges;
CREATE POLICY prb_select ON project_review_badges
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm
       WHERE pgm.group_id = project_review_badges.group_id
         AND pgm.user_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups pg
        JOIN projects p ON p.id = pg.project_id
        LEFT JOIN course_members cm
               ON cm.course_id = p.course_id AND cm.user_id = auth.uid()
        LEFT JOIN profiles pr ON pr.id = auth.uid()
       WHERE pg.id = project_review_badges.group_id
         AND (
              pr.role = 'admin'
           OR pr.email = 'l.d.j.kuijper@vu.nl'
           OR cm.member_role = 'teacher'
         )
    )
  );

COMMIT;
