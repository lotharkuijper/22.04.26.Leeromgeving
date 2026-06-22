-- Task #312: Studiecafé — per-(gebruiker, thread) leesstatus.
--
-- Task #307 hield één per-cursus "laatst gezien"-moment bij; het studiecafé
-- bezoeken wiste daardoor ALLE "nieuw"-markeringen tegelijk, ook voor threads die
-- de student nooit opende. Deze tabel houdt per (gebruiker, thread) bij wanneer de
-- gebruiker die thread voor het laatst OPENDE. Een thread is "nieuw" wanneer zijn
-- last_activity_at ná de zachte-uitrol-vloer (studiecafe_last_seen) ligt ÉN ná dit
-- per-thread read_at (of er nog geen read-rij is). Zo blijven alleen werkelijk
-- ongeopende threads gemarkeerd.
--
-- TOEGANGSMODEL: identiek aan studiecafe_last_seen — eigen-rij-data met RLS
-- (auth.uid() = user_id). De server schrijft/leest via de service-role
-- (supabaseAdmin); de policies laten een gebruiker desgewenst ook de eigen rijen
-- rechtstreeks lezen. We koppelen NIET aan course_members (toegang is
-- zichtbaarheids-gebaseerd, dus studenten hebben vaak geen course_members-rij).

BEGIN;

CREATE TABLE IF NOT EXISTS studiecafe_thread_reads (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES studiecafe_threads(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);

-- Snel ophalen van alle leesmomenten van één gebruiker binnen één cursus.
CREATE INDEX IF NOT EXISTS studiecafe_thread_reads_user_course_idx
  ON studiecafe_thread_reads (user_id, course_id);

ALTER TABLE studiecafe_thread_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studiecafe_thread_reads_select ON studiecafe_thread_reads;
CREATE POLICY studiecafe_thread_reads_select ON studiecafe_thread_reads FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_thread_reads_insert ON studiecafe_thread_reads;
CREATE POLICY studiecafe_thread_reads_insert ON studiecafe_thread_reads FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_thread_reads_update ON studiecafe_thread_reads;
CREATE POLICY studiecafe_thread_reads_update ON studiecafe_thread_reads FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_thread_reads_delete ON studiecafe_thread_reads;
CREATE POLICY studiecafe_thread_reads_delete ON studiecafe_thread_reads FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

COMMIT;
