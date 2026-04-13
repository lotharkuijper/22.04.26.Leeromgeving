# Superuser System Documentation V3

## Overview

This application implements a **permanent superuser enforcement system** for the email address `l.d.j.kuijper@vu.nl`. This guarantees admin rights through a triple-layered mechanism that runs automatically in Supabase, completely independent of frontend code or build environments.

## Implementation V3 (Complete Server-Side Enforcement)

The superuser system operates through THREE independent layers that guarantee admin rights in all circumstances, independent of frontend code or deployment environments.

### Layer 1: Database Triggers (Permanent, Always Active)

**Location**: `supabase/migrations/*_enhance_superuser_triggers_with_logging.sql`

**What it does**: BEFORE INSERT/UPDATE triggers automatically set `role='admin'` for the superuser email BEFORE data is written to the database. This makes it impossible to bypass.

#### Trigger 1: `enforce_superuser_role_v3()` on `profiles` table
- **Fires**: BEFORE INSERT OR UPDATE on profiles
- **Behavior**: Forces `role='admin'` for superuser email
- **Logging**: Logs `[SUPERUSER ACTIVE]` to PostgreSQL logs
- **Security**: SECURITY DEFINER (elevated privileges)
- **Critical**: Runs BEFORE data is committed (impossible to bypass)

#### Trigger 2: `enforce_superuser_on_auth_users()` on `auth.users` table
- **Fires**: AFTER INSERT OR UPDATE on auth.users
- **Behavior**: Updates profile to admin if email changes
- **Logging**: Logs `[SUPERUSER ACTIVE]` to PostgreSQL logs
- **Security**: SECURITY DEFINER (elevated privileges)
- **Purpose**: Catches changes at the auth layer

#### Emergency RPC: `force_superuser_status(target_email text)`
- **Callable**: From frontend, Edge Function, or database console
- **Behavior**:
  - Creates profile if missing
  - Forces role to admin
  - Only works for superuser email
- **Security**: SECURITY DEFINER, bypasses RLS
- **Usage**: Emergency recovery callable from anywhere

#### Verification RPC: `verify_superuser_role(check_email text)`
- **Callable**: From anywhere
- **Returns**: JSON with current role status
- **Purpose**: Health check to verify superuser status

### Layer 2: Edge Function (Server-Side Enforcement)

**Location**: `supabase/functions/auth-enforce-superuser/index.ts`

**What it does**: Supabase Edge Function that runs on Supabase servers (NOT in your code). Called automatically by frontend on every login/signup/session refresh.

#### Features
- Uses SERVICE_ROLE_KEY (bypasses ALL RLS policies)
- Creates profile with admin role if missing
- Corrects role to admin if somehow wrong
- Works in preview builds, published builds, and local dev
- Deployed permanently to Supabase (survives code changes)

#### Logging
- All operations log `[SUPERUSER ACTIVE]` to Edge Function logs
- Visible in Supabase Dashboard > Edge Functions > Logs

#### Deployment
- Already deployed via `mcp__supabase__deploy_edge_function`
- Endpoint: `https://[project-ref].supabase.co/functions/v1/auth-enforce-superuser`
- No JWT verification (can be called anytime)

### Layer 3: Frontend Failsafes (Client-Side Backup)

**Location**: `src/contexts/AuthContext.tsx`

**What it does**: Triple failsafe mechanism in the frontend that detects and auto-corrects wrong roles.

#### Failsafe 1: `enforceSuperuserRole()`
- Called automatically on every login/signup
- Calls Edge Function to enforce role
- Calls RPC emergency function as backup
- Logs `[SUPERUSER ACTIVE]` to browser console

#### Failsafe 2: `fetchProfile()` with Detection
- Detects if role is wrong after fetch
- Automatically triggers emergency correction
- Retries profile fetch after correction
- Logs `[SUPERUSER FAILSAFE]` if wrong role detected

#### Failsafe 3: `onAuthStateChange()` Hook
- Monitors auth events (SIGNED_IN, TOKEN_REFRESHED)
- Automatically enforces role on every auth event
- Works on session restore and tab switching

#### Cache Management
- `clearAuthCache()` clears stale session data
- Called on every login/signup
- Prevents cached "Student" role from displaying

## Execution Flow V3

### Registration Flow (New User)
```
1. User signs up with l.d.j.kuijper@vu.nl
   ↓
2. auth.users record created in database
   ↓
3. ✅ Database Trigger: enforce_superuser_on_auth_users() fires
   ↓
4. Profile auto-created with role='admin' (server-side)
   ↓
5. Frontend: clearAuthCache()
   ↓
6. Frontend: enforceSuperuserRole() called
   ├─→ Edge Function: auth-enforce-superuser
   └─→ RPC: force_superuser_status()
   ↓
7. Wait 1.5 seconds for triggers to complete
   ↓
8. fetchProfile() retrieves admin profile
   ↓
9. ✅ User has immediate admin access
   ↓
10. Console logs: [SUPERUSER ACTIVE]
```

### Login Flow (Existing User)
```
1. User logs in with l.d.j.kuijper@vu.nl
   ↓
2. Supabase auth validates credentials
   ↓
3. Frontend: clearAuthCache()
   ↓
4. Frontend: enforceSuperuserRole() called
   ├─→ Edge Function: auth-enforce-superuser
   │   └─→ Verifies role='admin' in database
   └─→ RPC: force_superuser_status()
       └─→ Emergency backup verification
   ↓
5. Wait 1 second for enforcement
   ↓
6. fetchProfile() retrieves admin profile
   ↓
7. ✅ User logged in with admin access
   ↓
8. Console logs: [SUPERUSER ACTIVE] Admin access confirmed
```

### Session Restore Flow (Page Refresh)
```
1. Page loads with existing session cookie
   ↓
2. getSession() retrieves active session
   ↓
3. onAuthStateChange fires with TOKEN_REFRESHED event
   ↓
4. Frontend: enforceSuperuserRole() called
   ├─→ Edge Function verifies role
   └─→ RPC backup verification
   ↓
5. fetchProfile() fetches from database
   ↓
6. ✅ Database trigger guarantees role='admin'
   ↓
7. Profile loaded with admin access
   ↓
8. Console logs: [SUPERUSER ACTIVE]
```

### Emergency Recovery Flow (Wrong Role Detected)
```
1. fetchProfile() detects role='student' (somehow)
   ↓
2. Console logs: [SUPERUSER FAILSAFE] Wrong role detected!
   ↓
3. enforceSuperuserRole() activated
   ├─→ Edge Function: auth-enforce-superuser
   │   └─→ Uses SERVICE_ROLE to force update
   └─→ RPC: force_superuser_status()
       └─→ Creates/updates profile with admin
   ↓
4. Wait 1 second for corrections
   ↓
5. fetchProfile() retries
   ↓
6. ✅ Database trigger ensures role='admin'
   ↓
7. Profile corrected
   ↓
8. Console logs: [SUPERUSER ACTIVE] Admin access confirmed
```

## Why This Works (Guarantees)

### 1. Database Triggers Are Permanent
- Stored in database schema (not in code)
- Survive code deployments and rebuilds
- Run automatically on EVERY data change
- BEFORE triggers cannot be bypassed (data written with correct role)
- Work in preview, published, and local environments

### 2. Edge Function Is Server-Side
- Deployed to Supabase servers (not in your frontend code)
- Uses SERVICE_ROLE_KEY (maximum privileges, bypasses RLS)
- Runs independently of browser or frontend state
- Survives deployments (not part of build artifacts)
- Works even if frontend code has bugs

### 3. Frontend Provides Triple Redundancy
- Failsafe 1: Calls Edge Function on every login/signup
- Failsafe 2: Calls RPC emergency function as backup
- Failsafe 3: Detects wrong role and auto-corrects
- Clears cache to prevent stale data
- Logs everything for debugging

### 4. Multiple Points of Enforcement
```
Attempt to set role='student'
  ↓
❌ BLOCKED by database BEFORE trigger
  ↓
Even if bypassed somehow...
  ↓
❌ CORRECTED by auth.users AFTER trigger
  ↓
Even if both fail somehow...
  ↓
❌ FIXED by Edge Function on next login
  ↓
Even if Edge Function fails...
  ↓
❌ EMERGENCY CORRECTED by RPC function
  ↓
Even if all server-side fails...
  ↓
❌ FRONTEND DETECTS and calls emergency functions
```

### Result: IMPOSSIBLE to be non-admin

## What's New in V3

### New Components
- ✅ Edge Function: `auth-enforce-superuser` (deployed to Supabase)
- ✅ Enhanced database triggers with comprehensive logging
- ✅ Trigger on auth.users table (catches changes at source)
- ✅ RPC: `verify_superuser_role()` for health checks
- ✅ Frontend: `enforceSuperuserRole()` function
- ✅ Frontend: `clearAuthCache()` cache management
- ✅ Auto-correction on auth state changes (TOKEN_REFRESHED, SIGNED_IN)

