/*
  # Projects and Collaboration System

  ## Overview
  Tabellen voor data analyse projecten en samenwerkingsfunctionaliteit.

  ## New Tables
  
  ### `datasets`
  - `id` (uuid, primary key)
  - `name` (text, not null)
  - `description` (text)
  - `file_path` (text, not null) - Supabase Storage path
  - `file_type` (text) - CSV, Excel, etc
  - `file_size` (bigint)
  - `variables_info` (jsonb) - Informatie over variabelen
  - `row_count` (integer)
  - `column_count` (integer)
  - `uploaded_by` (uuid, foreign key)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `projects`
  - `id` (uuid, primary key)
  - `title` (text, not null)
  - `research_question` (text, not null)
  - `dataset_id` (uuid, foreign key)
  - `description` (text)
  - `difficulty` (text)
  - `is_public` (boolean)
  - `created_by` (uuid, foreign key)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `student_project_sessions`
  - `id` (uuid, primary key)
  - `project_id` (uuid, foreign key)
  - `student_id` (uuid, foreign key)
  - `current_phase` (text) - 'exploration', 'hypothesis', 'analysis', 'interpretation'
  - `hypothesis` (text)
  - `analysis_notes` (text)
  - `conclusions` (text)
  - `started_at` (timestamptz)
  - `last_activity` (timestamptz)
  - `completed` (boolean)

  ### `project_analyses`
  - `id` (uuid, primary key)
  - `session_id` (uuid, foreign key)
  - `analysis_type` (text) - Type analyse (bijv. 'descriptive', 'correlation', 'regression')
  - `code_snippet` (text)
  - `results` (jsonb)
  - `interpretation` (text)
  - `created_at` (timestamptz)

  ### `collaboration_sessions`
  - `id` (uuid, primary key)
  - `name` (text, not null)
  - `session_type` (text) - 'quiz' of 'project'
  - `context_id` (uuid) - Link naar quiz_set of project
  - `status` (text) - 'active', 'completed', 'archived'
  - `created_by` (uuid, foreign key)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `collaboration_participants`
  - `id` (uuid, primary key)
  - `session_id` (uuid, foreign key)
  - `user_id` (uuid, foreign key)
  - `role` (text) - 'owner', 'member'
  - `joined_at` (timestamptz)
  - Unique constraint op (session_id, user_id)

  ### `collaboration_messages`
  - `id` (uuid, primary key)
  - `session_id` (uuid, foreign key)
  - `user_id` (uuid, foreign key)
  - `message` (text, not null)
  - `message_type` (text) - 'user', 'system', 'bot'
  - `created_at` (timestamptz)

  ## Storage
  - Storage bucket 'datasets' voor dataset bestanden

  ## Security
  - RLS enabled
  - Alleen docenten/admin kunnen datasets en projecten uploaden
  - Studenten kunnen projecten starten en analyses opslaan
  - Collaboration deelnemers kunnen groepsberichten zien
*/

-- Datasets table
CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  file_path text NOT NULL,
  file_type text,
  file_size bigint DEFAULT 0,
  variables_info jsonb DEFAULT '{}'::jsonb,
  row_count integer DEFAULT 0,
  column_count integer DEFAULT 0,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  research_question text NOT NULL,
  dataset_id uuid REFERENCES datasets(id) ON DELETE SET NULL,
  description text,
  difficulty text DEFAULT 'intermediate' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  is_public boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Student project sessions table
CREATE TABLE IF NOT EXISTS student_project_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  student_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  current_phase text DEFAULT 'exploration' CHECK (current_phase IN ('exploration', 'hypothesis', 'analysis', 'interpretation')),
  hypothesis text,
  analysis_notes text,
  conclusions text,
  started_at timestamptz DEFAULT now() NOT NULL,
  last_activity timestamptz DEFAULT now() NOT NULL,
  completed boolean DEFAULT false,
  UNIQUE(project_id, student_id)
);

-- Project analyses table
CREATE TABLE IF NOT EXISTS project_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES student_project_sessions(id) ON DELETE CASCADE NOT NULL,
  analysis_type text,
  code_snippet text,
  results jsonb DEFAULT '{}'::jsonb,
  interpretation text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Collaboration sessions table
