-- Task #307: Studiecafé — per-gebruiker "laatst gezien" voor ongelezen-indicatoren.
--
-- Houdt per (gebruiker, cursus) bij wanneer de gebruiker het studiecafé voor het
-- laatst opende. De nav-badge en de per-thread "nieuw"-markering vergelijken
-- studiecafe_threads.last_activity_at met deze last_seen_at.
--
-- TOEGANGSMODEL: dit is eigen-rij-data (zoals student_course_levels). RLS staat aan
-- met eigen-rij-policies (auth.uid() = user_id). De server schrijft/leest via de
-- service-role (supabaseAdmin), maar de policies laten een gebruiker desgewenst ook
-- de eigen rij rechtstreeks lezen. We koppelen NIET aan course_members: toegang tot
-- het studiecafé is zichtbaarheids-gebaseerd, dus een student heeft vaak geen
-- course_members-rij.

BEGIN;

CREATE TABLE IF NOT EXISTS studiecafe_last_seen (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);

ALTER TABLE studiecafe_last_seen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studiecafe_last_seen_select ON studiecafe_last_seen;
CREATE POLICY studiecafe_last_seen_select ON studiecafe_last_seen FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_last_seen_insert ON studiecafe_last_seen;
CREATE POLICY studiecafe_last_seen_insert ON studiecafe_last_seen FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_last_seen_update ON studiecafe_last_seen;
CREATE POLICY studiecafe_last_seen_update ON studiecafe_last_seen FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_last_seen_delete ON studiecafe_last_seen;
CREATE POLICY studiecafe_last_seen_delete ON studiecafe_last_seen FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

COMMIT;
