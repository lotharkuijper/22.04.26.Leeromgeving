-- Task #144: Ontkoppel de persona-bibliotheek van project_personas.
-- Verwijder de FK-constraint en de unieke index op source_persona_id zodat
-- bibliotheek-persona's volledig onafhankelijk zijn van project-kopieën.

-- 1. Verwijder de FK-constraint (aangemaakt door inline REFERENCES in 20260508120000).
ALTER TABLE project_personas
  DROP CONSTRAINT IF EXISTS project_personas_source_persona_id_fkey;

-- 2. Verwijder de unieke partiële index op (project_id, source_persona_id).
DROP INDEX IF EXISTS project_personas_unique_source_idx;

-- 3. Ruim specifieke test-persona op die nooit bedoeld was voor productie.
--    Exact matchen op naam om onbedoelde verwijderingen te voorkomen.
DELETE FROM course_personas
  WHERE name = 'Ambtenaar afdeling Welzijn Gemeente Amsterdam';
