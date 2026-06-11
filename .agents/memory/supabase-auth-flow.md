---
name: Supabase auth flow constraints
description: Non-obvious rules for the AuthContext login/registration flow that prevent silent hangs.
---

# Supabase auth flow constraints

These rules exist because the login flow silently hung (button spun forever, no error) and existing-account signup gave no feedback. Keep them when touching `src/contexts/AuthContext.tsx`.

- **Never `await` Supabase calls inside the `onAuthStateChange` callback.** The callback holds an internal lock; calling `supabase.from(...)` / `supabase.auth.getUser()` inside it deadlocks → the whole client hangs. Keep the callback synchronous: only set session/user state, then defer profile loading via `setTimeout(..., 0)`.
  **Why:** classic Supabase-js v2 deadlock; symptom is a login button stuck "loading" with no error.

- **Don't gate navigation on the profile fetch.** `signIn`/`signUp` must NOT `await fetchProfile`. Navigation is driven by `user` state — the router (`src/App.tsx`) redirects `/login → /dashboard` once `user` is set. A slow/failed profile fetch must never block login.
  **How to apply:** load profile in the background (via the listener) with a timeout vangnet; pages already handle a missing/loading profile.

- **Wrap auth network calls in a timeout vangnet** (`withTimeout`): getSession, signIn, signUp, fetchProfile. Prevents the UI from hanging indefinitely on a stalled request.

- **Detect obfuscated existing-account signup.** Supabase `signUp` on an already-registered email (with confirm-email on) returns NO error but a "fake" user with `data.user.identities === []` and no session. Treat empty `identities` as "account exists" → throw `'User already registered'`, which `LoginPage` maps to i18n `login.err.alreadyRegistered` (NL+EN). Without this it silently looks like success.

- **Removing the signup UI from `LoginPage` does NOT disable self-registration.** Anyone with the anon key can still call `supabase.auth.signUp` directly. To truly close it the project owner must toggle off "Allow new users to sign up" in the Supabase Auth dashboard. Always surface this as a manual prerequisite when asked to "disable self-registration".
  **Why:** client-side UI removal is cosmetic; the GoTrue endpoint stays open until the dashboard setting is changed.

- **Bulk-provisioning students = invite + enroll, service-role only.** New accounts via `supabaseAdmin.auth.admin.inviteUserByEmail({redirectTo: <origin>/activate})` (sends activation mail), then enroll in `course_members` filling BOTH `member_role` and legacy `role`. For idempotency on existing members use upsert `onConflict: 'course_id,user_id'` with `ignoreDuplicates:true` so an existing teacher/superuser is never downgraded. Bulk email at scale needs custom SMTP in Supabase + `/activate` in the redirect allow-list, or invites get rate-limited (429).
  **How to apply:** see `/api/admin/bulk-accounts/provision` + `server/bulkAccounts.js`.
