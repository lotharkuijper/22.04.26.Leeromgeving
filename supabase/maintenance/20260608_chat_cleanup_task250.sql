-- Task #250 — Chat verwijderen & cursus opschonen (eenmalige data-opschoning)
--
-- Dit is GEEN schema-migratie maar een eenmalige, auditbare data-runbook.
-- Reeds uitgevoerd door de agent tegen Supabase via SUPABASE_DB_URL (session
-- pooler, poort 5432) op 2026-06-08. Bewaard voor traceerbaarheid.
--
-- Context: door de Task #246-backfill kreeg elke historische conversatie
-- course_id = MenS1 (dbb59936-d4cc-43ce-b1cc-15afa963930d). "Verwijderen" was
-- tot Task #250 een soft-delete (status='archived'). Vanaf Task #250 verwijdert
-- de chat-route definitief; deze runbook ruimt de achtergebleven archief-rijen
-- op en herstelt twee verkeerd toegewezen actieve chats.

-- =====================================================================
-- STAP 2 — Bestaande gearchiveerde chats definitief verwijderen
-- =====================================================================
-- Vooraf (telling vóór verwijdering):
--   conversations: active=6, archived=40
--   berichten in gearchiveerde conversaties: 232 (verdwijnen via ON DELETE CASCADE)
--
-- Verwijder-statement (idempotent: een tweede run verwijdert 0 rijen):
WITH del AS (
  DELETE FROM conversations
  WHERE status = 'archived'
  RETURNING id
)
SELECT count(*) AS deleted_conversations FROM del;
-- Resultaat van de uitgevoerde run: deleted_conversations = 40
--
-- Achteraf (telling ná verwijdering): conversations active=6, archived=0

-- =====================================================================
-- STAP 3 — Verkeerd toegewezen actieve chats naar de juiste cursus
-- =====================================================================
-- Door de gebruiker bevestigde correcties (overige 4 actieve chats blijven
-- terecht onder MenS1):
--   - "Ik wil graag meer leren over mediatieanalyse, want..." (5 jun)
--       d64791c5-4d1f-40e2-8c32-8da820175c76  ->  Statistical Inference
--       (9485d5c9-e0b8-47b1-9d13-452e8518f5ad)
--   - "Ik zou graag willen weten wat de grondbeginselen v..." (7 jun)
--       70acd4f2-bee4-4858-a317-0d121e96bdd9  ->  Dynamic Energy Budget Models
--       (481a664f-5ca5-4cc5-aa00-3e3d93f93565)

UPDATE conversations
SET course_id = (SELECT id FROM courses WHERE name = 'Statistical Inference')
WHERE id = 'd64791c5-4d1f-40e2-8c32-8da820175c76';

UPDATE conversations
SET course_id = (SELECT id FROM courses WHERE name = 'Dynamic Energy Budget Models')
WHERE id = '70acd4f2-bee4-4858-a317-0d121e96bdd9';

-- =====================================================================
-- VERIFICATIE (uitgevoerd, resultaat hieronder)
-- =====================================================================
-- SELECT cv.title, co.name AS course
-- FROM conversations cv
-- LEFT JOIN courses co ON co.id = cv.course_id
-- WHERE cv.status = 'active' AND cv.module_type = 'general'
-- ORDER BY cv.created_at;
--
--                         title                         |            course
-- -------------------------------------------------------+------------------------------
--  Nieuwe conversatie                                    | MenS1
--  Hoi Chat.                                             | MenS1
--  wat is regressie                                      | MenS1
--  Ik wil graag meer leren over mediatieanalyse, want... | Statistical Inference
--  Ik zou graag willen weten wat de grondbeginselen v... | Dynamic Energy Budget Models
--  Ik begrijp de Poissonverdeling nog niet goed. Gebe... | MenS1
