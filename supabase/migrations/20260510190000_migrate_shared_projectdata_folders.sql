-- Task #83: Migreer gedeelde of wees-"Projectdata"-mappen zodat elke cursus
-- zijn eigen kopie krijgt.
--
-- Aanleiding: na task-82 maakt de code cursus-gebonden Projectdata-mappen aan,
-- maar bestaande "Projectdata"-mappen kunnen zijn:
--   a) gedeeld  — via course_folder_assignments gekoppeld aan >1 cursus
--   b) wees     — helemaal niet gekoppeld aan een cursus
-- Correct (1 cursus, 1 map) worden NIET aangeraakt.
--
-- Aanpak per kandidaat-map (gedeeld of wees):
--   Stap A — submap-herindeling
--     Voor elke submap met "projectId:<uuid>" in de description:
--       • Zoek de course_id van dat project.
--       • Zoek een bestaande cursus-eigen Projectdata (inclusief de huidige
--         map als die al de enige koppeling voor die cursus is).
--       • Maak er een aan als die niet bestaat.
--       • Verplaats de submap naar de cursus-eigen Projectdata (alleen als
--         dat een andere map is dan de huidige).
--       • Verwijder de koppeling van de gedeelde map naar die cursus ALLEEN
--         als er geen niet-herkende kinderen meer in de map zitten.
--   Stap B — document-herindeling
--     Voor documenten direct in de kandidaat-map (via document_ref_id):
--       • Zoek de cursus en verplaats naar de cursus-eigen Projectdata.
--   Stap C — opruimen
--     Verwijder de kandidaat-map als hij leeg is en elke gekoppelde cursus
--     een betere Projectdata heeft.

DO $$
DECLARE
  v_pd_folder         record;
  v_subfolder         record;
  v_doc               record;
  v_proj_course_id    uuid;
  v_doc_course_id     uuid;
  v_project_id_str    text;
  v_course_parent_id  uuid;
  v_existing_pd_id    uuid;
  v_new_pd_id         uuid;
  v_admin_id          uuid;
  v_stale_course_id   uuid;
  v_cfa_count         integer;
  v_unrecognised      integer;
