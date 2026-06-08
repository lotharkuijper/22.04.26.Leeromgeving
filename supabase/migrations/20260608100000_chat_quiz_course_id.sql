-- Task #246: chats en quizpogingen koppelen aan de cursus waarin ze zijn gevoerd,
-- zodat een gebruiker per actieve cursus alleen de eigen chats/quizzen ziet.
-- Voegt een nullable course_id toe aan conversations en quiz_attempts
-- (FK naar courses, ON DELETE SET NULL zodat het verwijderen van een cursus
-- de rij niet wist) + index, en labelt bestaande rijen als horend bij MenS1.
-- RLS is al gebruiker-gescoord; geen RLS-wijziging nodig.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_course_id
  ON conversations (course_id);

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_course_id
  ON quiz_attempts (course_id);

-- Backfill: bestaande chats en quizpogingen horen historisch bij MenS1.
UPDATE conversations
SET course_id = 'dbb59936-d4cc-43ce-b1cc-15afa963930d'
WHERE course_id IS NULL;

UPDATE quiz_attempts
SET course_id = 'dbb59936-d4cc-43ce-b1cc-15afa963930d'
WHERE course_id IS NULL;
