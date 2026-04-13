/*
  # Add ShareStats metadata fields to quiz_questions

  ## Overview
  Voegt extra velden toe aan quiz_questions voor ShareStats integratie metadata.

  ## Changes
  1. New Columns
    - `subtopic` (text) - Subtopic uit ShareStats mapnaam (tweede segment)
    - `language` (text) - Taalcode (nl, en, etc.) uit mapnaam (vierde segment)
    - `institution` (text) - Instelling uit mapnaam (eerste segment, bijv. "uva")
    - `metadata` (jsonb) - Meta-information velden uit Rmd bestand
  
  2. Indexes
    - Index op language voor snelle filtering
    - Index op institution voor rapportage
*/

-- Add new columns to quiz_questions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'subtopic'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN subtopic text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'language'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN language text DEFAULT 'nl';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'institution'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN institution text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS quiz_questions_language_idx ON quiz_questions(language);
CREATE INDEX IF NOT EXISTS quiz_questions_institution_idx ON quiz_questions(institution);
CREATE INDEX IF NOT EXISTS quiz_questions_subtopic_idx ON quiz_questions(subtopic);
CREATE INDEX IF NOT EXISTS quiz_questions_sharestats_id_idx ON quiz_questions(sharestats_id);
