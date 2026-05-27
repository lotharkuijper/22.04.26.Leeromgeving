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

## Conventies
- TypeScript strict, geen package.json edits.
- Data-testids op interactieve elementen.
- Dutch UI, second person.
- Shadcn UI + tailwind; lucide-react icons.
