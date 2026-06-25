-- Task #385 — Verwijder overkoepelende onderwerp-labels.
-- LEAP-VU begon als epidemiologie/biostatistiek-tool: elk concept en elk topic
-- was hardgekoppeld aan een overkoepelend vak (`epidemiologie`/`biostatistiek`,
-- topics ook `algemeen`). Voor cursussen als DEB-learn is dat betekenisloos en
-- soms gewoon fout. We verwijderen de overkoepelende-vak-categorisatie:
--   * NOT NULL + CHECK op de category-kolommen vervalt (rijen mogen geen vak
--     meer hebben),
--   * bestaande waarden worden geblankt (NULL) zodat oude labels nergens meer
--     verschijnen.
-- De kolommen zelf blijven bestaan (nullable) voor veiligheid/omkeerbaarheid.

ALTER TABLE concepts ALTER COLUMN category DROP NOT NULL;
ALTER TABLE concepts DROP CONSTRAINT IF EXISTS concepts_category_check;
UPDATE concepts SET category = NULL WHERE category IS NOT NULL;

ALTER TABLE topics ALTER COLUMN category DROP NOT NULL;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_category_check;
UPDATE topics SET category = NULL WHERE category IS NOT NULL;
