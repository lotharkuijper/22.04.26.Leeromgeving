-- Task #78: Projectruimte MVP
-- Voegt course-gebonden persona-bibliotheek, project-eigen persona-kopieën,
-- project-groepen met leden, groepschat (realtime), persona-threads per groep,
-- en checkpoints toe. Bestaande projects/student_project_sessions worden
-- additief uitgebreid (geen breaking changes).

-- 1. Projects: extra velden voor briefing, rubric, course-binding, en
-- groepsinstellingen. Bestaande velden (title, research_question, ...) blijven.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS briefing_markdown text,
  ADD COLUMN IF NOT EXISTS rubric_criteria jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS document_refs jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS max_group_size integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS allow_self_signup boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active' CHECK (status IN ('active', 'archived'));

CREATE INDEX IF NOT EXISTS projects_course_id_idx ON projects(course_id);

-- student_project_sessions: nullable group_id zodat individueel = groep van 1.
ALTER TABLE student_project_sessions
  ADD COLUMN IF NOT EXISTS group_id uuid;

-- 2. Course persona library — beheerd door docent/admin per cursus.
CREATE TABLE IF NOT EXISTS course_personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  avatar_emoji text DEFAULT '🤖',
  system_prompt text NOT NULL DEFAULT '',
  rag_enabled boolean DEFAULT true,
  rag_folder_ids jsonb DEFAULT '[]'::jsonb,
  visible_from_phase integer,
  is_default boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS course_personas_course_idx ON course_personas(course_id);

-- 3. Project personas — kopieën, project-eigen aanpassingen.
CREATE TABLE IF NOT EXISTS project_personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  source_persona_id uuid REFERENCES course_personas(id) ON DELETE SET NULL,
  name text NOT NULL,
  avatar_emoji text DEFAULT '🤖',
  system_prompt text NOT NULL DEFAULT '',
  rag_enabled boolean DEFAULT true,
  rag_folder_ids jsonb DEFAULT '[]'::jsonb,
  visible_from_phase integer,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS project_personas_project_idx ON project_personas(project_id);

-- 4. Project groups — onafhankelijk van legacy collaboration_groups.
CREATE TABLE IF NOT EXISTS project_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  invite_code text UNIQUE NOT NULL,
  status text DEFAULT 'active' CHECK (status IN ('active', 'finalized', 'archived')),
  finalized_at timestamptz,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS project_groups_project_idx ON project_groups(project_id);

CREATE TABLE IF NOT EXISTS project_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role text DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_group_members_user_idx ON project_group_members(user_id);
CREATE INDEX IF NOT EXISTS project_group_members_group_idx ON project_group_members(group_id);

-- 5. Group chat messages (realtime).
CREATE TABLE IF NOT EXISTS group_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  body text NOT NULL,
  reactions jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS group_chat_messages_group_idx ON group_chat_messages(group_id, created_at DESC);

-- 6. Persona threads per groep (één thread per groep+persona).
CREATE TABLE IF NOT EXISTS group_persona_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE NOT NULL,
  persona_id uuid REFERENCES project_personas(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(group_id, persona_id)
);