BEGIN
  -- ============================================================
  -- Bepaal kandidaat-mappen: gedeeld (>1 cursus) of wees (0).
  -- ============================================================
  IF NOT EXISTS (
    SELECT 1
    FROM document_folders df
    WHERE df.name = 'Projectdata'
      AND df.folder_type = 'data'
      AND (
        -- gedeeld
        (SELECT COUNT(*) FROM course_folder_assignments c WHERE c.folder_id = df.id) > 1
        OR
        -- wees
        NOT EXISTS (SELECT 1 FROM course_folder_assignments c WHERE c.folder_id = df.id)
      )
  ) THEN
    RAISE NOTICE 'Geen gedeelde of wees Projectdata-mappen gevonden; migratie niet nodig.';
    RETURN;
  END IF;

  -- Zoek admin-gebruiker (alleen nodig als we daadwerkelijk iets aanmaken).
  SELECT id INTO v_admin_id
  FROM profiles
  WHERE role = 'admin' OR email = 'l.d.j.kuijper@vu.nl'
  ORDER BY (email = 'l.d.j.kuijper@vu.nl') DESC
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Geen admin-gebruiker gevonden; migratie afgebroken.';
  END IF;

  -- ============================================================
  -- Itereer over kandidaat-mappen (gedeeld of wees).
  -- ============================================================
  FOR v_pd_folder IN (
    SELECT df.id, df.name, df.parent_folder_id,
           (SELECT COUNT(*) FROM course_folder_assignments c WHERE c.folder_id = df.id) AS cfa_count
    FROM document_folders df
    WHERE df.name = 'Projectdata'
      AND df.folder_type = 'data'
      AND (
        (SELECT COUNT(*) FROM course_folder_assignments c WHERE c.folder_id = df.id) > 1
        OR
        NOT EXISTS (SELECT 1 FROM course_folder_assignments c WHERE c.folder_id = df.id)
      )
    ORDER BY df.id
  ) LOOP

    v_cfa_count := v_pd_folder.cfa_count;
    RAISE NOTICE '=== Kandidaat Projectdata-map: % (% cursus-koppelingen) ===',
      v_pd_folder.id, v_cfa_count;

    -- --------------------------------------------------------
    -- Stap A: project-submappen herindelen
    -- --------------------------------------------------------
    FOR v_subfolder IN (
      SELECT df.id, df.description, df.name
      FROM document_folders df
      WHERE df.parent_folder_id = v_pd_folder.id
      ORDER BY df.id
    ) LOOP

      v_project_id_str := substring(v_subfolder.description FROM 'projectId:([a-f0-9\-]{36})');
      IF v_project_id_str IS NULL THEN
        RAISE NOTICE '  submap %: geen projectId-marker, sla over', v_subfolder.id;
        CONTINUE;
      END IF;

      -- Sla over als de geëxtraheerde string geen geldig UUID-formaat heeft
      -- (voorkomt een afbrekende cast-fout op vervuilde legacy descriptions).
      IF v_project_id_str !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE NOTICE '  submap %: geëxtraheerde projectId "%" is geen geldig UUID, sla over',
          v_subfolder.id, v_project_id_str;
        CONTINUE;
      END IF;

      SELECT course_id INTO v_proj_course_id
      FROM projects
      WHERE id = v_project_id_str::uuid;

      IF v_proj_course_id IS NULL THEN
        RAISE NOTICE '  submap %: project % heeft geen course_id, sla over',
          v_subfolder.id, v_project_id_str;
        CONTINUE;
      END IF;

      -- Zoek een bestaande cursus-eigen Projectdata. De huidige map telt mee
      -- als geldige bestemming ALLEEN als de kandidaat-map al de enige
      -- koppeling voor deze cursus is (= map is wees of single-course voor
      -- deze cursus; in dat geval is er niks te verplaatsen).
      SELECT df.id INTO v_existing_pd_id
      FROM document_folders df
      JOIN course_folder_assignments cfa ON cfa.folder_id = df.id
      WHERE df.name = 'Projectdata'
        AND cfa.course_id = v_proj_course_id
      LIMIT 1;

      IF v_existing_pd_id = v_pd_folder.id THEN
        -- De gedeelde/wees-map is al de enige Projectdata voor deze cursus.
        -- Als de map gedeeld is, moeten we toch een aparte map aanmaken.
        IF v_cfa_count > 1 THEN
          -- Gedeelde map: maak een cursus-eigen Projectdata aan.
          v_existing_pd_id := NULL; -- forceer aanmaken
        ELSE
          -- Wees-map met al een koppeling (zou niet moeten, maar defensief):
          -- submap staat al op de juiste plek.
          RAISE NOTICE '  submap %: al correct in wees-map (enige koppeling voor cursus %), sla over',
            v_subfolder.id, v_proj_course_id;
          CONTINUE;
        END IF;
      END IF;

      IF v_existing_pd_id IS NOT NULL THEN
        v_new_pd_id := v_existing_pd_id;
        RAISE NOTICE '  submap %: bestaande cursus-Projectdata % voor cursus %',
          v_subfolder.id, v_new_pd_id, v_proj_course_id;
      ELSE
        -- Maak een nieuwe cursus-eigen Projectdata aan.
        SELECT cfa.folder_id INTO v_course_parent_id
        FROM course_folder_assignments cfa
        JOIN document_folders df2 ON df2.id = cfa.folder_id
        WHERE cfa.course_id = v_proj_course_id
          AND df2.folder_type IN ('course', 'general')
          AND df2.name != 'Projectdata'
        LIMIT 1;

        -- Subtree-check: bestaat er al een Projectdata als kind van de parent?
        IF v_course_parent_id IS NOT NULL THEN
          SELECT df.id INTO v_existing_pd_id
          FROM document_folders df
          WHERE df.name = 'Projectdata'
            AND df.parent_folder_id = v_course_parent_id
            AND df.id != v_pd_folder.id
          LIMIT 1;
        END IF;

        IF v_existing_pd_id IS NOT NULL THEN
          v_new_pd_id := v_existing_pd_id;
          INSERT INTO course_folder_assignments (course_id, folder_id)
          VALUES (v_proj_course_id, v_new_pd_id)
          ON CONFLICT DO NOTHING;
          RAISE NOTICE '  Hergebruik ontkoppelde Projectdata % voor cursus %',
            v_new_pd_id, v_proj_course_id;
        ELSE
          INSERT INTO document_folders
            (name, description, parent_folder_id, created_by, folder_type, is_root)
          VALUES
            ('Projectdata', 'Projectdata — bestanden per project',
             v_course_parent_id, v_admin_id, 'data', false)
          RETURNING id INTO v_new_pd_id;

          INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
          VALUES
            (v_new_pd_id, 'admin',   true, true),
            (v_new_pd_id, 'docent',  true, true),
            (v_new_pd_id, 'student', true, false)
          ON CONFLICT DO NOTHING;

          INSERT INTO course_folder_assignments (course_id, folder_id)
          VALUES (v_proj_course_id, v_new_pd_id)
          ON CONFLICT DO NOTHING;

          RAISE NOTICE '  Nieuwe Projectdata % aangemaakt (parent %) voor cursus %',
            v_new_pd_id, v_course_parent_id, v_proj_course_id;
        END IF;
      END IF;

      -- Verplaats de submap naar de cursus-eigen Projectdata.
      IF v_new_pd_id != v_pd_folder.id THEN
        UPDATE document_folders
        SET parent_folder_id = v_new_pd_id
        WHERE id = v_subfolder.id;
        RAISE NOTICE '  Submap % ("%") verplaatst → %',
          v_subfolder.id, v_subfolder.name, v_new_pd_id;
      END IF;

      -- Verwijder de koppeling van de gedeelde map naar deze cursus ALLEEN
      -- als er daarna geen niet-herkende kinderen in de map overblijven die
      -- nog tot deze cursus zouden kunnen behoren (voorzichtigheidsprincipe).
      SELECT COUNT(*) INTO v_unrecognised
      FROM document_folders df
      WHERE df.parent_folder_id = v_pd_folder.id
        AND (df.description IS NULL OR df.description NOT LIKE '%projectId:%');

      IF v_cfa_count > 1 AND v_unrecognised = 0 THEN
        DELETE FROM course_folder_assignments
        WHERE folder_id = v_pd_folder.id
          AND course_id = v_proj_course_id;
        RAISE NOTICE '  Koppeling cursus % → gedeelde map % verwijderd',
          v_proj_course_id, v_pd_folder.id;
      ELSIF v_cfa_count > 1 THEN
        RAISE NOTICE '  Koppeling cursus % → gedeelde map % behouden (%  niet-herkende kinderen)',
          v_proj_course_id, v_pd_folder.id, v_unrecognised;
      END IF;

    END LOOP; -- einde subfolders

    -- --------------------------------------------------------
    -- Stap B: documenten direct in de kandidaat-map herindelen
    -- --------------------------------------------------------
    FOR v_doc IN (
      SELECT d.id
      FROM documents d
      WHERE d.folder_id = v_pd_folder.id
      ORDER BY d.id
    ) LOOP

      SELECT p.course_id INTO v_doc_course_id
      FROM project_documents pd
      JOIN projects p ON p.id = pd.project_id
      WHERE pd.document_ref_id = v_doc.id
      LIMIT 1;

      IF v_doc_course_id IS NULL THEN
        RAISE NOTICE '  document %: geen project/cursus gevonden, sla over', v_doc.id;
        CONTINUE;
      END IF;

      -- Zoek cursus-eigen Projectdata (huidige map telt alleen mee als
      -- de kandidaat wees is EN alleen aan deze cursus gekoppeld is — maar
      -- dan is er niets te verplaatsen).
      SELECT df.id INTO v_existing_pd_id
      FROM document_folders df
      JOIN course_folder_assignments cfa ON cfa.folder_id = df.id
      WHERE df.name = 'Projectdata'
        AND cfa.course_id = v_doc_course_id
        AND (df.id != v_pd_folder.id OR v_cfa_count = 1)
      LIMIT 1;

      IF v_existing_pd_id IS NOT NULL AND v_existing_pd_id != v_pd_folder.id THEN
        UPDATE documents SET folder_id = v_existing_pd_id WHERE id = v_doc.id;
        RAISE NOTICE '  document % → cursus-Projectdata %', v_doc.id, v_existing_pd_id;
      ELSIF v_existing_pd_id IS NULL THEN
        -- Maak cursus-Projectdata aan.
        SELECT cfa.folder_id INTO v_course_parent_id
        FROM course_folder_assignments cfa
        JOIN document_folders df2 ON df2.id = cfa.folder_id
        WHERE cfa.course_id = v_doc_course_id
          AND df2.folder_type IN ('course', 'general')
          AND df2.name != 'Projectdata'
        LIMIT 1;

        INSERT INTO document_folders
          (name, description, parent_folder_id, created_by, folder_type, is_root)
        VALUES
          ('Projectdata', 'Projectdata — bestanden per project',
           v_course_parent_id, v_admin_id, 'data', false)
        RETURNING id INTO v_new_pd_id;

        INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
        VALUES
          (v_new_pd_id, 'admin',   true, true),
          (v_new_pd_id, 'docent',  true, true),
          (v_new_pd_id, 'student', true, false)
        ON CONFLICT DO NOTHING;

        INSERT INTO course_folder_assignments (course_id, folder_id)
        VALUES (v_doc_course_id, v_new_pd_id)
        ON CONFLICT DO NOTHING;

        UPDATE documents SET folder_id = v_new_pd_id WHERE id = v_doc.id;
        RAISE NOTICE '  document % → nieuwe cursus-Projectdata % (cursus %)',
          v_doc.id, v_new_pd_id, v_doc_course_id;

        -- Verwijder stale koppeling voor gedeelde map als er geen
        -- niet-herkende kinderen meer zijn.
        IF v_cfa_count > 1 THEN
          SELECT COUNT(*) INTO v_unrecognised
          FROM document_folders df
          WHERE df.parent_folder_id = v_pd_folder.id
            AND (df.description IS NULL OR df.description NOT LIKE '%projectId:%');

          IF v_unrecognised = 0 THEN
            DELETE FROM course_folder_assignments
            WHERE folder_id = v_pd_folder.id AND course_id = v_doc_course_id;
            RAISE NOTICE '  Koppeling cursus % → gedeelde map % verwijderd',
              v_doc_course_id, v_pd_folder.id;
          END IF;
        END IF;
      ELSE
        RAISE NOTICE '  document %: al correct in deze map (wees, enige koppeling), sla over', v_doc.id;
      END IF;

    END LOOP; -- einde documenten

    -- --------------------------------------------------------
    -- Stap C: opruimen van lege kandidaat-mappen
    -- --------------------------------------------------------
    IF NOT EXISTS (
      SELECT 1 FROM document_folders WHERE parent_folder_id = v_pd_folder.id
    ) AND NOT EXISTS (
      SELECT 1 FROM documents WHERE folder_id = v_pd_folder.id
    ) THEN
      -- Map is leeg. Verwijder koppelingen voor cursussen met een betere
      -- eigen Projectdata.
      FOR v_stale_course_id IN (
        SELECT course_id
        FROM course_folder_assignments
        WHERE folder_id = v_pd_folder.id
      ) LOOP
        IF EXISTS (
          SELECT 1
          FROM document_folders df
          JOIN course_folder_assignments cfa2 ON cfa2.folder_id = df.id
          WHERE df.name = 'Projectdata'
            AND cfa2.course_id = v_stale_course_id
            AND df.id != v_pd_folder.id
        ) THEN
          DELETE FROM course_folder_assignments
          WHERE folder_id = v_pd_folder.id AND course_id = v_stale_course_id;
          RAISE NOTICE '  Stale koppeling cursus % → lege map % verwijderd',
            v_stale_course_id, v_pd_folder.id;
        END IF;
      END LOOP;

      IF NOT EXISTS (
        SELECT 1 FROM course_folder_assignments WHERE folder_id = v_pd_folder.id
      ) THEN
        DELETE FROM document_folders WHERE id = v_pd_folder.id;
        RAISE NOTICE 'Lege gedeelde Projectdata-map % verwijderd.', v_pd_folder.id;
      ELSE
        RAISE NOTICE 'Lege map % is enige Projectdata voor resterende cursus(sen); behouden.',
          v_pd_folder.id;
      END IF;

    ELSE
      -- Map is nog niet volledig leeg na migratie.
      IF (SELECT COUNT(*) FROM course_folder_assignments WHERE folder_id = v_pd_folder.id) > 1 THEN
        RAISE WARNING
          'Projectdata-map % is na migratie nog gekoppeld aan meerdere cursussen en '
          'bevat niet-gemigreerde inhoud; handmatige controle aanbevolen.',
          v_pd_folder.id;
      END IF;
    END IF;

  END LOOP; -- einde kandidaat-mappen

  RAISE NOTICE 'Migratie task-83 voltooid.';
END $$;

-- ============================================================
-- Post-migratie audit: controleer de eindtoestand.
-- Voer dit blok handmatig uit na de migratie om te valideren.
-- ============================================================

-- 1) Gedeelde Projectdata-mappen: mogen geen rijen opleveren.
-- SELECT df.id, df.name, COUNT(cfa.course_id) AS cursus_koppelingen
-- FROM document_folders df
-- JOIN course_folder_assignments cfa ON cfa.folder_id = df.id
-- WHERE df.name = 'Projectdata'
-- GROUP BY df.id, df.name
-- HAVING COUNT(cfa.course_id) > 1;

-- 2) Wees Projectdata-mappen: mogen geen rijen opleveren.
-- SELECT df.id, df.name
-- FROM document_folders df
-- WHERE df.name = 'Projectdata'
--   AND df.folder_type = 'data'
--   AND NOT EXISTS (SELECT 1 FROM course_folder_assignments c WHERE c.folder_id = df.id);

-- 3) Binaire project-documenten buiten een cursus-subtree:
--    document_ref_id-docs waarvan folder_id naar een root-loze Projectdata wijst.
-- SELECT pd.id, pd.project_id, d.folder_id, df.name, df.parent_folder_id
-- FROM project_documents pd
-- JOIN documents d ON d.id = pd.document_ref_id
-- JOIN document_folders df ON df.id = d.folder_id
-- WHERE df.parent_folder_id IS NULL
--   AND df.name = 'Projectdata';

