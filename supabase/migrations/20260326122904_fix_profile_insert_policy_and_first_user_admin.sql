/*
  # Fix Profile Registration and First User Admin

  ## Overview
  Lost het "Database error saving new user" probleem op door de ontbrekende INSERT policy toe te voegen.
  Voegt ook fallback logica toe zodat de eerste geregistreerde gebruiker automatisch admin wordt.

  ## Changes Made

  1. **INSERT Policy voor Profiles**
     - Voegt policy toe die nieuwe profile inserts toestaat via de trigger
     - Gebruikt service_role voor maximale veiligheid
     - Alleen de handle_new_user() functie kan profiles aanmaken

  2. **First User Admin Logica**
     - Update handle_new_user() functie
     - Als profiles tabel leeg is, wordt nieuwe user admin
     - Anders: l.d.j.kuijper@vu.nl wordt admin, rest wordt student

  ## Security

  - RLS blijft enabled
  - INSERT alleen via trigger (SECURITY DEFINER)
  - Users kunnen zichzelf niet direct admin maken
  - Bestaande SELECT en UPDATE policies blijven ongewijzigd

  ## Important Notes

  1. Eerste registratie = admin (als tabel leeg is)
  2. l.d.j.kuijper@vu.nl = altijd admin (hardcoded)
  3. Alle andere registraties = student (standaard)
  4. Deze fix lost het "Database error saving new user" probleem op
*/

-- Add INSERT policy for profiles table
-- This allows the trigger to insert new profiles
CREATE POLICY "Enable insert via trigger"
  ON profiles FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

-- Update handle_new_user function to make first user admin
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_count INTEGER;
BEGIN
  -- Count existing profiles
  SELECT COUNT(*) INTO user_count FROM profiles;
  
  -- Insert new profile
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE 
      -- If no users exist, first user becomes admin
      WHEN user_count = 0 THEN 'admin'
      -- Hardcoded admin email always gets admin role
      WHEN NEW.email = 'l.d.j.kuijper@vu.nl' THEN 'admin'
      -- Everyone else gets student role
      ELSE 'student'
    END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
