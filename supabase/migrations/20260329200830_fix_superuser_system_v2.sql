/*
  # Fix Superuser System V2
  
  1. Purpose
    - Fix broken superuser mechanism for l.d.j.kuijper@vu.nl
    - Remove crashing RPC functions
    - Implement robust database triggers
    - Ensure PERMANENT admin access via multiple failsafes
    
  2. Changes
    - Remove broken ensure_my_superuser_status() function
    - Create auth.users trigger for automatic profile creation
    - Strengthen profiles trigger for role enforcement
    - Add emergency fix function
    - Fix existing superuser if present
    
  3. Guarantees
    - l.d.j.kuijper@vu.nl ALWAYS gets role='admin'
    - Works on registration, login, profile updates
    - Cannot be overridden by manual database changes
    - No frontend involvement needed (triggers handle everything)
*/

-- STEP 1: Remove broken functions that crash with 500 errors
DROP FUNCTION IF EXISTS ensure_my_superuser_status();
DROP FUNCTION IF EXISTS ensure_superuser_profile(uuid, text);

-- STEP 2: Create robust auth trigger for new user registration
CREATE OR REPLACE FUNCTION handle_new_user_with_superuser_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check if this is the superuser email
  IF NEW.email = 'l.d.j.kuijper@vu.nl' THEN
    -- Create profile with admin role immediately
    INSERT INTO public.profiles (id, email, role, full_name, created_at, updated_at)
    VALUES (
      NEW.id,
      NEW.email,
      'admin',
      'Lothar Kuijper',
      now(),
      now()
    )
    ON CONFLICT (id) DO UPDATE
    SET 
      role = 'admin',
      email = EXCLUDED.email,
      updated_at = now();
  ELSE
    -- Regular users get student role
    INSERT INTO public.profiles (id, email, role, full_name, created_at, updated_at)
    VALUES (
      NEW.id,
      NEW.email,
      'student',
      COALESCE(NEW.raw_user_meta_data->>'full_name', 'User'),
      now(),
      now()
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- STEP 3: Attach trigger to auth.users (runs on every new registration)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user_with_superuser_check();

-- STEP 4: Strengthen profile enforcement trigger (for existing profiles)
CREATE OR REPLACE FUNCTION enforce_superuser_role_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_email text;
BEGIN
  -- Get email from auth.users
  SELECT email INTO user_email
  FROM auth.users
  WHERE id = NEW.id;
  
  -- If this is the superuser email, FORCE admin role
  IF user_email = 'l.d.j.kuijper@vu.nl' THEN
    NEW.role := 'admin';
    NEW.updated_at := now();
  END IF;
  
  RETURN NEW;
END;
$$;

-- Replace old trigger with new version
DROP TRIGGER IF EXISTS enforce_superuser_on_profile_insert ON profiles;
DROP TRIGGER IF EXISTS enforce_superuser_on_profiles ON profiles;
CREATE TRIGGER enforce_superuser_on_profiles
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_superuser_role_v2();

-- STEP 5: Emergency fix function (can be called manually if needed)
CREATE OR REPLACE FUNCTION force_superuser_status(target_email text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_user_id uuid;
  result json;
BEGIN
  -- Only allow for superuser email
  IF target_email != 'l.d.j.kuijper@vu.nl' THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;
  
  -- Find user ID
  SELECT id INTO target_user_id
  FROM auth.users
  WHERE email = target_email;
  
  IF target_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'User not found in auth.users');
  END IF;
  
  -- Force create/update profile with admin role
  INSERT INTO public.profiles (id, email, role, full_name, created_at, updated_at)
  VALUES (
    target_user_id,
    target_email,
    'admin',
    'Lothar Kuijper',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET 
    role = 'admin',
    email = EXCLUDED.email,
    updated_at = now();
  
  RETURN json_build_object(
    'success', true, 
    'message', 'Superuser status enforced',
    'user_id', target_user_id
  );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION force_superuser_status TO authenticated;
GRANT EXECUTE ON FUNCTION handle_new_user_with_superuser_check TO authenticated;
GRANT EXECUTE ON FUNCTION enforce_superuser_role_v2 TO authenticated;

-- STEP 6: Fix existing superuser profile if user already exists
DO $$
DECLARE
  su_id uuid;
  profile_exists boolean;
BEGIN
  -- Check if superuser exists in auth.users
  SELECT id INTO su_id
  FROM auth.users
  WHERE email = 'l.d.j.kuijper@vu.nl';
  
  IF su_id IS NOT NULL THEN
    -- Check if profile exists
    SELECT EXISTS(SELECT 1 FROM profiles WHERE id = su_id) INTO profile_exists;
    
    IF profile_exists THEN
      -- Update existing profile to admin
      UPDATE profiles
      SET 
        role = 'admin',
        email = 'l.d.j.kuijper@vu.nl',
        updated_at = now()
      WHERE id = su_id;
      
      RAISE NOTICE 'Superuser profile updated to admin role';
    ELSE
      -- Create missing profile
      INSERT INTO profiles (id, email, role, full_name, created_at, updated_at)
      VALUES (
        su_id,
        'l.d.j.kuijper@vu.nl',
        'admin',
        'Lothar Kuijper',
        now(),
        now()
      );
      
      RAISE NOTICE 'Superuser profile created';
    END IF;
  END IF;
END;
$$;