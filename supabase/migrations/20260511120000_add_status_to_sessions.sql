-- Voeg status en completed_at toe aan student_project_sessions.
-- De server-code (task #106) gebruikt deze kolommen al, maar ze ontbraken
-- nog in het DB-schema — waardoor sessie-upserts stil faalden en
-- "Vervolg laatste sessie" na een checkpoint verdween.

ALTER TABLE student_project_sessions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_progress',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Backfill: rijen met completed=true krijgen status='completed'.
UPDATE student_project_sessions
  SET status = 'completed'
  WHERE completed = true AND status = 'in_progress';

-- Voeg unieke index toe op (student_id, project_id) zodat de onConflict
-- in PostgREST/Supabase correct werkt.
-- De bestaande constraint heet student_project_sessions_project_id_student_id_key
-- en dekt (project_id, student_id); die blijft geldig.
-- Geen nieuwe index nodig — de bestaande unieke constraint volstaat.
