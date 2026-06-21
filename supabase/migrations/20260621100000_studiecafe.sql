-- Task #304: Studiecafé — discussieruimte per cursus.
--
-- Een laagdrempelig, per-cursus discussieforum (ontwerp D: uitnodigende feed +
-- filter-chips + platte reacties + pinnen + emoji-reacties + "opgelost"-markering).
-- Docenten modereren volledig (andermans posts verwijderen, threads sluiten/pinnen),
-- geven een "pluim" (kudos) op goede studentposts en plaatsen aankondigingen.
--
-- TOEGANGSMODEL (cruciaal): cursus-toegang is ZICHTBAARHEIDS-gebaseerd, niet
-- lidmaatschaps-gebaseerd. Zelf-geregistreerde studenten (Task #272) hebben vaak
-- GEEN course_members-rij. De SELECT-RLS spiegelt daarom bewust
-- canAccessCourseContent (server/courseAvailability.js): een actieve + zichtbare
-- cursus is leesbaar voor élke ingelogde gebruiker. We gebruiken NIET
-- pr_user_has_course_access (die is lidmaatschap/projectgroep-gebaseerd en zou
-- zichtbaarheids-only studenten buitensluiten).
--
-- SCHRIJVEN: er zijn BEWUST geen INSERT/UPDATE/DELETE-policies voor 'authenticated'.
-- Alle mutaties lopen server-side via de service-role (supabaseAdmin), die RLS
-- omzeilt, met userHasCourseAccess / isStaffForCourse als poortwachters. Zo kunnen
-- zichtbaarheids-only studenten wél realtime meelezen (SELECT-policy slaagt) maar
-- niet rechtstreeks in de tabellen schrijven.
--
-- VERWIJDEREN: soft-delete (deleted_at/deleted_by). Moderatie zendt dan een
-- realtime UPDATE uit (betrouwbaar) i.p.v. een DELETE-event (dat bij de
-- standaard replica identity vaak alleen de PK bevat). Behoudt ook context/audit.

BEGIN;

-- 1. Threads (top-level posts in de feed).
CREATE TABLE IF NOT EXISTS studiecafe_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL,
  category text NOT NULL DEFAULT 'vraag' CHECK (category IN ('vraag', 'discussie', 'tip')),
  is_pinned boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  is_announcement boolean NOT NULL DEFAULT false,
  is_resolved boolean NOT NULL DEFAULT false,
  kudos_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  kudos_at timestamptz,
  reactions jsonb NOT NULL DEFAULT '{}'::jsonb,
  reply_count integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studiecafe_threads_feed_idx
  ON studiecafe_threads(course_id, is_pinned DESC, last_activity_at DESC);

-- 2. Replies (platte reacties op een thread).
CREATE TABLE IF NOT EXISTS studiecafe_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES studiecafe_threads(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  body text NOT NULL,
  kudos_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  kudos_at timestamptz,
  reactions jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studiecafe_replies_thread_idx
  ON studiecafe_replies(thread_id, created_at);

-- 3. RLS aanzetten.
ALTER TABLE studiecafe_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE studiecafe_replies ENABLE ROW LEVEL SECURITY;

-- 4. Lees-poortwachter: spiegelt canAccessCourseContent. SECURITY DEFINER zodat
--    de functie courses/course_members mag bevragen zonder RLS-recursie.
--    - admin/superuser            → altijd.
--    - docent van de cursus       → altijd (pr_is_course_teacher dekt admin + docent
--                                     met course_members teacher-rij; verborgen
--                                     cursussen blijven zo docent-only).
--    - actief + zichtbaar         → élke ingelogde gebruiker (open, = courses-RLS).
--    - inactief + zichtbaar       → alléén leden (gearchiveerd blijft leesbaar voor
--                                     wie er al bij hoort).
CREATE OR REPLACE FUNCTION sc_can_read_course(p_course_id uuid) RETURNS boolean AS $$
  SELECT
    pr_is_admin()
    OR pr_is_course_teacher(p_course_id)
    OR EXISTS (
      SELECT 1 FROM courses c
       WHERE c.id = p_course_id
         AND c.is_active = true
         AND c.student_visible = true
    )
    OR EXISTS (
      SELECT 1
        FROM courses c
        JOIN course_members cm ON cm.course_id = c.id
       WHERE c.id = p_course_id
         AND c.is_active = false
         AND c.student_visible = true
         AND cm.user_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 5. SELECT-policies (alleen lezen; alle schrijfacties lopen via de service-role).
DROP POLICY IF EXISTS studiecafe_threads_select ON studiecafe_threads;
CREATE POLICY studiecafe_threads_select ON studiecafe_threads FOR SELECT TO authenticated
  USING (sc_can_read_course(course_id));

DROP POLICY IF EXISTS studiecafe_replies_select ON studiecafe_replies;
CREATE POLICY studiecafe_replies_select ON studiecafe_replies FOR SELECT TO authenticated
  USING (sc_can_read_course(course_id));

-- 6. Realtime aanzetten (idempotent; negeer als de publicatie niet bestaat).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'studiecafe_threads'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE studiecafe_threads';
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'studiecafe_replies'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE studiecafe_replies';
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

COMMIT;
