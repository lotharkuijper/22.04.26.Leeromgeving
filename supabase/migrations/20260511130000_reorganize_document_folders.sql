-- Migratie: herstructureer document_folders naar consistente cursus-boom
-- Doel: Root → [CourseName] → {RAG (folder_type='rag_sources'), Projectdata (folder_type='data')}
--
-- Huidige warboel:
--   - 3 is_root rijen (Bestandenomgeving + 2 lege "Documenten")
--   - 4 wees-mappen zonder parent: __test_trigger__, Basiscursus(69ab9722),
--     MenS1(e37814df), RAG-MenS1(b8d4e0b1) — laatste heeft 4 RAG-docs
--   - Basiscursus(74747685) heeft lege submappen: Data, Overige, RAG, Rollen
-- Doelstructuur:
--   Bestandenomgeving (root)
--   ├── Basiscursus/
--   │   ├── RAG/          (folder_type='rag_sources')
--   │   └── Projectdata/  (folder_type='data')
--   └── MenS1/
--       ├── RAG/          (folder_type='rag_sources')  ← 4 docs hiernaartoe
--       └── Projectdata/  (folder_type='data')
--           ├── Project Waterlandpleinbuurt Amsterdam/
--           └── Welzijn in Waterlandpleinbuurt/

DO $$
DECLARE
  v_root_id            UUID := '7a6109e6-9a8d-4e6d-980d-ffd1bbb293d5'; -- Bestandenomgeving
  v_basiscursus_id     UUID := '74747685-3632-4066-be61-95bb3e393c0a'; -- Basiscursus (exists under root)
  v_old_projectdata_id UUID := '89cad06a-2c42-40c2-9c3a-377aa0450c15'; -- Projectdata met project-submappen
  v_old_rag_id         UUID := 'ea70ae1e-f3a9-4eb1-9771-b886a3ed6d30'; -- lege RAG onder Basiscursus
  v_rag_mens1_id       UUID := 'b8d4e0b1-6070-4aea-bbc8-e10e836d9fa2'; -- wees RAG-MenS1 met 4 docs
  v_course_mens1       UUID := 'dbb59936-d4cc-43ce-b1cc-15afa963930d';
  v_course_basiscursus UUID := '1442a4a5-26f8-4267-ab6e-1f8628c5e508';
  v_mens1_folder_id          UUID;
  v_mens1_rag_id             UUID;
  v_basiscursus_rag_id       UUID;
  v_basiscursus_projectdata_id UUID;
