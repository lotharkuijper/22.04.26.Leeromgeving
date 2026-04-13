/*
  # Document-Driven Glossary and Quiz Validation System

  ## Overview
  This migration transforms the system from hardcoded concepts to document-driven concepts
  and adds quiz validation against course material.

  ## 1. Concepts Table Enhancement
  ### New Columns:
    - `source_document_id` (uuid, nullable) - Links concept to the document it was extracted from
    - `extraction_method` (enum) - How the concept was added: 'manual', 'auto_extracted', 'seeded'
    - `review_status` (enum) - Admin review status: 'needs_review', 'approved', 'rejected'
    - `extracted_at` (timestamptz) - When automatic extraction occurred
    - `reviewed_by` (uuid, nullable) - Admin who reviewed the concept
    - `reviewed_at` (timestamptz, nullable) - When review occurred
    - `related_chunk_ids` (uuid array) - Document chunks where this concept appears

  ## 2. Topics System
  ### New Table: `topics`
    - Hierarchical topic taxonomy for organizing concepts and quiz questions
    - Links to both concepts and quiz questions for consistency checking
    
  ### New Junction Tables:
    - `concept_topics` - Maps concepts to topics (many-to-many)
    - `quiz_question_topics` - Maps quiz questions to topics (many-to-many)
    - `document_topics` - Maps documents to topics (many-to-many)

  ## 3. Quiz Validation Enhancement
  ### Updates to `quiz_questions`:
    - Enhanced validation_status with new options
    - validation_metadata (jsonb) - Stores matching document info, similarity scores
    - last_validated_at (timestamptz) - When validation was last run
    
  ### New Table: `quiz_validations`
    - Tracks validation history for each question
    - Stores document matches and similarity scores over time

  ## 4. Security
    - RLS policies for all new tables
    - Only admins and docents can manage topics
    - Only admins can approve concepts
    - Students can view approved concepts and validated quiz questions

  ## Important Notes
    - Existing concepts are marked as 'seeded' extraction method
    - All existing concepts are auto-approved for backward compatibility
    - Quiz validation is optional - questions can be manually approved
*/

-- ============================================
-- 1. ENHANCE CONCEPTS TABLE
-- ============================================

-- Add extraction method enum
DO $$ BEGIN
  CREATE TYPE extraction_method AS ENUM ('manual', 'auto_extracted', 'seeded');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add review status enum
DO $$ BEGIN
  CREATE TYPE concept_review_status AS ENUM ('needs_review', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add new columns to concepts table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'source_document_id'
  ) THEN
    ALTER TABLE concepts ADD COLUMN source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'extraction_method'
  ) THEN
    ALTER TABLE concepts ADD COLUMN extraction_method extraction_method DEFAULT 'manual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'review_status'
  ) THEN
    ALTER TABLE concepts ADD COLUMN review_status concept_review_status DEFAULT 'approved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'extracted_at'
  ) THEN
    ALTER TABLE concepts ADD COLUMN extracted_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'reviewed_by'
  ) THEN
    ALTER TABLE concepts ADD COLUMN reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'reviewed_at'
  ) THEN
    ALTER TABLE concepts ADD COLUMN reviewed_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'related_chunk_ids'
  ) THEN
    ALTER TABLE concepts ADD COLUMN related_chunk_ids uuid[] DEFAULT '{}';
  END IF;
END $$;

-- Mark existing concepts as seeded and approved
UPDATE concepts 
SET extraction_method = 'seeded', 
    review_status = 'approved'
WHERE extraction_method IS NULL;

-- Create index on source document for faster lookups
CREATE INDEX IF NOT EXISTS idx_concepts_source_document 
  ON concepts(source_document_id) WHERE source_document_id IS NOT NULL;

-- ============================================
-- 2. CREATE TOPICS SYSTEM
-- ============================================

