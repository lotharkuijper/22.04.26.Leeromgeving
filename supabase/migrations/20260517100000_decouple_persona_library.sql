-- Task #144: Ontkoppel de persona-bibliotheek van project_personas.
-- Verwijder de FK-constraint en de unieke index op source_persona_id zodat
-- bibliotheek-persona's volledig onafhankelijk zijn van project-kopieën.

-- 1. Verwijder de FK-constraint (aangemaakt door inline REFERENCES in 20260508120000).
ALTER TABLE project_personas
  DROP CONSTRAINT IF EXISTS project_personas_source_persona_id_fkey;

-- 2. Verwijder de unieke partiële index op (project_id, source_persona_id).
DROP INDEX IF EXISTS project_personas_unique_source_idx;

-- 3. Ruim test-bibliotheek-persona's op die nooit bedoeld waren voor productie.
DELETE FROM course_personas
  WHERE name ILIKE '%Ambtenaar%Welzijn%';
