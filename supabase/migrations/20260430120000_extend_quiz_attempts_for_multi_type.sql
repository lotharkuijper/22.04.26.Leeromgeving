-- Task #52 (Quiz-omgeving herontwerp fase 1)
-- Breid `quiz_attempts` uit zodat één rij een complete dynamisch
-- gegenereerde quiz kan vasthouden, met:
--   * meerdere geselecteerde onderwerpen (topics text[])
--   * een vraagtype per quiz (mcq | open | casus)
--   * de gegenereerde vragen + de gegeven antwoorden + per-vraag AI-evaluatie
--     (feedback / feedforward / score 0-100) opgeslagen als JSON
--   * een totaal-percentagescore die voor alle drie de typen geldt
--
-- `quiz_set_id` mag nu NULL zijn, omdat de nieuwe ad-hoc AI-quizzes niet
-- meer aan een vaste quiz_set hangen. Bestaande historische rijen blijven
-- werken; voor de nieuwe stroom wordt enkel het uitgebreide model gebruikt.

ALTER TABLE quiz_attempts ALTER COLUMN quiz_set_id DROP NOT NULL;

ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS topics text[] DEFAULT '{}'::text[];
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS difficulty text;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS question_type text;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS questions_data jsonb DEFAULT '[]'::jsonb;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS answers jsonb DEFAULT '[]'::jsonb;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS score_percentage integer;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- CHECK voor question_type idempotent toevoegen
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quiz_attempts_question_type_check'
  ) THEN
    ALTER TABLE quiz_attempts
      ADD CONSTRAINT quiz_attempts_question_type_check
      CHECK (question_type IS NULL OR question_type IN ('mcq', 'open', 'casus'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS quiz_attempts_created_at_idx ON quiz_attempts (created_at DESC);
