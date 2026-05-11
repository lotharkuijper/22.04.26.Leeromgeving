-- Task #92: Voeg projectId:<uuid>-marker toe aan Projectdata-submappen die
-- vóór de marker-conventie zijn aangemaakt (d.w.z. description bevat GEEN
-- "projectId:"-tekst).
--
-- Aanpak:
--   • Zoek elke submap van een "Projectdata"-map zonder "projectId:" in description.
--   • Match op mapnaam ↔ projecttitel (case-insensitive, getrimmed).
--   • Als precies één project matcht: update de description en log de wijziging.
--   • Als nul of meer-dan-één project matcht: sla over en log een waarschuwing.
--   • Idempotent: mappen die al de marker bevatten worden nooit aangeraakt.

DO $$
DECLARE
  v_subfolder       record;
  v_match_count     integer;
  v_project_id      uuid;
  v_project_title   text;
  v_old_desc        text;
  v_new_desc        text;
  v_fixed           integer := 0;
  v_skipped_noMatch integer := 0;
  v_skipped_multi   integer := 0;
BEGIN
  FOR v_subfolder IN (
    SELECT df.id, df.name, df.description, df.parent_folder_id
    FROM   document_folders df
    JOIN   document_folders pd ON pd.id = df.parent_folder_id
    WHERE  pd.name        = 'Projectdata'
      AND  pd.folder_type = 'data'
      AND  (df.description IS NULL OR df.description NOT LIKE '%projectId:%')
    ORDER  BY df.id
  ) LOOP

    -- Tel hoeveel actieve projecten exact deze naam dragen (na trim).
    SELECT COUNT(*), MAX(id), MAX(title)
    INTO   v_match_count, v_project_id, v_project_title
    FROM   projects
    WHERE  lower(trim(title)) = lower(trim(v_subfolder.name));

    IF v_match_count = 0 THEN
      RAISE NOTICE 'Submap % ("%"): geen overeenkomend project gevonden – overgeslagen.',
        v_subfolder.id, v_subfolder.name;
      v_skipped_noMatch := v_skipped_noMatch + 1;
      CONTINUE;
    END IF;

    IF v_match_count > 1 THEN
      RAISE NOTICE 'Submap % ("%"): % projecten matchen op naam – overgeslagen (ambigue).',
        v_subfolder.id, v_subfolder.name, v_match_count;
      v_skipped_multi := v_skipped_multi + 1;
      CONTINUE;
    END IF;

    -- Precies één match: voeg marker toe.
    v_old_desc := coalesce(v_subfolder.description, '');
    IF v_old_desc = '' THEN
      v_new_desc := 'Projectbestanden — projectId:' || v_project_id;
    ELSE
      v_new_desc := v_old_desc || ' projectId:' || v_project_id;
    END IF;

    UPDATE document_folders
    SET    description = v_new_desc
    WHERE  id = v_subfolder.id;

    RAISE NOTICE 'Submap % ("%") ← projectId:% toegevoegd (project: "%").',
      v_subfolder.id, v_subfolder.name, v_project_id, v_project_title;
    v_fixed := v_fixed + 1;

  END LOOP;

  RAISE NOTICE 'Klaar: % submap(pen) bijgewerkt, % overgeslagen (geen match), % overgeslagen (meerdere matches).',
    v_fixed, v_skipped_noMatch, v_skipped_multi;
END $$;
