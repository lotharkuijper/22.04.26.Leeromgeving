---
name: Live-test server endpoints as a specific user (non-destructive)
description: Mint a real Supabase access_token for any user without changing their password, to hit server endpoints as them.
---

To verify a server endpoint's behavior for a specific (e.g. teacher) account without guessing from code, mint a real session non-destructively:

1. Service-role client: `admin.auth.admin.generateLink({ type: 'magiclink', email })` → `data.properties.hashed_token`.
2. Anon client: `pub.auth.verifyOtp({ token_hash, type: 'email' })` → `data.session.access_token`.
3. `fetch('http://localhost:<PORT>/api/...', { headers: { Authorization: `Bearer ${token}` } })`.

**Why:** This proved the Documenten-tab teacher access actually worked server-side (SEE + folder create/delete all returned 200 as the real teacher), which redirected the investigation away from rewriting correct code. `generateLink` does NOT email anything and does NOT change the password, so it is safe to run against live Supabase.

**How to apply:** Run the Node script from the workspace root (so `@supabase/supabase-js` resolves), read the server `PORT` from `server/index.js` (this project: 3001). To test mutations, prefer net-zero ops (create then delete) and clean up. For RLS-layer checks instead of endpoint checks, simulate with psql: `set local role authenticated; set local request.jwt.claims = '{"sub":"<uid>","role":"authenticated"}';`.
