---
name: Supabase session invalidation after API-key/JWT rotation
description: Why every authenticated server endpoint can suddenly 401 while the client still shows signed-in, and how to recover.
---

# Zombie Supabase sessions after key/JWT rotation

When a Supabase project is migrated to the **new API-key format** (anon key becomes
`sb_publishable_...` instead of a legacy `eyJ...` JWT), existing **refresh tokens get
invalidated**. Browsers holding a cached session then enter a "zombie" state:

- `getSession()` still returns the cached session from localStorage; the client SDK
  keeps reporting `SIGNED_IN` and can still do some direct reads.
- The access token can no longer be refreshed (`refresh_token_not_found`), so it
  eventually expires and the **server** rejects it: `auth.getUser()` returns 401/403
  on **every** authenticated endpoint.

**Signature to recognize it:** client-side `[AUTH] Profile loaded ... admin` succeeds,
but all server calls (concepts, history, RAG, etc.) return 401 at the same time. This
is NOT an OpenAI/key problem even if the UI says so.

**Why the misleading "OpenAI weigerde de toegang":** `llmErrorToDutch` maps any 401/403
to an OpenAI-key message. Unrelated auth 401s on the page can surface as that text.

**How to diagnose fast (no user involvement):** mint a throwaway user via the service
role, sign in to get a fresh token, and hit both `/auth/v1/user` and a server route that
uses `requireAuthUser`. If the fresh token returns 200 everywhere, server/config/anon
key are fine and the user's cached session is the culprit. Delete the temp user after.

**Fix / recovery:**
- Immediate: the affected user logs out and logs back in (mints a fresh, valid session).
- Durable: on app load, after `getSession()`, validate the cached session with
  `auth.getUser()`; on a *definitive* auth error (401/403 or `AuthSessionMissingError`)
  sign out cleanly so the user is routed to login and self-heals. Do **not** sign out on
  transient errors (network/timeout, 429/5xx, generic `AuthApiError` without 401/403) or
  flaky connections will log people out. This logic lives behind a pure, tested helper.

**Why:** a cached-but-dead session otherwise leaves users stuck on a half-broken app with
a misleading error and no obvious escape.
