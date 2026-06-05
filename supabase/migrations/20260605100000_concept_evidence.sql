/*
  # Concept ↔ bewijsfragment koppeling (Task #243)

  ## Overzicht
  Slaat per begrip de ondersteunende RAG-bronfragmenten op die tijdens de
  begripsextractie zijn gevonden. Zo krijgt de "Ik leg uit"-pagina een
  gegarandeerde basis-context uit het cursusmateriaal, onafhankelijk van
  module-activatie, drempel of query-instellingen.

  ## Tabel `concept_evidence`
  - `id` (uuid, pk)
  - `concept_id` (uuid, fk concepts ON DELETE CASCADE) — het begrip
  - `course_id` (uuid, fk courses ON DELETE CASCADE, nullable) — cursuscontext
  - `document_id` (uuid, fk documents ON DELETE CASCADE, nullable) — bron
  - `chunk_id` (uuid, nullable) — id van het document_chunk (kan verdwijnen bij re-ingestie)
  - `snippet` (text) — de fragmenttekst zelf, zodat de koppeling re-ingestie overleeft
  - `similarity` (real) — similarity-score bij extractie
  - `created_at` (timestamptz)

  ## Beveiliging
  - RLS aan; alle geauthenticeerde gebruikers mogen lezen (bron-referenties).
  - Schrijven gebeurt uitsluitend server-side via de service-role (bypasst RLS).
*/

CREATE TABLE IF NOT EXISTS concept_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id uuid,
  snippet text NOT NULL,
  similarity real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_concept_evidence_concept
  ON concept_evidence (concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_evidence_course
  ON concept_evidence (course_id);

ALTER TABLE concept_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "concept_evidence_read_authenticated" ON concept_evidence;
CREATE POLICY "concept_evidence_read_authenticated" ON concept_evidence
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "concept_evidence_admin_all" ON concept_evidence;
CREATE POLICY "concept_evidence_admin_all" ON concept_evidence
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );
