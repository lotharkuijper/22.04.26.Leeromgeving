-- Task #351: bijlagen (citaten) op Studiecafé-threads en -replies.
-- Een bijlage is een JSON-array met geciteerde fragmenten, bijv. een AI-antwoord
-- uit de chat (markdown + KaTeX + bronvermeldingen). Bewust een jsonb-kolom met
-- DEFAULT '[]' zodat bestaande rijen en oude clients (die het veld niet sturen)
-- defensief blijven werken. Vorm per item wordt server-side gevalideerd
-- (sanitizeAttachments in server/studiecafe.js).
BEGIN;

ALTER TABLE studiecafe_threads
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE studiecafe_replies
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
