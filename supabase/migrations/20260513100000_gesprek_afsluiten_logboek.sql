-- Task #129: Gesprek afsluiten + Gesprekslogboek
-- Breidt group_persona_threads uit met afsluitingsinformatie zodat studenten
-- gesprekken écht kunnen afsluiten en er een gesprekslogboek per groep ontstaat.
--
-- Kernverandering: de bestaande UNIQUE(group_id, persona_id) constraint wordt
-- vervangen door een partiële unieke index die alleen voor OPEN threads geldt.
-- Zo kunnen meerdere gesloten threads per groep+persona bestaan, maar is er
-- altijd hoogstens één open thread tegelijk.

-- 1. Verwijder de bestaande unieke constraint.
ALTER TABLE group_persona_threads
  DROP CONSTRAINT IF EXISTS group_persona_threads_group_id_persona_id_key;

-- 2. Voeg afsluiting-kolommen toe.
ALTER TABLE group_persona_threads
  ADD COLUMN IF NOT EXISTS closed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS topics      text[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS agreements  text[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS closing_summary text;

-- 3. Partiële unieke index: hoogstens één open thread per groep+persona.
CREATE UNIQUE INDEX IF NOT EXISTS group_persona_threads_open_unique
  ON group_persona_threads(group_id, persona_id)
  WHERE closed_at IS NULL;

-- 4. Index voor het snel ophalen van het gesprekslogboek (gesloten threads).
CREATE INDEX IF NOT EXISTS group_persona_threads_closed_idx
  ON group_persona_threads(group_id, closed_at DESC)
  WHERE closed_at IS NOT NULL;