BEGIN

  -- ── Stap 1: verwijder de twee lege "Documenten" root-mappen ──────────────
  DELETE FROM document_folders WHERE id IN (
    'f47a208f-1539-41af-b1c1-efa2f8abbcb9',
    '1b9c6a0f-a263-47c4-baad-37c195473205'
  );

  -- ── Stap 2: verwijder __test_trigger__ (leeg, geen documenten) ──────────
  DELETE FROM document_folders WHERE id = '3c8db07f-4620-4d74-814a-dd8d2b4b9997';

  -- ── Stap 3: verwijder wees-Basiscursus (69ab9722) ────────────────────────
  DELETE FROM course_folder_assignments WHERE folder_id = '69ab9722-258e-461f-9331-9e71e793c001';
  DELETE FROM document_folders          WHERE id        = '69ab9722-258e-461f-9331-9e71e793c001';

  -- ── Stap 4: verwijder lege submappen van Basiscursus (74747685) ──────────
  --    Data (8ed05ca4), Overige (54aa61ba), Rollen (554a5d05)
  DELETE FROM document_folders WHERE id IN (
    '8ed05ca4-0429-4277-8122-50d1ffee1a38',
    '54aa61ba-b8bd-4ed6-87b0-ca55c9d1d1f3',
    '554a5d05-a0ab-4214-bd9a-795c39ea69d3'
  );

  -- ── Stap 5: verwijder de lege RAG-map (ea70ae1e) onder Basiscursus ───────
  --    (rag_assignments worden door ON DELETE CASCADE meegenomen)
  DELETE FROM document_folders WHERE id = v_old_rag_id;

  -- ── Stap 6: maak MenS1-map aan onder Bestandenomgeving ───────────────────
  INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root)
  VALUES ('MenS1', 'Cursusmap MenS1', v_root_id, 'course', false)
  RETURNING id INTO v_mens1_folder_id;

  INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
  VALUES
    (v_mens1_folder_id, 'admin',   true, true),
    (v_mens1_folder_id, 'docent',  true, true),
    (v_mens1_folder_id, 'student', true, false)
  ON CONFLICT DO NOTHING;

  -- ── Stap 7: maak MenS1/RAG aan (folder_type='rag_sources') ───────────────
  INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root)
  VALUES ('RAG', 'RAG-documenten voor MenS1', v_mens1_folder_id, 'rag_sources', false)
  RETURNING id INTO v_mens1_rag_id;

  INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
  VALUES
    (v_mens1_rag_id, 'admin',   true, true),
    (v_mens1_rag_id, 'docent',  true, true),
    (v_mens1_rag_id, 'student', true, false)
  ON CONFLICT DO NOTHING;

  -- ── Stap 8: verplaats 4 RAG-documenten van RAG-MenS1 → MenS1/RAG ─────────
  UPDATE documents SET folder_id = v_mens1_rag_id WHERE folder_id = v_rag_mens1_id;

  -- ── Stap 9: reparent Projectdata (89cad06a) van Basiscursus → MenS1 ──────
  UPDATE document_folders SET parent_folder_id = v_mens1_folder_id WHERE id = v_old_projectdata_id;

  -- ── Stap 10: verwijder wees RAG-MenS1 (nu leeg) ──────────────────────────
  DELETE FROM course_folder_assignments WHERE folder_id = v_rag_mens1_id;
  DELETE FROM document_folders          WHERE id        = v_rag_mens1_id;

  -- ── Stap 11: verwijder wees MenS1 (e37814df) ─────────────────────────────
  DELETE FROM course_folder_assignments WHERE folder_id = 'e37814df-3015-45dd-a222-fb9142b583fd';
  DELETE FROM document_folders          WHERE id        = 'e37814df-3015-45dd-a222-fb9142b583fd';

  -- ── Stap 12: maak Basiscursus/RAG aan ────────────────────────────────────
  INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root)
  VALUES ('RAG', 'RAG-documenten voor Basiscursus', v_basiscursus_id, 'rag_sources', false)
  RETURNING id INTO v_basiscursus_rag_id;

  INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
  VALUES
    (v_basiscursus_rag_id, 'admin',   true, true),
    (v_basiscursus_rag_id, 'docent',  true, true),
    (v_basiscursus_rag_id, 'student', true, false)
  ON CONFLICT DO NOTHING;

  -- ── Stap 13: maak Basiscursus/Projectdata aan ─────────────────────────────
  INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root)
  VALUES ('Projectdata', 'Projectbestanden voor Basiscursus', v_basiscursus_id, 'data', false)
  RETURNING id INTO v_basiscursus_projectdata_id;

  INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
  VALUES
    (v_basiscursus_projectdata_id, 'admin',   true, true),
    (v_basiscursus_projectdata_id, 'docent',  true, true),
    (v_basiscursus_projectdata_id, 'student', true, false)
  ON CONFLICT DO NOTHING;

  -- ── Stap 14: herstel course_folder_assignments ────────────────────────────
  DELETE FROM course_folder_assignments WHERE course_id IN (v_course_mens1, v_course_basiscursus);

  INSERT INTO course_folder_assignments (course_id, folder_id)
  VALUES
    (v_course_mens1,       v_mens1_rag_id),              -- MenS1 → MenS1/RAG
    (v_course_mens1,       v_old_projectdata_id),         -- MenS1 → MenS1/Projectdata
    (v_course_basiscursus, v_basiscursus_rag_id),         -- Basiscursus → Basiscursus/RAG
    (v_course_basiscursus, v_basiscursus_projectdata_id)  -- Basiscursus → Basiscursus/Projectdata
  ON CONFLICT DO NOTHING;

  -- ── Stap 15: herstel folder_rag_assignments → MenS1/RAG ──────────────────
  --    ON DELETE CASCADE heeft de oude rag-assignments al verwijderd (stap 5)
  INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
  VALUES
    (v_mens1_rag_id, 'general', true),
    (v_mens1_rag_id, 'explain', true),
    (v_mens1_rag_id, 'quiz',    true)
  ON CONFLICT (folder_id, module_type) DO UPDATE SET is_active = true;

  RAISE NOTICE 'Migratie voltooid. MenS1-map: %, MenS1/RAG: %', v_mens1_folder_id, v_mens1_rag_id;
END $$;
