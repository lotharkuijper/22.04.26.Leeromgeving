-- Task #110: Koppel bestaande zwevende Projectdata-mappen aan de globale root.
--
-- Een "zwevende" map is een map met:
--   • folder_type = 'data'
--   • name = 'Projectdata'
--   • parent_folder_id IS NULL
--   • is_root IS NOT TRUE
--
-- Aanpak (volledig conflict-safe):
--   1. Zoek de globale root-map (is_root = true).
--   2. Stel vast of er al een Projectdata-kind onder die root bestaat.
--   3. Voor elke zwevende map:
--        a. Als er nog GEEN Projectdata-kind onder root bestaat:
--           → update parent_folder_id naar de globale root (eerste map wordt de canonieke).
--        b. Als er al een Projectdata-kind onder root bestaat (de canonieke):
--           → reassign course_folder_assignments (per rij, conflict-safe).
--           → reassign directe documenten naar de canonieke map.
--           → per kind-map: als geen naamsconflict → reparent;
--               als wél naamsconflict → inhoud (docs + submappen) naar bestaande canonieke kind,
--               dan dubbele kind-map verwijderen.
--           → verwijder de dubbele Projectdata-map (CASCADE ruimt folder_permissions op).
--   4. Idempotent: mappen die al een parent hebben worden nooit aangeraakt.

DO $$
DECLARE
  v_root_id         uuid;
  v_canonical_id    uuid;
  v_folder          record;
  v_child           record;
  v_conflict_id     uuid;
  v_fixed           integer := 0;
  v_merged          integer := 0;
  v_children_moved  integer := 0;
BEGIN
  -- 1. Zoek de globale root-map.
  SELECT id INTO v_root_id
  FROM   document_folders
  WHERE  is_root = true
  LIMIT  1;

  IF v_root_id IS NULL THEN
    RAISE NOTICE 'Backfill overgeslagen: geen globale root-map (is_root=true) gevonden.';
    RETURN;
  END IF;

  -- 2. Stel vast of er al een canonieke Projectdata-map onder root bestaat.
  SELECT id INTO v_canonical_id
  FROM   document_folders
  WHERE  parent_folder_id = v_root_id
    AND  name             = 'Projectdata'
    AND  folder_type      = 'data'
  LIMIT  1;

  -- 3. Verwerk elke zwevende Projectdata-map.
  FOR v_folder IN (
    SELECT id
    FROM   document_folders
    WHERE  folder_type      = 'data'
      AND  name             = 'Projectdata'
      AND  parent_folder_id IS NULL
      AND  (is_root IS NULL OR is_root = false)
    ORDER  BY id
  ) LOOP

    IF v_canonical_id IS NULL THEN
      -- 3a. Nog geen canonieke map: deze wordt de canonieke.
      UPDATE document_folders
      SET    parent_folder_id = v_root_id
      WHERE  id = v_folder.id;

      v_canonical_id := v_folder.id;
      v_fixed := v_fixed + 1;
      RAISE NOTICE 'Map % als canonieke Projectdata-map onder root % geplaatst.',
        v_folder.id, v_root_id;

    ELSE
      -- 3b. Er bestaat al een canonieke map: merge v_folder daarin.

      -- Reassign course_folder_assignments per rij (conflict-safe via gecorreleerde alias).
      UPDATE course_folder_assignments AS cfa_old
      SET    folder_id = v_canonical_id
      WHERE  cfa_old.folder_id = v_folder.id
        AND  NOT EXISTS (
          SELECT 1 FROM course_folder_assignments cfa_new
          WHERE  cfa_new.folder_id = v_canonical_id
            AND  cfa_new.course_id = cfa_old.course_id
        );
      -- Echte duplicaten (canonieke had al die cursus): veilig verwijderen.
      DELETE FROM course_folder_assignments WHERE folder_id = v_folder.id;

      -- Reassign directe documenten die hangen aan de dubbele Projectdata-map zelf.
      UPDATE documents
      SET    folder_id = v_canonical_id
      WHERE  folder_id = v_folder.id;

      -- Reassign kind-mappen één voor één om naamsconflicten te detecteren.
      FOR v_child IN (
        SELECT id, name
        FROM   document_folders
        WHERE  parent_folder_id = v_folder.id
        ORDER  BY id
      ) LOOP
        -- Bestaat er al een kind met dezelfde naam onder de canonieke map?
        SELECT id INTO v_conflict_id
        FROM   document_folders
        WHERE  parent_folder_id = v_canonical_id
          AND  name             = v_child.name
        LIMIT  1;

        IF v_conflict_id IS NULL THEN
          -- Geen conflict: kind simpelweg reparenten.
          UPDATE document_folders
          SET    parent_folder_id = v_canonical_id
          WHERE  id = v_child.id;

          RAISE NOTICE 'Kind-map % ("%") verplaatst naar canonieke map %.',
            v_child.id, v_child.name, v_canonical_id;
        ELSE
          -- Naamsconflict: inhoud van v_child.id overnemen in v_conflict_id,
          -- daarna dubbele kind-map verwijderen.
          -- Documenten.
          UPDATE documents
          SET    folder_id = v_conflict_id
          WHERE  folder_id = v_child.id;

          -- Sub-submappen (dieper nesten): reparenten naar bestaande kind.
          UPDATE document_folders
          SET    parent_folder_id = v_conflict_id
          WHERE  parent_folder_id = v_child.id;

          -- Dubbele kind-map verwijderen (CASCADE ruimt folder_permissions op).
          DELETE FROM document_folders WHERE id = v_child.id;

          RAISE NOTICE 'Kind-map % ("%") samengevoegd met bestaande map % (naamsconflict).',
            v_child.id, v_child.name, v_conflict_id;
        END IF;

        v_children_moved := v_children_moved + 1;
      END LOOP;

      -- Verwijder de nu lege dubbele Projectdata-map (CASCADE verwijdert folder_permissions).
      DELETE FROM document_folders WHERE id = v_folder.id;

      v_merged := v_merged + 1;
      RAISE NOTICE 'Dubbele map % samengevoegd met canonieke map %.',
        v_folder.id, v_canonical_id;
    END IF;

  END LOOP;

  RAISE NOTICE 'Backfill klaar: % map(pen) gekoppeld aan root, % dubbele(n) samengevoegd, % kind-mappen verwerkt.',
    v_fixed, v_merged, v_children_moved;
END $$;
