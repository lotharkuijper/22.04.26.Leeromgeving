# VU Amsterdam Epi/Bio Leeromgeving

Vite/React SPA + Express server + Supabase (PostgreSQL/auth/RLS).
LLM: Groq `llama-3.3-70b-versatile`. Embeddings: OpenAI `text-embedding-3-small`.
Taal: Nederlands, tweede persoon (`je`/`jij`). Superuser: `l.d.j.kuijper@vu.nl`.

## Architectuur
- `src/` — React frontend (pagina's, contexten, services).
- `server/index.js` — Express API: prompts, quiz, RAG, ItemBank-sync, mappings, mix.
- `supabase/migrations/` — SQL-migraties; gebruiker past ze handmatig toe in Supabase Studio. Server detecteert ontbrekende kolommen/tabellen defensief.
- Drie quiz-bronnen (Task #57): `rag` (cursusmateriaal via embeddings), `itembank` (ShareStats GitHub-mchoice items), `llm` (creatief). Mix per cursus instelbaar in admin.

## Belangrijke services
- `src/services/quiz-mix.service.ts` — orkestreert mix-aware quizgeneratie, format-conversie ItemBank→MCQQuestion.
- `src/services/sharestats-integration.service.ts` — GitHub-tree walker, `extype: mchoice`-filter, parse `exsection`-array.
- `src/services/llm.service.ts` — Groq client, generateQuiz, evaluators.
- `src/services/rag.service.ts` — Supabase vector-search.

## Admin-tabs
- `quiz_sources` (nieuw) — mix-sliders per cursus, ItemBank-mapping, RAG-folder mapping, 4 quiz-prompts editor.
- ItemBank-config in `chatbot_prompts` rij `__quiz_itembank_config__` (JSON: owner/repo/branch/last_synced_at).

## Conventies
- TypeScript strict, geen package.json edits.
- Data-testids op interactieve elementen.
- Dutch UI, second person.
- Shadcn UI + tailwind; lucide-react icons.