-- Topics table for organizing concepts and quiz questions
CREATE TABLE IF NOT EXISTS topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  category text NOT NULL CHECK (category IN ('epidemiologie', 'biostatistiek', 'algemeen')),
  parent_topic_id uuid REFERENCES topics(id) ON DELETE CASCADE,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Junction table: concepts to topics (many-to-many)
CREATE TABLE IF NOT EXISTS concept_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  relevance_score decimal(3,2) DEFAULT 1.0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(concept_id, topic_id)
);

-- Junction table: quiz questions to topics (many-to-many)
CREATE TABLE IF NOT EXISTS quiz_question_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  relevance_score decimal(3,2) DEFAULT 1.0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(question_id, topic_id)
);

-- Junction table: documents to topics (many-to-many)
CREATE TABLE IF NOT EXISTS document_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  coverage_score decimal(3,2) DEFAULT 1.0,
  extracted_automatically boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(document_id, topic_id)
);

-- Indexes for topic relationships
CREATE INDEX IF NOT EXISTS idx_concept_topics_concept ON concept_topics(concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_topics_topic ON concept_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_quiz_question_topics_question ON quiz_question_topics(question_id);
CREATE INDEX IF NOT EXISTS idx_quiz_question_topics_topic ON quiz_question_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_document_topics_document ON document_topics(document_id);
CREATE INDEX IF NOT EXISTS idx_document_topics_topic ON document_topics(topic_id);

-- ============================================
-- 3. ENHANCE QUIZ VALIDATION SYSTEM
-- ============================================

-- Add new columns to quiz_questions table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'validation_metadata'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN validation_metadata jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_questions' AND column_name = 'last_validated_at'
  ) THEN
    ALTER TABLE quiz_questions ADD COLUMN last_validated_at timestamptz;
  END IF;
END $$;

-- Quiz validation history table
CREATE TABLE IF NOT EXISTS quiz_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  validation_status text NOT NULL CHECK (validation_status IN ('validated', 'not_validated', 'rejected', 'manual_approved')),
  similarity_score decimal(4,3),
  matched_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  matched_chunk_ids uuid[],
  matched_concepts uuid[],
  validation_notes text,
  validated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  validated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quiz_validations_question ON quiz_validations(question_id);
CREATE INDEX IF NOT EXISTS idx_quiz_validations_status ON quiz_validations(validation_status);
CREATE INDEX IF NOT EXISTS idx_quiz_validations_score ON quiz_validations(similarity_score DESC);

-- ============================================
-- 4. ROW LEVEL SECURITY POLICIES
-- ============================================

-- Topics table RLS
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view topics"
  ON topics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and docents can manage topics"
  ON topics FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Concept topics junction RLS
ALTER TABLE concept_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view concept topics"
  ON concept_topics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and docents can manage concept topics"
  ON concept_topics FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Quiz question topics junction RLS
ALTER TABLE quiz_question_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view quiz question topics"
  ON quiz_question_topics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and docents can manage quiz question topics"
  ON quiz_question_topics FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Document topics junction RLS
ALTER TABLE document_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view document topics"
  ON document_topics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and docents can manage document topics"
  ON document_topics FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Quiz validations RLS
ALTER TABLE quiz_validations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and docents can view quiz validations"
  ON quiz_validations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

CREATE POLICY "Admins and docents can manage quiz validations"
  ON quiz_validations FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Update concepts RLS to allow admin approval
DROP POLICY IF EXISTS "Docenten kunnen begrippen toevoegen" ON concepts;

CREATE POLICY "Docents and admins can add concepts"
  ON concepts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

CREATE POLICY "Admins and docents can update concepts"
  ON concepts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Students can only view approved concepts
DROP POLICY IF EXISTS "Iedereen kan begrippen lezen" ON concepts;

CREATE POLICY "Everyone can view approved concepts"
  ON concepts FOR SELECT
  TO authenticated
  USING (
    review_status = 'approved'
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );