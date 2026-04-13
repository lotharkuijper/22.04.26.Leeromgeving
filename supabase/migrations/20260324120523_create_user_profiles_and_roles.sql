/*
  # User Profiles and Roles System

  ## Overview
  Dit creëert het basis gebruikerssysteem met rollen en profielen voor de epidemiologie leeromgeving.

  ## New Tables
  
  ### `profiles`
  - `id` (uuid, primary key) - Links naar auth.users
  - `email` (text, unique, not null) - Email van gebruiker
  - `full_name` (text) - Volledige naam
  - `role` (text, not null) - Rol: 'student', 'docent', of 'admin'
  - `university` (text) - Universiteit naam
  - `study_year` (integer) - Studiejaar voor studenten
  - `avatar_url` (text) - Profielfoto URL
  - `created_at` (timestamptz) - Account aanmaak datum
  - `updated_at` (timestamptz) - Laatste update

  ### `user_audit_log`
  - `id` (uuid, primary key)
  - `user_id` (uuid, foreign key) - Gebruiker waarover het gaat
  - `changed_by` (uuid, foreign key) - Admin die wijziging maakte
  - `old_role` (text) - Oude rol
  - `new_role` (text) - Nieuwe rol
  - `reason` (text) - Reden voor wijziging
  - `created_at` (timestamptz) - Wanneer wijziging plaatsvond

  ## Security
  
  - RLS enabled op alle tabellen
  - Studenten kunnen alleen hun eigen profiel lezen
  - Docenten kunnen alle profielen lezen
  - Alleen admin kan rollen wijzigen
  - Admin (l.d.j.kuijper@vu.nl) krijgt automatisch admin rol
  - Alle andere nieuwe users krijgen automatisch student rol

  ## Important Notes
  
  1. De admin email l.d.j.kuijper@vu.nl wordt hardcoded en krijgt automatisch admin rechten
  2. Alle nieuwe registraties worden standaard als 'student' aangemaakt
  3. Audit logging houdt alle rol wijzigingen bij
*/

-- Create profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  full_name text,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'docent', 'admin')),
  university text,
  study_year integer CHECK (study_year >= 1 AND study_year <= 10),
  avatar_url text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Create user audit log table
CREATE TABLE IF NOT EXISTS user_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  changed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  old_role text NOT NULL,
  new_role text NOT NULL,
  reason text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_audit_log ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Docenten and admin can read all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id 
    AND role = (SELECT role FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Only admin can change roles"
  ON profiles FOR UPDATE
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

-- Audit log policies
CREATE POLICY "Admin can read audit log"
  ON user_audit_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admin can insert audit log"
  ON user_audit_log FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Function to handle new user creation
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE 
      WHEN NEW.email = 'l.d.j.kuijper@vu.nl' THEN 'admin'
      ELSE 'student'
    END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user creation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Function to log role changes
CREATE OR REPLACE FUNCTION log_role_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO user_audit_log (user_id, changed_by, old_role, new_role)
    VALUES (NEW.id, auth.uid(), OLD.role, NEW.role);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for role changes
DROP TRIGGER IF EXISTS on_role_change ON profiles;
CREATE TRIGGER on_role_change
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION log_role_change();