-- Task #351: nieuwe Studiecafé-categorie 'check-llm' ("Klopt dit wel?").
-- Studenten kunnen een AI-antwoord uit de chat ter controle in het Studiecafé
-- plaatsen. We breiden de CHECK op studiecafe_threads.category uit met 'check-llm'
-- (bestaande categorieën blijven ongewijzigd).
BEGIN;

ALTER TABLE studiecafe_threads
  DROP CONSTRAINT IF EXISTS studiecafe_threads_category_check;

ALTER TABLE studiecafe_threads
  ADD CONSTRAINT studiecafe_threads_category_check
  CHECK (category IN ('vraag', 'discussie', 'samenwerken', 'check-llm'));

COMMIT;