CREATE TABLE IF NOT EXISTS collaboration_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  session_type text NOT NULL CHECK (session_type IN ('quiz', 'project')),
  context_id uuid,
  status text DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Collaboration participants table
CREATE TABLE IF NOT EXISTS collaboration_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES collaboration_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role text DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(session_id, user_id)
);

-- Collaboration messages table
CREATE TABLE IF NOT EXISTS collaboration_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES collaboration_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  message text NOT NULL,
  message_type text DEFAULT 'user' CHECK (message_type IN ('user', 'system', 'bot')),
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS datasets_uploaded_by_idx ON datasets(uploaded_by);
CREATE INDEX IF NOT EXISTS projects_dataset_id_idx ON projects(dataset_id);
CREATE INDEX IF NOT EXISTS student_project_sessions_student_id_idx ON student_project_sessions(student_id);
CREATE INDEX IF NOT EXISTS collaboration_participants_session_id_idx ON collaboration_participants(session_id);
CREATE INDEX IF NOT EXISTS collaboration_messages_session_id_idx ON collaboration_messages(session_id);

-- Enable RLS
ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_project_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_messages ENABLE ROW LEVEL SECURITY;

-- Datasets policies
CREATE POLICY "All authenticated users can read datasets"
  ON datasets FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Docenten and admin can manage datasets"
  ON datasets FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Projects policies
CREATE POLICY "Students can read public projects"
  ON projects FOR SELECT
  TO authenticated
  USING (
    is_public = true OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Docenten and admin can manage projects"
  ON projects FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Student project sessions policies
CREATE POLICY "Students can read own sessions"
  ON student_project_sessions FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

CREATE POLICY "Docenten and admin can read all sessions"
  ON student_project_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Students can manage own sessions"
  ON student_project_sessions FOR ALL
  TO authenticated
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

-- Project analyses policies
CREATE POLICY "Students can read own analyses"
  ON project_analyses FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM student_project_sessions
      WHERE student_project_sessions.id = session_id
      AND student_project_sessions.student_id = auth.uid()
    )
  );

CREATE POLICY "Students can manage own analyses"
  ON project_analyses FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM student_project_sessions
      WHERE student_project_sessions.id = session_id
      AND student_project_sessions.student_id = auth.uid()
    )
  );

-- Collaboration sessions policies
CREATE POLICY "Participants can read their sessions"
  ON collaboration_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM collaboration_participants
      WHERE collaboration_participants.session_id = id
      AND collaboration_participants.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create collaboration sessions"
  ON collaboration_sessions FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Session owner can update session"
  ON collaboration_sessions FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM collaboration_participants
      WHERE collaboration_participants.session_id = id
      AND collaboration_participants.user_id = auth.uid()
      AND collaboration_participants.role = 'owner'
    )
  );

-- Collaboration participants policies
CREATE POLICY "Participants can read session participants"
  ON collaboration_participants FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM collaboration_participants cp
      WHERE cp.session_id = session_id
      AND cp.user_id = auth.uid()
    )
  );

CREATE POLICY "Session owner can manage participants"
  ON collaboration_participants FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM collaboration_sessions
      WHERE collaboration_sessions.id = session_id
      AND collaboration_sessions.created_by = auth.uid()
    )
  );

-- Collaboration messages policies
CREATE POLICY "Participants can read session messages"
  ON collaboration_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM collaboration_participants
      WHERE collaboration_participants.session_id = session_id
      AND collaboration_participants.user_id = auth.uid()
    )
  );

CREATE POLICY "Participants can send messages"
  ON collaboration_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM collaboration_participants
      WHERE collaboration_participants.session_id = session_id
      AND collaboration_participants.user_id = auth.uid()
    )
  );

-- Triggers
DROP TRIGGER IF EXISTS datasets_updated_at ON datasets;
CREATE TRIGGER datasets_updated_at
  BEFORE UPDATE ON datasets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS collaboration_sessions_updated_at ON collaboration_sessions;
CREATE TRIGGER collaboration_sessions_updated_at
  BEFORE UPDATE ON collaboration_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Create storage bucket for datasets
INSERT INTO storage.buckets (id, name, public)
VALUES ('datasets', 'datasets', false)
ON CONFLICT (id) DO NOTHING;