### Enhanced Features
- ✅ All layers log `[SUPERUSER ACTIVE]` for easy debugging
- ✅ Triple redundancy (Database → Edge Function → Frontend)
- ✅ Works in ALL environments (preview, published, local)
- ✅ Survives deployments, rebuilds, cache clears
- ✅ Emergency recovery if wrong role detected
- ✅ Health check verification function

## Testing the System

### Test 1: Fresh Login (Most Important)
**Steps:**
1. Logout completely
2. Clear browser cache: Ctrl+Shift+Delete (Windows/Linux) or Cmd+Shift+R (Mac)
3. Login with `l.d.j.kuijper@vu.nl`

**Expected Results:**
- Console logs `[SUPERUSER] Login detected, enforcing admin role...`
- Console logs `[SUPERUSER ACTIVE] Edge function response`
- Console logs `[SUPERUSER ACTIVE] RPC failsafe response`
- Console logs `[SUPERUSER ACTIVE] Admin access confirmed`
- UI shows "Admin" badge (NOT "Student")

### Test 2: Database Manipulation (Trigger Test)
**Steps:**
```sql
-- Try to force wrong role
UPDATE profiles SET role='student' WHERE email='l.d.j.kuijper@vu.nl';

-- Check result
SELECT email, role FROM profiles WHERE email='l.d.j.kuijper@vu.nl';
```

**Expected Results:**
- Role is STILL 'admin' (trigger blocked the change)
- PostgreSQL logs show `[SUPERUSER ACTIVE] Role enforced`

### Test 3: Edge Function Manual Call
**Steps:**
```typescript
const { data } = await supabase.functions.invoke('auth-enforce-superuser', {
  body: { email: 'l.d.j.kuijper@vu.nl' }
});
console.log(data);
```

**Expected Results:**
```json
{
  "success": true,
  "message": "[SUPERUSER ACTIVE] Admin status confirmed",
  "profile": { "email": "l.d.j.kuijper@vu.nl", "role": "admin" }
}
```

### Test 4: Emergency RPC Function
**Steps:**
```typescript
const { data } = await supabase.rpc('force_superuser_status');
console.log(data);
```

**Expected Results:**
```json
{
  "success": true,
  "message": "[SUPERUSER ACTIVE] Role corrected to admin",
  "user_id": "...",
  "email": "l.d.j.kuijper@vu.nl"
}
```

### Test 5: Health Check
**Steps:**
```typescript
const { data } = await supabase.rpc('verify_superuser_role');
console.log(data);
```

**Expected Results:**
```json
{
  "exists": true,
  "email": "l.d.j.kuijper@vu.nl",
  "role": "admin",
  "is_correct": true
}
```

### Test 6: Missing Profile Recovery
**Steps:**
```sql
-- Delete profile
DELETE FROM profiles WHERE email='l.d.j.kuijper@vu.nl';
```
Then login again.

**Expected Results:**
- Frontend creates profile automatically
- Triggers set role to 'admin'
- Console logs `[SUPERUSER ACTIVE] Superuser profile created`
- UI shows admin access

## Logging & Debugging

### Database Logs
Check Supabase Dashboard → Database → Logs:
```
[SUPERUSER ACTIVE] Role enforced for l.d.j.kuijper@vu.nl at 2024-03-29...
[SUPERUSER ACTIVE] Profile role corrected via auth trigger
[SUPERUSER ACTIVE] Emergency role correction executed
```

### Edge Function Logs
Check Supabase Dashboard → Edge Functions → auth-enforce-superuser → Logs:
```
[SUPERUSER ACTIVE] Processing l.d.j.kuijper@vu.nl (LOGIN)
[SUPERUSER ACTIVE] Admin status confirmed
[SUPERUSER] Fixing incorrect role: student → admin
```

### Browser Console Logs
Open browser DevTools console:
```
[SUPERUSER] Login detected, enforcing admin role...
[SUPERUSER ACTIVE] Edge function response: {...}
[SUPERUSER ACTIVE] RPC failsafe response: {...}
[SUPERUSER ACTIVE] Admin access confirmed for l.d.j.kuijper@vu.nl
```

### Error Logs
If something fails, check for:
```
[SUPERUSER FAILSAFE] Wrong role detected! Current: student Expected: admin
[SUPERUSER] Activating emergency role correction...
[SUPERUSER] Edge function call failed: ...
```

## Maintenance

**CRITICAL - DO NOT MODIFY:**
- `enforce_superuser_role_v3()` database trigger function
- `enforce_superuser_on_auth_users()` database trigger function
- `auth-enforce-superuser` Edge Function logic
- Hardcoded email `l.d.j.kuijper@vu.nl` in all layers
- SERVICE_ROLE_KEY usage in Edge Function

