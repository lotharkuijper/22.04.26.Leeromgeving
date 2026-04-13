/*
  # Chat Conversations and Messages

  ## Overview
  Tabellen voor chat conversaties, berichten, en concept uitleg module.

  ## New Tables
  
  ### `conversations`
  - `id` (uuid, primary key)
  - `user_id` (uuid, foreign key) - Eigenaar van conversatie
  - `title` (text) - Conversatie titel
  - `module_type` (text) - Type: 'general', 'explain', 'project', 'quiz'
  - `context_id` (uuid) - Link naar project, concept, etc (optional)
  - `status` (text) - Status: 'active', 'archived'
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `messages`
  - `id` (uuid, primary key)
  - `conversation_id` (uuid, foreign key)
  - `role` (text) - 'user' of 'assistant'
  - `content` (text, not null)
  - `retrieved_context` (jsonb) - RAG context gebruikt voor dit bericht
  - `created_at` (timestamptz)

  ### `message_reactions`
  - `id` (uuid, primary key)
  - `message_id` (uuid, foreign key)
  - `user_id` (uuid, foreign key)
  - `reaction_type` (text) - 'helpful', 'not_helpful', 'incorrect'
  - `feedback_text` (text) - Optionele feedback
  - `created_at` (timestamptz)

  ### `concepts`
  - `id` (uuid, primary key)
  - `name` (text, unique, not null) - Begrip naam (bijv. "Confounding")
  - `category` (text) - 'epidemiologie' of 'biostatistiek'
  - `definition` (text) - Officiële definitie
  - `key_points` (text[]) - Array van kernpunten
  - `examples` (text[]) - Array van voorbeelden
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `student_explanations`
  - `id` (uuid, primary key)
  - `concept_id` (uuid, foreign key)
  - `student_id` (uuid, foreign key)
  - `explanation_text` (text, not null)
  - `version` (integer) - Versie nummer (student kan meerdere pogingen doen)
  - `feedback` (jsonb) - Gestructureerde feedback van LLM
  - `score` (jsonb) - Scores op volledigheid, correctheid, helderheid
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled
  - Users kunnen alleen eigen conversaties en berichten zien
  - Alle users kunnen concepts lezen
  - Docenten/admin kunnen alle student explanations zien
*/

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title text DEFAULT 'Nieuwe conversatie',
  module_type text DEFAULT 'general' CHECK (module_type IN ('general', 'explain', 'project', 'quiz')),
  context_id uuid,
  status text DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  retrieved_context jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Message reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  reaction_type text NOT NULL CHECK (reaction_type IN ('helpful', 'not_helpful', 'incorrect')),
  feedback_text text,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(message_id, user_id)
);

-- Concepts table
CREATE TABLE IF NOT EXISTS concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  category text NOT NULL CHECK (category IN ('epidemiologie', 'biostatistiek')),
  definition text,
  key_points text[] DEFAULT ARRAY[]::text[],
  examples text[] DEFAULT ARRAY[]::text[],
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Student explanations table
CREATE TABLE IF NOT EXISTS student_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE NOT NULL,
  student_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  explanation_text text NOT NULL,
  version integer DEFAULT 1,
  feedback jsonb DEFAULT '{}'::jsonb,
  score jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations(user_id);
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS student_explanations_student_id_idx ON student_explanations(student_id);
CREATE INDEX IF NOT EXISTS student_explanations_concept_id_idx ON student_explanations(concept_id);

-- Enable RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_explanations ENABLE ROW LEVEL SECURITY;

-- Conversations policies
CREATE POLICY "Users can read own conversations"
  ON conversations FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can create own conversations"
  ON conversations FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own conversations"
  ON conversations FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own conversations"
  ON conversations FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Messages policies
CREATE POLICY "Users can read messages from own conversations"
  ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert messages in own conversations"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- Message reactions policies
CREATE POLICY "Users can read own reactions"
  ON message_reactions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can create reactions"
  ON message_reactions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own reactions"
  ON message_reactions FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Concepts policies
CREATE POLICY "All authenticated users can read concepts"
  ON concepts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Docenten and admin can manage concepts"
  ON concepts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Student explanations policies
CREATE POLICY "Students can read own explanations"
  ON student_explanations FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

CREATE POLICY "Docenten and admin can read all explanations"
  ON student_explanations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Students can create own explanations"
  ON student_explanations FOR INSERT
  TO authenticated
  WITH CHECK (student_id = auth.uid());

-- Triggers
DROP TRIGGER IF EXISTS conversations_updated_at ON conversations;
CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS concepts_updated_at ON concepts;
CREATE TRIGGER concepts_updated_at
  BEFORE UPDATE ON concepts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();