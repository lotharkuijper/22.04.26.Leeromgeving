-- Voegt item_type toe aan quiz_questions zodat we MCQ- en open-vragen
-- afzonderlijk kunnen filteren bij quiz-generatie en dekkingsanalyse.
-- ShareStats / R-exams kent extype-waarden zoals mchoice / schoice (mcq)
-- en num / string / cloze (open). We mappen die bij ingest naar 'mcq' of
-- 'open'. Bestaande rijen krijgen de default 'mcq' (oude sync deed alleen
-- mchoice).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'item_type'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN item_type text DEFAULT 'mcq';
  END IF;
END $$;

-- Backfill: alle bestaande rijen zijn historisch mchoice-imports.
UPDATE quiz_questions SET item_type = 'mcq' WHERE item_type IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quiz_questions_item_type_check'
  ) THEN
    ALTER TABLE quiz_questions
      ADD CONSTRAINT quiz_questions_item_type_check
      CHECK (item_type IN ('mcq', 'open'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS quiz_questions_source_itemtype_lang_idx
  ON quiz_questions(source, item_type, language);