CREATE TABLE IF NOT EXISTS group_persona_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid REFERENCES group_persona_threads(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  rag_sources jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS group_persona_messages_thread_idx ON group_persona_messages(thread_id, created_at);

-- 7. Group checkpoints — tussentijdse + finale reflecties.
CREATE TABLE IF NOT EXISTS group_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkpoint', 'final')),
  reflection text NOT NULL,
  ai_summary text,
  rubric_feedback jsonb,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS group_checkpoints_group_idx ON group_checkpoints(group_id, created_at DESC);

-- 8. RLS aanzetten + beleid.
ALTER TABLE course_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_persona_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_persona_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_checkpoints ENABLE ROW LEVEL SECURITY;

-- Helper: is de huidige gebruiker admin/superuser?
CREATE OR REPLACE FUNCTION pr_is_admin() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (role = 'admin' OR email = 'l.d.j.kuijper@vu.nl')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Helper: is de gebruiker docent/admin van de gegeven cursus?
CREATE OR REPLACE FUNCTION pr_is_course_teacher(p_course_id uuid) RETURNS boolean AS $$
  SELECT pr_is_admin() OR EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'docent'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Helper: is de gebruiker lid van de gegeven groep?
CREATE OR REPLACE FUNCTION pr_is_group_member(p_group_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- course_personas: lezen door alle ingelogden (binnen een cursus die je bekijkt
-- in een project); schrijven door docent/admin.
DROP POLICY IF EXISTS course_personas_select ON course_personas;
CREATE POLICY course_personas_select ON course_personas FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS course_personas_modify ON course_personas;
CREATE POLICY course_personas_modify ON course_personas FOR ALL TO authenticated
  USING (pr_is_course_teacher(course_id))
  WITH CHECK (pr_is_course_teacher(course_id));

-- project_personas: lezen door alle ingelogden; schrijven door docent/admin.
DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS project_personas_modify ON project_personas;
CREATE POLICY project_personas_modify ON project_personas FOR ALL TO authenticated
  USING (pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'))
  WITH CHECK (pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));

-- project_groups: lezen door leden + docenten/admins; aanmaken door studenten zelf.
DROP POLICY IF EXISTS project_groups_select ON project_groups;
CREATE POLICY project_groups_select ON project_groups FOR SELECT TO authenticated
  USING (pr_is_group_member(id) OR pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));
DROP POLICY IF EXISTS project_groups_insert ON project_groups;
CREATE POLICY project_groups_insert ON project_groups FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
DROP POLICY IF EXISTS project_groups_update ON project_groups;
CREATE POLICY project_groups_update ON project_groups FOR UPDATE TO authenticated
  USING (pr_is_group_member(id) OR pr_is_admin())
  WITH CHECK (pr_is_group_member(id) OR pr_is_admin());

-- project_group_members: lezen door (groepsleden) + docenten/admins.
DROP POLICY IF EXISTS pgm_select ON project_group_members;
CREATE POLICY pgm_select ON project_group_members FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));
DROP POLICY IF EXISTS pgm_insert ON project_group_members;
CREATE POLICY pgm_insert ON project_group_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS pgm_delete ON project_group_members;
CREATE POLICY pgm_delete ON project_group_members FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR pr_is_admin());

-- group_chat_messages: lezen + schrijven door groepsleden.
DROP POLICY IF EXISTS gcm_select ON group_chat_messages;
CREATE POLICY gcm_select ON group_chat_messages FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));
DROP POLICY IF EXISTS gcm_insert ON group_chat_messages;
CREATE POLICY gcm_insert ON group_chat_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND pr_is_group_member(group_id));
DROP POLICY IF EXISTS gcm_update ON group_chat_messages;
CREATE POLICY gcm_update ON group_chat_messages FOR UPDATE TO authenticated
  USING (pr_is_group_member(group_id))
  WITH CHECK (pr_is_group_member(group_id));

-- group_persona_threads + messages: lezen door groepsleden; schrijven via server (service role).
DROP POLICY IF EXISTS gpt_select ON group_persona_threads;
CREATE POLICY gpt_select ON group_persona_threads FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));

DROP POLICY IF EXISTS gpm_select ON group_persona_messages;
CREATE POLICY gpm_select ON group_persona_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM group_persona_threads t WHERE t.id = thread_id AND (pr_is_group_member(t.group_id) OR pr_is_admin())));

-- group_checkpoints: lezen door groepsleden + docenten/admins.
DROP POLICY IF EXISTS gcp_select ON group_checkpoints;
CREATE POLICY gcp_select ON group_checkpoints FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent'));

-- Realtime aanzetten voor groepschat (idempotent: doe het alleen als niet al gepubliceerd).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'group_chat_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE group_chat_messages';
  END IF;
EXCEPTION WHEN undefined_object THEN
  -- supabase_realtime publication bestaat niet in deze omgeving; negeer.
  NULL;
END $$;
