# LEAP-VU — Learning & Engagement AI-Platform

Vite/React SPA + Express server + Supabase (PostgreSQL/auth/RLS).
LLM: Groq `llama-3.3-70b-versatile`. Embeddings: OpenAI `text-embedding-3-small`.
Taal: Nederlands, tweede persoon (`je`/`jij`). Superuser: `l.d.j.kuijper@vu.nl`.

## Architectuur / Belangrijkste mappen
- `src/` — React frontend (pagina's, contexten, services).
- `server/index.js` — Express API: prompts, quiz, RAG, ItemBank-sync, mappings, mix.
- `server/queryExpansion.js` — Synoniemen-map + `expandQuery()` voor Nederlandse vaktermen; spiegel van `src/services/queryExpansion.ts`.
- `supabase/migrations/` — SQL-migraties. Agent past ze zelf toe via een directe Postgres-verbinding (`SUPABASE_DB_URL`, session pooler, poort 5432). Server detecteert ontbrekende kolommen/tabellen defensief.
- Drie quiz-bronnen (Task #57): `rag` (cursusmateriaal via embeddings), `itembank` (ShareStats GitHub-mchoice items), `llm` (creatief). Mix per cursus instelbaar in admin.
- `src/pages/` — Wouter-loze, react-router-dom-pagina's; `ExplainPage`, `AdminPage`, `ChatPage`, etc.

## Belangrijke services
- `src/services/quiz-mix.service.ts` — orkestreert mix-aware quizgeneratie, format-conversie ItemBank→MCQQuestion.
- `src/services/sharestats-integration.service.ts` — GitHub-tree walker, `extype: mchoice`-filter, parse `exsection`-array.
- `src/services/llm.service.ts` — Groq client, generateQuiz, evaluators.
- `src/services/rag.service.ts` — Supabase vector-search. Gebruikt de Supabase RPC `match_document_chunks` direct.
- `src/services/queryExpansion.ts` — TypeScript-versie van de query-uitbreiding (gedeeld met `ExplainPage` en `AdminPage` types).

## RAG-instellingen
Per module (`chat`, `explain`, `quiz`, `project`) en per cursus instelbaar via `/api/rag-settings`. Velden:
- `similarity_threshold` (0.10–0.95)
- `match_count` (1–20)
- `rag_strict_mode` (boolean)
- `query_expansion_enabled` (boolean) — verrijkt korte vaktermen met Nederlandse synoniemen, key_points en de definition voordat de embedding wordt berekend. Standaard aan voor `explain`, uit voor de andere modules.

`extraction` heeft een eigen vorm met `similarity_threshold` en `min_evidence_chunks` (gebruikt door `/api/admin/extract-concepts`).

## Admin-tabs & Diagnose
- `quiz_sources` (nieuw) — mix-sliders per cursus, ItemBank-mapping, RAG-folder mapping, 4 quiz-prompts editor.
- ItemBank-config in `chatbot_prompts` rij `__quiz_itembank_config__` (JSON: owner/repo/branch/last_synced_at).
- `/api/admin/test-rag-similarity` accepteert `{ courseId, query, expand, definition?, keyPoints? }`. Met `expand: true` wordt `expandQuery()` toegepast en bevat het antwoord ook `embedQuery` zodat de admin-UI de verrijkte zoekstring kan tonen. Beschikbaar voor docenten (binnen hun cursussen) en admins.

## Projecten — beheer & beoordelaars (Task #80)
- `project_personas.persona_type` ∈ {`conversational`, `evaluator`}; ook op `course_personas`. Studenten zien evaluators NIET in `/room`; staff wel.
- `project_documents` (project-breed) — staff uploadt via `POST /api/projects/:id/documents`, lid leest via `GET`. Tekst wordt automatisch in elke persona-chat geïnjecteerd als blok "Projectmateriaal van de docent". Binaire datasets (Jamovi `.omv`, `.sav`, `.jasp`, `.rdata`, …) worden in `file_bytes`/`mime_type` opgeslagen — geen tekstextractie, niet als chat-context. Studenten downloaden via `GET /api/projects/:id/documents/:docId/download` (auth via `userHasProjectAccess`).
- Verborgen rubrics → `project_persona_documents.is_hidden_rubric=true`. Alleen staff mag uploaden, alleen op evaluator-persona's. Lijst-endpoint filtert hidden rubrics weg voor non-staff.
- `POST /api/projects/groups/:groupId/evaluate` — voert per evaluator de Groq-evaluatie uit (rubric + alle persona-gesprekken + projectdocs), schrijft één journal-entry per groepslid (`source_ref="group_evaluate:<groupId>:<personaId>:<requestId>"`).
- `POST /api/projects/:projectId/personas/:personaId/copy-to-library` — kopieert project-persona terug naar `course_personas` (idempotent op naam).
- Checkpoint-endpoint genereert ook 4-regelige Groq-samenvattingen per persona-thread → journal-entry per lid (`source_ref="group_thread_checkpoint:<cp.id>:<thread.id>"`); response bevat `threadSummariesAdded`.
- Persona-creatie zit in **Projecten → Beheer**; `PersonaLibraryTab` is read-only en dient als hergebruik-bibliotheek.
- ProjectRoomPage: persona als `<select>`-dropdown, persona-input is auto-resize textarea (Enter=verzenden, Shift+Enter=nieuwe regel, max ≈ 6 regels).

## Documentoordelen (Task #166, Fase 1)
- Tabel `project_document_reviews` (migratie `20260528100000_project_document_reviews.sql`): id, document_id, persona_id, group_id, verdict (enum `project_document_verdict` ∈ {`accepted`,`conditional`,`rejected`}), reasoning, relationship_delta (CHECK -5..+5), requested_by, raw_llm_response jsonb, created_at. RLS: SELECT voor groepsleden + staff van de cursus.
- `server/documentReview.js` — pure helpers: `validateReviewResponse` (parse + clamp delta, verdict-enum, reasoning niet leeg) en `canRequestDocumentReview({isStaff,isGroupMember})`. Getest via `server/__tests__/documentReview.test.js`.
- Endpoints onder `/api/projects/:projectId/documents/:docId/reviews`:
  - `GET ?groupId=` — lijst reviews voor (doc, groep). Toegang: staff of groepslid.
  - `POST { personaId, groupId }` — vraagt evaluator-persona om gestructureerd JSON-oordeel. Server gebruikt `OPENAI_CHAT_URL` + `OPENAI_MODEL` met `response_format: json_object` (1 retry bij ongeldig JSON), persisteert review + spiegelt per groepslid een `learning_journal_entries`-regel (`source_ref="document_review:<docId>:<personaId>:<reviewId>"`). Weigert binaire bestanden (`BINARY_DOWNLOAD_EXT_RE`) en docs zonder `content_text`. Verborgen rubrics van de evaluator (`is_hidden_rubric=true`) worden meegestuurd.
- `chatbot_prompts` sectie `project`, name `document_review`: editor-baar systeemsjabloon (`DEFAULT_DOCUMENT_REVIEW_PROMPT`). Geseed met `is_active=false` zodat docenten zelf activeren.
- `/api/projects/:projectId/room` retourneert nu ook `evaluators: [{id,name,avatar_emoji}]` zodat de UI per upload de oordelen-strip + "Vraag oordeel"-knoppen kan tonen, óók voor niet-staff (evaluator-persona's blijven uit de `personas`-dropdown gefilterd voor studenten).

## Persona-relaties (Task #167, Fase 2)
- Tabel `project_persona_relationships` (migratie `20260529100000_project_persona_relationships.sql` + RLS-verstrenging `20260529110000_project_persona_relationships_rls_tighten.sql`): unieke rij per (project, group, persona) met `score` (CHECK -10..+10, default 0) en `history` jsonb-array van events `{ts, source, refId, delta, note, by?}`. RLS na verstrenging: SELECT alleen voor staff (admin/superuser/teacher van de cursus). Studenten lezen uitsluitend via de server-endpoints die met service-role draaien en zelf score/history maskeren. INSERT/UPDATE alleen via service-role (server).
- `server/personaRelationship.js` — pure helpers (`clampScore`, `applyDelta`, `scoreToBucket`/`scoreToLabel` NL+EN, `appendHistory` met `maxItems`-rotatie (default 50), `hasHistoryRef`, `isBlocked`, `blockedMessage`, `buildPromptBlock`); constants `SCORE_MIN=-10`, `SCORE_MAX=+10`, `BLOCK_THRESHOLD=-8`. Getest via `server/__tests__/personaRelationship.test.js`.
- Server-hooks in `server/index.js`:
  - Persona-chat (`POST /api/projects/:projectId/persona-chat`): laadt vooraf de relatie, retourneert bij `score ≤ -8` direct `{ reply: blockedMessage, relationshipBlocked: true, relationship }` zonder thread- of user-bericht-save. Bij doorgang wordt `buildPromptBlock` voor elke echte persona in de systeemprompt geïnjecteerd (vóór RAG/projectmateriaal-blokken).
  - Document-review (`POST /api/projects/:projectId/documents/:docId/reviews`): na succesvolle persist roept `applyRelationshipDelta` aan met `source='document_review'`, `refId=review.id`, `note=verdict`. Idempotent via `refId` in history.
  - `GET /api/projects/:projectId/groups/:groupId/relationships?lang=` — overzicht per project-persona. Staff ziet score+volle history (laatste 5); studenten alleen label+timestamp+source.
  - `POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust` — staff-only handmatige correctie (`delta` -10..+10, `note` verplicht). Schrijft event met `source='staff_adjust'`, `refId=staff_adjust:<userId>:<ts>`, `by=userId`.
- `ProjectRoomPage`: badge naast persona-dropdown met label + (staff) numerieke score; blokkade-banner boven de chat-textarea + disable van invoer/send bij `blocked`; staff-paneel onder de project-materialen met tabel persona × score × label × laatste 5 events + Corrigeer-dialog (delta number ±10, motivatie-textarea); relaties worden herladen na elke review en na elke correctie.

## Cue-emissie bij gespreksafronding (Task #171, Fase 3)
- Migratie `20260530100000_persona_cue_emission.sql`: kolom `project_personas.cue_emission_enabled boolean NOT NULL DEFAULT true`; bestaande evaluator-rijen worden op `false` gezet (evaluators leveren oordelen via Fase 1, niet via cues).
- `server/personaRelationship.js` uitgebreid met pure helpers (getest in `personaRelationship.test.js`): `clampCueDelta` (-2..+2), `validateCueResponse({delta, reason})` (defensief: ongeldige JSON / missende reden / out-of-range → `{delta:0, reason:''}`, reden afgekapt op 280 tekens, emissie-uit ⇒ altijd 0), `buildCueInstructionBlock(lang)` (meta-prompt met regels: default 0, alleen op concrete cue uit de docent-tabel reageren, NOOIT op punten-/score-verzoeken of vleierij ingaan), `cueJsonInstruction(lang)`. Constants `CUE_DELTA_MIN=-2`, `CUE_DELTA_MAX=+2`.
- `POST /api/projects/groups/:groupId/threads/:threadId/close` (server): laadt persona (id, system_prompt, cue_emission_enabled, persona_type); als emissie aan staat (conversational + enabled + `hasCueTable(system_prompt)` true) bouwt de JSON-prompt uit met `relationship_delta`/`relationship_reason`-velden en injecteert `persona.system_prompt + buildCueInstructionBlock(lang)` als system-message zodat de docent-cue-tabel meegaat. Na succesvolle close wordt `applyRelationshipDelta({source:'persona_chat_close', refId:'thread_close:<threadId>', note:reason})` aangeroepen — idempotent op refId. Response blijft `{topics, agreements}`: stil voor studenten, zichtbaar voor staff in het Verstandhoudingen-paneel. `/close-preview` blijft ongewijzigd.
- Deterministische gate `hasCueTable(systemPrompt)` (pure helper, case-insensitive regex `/\bcue[\s-]?(tabel|table)\b/i`): zonder herkenbare cue-tabel-marker in de persona-prompt forceert de server delta=0, ongeacht wat het LLM produceert. Logt een waarschuwing wanneer emissie is uitgeschakeld vanwege ontbrekende tabel, zodat docenten kunnen debuggen waarom hun persona geen cues uitzendt.
- `applyRelationshipDelta` race-safe gemaakt via `pgPool`: atomic `INSERT ... ON CONFLICT (project_id, group_id, persona_id) DO UPDATE SET score = clamp(current + delta), history = current || event` met `WHERE` op `history @> {source,refId}` voor idempotentie; bij idempotente hit volgt 1× re-read. Fallback-pad (zonder pgPool) behoudt oude select+update/insert-flow voor testomgevingen.
- Admin (`ProjectsAdminTab`): nieuwe checkbox `cue_emission_enabled` (alleen zichtbaar voor `conversational` persona's) + uitklap-paneel met een Nederlandse voorbeeld-cue-tabel die docenten in de system_prompt kunnen plakken. `savePersona` stuurt het veld mee; evaluator-rijen krijgen automatisch `false`. POST/PATCH-endpoints én `POST /api/projects/copy-personas-from-library` (bulk-import) respecteren dezelfde regel en zijn defensief tegen ontbrekende kolom (oude DB).
- Prompt-injection-hardening: `sanitizeEventNote` in `personaRelationship.js` strippt newlines/tabs/control-chars + aanhalingstekens uit event-notes (incl. cue-redenen) vóór ze opnieuw in een system-prompt via `formatEvent` belanden; redenen worden tussen aanhalingstekens als citaat gewrapped en gecapt op 200 tekens, zodat een LLM-gegenereerde reden (uit studentcontent) geen nieuwe instructies kan injecteren in latere persona-chats.
- i18n: `room.relationship.eventSource.persona_chat_close` ("gespreksafronding" / "conversation close") + admin-keys `admin.projects.personas.cueEmissionLabel/Hint/cueTableTemplateTitle/cueTableTemplate` (NL+EN). `ProjectRoomPage` mapt de nieuwe event-source naar de label.

## Begrip ↔ bron-bewijs bij extractie (Task #243)
- Migratie `20260605100000_concept_evidence.sql` + RLS-verstrenging `20260605110000_concept_evidence_rls_tighten.sql`: tabel `concept_evidence` (concept_id FK CASCADE, course_id, document_id, chunk_id, snippet, similarity, created_at). RLS is cursus-scoped (admin/superuser + `course_members` van de cursus); schrijven enkel via service-role. Server detecteert defensief via `conceptEvidenceSchemaReady` (`detectConceptEvidenceSchema()` bij startup).
- `/api/admin/extract-concepts`: de verificatielus bewaart nu de `matched`-chunks (i.p.v. weggooien) en schrijft na `runReplace()` per geaccepteerd begrip de top-5 bronfragmenten weg (case-insensitief begrip-resolven, oude koppelingen eerst opruimen). Response bevat `evidenceWritten`/`conceptsLinked`; `RAGSetupPanel` toont dit via `admin.ragSetup.extract.statsEvidenceLinked` (NL+EN).
- `GET /api/concepts/evidence?conceptId=` (auth via `requireAuthUser`): filtert bewijsrijen per `course_id` via `userHasCourseAccess` (begrippen kunnen in de key_points-fallback gedeeld zijn tussen cursussen). `ExplainPage` merget opgeslagen bewijs (`fetchConceptEvidence` in `rag.service`) met de live RAG-chunks (dedupe op id of `documentId:content`-prefix, hoogste similarity wint), zodat geëxtraheerde begrippen altijd cursusmateriaal-context hebben.

## Conventies
- TypeScript strict, geen package.json edits.
- Data-testids op interactieve elementen.
- Dutch UI, second person.
- Shadcn UI + tailwind; lucide-react icons.
