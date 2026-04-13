/*
  # Quiz System

  ## Overview
  Tabellen voor quiz vragen, sets, pogingen en ShareStats integratie.

  ## New Tables
  
  ### `quiz_questions`
  - `id` (uuid, primary key)
  - `question_text` (text, not null)
  - `answer_options` (jsonb) - Array van antwoord opties
  - `correct_answer` (text) - Correct antwoord
  - `explanation` (text) - Uitleg bij antwoord
  - `source` (text) - 'sharestats' of 'custom'
  - `sharestats_id` (text) - ID van vraag in ShareStats (indien van toepassing)
  - `topic` (text) - Onderwerp (bijv. "Confounding", "Odds Ratio")
  - `difficulty` (text) - 'beginner', 'intermediate', 'advanced'
  - `validation_status` (text) - 'validated', 'not_validated', 'rejected'
  - `validation_score` (float) - RAG similarity score
  - `created_by` (uuid, foreign key) - Creator (docent/admin voor custom)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `quiz_sets`
  - `id` (uuid, primary key)
  - `name` (text, not null)
  - `description` (text)
  - `difficulty` (text)
  - `is_public` (boolean) - Zichtbaar voor studenten
  - `created_by` (uuid, foreign key)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `quiz_set_questions`
  - `id` (uuid, primary key)
  - `quiz_set_id` (uuid, foreign key)
  - `question_id` (uuid, foreign key)
  - `order_index` (integer) - Volgorde in set
  - Unique constraint op (quiz_set_id, question_id)

  ### `quiz_attempts`
  - `id` (uuid, primary key)
  - `quiz_set_id` (uuid, foreign key)
  - `student_id` (uuid, foreign key)
  - `started_at` (timestamptz)
  - `completed_at` (timestamptz)
  - `score` (integer) - Aantal goed
  - `total_questions` (integer)
  - `time_spent_seconds` (integer)

  ### `student_answers`
  - `id` (uuid, primary key)
  - `attempt_id` (uuid, foreign key)
  - `question_id` (uuid, foreign key)
  - `selected_answer` (text)
  - `is_correct` (boolean)
  - `time_spent_seconds` (integer)
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled
  - Studenten kunnen alleen validated vragen zien (tenzij admin/docent)
  - Alleen docenten/admin kunnen quiz sets maken
  - Studenten kunnen eigen pogingen zien
*/

-- Quiz questions table
CREATE TABLE IF NOT EXISTS quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_text text NOT NULL,
  answer_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_answer text NOT NULL,
  explanation text,
  source text DEFAULT 'custom' CHECK (source IN ('sharestats', 'custom')),
  sharestats_id text,
  topic text,
  difficulty text DEFAULT 'intermediate' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  validation_status text DEFAULT 'not_validated' CHECK (validation_status IN ('validated', 'not_validated', 'rejected')),
  validation_score float DEFAULT 0.0,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Quiz sets table
CREATE TABLE IF NOT EXISTS quiz_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  difficulty text DEFAULT 'intermediate' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  is_public boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Quiz set questions mapping
CREATE TABLE IF NOT EXISTS quiz_set_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_set_id uuid REFERENCES quiz_sets(id) ON DELETE CASCADE NOT NULL,
  question_id uuid REFERENCES quiz_questions(id) ON DELETE CASCADE NOT NULL,
  order_index integer DEFAULT 0,
  UNIQUE(quiz_set_id, question_id)
);

-- Quiz attempts table
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_set_id uuid REFERENCES quiz_sets(id) ON DELETE CASCADE NOT NULL,
  student_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  started_at timestamptz DEFAULT now() NOT NULL,
  completed_at timestamptz,
  score integer DEFAULT 0,
  total_questions integer DEFAULT 0,
  time_spent_seconds integer DEFAULT 0
);

-- Student answers table
CREATE TABLE IF NOT EXISTS student_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid REFERENCES quiz_attempts(id) ON DELETE CASCADE NOT NULL,
  question_id uuid REFERENCES quiz_questions(id) ON DELETE CASCADE NOT NULL,
  selected_answer text,
  is_correct boolean DEFAULT false,
  time_spent_seconds integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS quiz_questions_topic_idx ON quiz_questions(topic);
CREATE INDEX IF NOT EXISTS quiz_questions_validation_status_idx ON quiz_questions(validation_status);
CREATE INDEX IF NOT EXISTS quiz_attempts_student_id_idx ON quiz_attempts(student_id);
CREATE INDEX IF NOT EXISTS quiz_set_questions_quiz_set_id_idx ON quiz_set_questions(quiz_set_id);

-- Enable RLS
ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_set_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_answers ENABLE ROW LEVEL SECURITY;

-- Quiz questions policies
CREATE POLICY "Students can read validated questions"
  ON quiz_questions FOR SELECT
  TO authenticated
  USING (
    validation_status = 'validated' OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Docenten and admin can manage questions"
  ON quiz_questions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Quiz sets policies
CREATE POLICY "Students can read public quiz sets"
  ON quiz_sets FOR SELECT
  TO authenticated
  USING (
    is_public = true OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Docenten and admin can manage quiz sets"
  ON quiz_sets FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Quiz set questions policies
CREATE POLICY "Users can read quiz set questions"
  ON quiz_set_questions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM quiz_sets
      WHERE quiz_sets.id = quiz_set_id
      AND (
        quiz_sets.is_public = true OR
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid()
          AND profiles.role IN ('docent', 'admin')
        )
      )
    )
  );

CREATE POLICY "Docenten and admin can manage quiz set questions"
  ON quiz_set_questions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Quiz attempts policies
CREATE POLICY "Students can read own attempts"
  ON quiz_attempts FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

CREATE POLICY "Docenten and admin can read all attempts"
  ON quiz_attempts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Students can create own attempts"
  ON quiz_attempts FOR INSERT
  TO authenticated
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can update own attempts"
  ON quiz_attempts FOR UPDATE
  TO authenticated
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

-- Student answers policies
CREATE POLICY "Students can read own answers"
  ON student_answers FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM quiz_attempts
      WHERE quiz_attempts.id = attempt_id
      AND quiz_attempts.student_id = auth.uid()
    )
  );

CREATE POLICY "Docenten and admin can read all answers"
  ON student_answers FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Students can insert own answers"
  ON student_answers FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM quiz_attempts
      WHERE quiz_attempts.id = attempt_id
      AND quiz_attempts.student_id = auth.uid()
    )
  );

-- Triggers
DROP TRIGGER IF EXISTS quiz_questions_updated_at ON quiz_questions;
CREATE TRIGGER quiz_questions_updated_at
  BEFORE UPDATE ON quiz_questions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS quiz_sets_updated_at ON quiz_sets;
CREATE TRIGGER quiz_sets_updated_at
  BEFORE UPDATE ON quiz_sets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();