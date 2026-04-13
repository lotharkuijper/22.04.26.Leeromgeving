/*
  # Create Learning Journal System
  
  1. New Tables
    - `learning_journal_entries`
      - `id` (uuid, primary key)
      - `user_id` (uuid, foreign key to profiles)
      - `title` (text)
      - `content` (text)
      - `activity_type` (text) - type of learning activity (e.g., study, practice, reflection)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
      
  2. Security
    - Enable RLS on `learning_journal_entries` table
    - Add policies for users to manage their own journal entries
    - Add policies for docents and admins to view all entries
*/

CREATE TABLE IF NOT EXISTS learning_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  content text NOT NULL,
  activity_type text DEFAULT 'reflection',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE learning_journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own journal entries"
  ON learning_journal_entries
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own journal entries"
  ON learning_journal_entries
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own journal entries"
  ON learning_journal_entries
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own journal entries"
  ON learning_journal_entries
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Docents can view all journal entries"
  ON learning_journal_entries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );