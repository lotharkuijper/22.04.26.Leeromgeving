-- Task: leerdagboek-notities koppelen aan de cursus waarin ze zijn aangemaakt.
-- Voegt een nullable course_id toe aan learning_journal_entries (FK naar courses,
-- ON DELETE SET NULL zodat het verwijderen van een cursus de notitie niet wist),
-- en labelt alle bestaande notities als aangemaakt binnen cursus MenS1.

ALTER TABLE learning_journal_entries
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_learning_journal_entries_course_id
  ON learning_journal_entries (course_id);

-- Backfill: bestaande notities horen historisch bij MenS1.
UPDATE learning_journal_entries
SET course_id = 'dbb59936-d4cc-43ce-b1cc-15afa963930d'
WHERE course_id IS NULL;
