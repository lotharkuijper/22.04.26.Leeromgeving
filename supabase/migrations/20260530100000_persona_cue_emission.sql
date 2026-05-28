-- Task #171 / Fase 3: cue-emissie aan/uit per persona.
-- Default `true` voor nieuwe rijen; bestaande evaluator-persona's worden
-- expliciet op `false` gezet zodat documentoordelen (Fase 1) en cues niet
-- dubbel meetellen. Bestaande conversational-rijen blijven default `true`.

BEGIN;

ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS cue_emission_enabled boolean NOT NULL DEFAULT true;

UPDATE project_personas
   SET cue_emission_enabled = false
 WHERE persona_type = 'evaluator';

COMMIT;