**Safe to Modify:**
- Log messages (keep `[SUPERUSER ACTIVE]` prefix for searching)
- Timeout values (currently 1s for login enforcement, 1.5s for signup)
- Retry delays (currently 500ms and 1000ms)
- Cache clearing behavior

## Adding More Superusers

To add additional superusers, update all three layers:

**1. Database Triggers:**
```sql
-- In both enforce_superuser_role_v3() and enforce_superuser_on_auth_users()
IF user_email IN ('l.d.j.kuijper@vu.nl', 'another@example.com') THEN
  NEW.role := 'admin';
END IF;
```

**2. Edge Function:**
Update `supabase/functions/auth-enforce-superuser/index.ts`:
```typescript
const SUPERUSER_EMAILS = ['l.d.j.kuijper@vu.nl', 'another@example.com'];
const isSuperuser = SUPERUSER_EMAILS.includes(userEmail);
```

**3. Frontend:**
Update `src/contexts/AuthContext.tsx`:
```typescript
const SUPERUSER_EMAILS = ['l.d.j.kuijper@vu.nl', 'another@example.com'];
```

Then redeploy the Edge Function:
```bash
supabase functions deploy auth-enforce-superuser --no-verify-jwt
```

## Troubleshooting

### Problem: UI Shows "Student" Instead of "Admin"

**Solutions (try in order):**
1. Hard refresh: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
2. Clear browser cache completely
3. Open in incognito/private window
4. Logout and login again
5. Run emergency RPC in console:
   ```typescript
   await supabase.rpc('force_superuser_status')
   ```

### Problem: Edge Function Not Responding

**Check:**
1. Supabase Dashboard → Edge Functions → verify `auth-enforce-superuser` is deployed
2. Check function logs for errors
3. Manually test:
   ```typescript
   const { data } = await supabase.functions.invoke('auth-enforce-superuser', {
     body: { email: 'l.d.j.kuijper@vu.nl' }
   });
   console.log(data);
   ```

### Problem: Database Trigger Not Firing

**Check:**
```sql
-- Verify triggers exist and are enabled
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE tgname IN ('enforce_superuser_on_profiles', 'enforce_superuser_on_auth_users_trigger');
-- tgenabled should be 'O' (origin/enabled)
```

**Fix:**
```sql
-- Re-enable if disabled
ALTER TABLE profiles ENABLE TRIGGER enforce_superuser_on_profiles;
ALTER TABLE auth.users ENABLE TRIGGER enforce_superuser_on_auth_users_trigger;
```

### Problem: Console Shows "[SUPERUSER FAILSAFE] Wrong role detected"

**This is NOT an error!** The failsafe system is working correctly and auto-correcting the role. Wait 2 seconds and verify:
- Console logs `[SUPERUSER ACTIVE] Admin access confirmed`
- UI shows "Admin"

If it keeps looping, run emergency RPC:
```typescript
await supabase.rpc('force_superuser_status')
```

### Problem: Profile Not Found After Login

**This is automatically handled** by the system. The frontend will create the profile with admin role. Check console for:
```
[AUTH] No profile found, attempting to create one...
[SUPERUSER ACTIVE] Superuser profile created
[AUTH] Profile created, retrying fetch...
```

## Security & Architecture Notes

### Why This Is Secure
- Superuser email is **hardcoded in database** (can't be changed via API)
- Database triggers run with SECURITY DEFINER (elevated privileges)
- Edge Function uses SERVICE_ROLE_KEY (bypasses all RLS)
- Frontend failsafes detect tampering and auto-correct
- Multiple independent verification layers

### Why This Survives Deployments
- **Database triggers**: Stored in database schema, not in code
- **Edge Function**: Deployed to Supabase servers, not in builds
- **Both persist** through code changes, rebuilds, and deployments

### Why This Works Everywhere
- **Preview builds**: Triggers and Edge Function run server-side
- **Published builds**: Same server-side infrastructure
- **Local development**: Uses same Supabase project
- **All browsers**: No browser-specific code

## Summary

You are NOW permanently admin through:

1. **Database Triggers** - Force admin role BEFORE data is written
2. **Edge Function** - Verifies and corrects role on every login
3. **Frontend Failsafes** - Detects wrong role and auto-corrects
4. **Emergency RPC** - Manual correction available anytime

This works in:
- ✅ Preview builds
- ✅ Published builds
- ✅ Local development
- ✅ After cache clear
- ✅ After logout/login
- ✅ After database updates
- ✅ All browsers
- ✅ Incognito mode

**IT IS IMPOSSIBLE TO NOT BE ADMIN** with your email.
