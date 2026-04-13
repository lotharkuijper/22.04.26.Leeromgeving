/*
  # Fix Chatbot Prompts RLS Policies
  
  1. Changes
    - Simplify the SELECT policy for chatbot_prompts
    - Allow all authenticated users to read active prompts
    
  2. Security
    - Authenticated users can read active prompts
    - Only admins can modify prompts
*/

-- Drop and recreate the "Everyone can read active prompts" policy
DROP POLICY IF EXISTS "Everyone can read active prompts" ON chatbot_prompts;

-- Allow authenticated users to read active prompts
CREATE POLICY "Authenticated users can read active prompts"
  ON chatbot_prompts
  FOR SELECT
  TO authenticated
  USING (is_active = true);
