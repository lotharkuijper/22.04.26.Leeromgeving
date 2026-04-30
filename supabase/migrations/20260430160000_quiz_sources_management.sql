-- Migratie: beheer van quiz-bronnen (Task #57).
--
-- Voegt de schema-onderdelen toe die nodig zijn om expliciet te beheren uit
-- welke bronnen de quizgenerator vragen mag halen:
--   1) extra kolommen op `quiz_questions` voor itembank-metadata (exsection
--      als gestructureerd pad, broninfo);
--   2) tabel `concept_itembank_sections` met de docent-mapping van
--      cursus-begrippen naar itembank-secties (exsection paden);
--   3) tabel `concept_rag_sources` met de expliciete koppeling van een
--      cursus-begrip naar één primaire RAG-folder (MVP: 1-op-1; uitbreiding
--      naar meerdere folders/documenten kan later);
--   4) tabel `quiz_sources_mix` met de bronnen-verdeling per cursus
--      (% RAG / % ItemBank / % LLM-creatief).
--
-- De server detecteert defensief of deze migratie is toegepast en degradeert
-- netjes als dat (nog) niet zo is.

-- 1. Itembank-metadata kolommen op quiz_questions ----------------------------
ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS exsection_path text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_repo text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_commit_sha text DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_quiz_questions_exsection_path
  ON quiz_questions USING gin (exsection_path);

-- 2. Mapping concept ↔ itembank-sectie ---------------------------------------
CREATE TABLE IF NOT EXISTS concept_itembank_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE,
  exsection_path text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (concept_id, exsection_path)
);

CREATE INDEX IF NOT EXISTS idx_concept_itembank_sections_concept
  ON concept_itembank_sections (concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_itembank_sections_course
  ON concept_itembank_sections (course_id);

ALTER TABLE concept_itembank_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "concept_itembank_sections_admin_all" ON concept_itembank_sections;
CREATE POLICY "concept_itembank_sections_admin_all" ON concept_itembank_sections
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );

DROP POLICY IF EXISTS "concept_itembank_sections_read_authenticated" ON concept_itembank_sections;
CREATE POLICY "concept_itembank_sections_read_authenticated" ON concept_itembank_sections
  FOR SELECT USING (auth.role() = 'authenticated');

-- 3. Expliciete RAG-koppeling concept ↔ primaire folder ----------------------
CREATE TABLE IF NOT EXISTS concept_rag_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (concept_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_rag_sources_concept
  ON concept_rag_sources (concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_rag_sources_course
  ON concept_rag_sources (course_id);

ALTER TABLE concept_rag_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "concept_rag_sources_admin_all" ON concept_rag_sources;
CREATE POLICY "concept_rag_sources_admin_all" ON concept_rag_sources
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );

DROP POLICY IF EXISTS "concept_rag_sources_read_authenticated" ON concept_rag_sources;
CREATE POLICY "concept_rag_sources_read_authenticated" ON concept_rag_sources
  FOR SELECT USING (auth.role() = 'authenticated');

-- 4. Bronnen-mix per cursus --------------------------------------------------
-- Drie gehele percentages tussen 0 en 100, samen 100. Server normaliseert
-- defensief mocht de som afwijken.
CREATE TABLE IF NOT EXISTS quiz_sources_mix (
  course_id uuid PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  pct_rag integer NOT NULL DEFAULT 50 CHECK (pct_rag BETWEEN 0 AND 100),
  pct_itembank integer NOT NULL DEFAULT 0 CHECK (pct_itembank BETWEEN 0 AND 100),
  pct_llm integer NOT NULL DEFAULT 50 CHECK (pct_llm BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE quiz_sources_mix ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quiz_sources_mix_admin_all" ON quiz_sources_mix;
CREATE POLICY "quiz_sources_mix_admin_all" ON quiz_sources_mix
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );

DROP POLICY IF EXISTS "quiz_sources_mix_read_authenticated" ON quiz_sources_mix;
CREATE POLICY "quiz_sources_mix_read_authenticated" ON quiz_sources_mix
  FOR SELECT USING (auth.role() = 'authenticated');
