/*
  # Fix Remaining Circular RLS Policies

  ## Problem
  The UPDATE policy "Admin can update all profiles" still contains circular dependency.
  This could potentially cause issues similar to the SELECT policy we fixed earlier.

  ## Solution
  Create an `is_admin()` security definer function and use it in the UPDATE policy.

  ## Changes
  
  ### New Functions
  - `is_admin()` - Security definer function to check if user is admin

  ### Updated Policies
  - Drop and recreate "Admin can update all profiles" policy using security definer function
  
  ## Security Notes
  - Security definer function bypasses RLS safely for the check
  - No data leakage as function only returns boolean
*/

-- Create security definer function to check if current user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
DECLARE
  user_role text;
BEGIN
  SELECT role INTO user_role
  FROM profiles
  WHERE id = auth.uid()
  LIMIT 1;
  
  RETURN (user_role = 'admin');
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop the old circular policy
DROP POLICY IF EXISTS "Admin can update all profiles" ON profiles;
DROP POLICY IF EXISTS "Only admin can change roles" ON profiles;

-- Create new policy using security definer function
CREATE POLICY "Admin can update all profiles"
  ON profiles FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Add comment
COMMENT ON FUNCTION is_admin() IS 
  'Security definer function to check if current user has admin role. Bypasses RLS to prevent circular dependency.';
