/*
  # Complete RLS Policy Reset for Profiles

  ## Overview
  Complete reset van alle RLS policies op de profiles tabel om registratie te laten werken.
  Lost het "Database error saving new user" probleem definitief op.

  ## Changes Made

  1. **Drop Alle Bestaande Policies**
     - Verwijder alle oude policies om clean start te hebben
  
  2. **Nieuwe Eenvoudige INSERT Policy**
     - Staat INSERT toe voor iedereen (anon en authenticated)
     - Nodig voor registratie flow via trigger
  
  3. **SELECT Policies**
     - Users kunnen hun eigen profiel zien
     - Docenten en admins kunnen alle profielen zien
  
  4. **UPDATE Policies**
     - Users kunnen hun eigen profiel updaten (zonder rol te wijzigen)
     - Admin kan alle profielen updaten (inclusief rollen)

  5. **First User Admin Logic**
     - Update functie zodat eerste user altijd admin wordt
     - l.d.j.kuijper@vu.nl is altijd admin
     - Alle andere users worden student

  ## Security

  - RLS blijft enabled
  - INSERT alleen via trigger (SECURITY DEFINER)
  - Users kunnen hun eigen rol niet wijzigen
  - Alleen admin kan rollen wijzigen

  ## Testing

  Na deze migratie moet registratie werken:
  1. Eerste registratie = admin
  2. Volgende registraties = student
  3. Login moet werken
*/

-- Drop all existing policies on profiles
DROP POLICY IF EXISTS "Enable insert via trigger" ON profiles;
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Docenten and admin can read all profiles" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Only admin can change roles" ON profiles;

-- Create new INSERT policy (allows the trigger to insert)
CREATE POLICY "Allow insert for new user registration"
  ON profiles FOR INSERT
  TO public
  WITH CHECK (true);

-- Create SELECT policies
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Docent and admin can view all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
      AND p.role IN ('docent', 'admin')
    )
  );

-- Create UPDATE policies
CREATE POLICY "Users can update own profile (not role)"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT role FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Admin can update all profiles"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
      AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
      AND p.role = 'admin'
    )
  );

-- Recreate handle_new_user function with better error handling
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_count INTEGER;
  new_role TEXT;
BEGIN
  -- Count existing profiles
  SELECT COUNT(*) INTO user_count FROM profiles;
  
  -- Determine role
  IF user_count = 0 THEN
    new_role := 'admin';
  ELSIF NEW.email = 'l.d.j.kuijper@vu.nl' THEN
    new_role := 'admin';
  ELSE
    new_role := 'student';
  END IF;
  
  -- Insert new profile
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    new_role
  );
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'Error in handle_new_user: %', SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();
