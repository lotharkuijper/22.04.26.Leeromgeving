/*
  # Enhanced Superuser System with Logging and Failsafes

  1. Overview
    - Replaces existing superuser triggers with enhanced versions
    - Adds comprehensive logging for all superuser operations
    - Creates failsafe mechanisms to ensure role is always correct
    - Adds RPC function for emergency role correction

  2. Changes Made
    - Enhanced trigger function on profiles table with detailed logging
    - Added trigger on auth.users table to catch changes at the source
    - Created force_superuser_status() RPC for emergency corrections
    - Added verify_superuser_role() function for health checks

  3. Security
    - All functions run with SECURITY DEFINER (elevated privileges)
    - Only superuser email can be auto-promoted to admin
    - Extensive logging for audit trails
    - Immutable superuser email constant

  4. Features
    - BEFORE INSERT/UPDATE trigger ensures role='admin' before data is written
    - Automatic logging to PostgreSQL logs with [SUPERUSER ACTIVE] prefix
    - Emergency RPC function can be called from frontend as failsafe
    - Works independently of frontend or Edge Functions
*/

-- Drop existing triggers and functions to replace with enhanced versions
DROP TRIGGER IF EXISTS enforce_superuser_on_profiles ON profiles;
DROP FUNCTION IF EXISTS enforce_superuser_role();
DROP FUNCTION IF EXISTS enforce_superuser_role_v2();

-- Enhanced superuser enforcement function with comprehensive logging
CREATE OR REPLACE FUNCTION enforce_superuser_role_v3()
RETURNS trigger AS $$
DECLARE
  user_email text;
  superuser_email constant text := 'l.d.j.kuijper@vu.nl';
BEGIN
  -- Get email from auth.users or from NEW record
  IF TG_TABLE_NAME = 'profiles' THEN
    user_email := NEW.email;
    
    -- If email not set in profiles, fetch from auth.users
    IF user_email IS NULL THEN
      SELECT email INTO user_email FROM auth.users WHERE id = NEW.id;
    END IF;
  END IF;

  -- Enforce superuser role
  IF user_email = superuser_email THEN
    -- Force admin role
    NEW.role := 'admin';
    NEW.updated_at := now();
    
    -- Log to PostgreSQL logs (visible in Supabase Dashboard)
    RAISE LOG '[SUPERUSER ACTIVE] Role enforced for % at %', user_email, now();
    RAISE NOTICE '[SUPERUSER ACTIVE] Admin role set for %', user_email;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on profiles table
CREATE TRIGGER enforce_superuser_on_profiles
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_superuser_role_v3();

-- Add trigger on auth.users to catch email changes
CREATE OR REPLACE FUNCTION enforce_superuser_on_auth_users()
RETURNS trigger AS $$
DECLARE
  superuser_email constant text := 'l.d.j.kuijper@vu.nl';
BEGIN
  -- If this is the superuser, ensure profile has admin role
  IF NEW.email = superuser_email THEN
    RAISE LOG '[SUPERUSER ACTIVE] Auth user change detected for %', NEW.email;
    
    -- Update profile if it exists
    UPDATE profiles 
    SET role = 'admin', updated_at = now()
    WHERE id = NEW.id AND role != 'admin';
    
    IF FOUND THEN
      RAISE LOG '[SUPERUSER ACTIVE] Profile role corrected via auth trigger';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Create trigger on auth.users
DROP TRIGGER IF EXISTS enforce_superuser_on_auth_users_trigger ON auth.users;
CREATE TRIGGER enforce_superuser_on_auth_users_trigger
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION enforce_superuser_on_auth_users();

-- Emergency RPC function to force superuser status
CREATE OR REPLACE FUNCTION force_superuser_status(target_email text DEFAULT 'l.d.j.kuijper@vu.nl')
RETURNS json AS $$
DECLARE
  target_user_id uuid;
  result json;
  superuser_email constant text := 'l.d.j.kuijper@vu.nl';
BEGIN
  -- Security check: only allow for superuser email
  IF target_email != superuser_email THEN
    RAISE EXCEPTION '[SUPERUSER] Emergency function only works for superuser email';
  END IF;

  -- Find user ID
  SELECT id INTO target_user_id FROM auth.users WHERE email = target_email;
  
  IF target_user_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'User not found',
      'email', target_email
    );
  END IF;

  -- Force update profile
  UPDATE profiles 
  SET role = 'admin', updated_at = now()
  WHERE id = target_user_id;

  IF NOT FOUND THEN
    -- Create profile if doesn't exist
    INSERT INTO profiles (id, email, role, full_name)
    VALUES (target_user_id, target_email, 'admin', 'Superuser Admin')
    ON CONFLICT (id) DO UPDATE SET role = 'admin', updated_at = now();
  END IF;

  RAISE LOG '[SUPERUSER ACTIVE] Emergency role correction executed for %', target_email;

  result := json_build_object(
    'success', true,
    'message', '[SUPERUSER ACTIVE] Role corrected to admin',
    'user_id', target_user_id,
    'email', target_email
  );

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Verification function to check superuser status
CREATE OR REPLACE FUNCTION verify_superuser_role(check_email text DEFAULT 'l.d.j.kuijper@vu.nl')
RETURNS json AS $$
DECLARE
  user_profile profiles%ROWTYPE;
  result json;
BEGIN
  SELECT * INTO user_profile FROM profiles WHERE email = check_email;
  
  IF NOT FOUND THEN
    RETURN json_build_object(
      'exists', false,
      'email', check_email,
      'message', 'Profile not found'
    );
  END IF;

  result := json_build_object(
    'exists', true,
    'email', user_profile.email,
    'role', user_profile.role,
    'is_correct', user_profile.role = 'admin',
    'last_updated', user_profile.updated_at
  );

  IF user_profile.role = 'admin' THEN
    RAISE LOG '[SUPERUSER ACTIVE] Verification passed for %', check_email;
  ELSE
    RAISE WARNING '[SUPERUSER] ROLE MISMATCH: Expected admin, got %', user_profile.role;
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Grant execute permissions on RPC functions
GRANT EXECUTE ON FUNCTION force_superuser_status(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION verify_superuser_role(text) TO authenticated, anon;

-- Log successful deployment
DO $$
BEGIN
  RAISE LOG '[SUPERUSER] Enhanced trigger system deployed successfully at %', now();
END $$;
