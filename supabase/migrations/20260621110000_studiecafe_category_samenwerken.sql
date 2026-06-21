-- Task #304: vervang de Studiecafé-categorie 'tip' door 'samenwerken'.
-- Design D (optie D) gebruikt de chips Vragen · Discussie · Samenwerken (+
-- Aankondigingen-filter). De oorspronkelijke CHECK liet ('vraag','discussie','tip')
-- toe; we migreren bestaande 'tip'-rijen naar 'samenwerken' en herzetten de CHECK.
BEGIN;

ALTER TABLE studiecafe_threads
  DROP CONSTRAINT IF EXISTS studiecafe_threads_category_check;

UPDATE studiecafe_threads SET category = 'samenwerken' WHERE category = 'tip';

ALTER TABLE studiecafe_threads
  ADD CONSTRAINT studiecafe_threads_category_check
  CHECK (category IN ('vraag', 'discussie', 'samenwerken'));

COMMIT;
