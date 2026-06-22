-- Task #334 — defensieve verscherping van de concepts-RLS.
--
-- Achtergrond: de live-DB heeft (nog) GEEN concepts.course_id-kolom; cursus-
-- koppeling loopt via de key_points-marker `course_id:<uuid>` (zie memory
-- `concept-course-scoping`). De vorige migratie (20260622100000) gaf docenten
-- daarom write/read via `is_teacher_anywhere(auth.uid())` — de enige haalbare
-- afbakening zonder kolom, consistent met datasets/quiz_sets.
--
-- RISICO: er bestaat een (niet-toegepaste) migratie 20260414 die concepts.
-- course_id WEL toevoegt. Zodra die ergens (bv. productie) wél draait, zou een
-- `is_teacher_anywhere`-policy een docent van cursus A schrijf/lees-toegang tot
-- begrippen van cursus B geven — een cross-course-lek.
--
-- Deze migratie is daarom DEFENSIEF en idempotent: ze detecteert of
-- concepts.course_id bestaat en kiest de policy-vorm daarop af:
--   * MET course_id  → cursus-afgebakend: admin OF (course_id IS NOT NULL AND
--     is_course_teacher(uid, course_id)). Globale seeds (course_id IS NULL)
--     blijven admin-only voor schrijven; lezen volgt approved/admin/eigen-cursus.
--   * ZONDER course_id → ongewijzigd t.o.v. 20260622100000 (is_teacher_anywhere).
-- Draai deze migratie opnieuw nadat course_id is toegevoegd om automatisch naar
-- de afgebakende vorm te schakelen.

DO $$
DECLARE
  has_course_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'concepts'
      AND column_name = 'course_id'
  ) INTO has_course_id;

  -- Begin schoon: verwijder de policies uit 20260622100000 (en eventuele
  -- eerdere varianten) zodat we ze deterministisch herbouwen.
  DROP POLICY IF EXISTS "concepts_insert_admin_or_teacher" ON concepts;
  DROP POLICY IF EXISTS "concepts_update_admin_or_teacher" ON concepts;
  DROP POLICY IF EXISTS "concepts_delete_admin_or_teacher" ON concepts;
  DROP POLICY IF EXISTS "concepts_read_approved_or_staff" ON concepts;

  IF has_course_id THEN
    -- Cursus-afgebakende vorm.
    EXECUTE $p$
      CREATE POLICY "concepts_insert_admin_or_teacher" ON concepts
        FOR INSERT TO authenticated
        WITH CHECK (
          is_admin()
          OR (course_id IS NOT NULL AND is_course_teacher(auth.uid(), course_id))
        );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_update_admin_or_teacher" ON concepts
        FOR UPDATE TO authenticated
        USING (
          is_admin()
          OR (course_id IS NOT NULL AND is_course_teacher(auth.uid(), course_id))
        )
        WITH CHECK (
          is_admin()
          OR (course_id IS NOT NULL AND is_course_teacher(auth.uid(), course_id))
        );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_delete_admin_or_teacher" ON concepts
        FOR DELETE TO authenticated
        USING (
          is_admin()
          OR (course_id IS NOT NULL AND is_course_teacher(auth.uid(), course_id))
        );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_read_approved_or_staff" ON concepts
        FOR SELECT TO authenticated
        USING (
          review_status = 'approved'::concept_review_status
          OR is_admin()
          OR (course_id IS NOT NULL AND is_course_teacher(auth.uid(), course_id))
        );
    $p$;
  ELSE
    -- Geen course_id-kolom: behoud de afbakening uit 20260622100000.
    EXECUTE $p$
      CREATE POLICY "concepts_insert_admin_or_teacher" ON concepts
        FOR INSERT TO authenticated
        WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_update_admin_or_teacher" ON concepts
        FOR UPDATE TO authenticated
        USING ( is_admin() OR is_teacher_anywhere(auth.uid()) )
        WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_delete_admin_or_teacher" ON concepts
        FOR DELETE TO authenticated
        USING ( is_admin() OR is_teacher_anywhere(auth.uid()) );
    $p$;
    EXECUTE $p$
      CREATE POLICY "concepts_read_approved_or_staff" ON concepts
        FOR SELECT TO authenticated
        USING (
          review_status = 'approved'::concept_review_status
          OR is_admin()
          OR is_teacher_anywhere(auth.uid())
        );
    $p$;
  END IF;
END $$;
