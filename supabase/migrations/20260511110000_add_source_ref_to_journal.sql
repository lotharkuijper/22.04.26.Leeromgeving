-- Voeg source_ref toe aan learning_journal_entries zodat checkpoints
-- idempotent kunnen worden ingevoegd (deduplicatie via unieke partial index).
ALTER TABLE learning_journal_entries
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

-- Unieke partial index: voorkomt dat hetzelfde checkpoint-evenement
-- meerdere keren wordt opgeslagen voor dezelfde gebruiker.
CREATE UNIQUE INDEX IF NOT EXISTS learning_journal_entries_source_ref_user_idx
  ON learning_journal_entries (user_id, source_ref)
  WHERE source_ref IS NOT NULL;
