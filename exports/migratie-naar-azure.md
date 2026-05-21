# LEAP-VU — Migratie naar VU Azure (overzicht)

> Status: voorstel / nog niet uitgevoerd. Bedoeld als gespreksstuk
> met VU-IT en collega's.

## Wat we nu hebben (om te weten wat er mee moet)
- **Frontend**: Vite/React SPA (poort 5000 in dev, gebouwd → statische bundel).
- **Backend**: Express API (`server/index.js`, poort 3001).
- **Database**: Supabase Postgres met **pgvector** (RAG-embeddings),
  ~60 migraties, een RPC-functie `match_document_chunks`, en
  uitgebreide **RLS-policies**.
- **Auth**: Supabase Auth (signUp / signIn / sessions). 20+
  frontend-bestanden gebruiken `supabase.auth.*`.
- **Storage**: Supabase Storage-bucket voor RAG-documenten + binaire
  projectdatasets (Jamovi etc.).
- **Supabase-client**: 42 bestanden importeren direct uit
  `@supabase/supabase-js` — niet alleen voor data, ook voor
  auth-tokens die naar onze eigen API worden meegestuurd.
- **Externe LLM-keys**: Groq + OpenAI (blijven gewoon werken vanuit
  Azure).

## Doelarchitectuur op Azure (voorstel)

| Onderdeel             | Vervangen door                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Frontend SPA          | Azure Static Web Apps **of** Azure App Service (Node)                                                              |
| Express API           | Azure App Service (Linux, Node 20) of Azure Container Apps                                                         |
| Postgres + pgvector   | **Azure Database for PostgreSQL — Flexible Server** (pgvector wordt ondersteund als extensie)                      |
| Supabase Auth         | **Microsoft Entra ID (Azure AD)** met OIDC — past goed bij VU-SSO (eduID/SURFconext); rollen in eigen Postgres-tabel |
| Supabase Storage      | **Azure Blob Storage** (met SAS-URLs voor downloads)                                                               |
| Supabase RLS          | Vervangen door **server-side autorisatie** in Express (clients praten via de API, niet rechtstreeks op de DB)     |
| Secrets               | **Azure Key Vault** (i.p.v. Replit secrets)                                                                        |
| Logs / monitoring     | Azure Application Insights                                                                                         |

## Wat dit qua codewijzigingen betekent
1. **Auth-laag isoleren.** Eén centrale hook `useAuth` en
   server-middleware `requireUser`. Vervang Supabase-sessietokens
   door MSAL/Entra-ID JWT's; backend valideert die met de
   Entra-JWKS.
2. **Supabase-client uitfaseren.** Voor data: alle
   `supabase.from(...)` en `supabase.rpc(...)`-aanroepen in de
   frontend → vervangen door fetch naar je eigen Express-API.
   Backend gebruikt `pg` (al aanwezig) of `drizzle` direct tegen
   Azure Postgres.
3. **Storage-aanroepen.** Upload/download endpoints in Express die
   Blob Storage aanspreken via `@azure/storage-blob`; frontend
   uploadt via een korte SAS-URL of via de API.
4. **RAG-RPC overzetten.** De SQL-functie `match_document_chunks` is
   gewoon Postgres + pgvector → 1-op-1 kopiëren naar Azure Postgres;
   RPC-aanroep wordt een normale `pg.query`.
5. **Migraties.** De 60 SQL-bestanden in `supabase/migrations/` deels
   herbruikbaar; het Supabase-`auth.users`-schema is dat **niet** —
   koppeling moet via een eigen `profiles`-tabel met
   `entra_object_id` i.p.v. `auth.users.id`.

## Datamigratie (Supabase → Azure Postgres)
1. **Schema-export**: `pg_dump --schema-only` van Supabase (zonder
   `auth.*`, `storage.*`, `supabase_*`-schema's).
2. **Data-export**: `pg_dump --data-only` voor alle
   `public.*`-tabellen.
3. **Restore** in Azure Postgres; pgvector eerst aanzetten
   (`CREATE EXTENSION vector`).
4. **Gebruikers**: Supabase-`auth.users` exporteren (mail,
   created_at) → in Azure niet meer hosten; bij eerste login via
   Entra ID koppelen op e-mail.
5. **Storage**: bucket leegtrekken (Supabase Storage API of
   `s3 sync` op de S3-compatibele endpoint) → uploaden naar Blob
   met `azcopy`.
6. **Embeddings hoeven niet opnieuw** — vector-kolommen migreren
   mee.

---

## Wat jij (VU-kant) moet regelen
1. **Azure-subscription / resource group** binnen VU-tenant, met
   budget.
2. **Entra ID app-registratie** (OIDC): redirect URL, client ID,
   eventueel een app-role-claim voor docent/admin.
   SURFconext-federatie afstemmen met VU-IT.
3. **Resources provisionen** (kan via Bicep/Terraform die ik kan
   opleveren): Postgres Flexible Server (met pgvector toegestaan),
   App Service-plan + 2 web apps (frontend + api), Storage Account
   met blob-container, Key Vault.
4. **Domeinnaam + TLS** (bv. `leap-vu.vu.nl`) via VU-IT.
5. **AVG / data-classificatie** afstemmen: studentnamen,
   dagboek-notities en LLM-prompts zijn herleidbaar. Tekenen of
   Groq/OpenAI mogen verwerken (of switchen naar Azure OpenAI in
   NL/EU-regio).
6. **Toegang tot huidige Supabase-DB** voor migratie (service role
   key + project ref).
7. **CI/CD-beslissing**: GitHub Actions vanuit een VU-org of Azure
   DevOps.

## Wat ik (in Build-mode) kan doen
1. **Auth-abstractielaag** invoeren zonder gedrag te veranderen
   (`src/lib/auth.ts` met dezelfde API), zodat een latere swap naar
   MSAL/Entra ID één bestand is.
2. **Resterende directe `supabase.from(...)`-aanroepen in de
   frontend wegrefactoren** naar API-endpoints op Express (sommige
   bestaan al, niet alle).
3. **Storage-abstractie** introduceren (`server/storage.ts`) met
   twee implementaties: Supabase nu, Blob later.
4. **`pg`-pool centraal** maken op de server (er is nu al een
   `SUPABASE_DB_URL` voor directe migraties — die kan zo naar Azure
   wijzen).
5. **Migratie-script** schrijven dat Supabase-migraties bundelt tot
   één idempotent SQL-bestand zonder Supabase-specifieke
   `auth.*`-verwijzingen.
6. **Bicep- of Terraform-templates** voor de Azure-resources
   opleveren.
7. **GitHub Actions workflow** (build → deploy naar App Service)
   opleveren.
8. **Dockerfile** voor de API (handig voor Container Apps en lokaal
   reproduceren).
9. **MSAL-integratie in React** (`@azure/msal-react`) en
   JWT-validatie-middleware op Express, met feature-flag.
10. **Migratie-runbook** (stap-voor-stap dump/restore + smoke
    tests) als markdown.

## Voorgestelde volgorde (los uit te voeren als losse taken)
1. Auth- en storage-abstracties invoeren (nog steeds tegen
   Supabase) — geen functionele wijziging.
2. Frontend volledig via eigen API laten praten (geen
   `supabase.from` meer in `src/`).
3. Bicep + Key Vault + lege Azure Postgres + Blob inrichten
   (dry-run).
4. Eénmalige schema- en data-dump testen naar Azure (staging).
5. Entra ID-login achter feature-flag aanzetten; e-mail-koppeling
   met bestaande profielen.
6. Cut-over: app naar Azure-URL, oude Supabase op read-only zetten,
   daarna afsluiten.
