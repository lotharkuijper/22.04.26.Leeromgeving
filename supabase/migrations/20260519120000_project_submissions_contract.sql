-- Task #156 contract-alignment: file_bytes NOT NULL, byte_size integer NOT NULL.
-- Eventuele bestaande rijen zonder bytes worden opgeschoond (er waren er nog
-- geen in productie tijdens de eerste deploy; deze migratie is defensief).

BEGIN;

DELETE FROM project_submissions WHERE file_bytes IS NULL;

ALTER TABLE project_submissions
  ALTER COLUMN file_bytes SET NOT NULL;

-- byte_size: bigint -> integer, NOT NULL, geen default (server zet hem altijd).
ALTER TABLE project_submissions
  ALTER COLUMN byte_size DROP DEFAULT,
  ALTER COLUMN byte_size TYPE integer USING LEAST(byte_size, 2147483647)::integer,
  ALTER COLUMN byte_size SET NOT NULL;

COMMIT;
