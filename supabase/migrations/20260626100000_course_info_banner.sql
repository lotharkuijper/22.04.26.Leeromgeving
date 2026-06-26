-- Task: Cursus-banner. Docenten kunnen per cursus een sfeerafbeelding (banner)
-- instellen die studenten bovenaan het Dashboard bij de cursusinformatie zien.
-- De banner is een weergave-instelling op het bestaande course_info-blok: één
-- afbeelding per cursus, met positie (boven/onder/links/rechts/achtergrond),
-- vrij instelbare hoogte, doorzichtigheid (achtergrond-stand) en uitsnede.
-- De afbeelding zelf staat in de private bucket docs_general (pad in banner_path);
-- de server levert bij GET /info een kortlopende signed URL. Geen documents-rij.

BEGIN;

ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_path     text;
ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_position text     NOT NULL DEFAULT 'top';
ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_height   integer  NOT NULL DEFAULT 220;
ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_opacity  smallint NOT NULL DEFAULT 100;
ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_focal    text     NOT NULL DEFAULT 'center';
ALTER TABLE course_info ADD COLUMN IF NOT EXISTS banner_alt      text     NOT NULL DEFAULT '';

-- Idempotente CHECK-constraints (PG kent geen ADD CONSTRAINT IF NOT EXISTS).
DO $$ BEGIN
  ALTER TABLE course_info ADD CONSTRAINT course_info_banner_position_chk
    CHECK (banner_position IN ('top','bottom','left','right','background'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE course_info ADD CONSTRAINT course_info_banner_focal_chk
    CHECK (banner_focal IN ('top','center','bottom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE course_info ADD CONSTRAINT course_info_banner_height_chk
    CHECK (banner_height BETWEEN 80 AND 600);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE course_info ADD CONSTRAINT course_info_banner_opacity_chk
    CHECK (banner_opacity BETWEEN 10 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
