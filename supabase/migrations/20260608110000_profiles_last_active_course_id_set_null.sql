-- Fix: een cursus verwijderen faalde met
--   update or delete on table "courses" violates foreign key constraint
--   "profiles_last_active_course_id_fkey" on table "profiles"
-- omdat deze FK geen ON DELETE-actie had (NO ACTION/RESTRICT). Wanneer een
-- gebruiker de te verwijderen cursus als laatst-actieve cursus had, blokkeerde
-- dat de DELETE FROM courses in de transactionele cursus-verwijdering.
--
-- We zetten de FK op ON DELETE SET NULL, consistent met alle andere course_id
-- FK's (conversations, quiz_attempts, projects, learning_journal_entries):
-- het verwijderen van een cursus maakt last_active_course_id leeg i.p.v. te falen.

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_last_active_course_id_fkey;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_last_active_course_id_fkey
  FOREIGN KEY (last_active_course_id) REFERENCES courses(id) ON DELETE SET NULL;
