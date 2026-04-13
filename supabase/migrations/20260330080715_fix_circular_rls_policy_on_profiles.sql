/*
  # Fix Circular RLS Policy on Profiles Table

  ## Problem
  The policy "Docenten and admin can read all profiles" contains a circular dependency:
  - When querying profiles, the policy does a subquery on profiles
  - This subquery triggers the same RLS policy check again
  - Results in infinite recursion and 500 Internal Server Error
  - Users cannot load their profiles, causing infinite loading loops

  ## Solution
  1. Drop the problematic circular policy
  2. Create a security definer function that bypasses RLS
  3. Add new policies that use this function to avoid recursion

  ## Changes
  
  ### Dropped Policies
  - "Docenten and admin can read all profiles" (circular dependency)
  - "Docent and admin can view all profiles" (duplicate/typo variant if exists)

  ### New Functions
  - `is_admin_or_docent()` - Security definer function to check user role without triggering RLS

  ### New Policies
  - "Admin and docent can view all profiles" - Uses security definer function to avoid recursion
  
  ## Security Notes
  - The "Users can read own profile" policy remains (always allows users to read their own data)
  - Security definer function is safe because it only checks the calling user's role
  - No data leakage possible as function only returns boolean for current user
*/

-- Drop the problematic circular policy
DROP POLICY IF EXISTS "Docenten and admin can read all profiles" ON profiles;
DROP POLICY IF EXISTS "Docent and admin can view all profiles" ON profiles;

-- Create security definer function to check if current user is admin or docent
-- This function bypasses RLS to avoid circular dependency
CREATE OR REPLACE FUNCTION is_admin_or_docent()
RETURNS boolean AS $$
DECLARE
  user_role text;
BEGIN
  -- Get the role of the current authenticated user
  -- This bypasses RLS because function is SECURITY DEFINER
  SELECT role INTO user_role
  FROM profiles
  WHERE id = auth.uid()
  LIMIT 1;
  
  -- Return true if user is admin or docent
  RETURN (user_role IN ('admin', 'docent'));
EXCEPTION
  WHEN OTHERS THEN
    -- If any error occurs, default to false (deny access)
    RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create new policy using the security definer function
-- This avoids circular dependency because the function bypasses RLS
CREATE POLICY "Admin and docent can view all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (is_admin_or_docent());

-- Add comment for clarity
COMMENT ON FUNCTION is_admin_or_docent() IS 
  'Security definer function to check if current user has admin or docent role. Bypasses RLS to prevent circular dependency in profile policies.';
