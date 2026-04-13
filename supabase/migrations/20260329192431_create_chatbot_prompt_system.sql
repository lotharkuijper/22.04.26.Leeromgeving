/*
  # Create Chatbot Prompt System
  
  1. New Tables
    - `chatbot_prompts`
      - `id` (uuid, primary key)
      - `name` (text) - identifier for the prompt
      - `content` (text) - the actual prompt text
      - `is_active` (boolean) - whether this prompt is currently active
      - `created_by` (uuid, foreign key to profiles)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
      
  2. Security
    - Enable RLS on `chatbot_prompts` table
    - Add policies for admins to manage prompts
    - Add policies for all authenticated users to read active prompts
    
  3. Initial Data
    - Insert default system prompt
*/

CREATE TABLE IF NOT EXISTS chatbot_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  content text NOT NULL,
  is_active boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE chatbot_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can read active prompts"
  ON chatbot_prompts
  FOR SELECT
  TO authenticated
  USING (is_active = true);

CREATE POLICY "Admins can view all prompts"
  ON chatbot_prompts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can create prompts"
  ON chatbot_prompts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update prompts"
  ON chatbot_prompts
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete prompts"
  ON chatbot_prompts
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chatbot_prompts WHERE name = 'default_system') THEN
    INSERT INTO chatbot_prompts (name, content, is_active)
    VALUES (
      'default_system',
      'Je bent een behulpzame AI-assistent voor de Vrije Universiteit leeromgeving voor Epidemiologie en Biostatistiek. 

Je helpt studenten bij het leren van epidemiologie en biostatistiek door:
- Duidelijke en begrijpelijke uitleg te geven van complexe concepten
- Vragen te beantwoorden op basis van het cursusmateriaal
- Studenten aan te moedigen zelf na te denken in plaats van directe antwoorden te geven
- Voorbeelden te geven die aansluiten bij de medische en gezondheidscontext

Wees altijd vriendelijk, geduldig en academisch correct. Als je niet zeker bent van een antwoord, geef dat dan eerlijk toe.',
      true
    );
  END IF;
END $$;