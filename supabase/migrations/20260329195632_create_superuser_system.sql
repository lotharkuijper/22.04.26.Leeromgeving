/*
  # Create Superuser System
  
  1. Purpose
    - Implement failsafe superuser mechanism for l.d.j.kuijper@vu.nl
    - Ensures PERMANENT admin access regardless of database state
    - Auto-creates profile if missing
    - Auto-corrects role if not admin
    
  2. Components
    - Trigger function to enforce superuser status on profiles
    - Trigger on profiles table insert/update
    - Function to ensure superuser profile exists
    - Function to force superuser status (callable from frontend)
    
  3. Security
    - Superuser email is hardcoded and cannot be changed via normal means
    - Bypasses RLS for this specific user
    - Service role is used to ensure profile creation always succeeds
*/

-- Function to check if email is superuser
CREATE OR REPLACE FUNCTION is_superuser_email(email_address text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN email_address = 'l.d.j.kuijper@vu.nl';
END;
$$;

-- Trigger function to enforce superuser role on profiles table
CREATE OR REPLACE FUNCTION enforce_superuser_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_email text;
BEGIN
  -- Get email from auth.users
  SELECT email INTO user_email
  FROM auth.users
  WHERE id = NEW.id;
  
  -- If this is the superuser email, force admin role
  IF is_superuser_email(user_email) THEN
    NEW.role := 'admin';
    NEW.updated_at := now();
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop trigger if exists and create new one
DROP TRIGGER IF EXISTS enforce_superuser_on_profile_insert ON profiles;
CREATE TRIGGER enforce_superuser_on_profile_insert
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_superuser_role();

-- Function to ensure superuser profile exists and has correct role
-- This function can be called from frontend or run automatically
CREATE OR REPLACE FUNCTION ensure_superuser_profile(user_id uuid, user_email text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  profile_exists boolean;
  result json;
BEGIN
  -- Only proceed if this is the superuser email
  IF NOT is_superuser_email(user_email) THEN
    RETURN json_build_object('success', false, 'message', 'Not a superuser email');
  END IF;
  
  -- Check if profile exists
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = user_id) INTO profile_exists;
  
  IF NOT profile_exists THEN
    -- Create profile with admin role
    INSERT INTO profiles (id, email, role, full_name)
    VALUES (
      user_id,
      user_email,
      'admin',
      'Lothar Kuijper'
    )
    ON CONFLICT (id) DO UPDATE
    SET 
      role = 'admin',
      email = user_email,
      updated_at = now();
    
    result := json_build_object('success', true, 'message', 'Superuser profile created');
  ELSE
    -- Update existing profile to ensure admin role
    UPDATE profiles
    SET 
      role = 'admin',
      email = user_email,
      updated_at = now()
    WHERE id = user_id;
    
    result := json_build_object('success', true, 'message', 'Superuser role enforced');
  END IF;
  
  RETURN result;
END;
$$;

-- Function to be called from frontend after auth
CREATE OR REPLACE FUNCTION ensure_my_superuser_status()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_user_id uuid;
  current_user_email text;
BEGIN
  -- Get current user info
  SELECT id, email INTO current_user_id, current_user_email
  FROM auth.users
  WHERE id = auth.uid();
  
  -- Ensure superuser profile if email matches
  IF is_superuser_email(current_user_email) THEN
    RETURN ensure_superuser_profile(current_user_id, current_user_email);
  END IF;
  
  RETURN json_build_object('success', false, 'message', 'Not a superuser');
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION is_superuser_email TO authenticated;
GRANT EXECUTE ON FUNCTION ensure_superuser_profile TO authenticated;
GRANT EXECUTE ON FUNCTION ensure_my_superuser_status TO authenticated;

-- Ensure superuser profile exists if user already registered
DO $$
DECLARE
  superuser_id uuid;
  superuser_email text := 'l.d.j.kuijper@vu.nl';
BEGIN
  -- Check if superuser exists in auth.users
  SELECT id INTO superuser_id
  FROM auth.users
  WHERE email = superuser_email;
  
  -- If user exists, ensure profile is correct
  IF superuser_id IS NOT NULL THEN
    PERFORM ensure_superuser_profile(superuser_id, superuser_email);
  END IF;
END;
$$;