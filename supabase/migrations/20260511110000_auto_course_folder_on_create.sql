-- Task #111: Koppel cursussen automatisch aan een map bij aanmaken.
--
-- Twee onderdelen:
--   A) Trigger: na elke INSERT op `courses` wordt automatisch
--      - een document_folders-rij aangemaakt (folder_type='course')
--      - een course_folder_assignments-rij aangemaakt
--      - standaard folder_permissions ingesteld (admin/docent: edit, student: view)
--
--   B) Backfill: bestaande cursussen zonder een 'course'-map krijgen
--      alsnog een eigen cursusmap + assignment.
--
-- Idempotent: de trigger-functie en de backfill controleren beide of een
-- course-type toewijzing al bestaat voordat ze iets aanmaken.

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Trigger-functie + trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auto_create_course_folder()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_folder_id uuid;
BEGIN
  -- Maak een cursusmap aan met folder_type='course'.
  INSERT INTO public.document_folders (name, description, folder_type, is_root)
  VALUES (
    NEW.name,
    'Cursusmap voor ' || NEW.name,
    'course',
    false
  )
  RETURNING id INTO v_folder_id;

  -- Koppel de map aan de cursus.
  INSERT INTO public.course_folder_assignments (course_id, folder_id)
  VALUES (NEW.id, v_folder_id)
  ON CONFLICT DO NOTHING;

  -- Stel standaardrechten in: admin en docent mogen bewerken; student mag lezen.
  INSERT INTO public.folder_permissions (folder_id, role, can_view, can_edit)
  VALUES
    (v_folder_id, 'admin',   true, true),
    (v_folder_id, 'docent',  true, true),
    (v_folder_id, 'student', true, false)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- Verwijder de trigger als die al bestaat (idempotent bij re-run).
DROP TRIGGER IF EXISTS trg_auto_create_course_folder ON public.courses;

CREATE TRIGGER trg_auto_create_course_folder
  AFTER INSERT ON public.courses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_create_course_folder();

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Backfill: bestaande cursussen zonder cursusmap
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_course   record;
  v_folder_id uuid;
  v_backfilled integer := 0;
BEGIN
  FOR v_course IN (
    -- Cursussen die GEEN course_folder_assignments-rij hebben die wijst naar
    -- een map met folder_type = 'course'.
    SELECT c.id, c.name
    FROM   public.courses c
    WHERE  NOT EXISTS (
      SELECT 1
      FROM   public.course_folder_assignments cfa
      JOIN   public.document_folders df ON df.id = cfa.folder_id
      WHERE  cfa.course_id = c.id
        AND  df.folder_type = 'course'
    )
    ORDER  BY c.name
  ) LOOP
    -- Maak een cursusmap aan.
    INSERT INTO public.document_folders (name, description, folder_type, is_root)
    VALUES (
      v_course.name,
      'Cursusmap voor ' || v_course.name,
      'course',
      false
    )
    RETURNING id INTO v_folder_id;

    -- Koppel de map aan de cursus.
    INSERT INTO public.course_folder_assignments (course_id, folder_id)
    VALUES (v_course.id, v_folder_id)
    ON CONFLICT DO NOTHING;

    -- Standaardrechten.
    INSERT INTO public.folder_permissions (folder_id, role, can_view, can_edit)
    VALUES
      (v_folder_id, 'admin',   true, true),
      (v_folder_id, 'docent',  true, true),
      (v_folder_id, 'student', true, false)
    ON CONFLICT DO NOTHING;

    v_backfilled := v_backfilled + 1;
    RAISE NOTICE 'Cursusmap aangemaakt voor cursus "%" (id=%): folder_id=%',
      v_course.name, v_course.id, v_folder_id;
  END LOOP;

  RAISE NOTICE 'Backfill klaar: % cursus(sen) van een eigen map voorzien.', v_backfilled;
END $$;
