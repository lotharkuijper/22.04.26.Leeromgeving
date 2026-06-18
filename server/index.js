import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import officeParserPkg from 'officeparser';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parseOfficeAsync = (buffer) => new Promise((resolve, reject) => {
  officeParserPkg.parseOffice(buffer, (data, err) => {
    if (err) reject(err); else resolve(data);
  });
});
import { createClient } from '@supabase/supabase-js';
import { expandQuery } from './queryExpansion.js';
import {
  extractPptxStructured,
  buildDeckText,
  slideToText,
  validateSections,
  fallbackChunks,
  splitLongSections,
  estimateTokens as estimatePptxTokens,
} from './pptxExtract.js';
import pkg from 'pg';
const { Pool } = pkg;
import {
  authorizeMemberRoleChange,
  checkLastTeacherProtection,
  parseForceFlag,
} from './memberRoleAuth.js';
import { validateReviewResponse, canRequestDocumentReview, badgeForGrade, normalizeBadgeAwardMode } from './documentReview.js';
import { authorizeAvailabilityChange, parseStudentVisible, memberCanAccessCourse, canAccessCourseContent } from './courseAvailability.js';
import { collectMemberUserIds, mergeCourseMembers } from './courseMembers.js';
import { buildLanguageInstruction, localizePrompt, languageEnglishName, normalizeLang } from './languages.js';
import {
  extractEmails,
  dedupeEmails,
  normalizeEmailList,
  authorizeBulkProvision,
  validateBatchSize,
  buildActivationRedirect,
  MAX_BULK_BATCH,
} from './bulkAccounts.js';
import {
  processPptxCore as processPptxCoreImpl,
  processPlainRagDocument as processPlainRagDocumentImpl,
} from './ragProcessing.js';
import { parseItembankCsv, csvRowToQuizQuestion } from './itembankCsv.js';
import { normalizeMix } from './quizSourcesMix.js';
import {
  discoverPages as discoverWebPages,
  fetchPage as fetchWebPage,
  htmlToText as webHtmlToText,
  extractTitle as webExtractTitle,
  normalizeUrl as normalizeWebUrl,
  sameWebEnvironment as sameWebEnv,
  isBlockedHost as isBlockedWebHost,
  WEB_IMPORT_LIMITS,
} from './webImport.js';
import { promises as dnsPromises } from 'node:dns';
import { isUnsupportedSamplingParamError, isEmptyOrTruncatedCompletion, postChatCompletionWithRetry } from './openaiSampling.js';
import { computeChatConfig } from './chatConfig.js';
import {
  normalizeTargetLang,
  normalizePageKey,
  normalizeSourceText,
  hashSource,
  buildTranslationPrompt,
  MAX_SOURCE_CHARS as TRANSLATION_MAX_SOURCE_CHARS,
} from './documentTranslation.js';
import { registerCourseInfoRoutes } from './courseInfo.js';
import { registerRelationshipAdjustRoute } from './relationshipAdjust.js';
import { registerConceptEvidenceRoutes } from './conceptEvidence.js';
import { convertOfficeToPdf, queueConversion, normalizeExt, CONVERT_TO_PDF_EXT, NATIVE_PDF_EXT, TEXT_EXT } from './documentRender.js';
import { planConceptReplace, planConceptWrites } from './conceptExtraction.js';
import {
  scoreToLabel as relScoreToLabel,
  scoreToBucket as relScoreToBucket,
  isBlocked as relIsBlocked,
  blockedMessage as relBlockedMessage,
  buildRelationshipPromptBlock as relBuildPromptBlock,
  validateCueResponse as relValidateCueResponse,
  buildCueInstructionBlock as relCueInstructionBlock,
  cueJsonInstruction as relCueJsonInstruction,
  hasCueTable as relHasCueTable,
} from './personaRelationship.js';
import {
  computeEffectiveLimit as conComputeEffectiveLimit,
  computeRemaining as conComputeRemaining,
  isConsultationBlocked as conIsBlocked,
  normalizeAutoCloseHours as conNormalizeAutoCloseHours,
  normalizeMaxConsultations as conNormalizeMax,
  normalizeExtraGrant as conNormalizeExtra,
  isThreadStale as conIsThreadStale,
  consultationLimitMessage as conLimitMessage,
} from './consultationLimit.js';
import { applyRelationshipDeltaImpl } from './threadClose.js';

// Directe Postgres-verbinding voor operaties die PostgREST niet kan
// uitvoeren, zoals bytea-inserts van binaire bestanden.


// DNS-resolver voor de SSRF-bescherming van de web-import: resolved een hostnaam
// naar al zijn A/AAAA-adressen zodat `fetchPage`/`discoverPages` elk resolved IP
// tegen de geblokkeerde ranges kunnen toetsen (DNS-rebinding/SSRF-bypass). Wordt
// als `lookup` geïnjecteerd; bij een resolutiefout gooit het, wat de helpers als
// "geblokkeerd" (fail-safe) behandelen.
async function resolveHostAddresses(hostname) {
  const records = await dnsPromises.lookup(hostname, { all: true });
  return records.map((rec) => rec.address);
}

let pgPool = null;
if (process.env.SUPABASE_DB_URL) {
  pgPool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  pgPool.on('error', (err) => console.error('[pgPool] client error', err.message));
}

// 15 MB ruwe upload-cap; tekstextractie kan kleiner uitkomen en wordt
// daarna nog eens beperkt door MAX_DOC_CHARS.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SUPABASE_URL = process.env.VITE_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPERUSER_EMAIL = 'l.d.j.kuijper@vu.nl';

let supabaseAdmin = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  console.log('[API Server] Supabase admin client initialized (service role)');
} else {
  console.warn('[API Server] SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL missing — admin routes disabled');
}

// === Azure OpenAI (chat/completions) ===
// Alle chat-/completion-aanroepen lopen via de Azure OpenAI-resource van de VU
// (leap-openai-vu). Routing gebeurt via de deployment in de URL; authenticatie
// via de 'api-key'-header (niet Bearer). Embeddings lopen óók via Azure — zie de
// embedding-config hieronder (text-embedding-3-small, géén publieke OpenAI).
// De chat-configuratie (URL + guard) wordt door een pure helper berekend zodat
// hij in tests verifieerbaar is zonder de Express-app te starten. Géén
// OpenAI-fallback voor chat: als Azure niet is geconfigureerd blijft de URL
// leeg en falen chat-calls expliciet (de endpoints gaten bovendien op
// AZURE_CHAT_READY). Zie server/chatConfig.js + chatConfig.test.js (Task #249).
const {
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  deployment: AZURE_OPENAI_DEPLOYMENT,
  azureChatReady: AZURE_CHAT_READY,
  chatUrl: OPENAI_CHAT_URL,
} = computeChatConfig(process.env);
const LLM_NOT_CONFIGURED_MSG = 'Azure OpenAI is niet geconfigureerd op de server (AZURE_OPENAI_ENDPOINT en AZURE_OPENAI_API_KEY ontbreken).';
console.log(`[API Server] Azure chat ${AZURE_CHAT_READY ? 'gereed' : 'NIET geconfigureerd'} — deployment=${AZURE_OPENAI_DEPLOYMENT}, api-version=${AZURE_OPENAI_API_VERSION}`);
// Auth-headers voor een chat-call. Azure verwacht de 'api-key'-header.
function chatAuthHeaders() {
  return { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' };
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// GPT-5 en o1/o3 modellen accepteren geen 'max_tokens' meer; ze vereisen
// 'max_completion_tokens'. We detecteren dat aan de modelnaam zodat alle
// fetches automatisch de juiste sleutel meesturen.
const IS_REASONING_MODEL = /^(gpt-5|o1|o3|o4)/i.test(OPENAI_MODEL);
const MAX_TOKENS_PARAM = IS_REASONING_MODEL
  ? 'max_completion_tokens'
  : 'max_tokens';
// Reasoning-modellen verbruiken een deel van het tokenbudget aan 'reasoning'.
// Houd die inspanning laag zodat er ruimte overblijft voor zichtbare output;
// non-reasoning-modellen kennen deze parameter niet (zou een 400 geven).
const REASONING_EFFORT = 'low';
// Model-afhankelijke parameters voor de "satelliet"-LLM-aanroepen (quizgeneratie,
// beoordeling, samenvattingen, project-evaluaties, document-oordelen, cues, …).
// Reasoning-modellen (gpt-5.x / o1 / o3 / o4) weigeren een aangepaste temperature/
// top_p met een HTTP 400 en gebruiken in plaats daarvan 'reasoning_effort'; non-
// reasoning-modellen krijgen de meegegeven temperature. De juiste max-tokens-sleutel
// (max_completion_tokens vs max_tokens) wordt altijd gezet. Het centrale /api/chat-
// pad heeft zijn eigen, uitgebreidere afhandeling (retry + lege/afgekapte detectie).
function chatModelParams({ temperature, maxTokens, reasoningEffort } = {}) {
  const params = {};
  if (maxTokens != null) params[MAX_TOKENS_PARAM] = maxTokens;
  if (IS_REASONING_MODEL) {
    params.reasoning_effort = reasoningEffort || REASONING_EFFORT;
  } else if (temperature != null) {
    params.temperature = temperature;
  }
  return params;
}
// === Azure OpenAI (embeddings) ===
// Embeddings (RAG-ingestie, RAG-zoekvragen, concept-extractie) lopen óók via de
// Azure OpenAI-resource van de VU (text-embedding-3-small). Net als bij chat:
// routing via de deployment-naam in de URL, authenticatie via de 'api-key'-header.
// Géén terugval naar de publieke OpenAI-API: zonder embedding-deployment
// (AZURE_OPENAI_EMBEDDING_DEPLOYMENT) is AZURE_EMBEDDINGS_READY=false en falen
// alle embedding-calls expliciet met een 503.
const AZURE_OPENAI_EMBEDDING_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '';
const AZURE_OPENAI_EMBEDDING_API_VERSION = process.env.AZURE_OPENAI_EMBEDDING_API_VERSION || AZURE_OPENAI_API_VERSION;
const AZURE_EMBEDDINGS_READY = Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY && AZURE_OPENAI_EMBEDDING_DEPLOYMENT);
const OPENAI_EMBEDDINGS_URL = AZURE_EMBEDDINGS_READY
  ? `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${encodeURIComponent(AZURE_OPENAI_EMBEDDING_DEPLOYMENT)}/embeddings?api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION}`
  : '';
const EMBEDDINGS_NOT_CONFIGURED_MSG = 'Azure OpenAI embeddings zijn niet geconfigureerd op de server (AZURE_OPENAI_EMBEDDING_DEPLOYMENT ontbreekt). Embeddings/RAG lopen uitsluitend via VU-Azure; er is geen terugval naar de publieke OpenAI.';
// Auth-headers voor een embedding-call. Azure verwacht de 'api-key'-header.
function embeddingAuthHeaders() {
  return { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' };
}
console.log(`[API Server] Azure embeddings ${AZURE_EMBEDDINGS_READY ? 'gereed' : 'NIET geconfigureerd'} — deployment=${AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '(leeg)'}, api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION}`);

// Thin wrapper rond postChatCompletionWithRetry: alle "satelliet" chat-completion-
// aanroepen (quiz, beoordeling, project-evaluatie, samenvattingen) lopen hierdoor,
// zodat ze (1) de Azure-auth-headers + Azure-URL gebruiken en (2) bij een 400 op
// temperature/top_p één keer opnieuw proberen zonder die params. De body bevat
// model/messages plus de via chatModelParams() opgebouwde sampling-parameters.
function openaiChatCompletion(body) {
  return postChatCompletionWithRetry({ url: OPENAI_CHAT_URL, headers: chatAuthHeaders(), body });
}

const FALLBACK_SYSTEM_PROMPT = `Je bent een Socratische tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je begeleidt studenten door een balans van korte uitleg en uitdagende vragen.

Regels:
1. Geef ALTIJD eerst 2-3 zinnen heldere uitleg over het concept
2. Volg op met één uitdagende vervolgvraag die aanzet tot kritisch denken
3. Houd antwoorden beknopt — vermijd lange theoretische uiteenzettingen
4. Geef studenten genoeg context om zelfstandig na te denken
5. Prijs deelantwoorden en moedig studenten aan dieper na te denken`;

const RAG_MODULE_DEFAULTS = {
  chat:    { similarity_threshold: 0.70, match_count: 5,  rag_strict_mode: false, query_expansion_enabled: false },
  explain: { similarity_threshold: 0.50, match_count: 5,  rag_strict_mode: true,  query_expansion_enabled: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5,  rag_strict_mode: true,  query_expansion_enabled: false },
  project: { similarity_threshold: 0.60, match_count: 7,  rag_strict_mode: false, query_expansion_enabled: false },
};

const RAG_EXTRACTION_DEFAULTS = {
  similarity_threshold: 0.55,
  min_evidence_chunks: 1,
};

// allowedFolderIds semantiek:
//   null / undefined  → geen folderfilter (alle chunks)
//   []                → expliciet geen toegang (geen resultaten)
//   [id, id, ...]     → alleen chunks uit deze folders
async function searchChunksServerSide(queryText, threshold, matchCount, allowedFolderIds, expansion, lang = 'nl') {
  if (!AZURE_EMBEDDINGS_READY || !supabaseAdmin) return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };

  // Expliciet lege toegestane mappen → geen toegang
  if (Array.isArray(allowedFolderIds) && allowedFolderIds.length === 0) {
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };
  }

  // Verrijk de zoekterm wanneer expansion-opties zijn meegegeven (synoniemen,
  // definitie, key_points). Dit geeft het embedding-model meer signaal voor
  // korte Nederlandse vaktermen waar text-embedding-3-small anders laag scoort.
  const embedQuery = (expansion && expansion.enabled)
    ? expandQuery(queryText, { definition: expansion.definition, keyPoints: expansion.keyPoints }, lang)
    : queryText;

  try {
    const embRes = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: embeddingAuthHeaders(),
      body: JSON.stringify({ model: 'text-embedding-3-small', input: [embedQuery] }),
    });
    if (!embRes.ok) {
      // Niet stil slikken: een mislukte Azure-embedding (bijv. 404 ontbrekende
      // deployment, 401 verkeerde key) leidde anders tot onzichtbare "0 resultaten".
      const errText = await embRes.text().catch(() => '');
      console.error(`[searchChunksServerSide] Azure embedding-call mislukt: HTTP ${embRes.status} — ${errText.slice(0, 300)}`);
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }
    const embData = await embRes.json();
    const embedding = embData.data?.[0]?.embedding;
    if (!embedding) {
      console.error('[searchChunksServerSide] Azure embedding-respons bevatte geen vector');
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }

    const { data: allChunks, error } = await supabaseAdmin.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: 0,
      match_count: Math.max(matchCount * 3, 15),
    });
    if (error || !allChunks) {
      if (error) console.error('[searchChunksServerSide] match_document_chunks RPC-fout:', error.message || JSON.stringify(error));
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }

    let candidate = allChunks;
    if (Array.isArray(allowedFolderIds) && allowedFolderIds.length > 0) {
      const docIds = [...new Set(allChunks.map(c => c.document_id))];
      const { data: docs } = await supabaseAdmin
        .from('documents')
        .select('id, folder_id')
        .in('id', docIds);
      const allowedDocIds = new Set((docs || []).filter(d => allowedFolderIds.includes(d.folder_id)).map(d => d.id));
      candidate = allChunks.filter(c => allowedDocIds.has(c.document_id));
    }

    return {
      matched: candidate.filter(c => c.similarity >= threshold).slice(0, matchCount),
      maxScore: candidate.length > 0 ? Math.max(...candidate.map(c => c.similarity)) : 0,
      candidatesInAllowed: candidate.length,
      embedQuery,
    };
  } catch (err) {
    console.error('[searchChunksServerSide] Error:', err.message);
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
  }
}

const RAG_STRICT_INSTRUCTION = `\n\nSTRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven uit het cursusmateriaal. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."`;

async function loadRagSettings(courseId) {
  if (!supabaseAdmin) return { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
  const keys = courseId
    ? [`__rag_settings_${courseId}__`, '__rag_settings_global__']
    : ['__rag_settings_global__'];
  for (const key of keys) {
    const { data } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('content')
      .eq('name', key)
      .maybeSingle();
    if (data?.content) {
      try {
        const parsed = JSON.parse(data.content);
        const merged = {};
        for (const mod of Object.keys(RAG_MODULE_DEFAULTS)) {
          merged[mod] = { ...RAG_MODULE_DEFAULTS[mod], ...(parsed[mod] || {}) };
        }
        merged.extraction = { ...RAG_EXTRACTION_DEFAULTS, ...(parsed.extraction || {}) };
        return merged;
      } catch { /* fall through to next key */ }
    }
  }
  return { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
}

let conceptsHasCourseId = false;
async function detectConceptsCourseIdColumn() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('concepts').select('course_id').limit(1);
    conceptsHasCourseId = !error || !error.message.includes('course_id');
    console.log(`[API Server] concepts.course_id: ${conceptsHasCourseId ? 'beschikbaar' : 'niet gemigreerd — key_points fallback actief'}`);
  } catch (e) {
    conceptsHasCourseId = false;
    console.warn('[API Server] Column detectie mislukt:', e.message);
  }
}

// Task #270: courses.student_visible bepaalt of een cursus zichtbaar/bruikbaar
// is voor studenten. Detecteer defensief of de migratie is toegepast, zodat een
// oude DB blijft werken (dan gedragen alle cursussen zich als zichtbaar) en de
// server-side toegangscheck (userHasCourseAccess) de kolom alleen raadpleegt
// wanneer hij bestaat.
let coursesHasStudentVisible = false;
async function detectCoursesStudentVisibleColumn() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('courses').select('student_visible').limit(1);
    coursesHasStudentVisible = !error || !/student_visible/.test(error.message || '');
    console.log(`[API Server] courses.student_visible: ${coursesHasStudentVisible ? 'beschikbaar' : 'niet gemigreerd — alle cursussen zichtbaar'}`);
  } catch (e) {
    coursesHasStudentVisible = false;
    console.warn('[API Server] courses.student_visible detectie mislukt:', e.message);
  }
}

// Task #52 (Quiz-omgeving herontwerp fase 1) breidt quiz_attempts uit met
// nieuwe kolommen (topics text[], difficulty, question_type, questions_data,
// answers, score_percentage, created_at). Detecteer of de migratie
// `20260430120000_extend_quiz_attempts_for_multi_type.sql` is toegepast,
// zodat /api/quiz/delete en de nieuwe insert-flow vroegtijdig en duidelijk
// kunnen falen als dat niet het geval is.
let quizAttemptsHasNewSchema = false;
async function detectQuizAttemptsSchema() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin
      .from('quiz_attempts')
      .select('topics, question_type, questions_data, answers, score_percentage, created_at')
      .limit(1);
    quizAttemptsHasNewSchema = !error;
    if (error) {
      console.warn(`[API Server] quiz_attempts nieuw schema NIET gevonden: ${error.message}`);
      console.warn('[API Server] Pas migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql toe in Supabase.');
    } else {
      console.log('[API Server] quiz_attempts nieuw schema beschikbaar.');
    }
  } catch (e) {
    quizAttemptsHasNewSchema = false;
    console.warn('[API Server] quiz_attempts schema detectie mislukt:', e.message);
  }
}

app.post('/api/chat', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!AZURE_CHAT_READY) {
    return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
  }

  const {
    messages = [],
    context,
    temperature = 0.7,
    top_p = 1,
    stream = false,
    max_tokens,
    skipSystemPrompt = false,
    ragStrictMode = false,
    systemPromptOverride,
    sources,
    lang = 'nl',
  } = req.body;

  // Bouw bron-instructieblok voor [1]/[2]/... citaten in chat-antwoorden.
  // Spiegel van buildSourcesBlock in src/services/llm.service.ts (Ik Leg Uit).
  const buildChatSourcesBlock = (srcs) => {
    if (!Array.isArray(srcs) || srcs.length === 0) return '';
    const numbered = srcs
      .map((s, i) => `[${i + 1}] ${(s && s.title) || 'Onbekende bron'}`)
      .join('\n');
    return `\n\nBronnen uit het cursusmateriaal die je tot je beschikking hebt:\n${numbered}\n\nVerwijsregels (volg deze STRIKT):\n- Verwijs in je antwoord naar een bron met exact de notatie [1], [2], ... direct na de zin waar je die bron gebruikt.\n- Gebruik géén andere verwijsvormen (geen titels, geen URL's, geen voetnoten, geen DOI's).\n- Als je in je antwoord informatie noemt die NIET uit deze bronnen komt maar uit algemene kennis, markeer die zin dan met "(buiten cursusmateriaal)" aan het einde van die zin.`;
  };
  const chatSourcesBlock = buildChatSourcesBlock(sources);

  const userMessages = Array.isArray(messages) ? messages.filter(m => m.role !== 'system') : [];

  let finalMessages;
  if (skipSystemPrompt) {
    if (systemPromptOverride) {
      finalMessages = [{ role: 'system', content: `${systemPromptOverride}${buildLanguageInstruction(lang)}` }, ...userMessages];
    } else {
      const langOnly = buildLanguageInstruction(lang).trim();
      finalMessages = langOnly ? [{ role: 'system', content: langOnly }, ...userMessages] : userMessages;
    }
  } else {
    let systemPromptContent = FALLBACK_SYSTEM_PROMPT;
    if (supabaseAdmin) {
      try {
        const quizNamesExclude = Object.keys(QUIZ_PROMPT_DEFAULTS);
        let promptQuery = supabaseAdmin
          .from('chatbot_prompts')
          .select('id, name, content')
          .eq('is_active', true)
          .not('name', 'like', '__rag_settings%')
          .not('name', 'like', '__doc_mutation_%')
          .not('name', 'like', '__concepts_regen_%')
          .neq('name', '__quiz_itembank_config__')
          .not('name', 'in', `(${quizNamesExclude.map(n => `"${n}"`).join(',')})`)
          .order('updated_at', { ascending: false })
          .limit(1);
        if (promptsHasSection) {
          promptQuery = promptQuery.eq('section', 'chat');
        }
        const { data: promptData, error: promptError } = await promptQuery.maybeSingle();
        if (promptError) {
          console.warn('[/api/chat] Prompt ophalen mislukt, fallback gebruikt:', promptError.message);
        } else if (promptData?.content) {
          systemPromptContent = promptData.content;
          console.log(`[/api/chat] Actieve chat-prompt geladen: "${promptData.name}" (id=${promptData.id})`);
        } else {
          console.warn('[/api/chat] Geen actieve chat-prompt in database — fallback gebruikt');
        }
      } catch (err) {
        console.warn('[/api/chat] Prompt ophalen exception, fallback gebruikt:', err.message);
      }
    }
    const langSuffix = buildLanguageInstruction(lang);
    let systemContent;
    if (ragStrictMode) {
      if (context) {
        systemContent = `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}${RAG_STRICT_INSTRUCTION}${langSuffix}`;
      } else {
        systemContent = `${systemPromptContent}${RAG_STRICT_INSTRUCTION}\n\nEr zijn geen relevante cursusteksten gevonden voor deze vraag. Informeer de student hierover.${langSuffix}`;
      }
    } else {
      systemContent = context
        ? `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}${langSuffix}`
        : `${systemPromptContent}${langSuffix}`;
    }
    if (chatSourcesBlock) systemContent += chatSourcesBlock;
    finalMessages = [{ role: 'system', content: systemContent }, ...userMessages];
  }

  const chatBody = {
    model: OPENAI_MODEL,
    messages: finalMessages,
    [MAX_TOKENS_PARAM]: max_tokens ?? 512,
    stream,
  };
  if (IS_REASONING_MODEL) {
    // Reasoning-modellen (gpt-5.x / o1 / o3 / o4) accepteren alleen de standaard
    // temperature/top_p (1) en weigeren een aangepaste waarde met een HTTP 400.
    // Stuur die parameters daarom proactief NIET mee — dat scheelt op elke
    // aanvraag een mislukte call + retry. Voeg in plaats daarvan een lage
    // reasoning_effort toe zodat er tokenbudget overblijft voor zichtbare output.
    chatBody.reasoning_effort = REASONING_EFFORT;
  } else {
    chatBody.temperature = temperature;
    chatBody.top_p = top_p;
  }

  const postChatCompletion = async (body) => {
    const r = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: chatAuthHeaders(),
      body: JSON.stringify(body),
    });
    // Lees eerst als tekst en parse defensief: bij een storing aan de
    // providerkant (HTML-foutpagina, gateway-timeout, lege body) is de body
    // geen geldige JSON en zou r.json() een exception gooien. Dan zetten we
    // body op null zodat de aanroeper dit als "dienst onbereikbaar" afhandelt.
    const rawText = await r.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
    return { r, body: parsed, rawText };
  };

  try {
    let { r: response, body: data, rawText } = await postChatCompletion(chatBody);

    // Reasoning-modellen weigeren een aangepaste temperature/top_p met een 400.
    // Probeer dan één keer opnieuw zonder die sampling-parameters, zodat het
    // antwoord alsnog gegenereerd wordt in plaats van te falen met
    // "het taalmodel weigerde het verzoek".
    if (!response.ok && response.status === 400 && isUnsupportedSamplingParamError(data)) {
      const { temperature: _t, top_p: _tp, ...retryBody } = chatBody;
      console.warn(`[/api/chat] Model ${OPENAI_MODEL} accepteert geen aangepaste temperature/top_p — opnieuw zonder die parameters.`);
      ({ r: response, body: data, rawText } = await postChatCompletion(retryBody));
    }

    // Niet-JSON of lege upstream-respons (HTML-foutpagina, gateway-timeout,
    // lege body): vertaal naar een herkenbare, herhaalbare melding i.p.v. een
    // generieke 500 die niet te onderscheiden is van een echte bug.
    if (data == null) {
      const snippet = (rawText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      console.error(`[/api/chat] OpenAI gaf geen geldige JSON terug status=${response.status} body=${snippet || '(leeg)'}`);
      return res.status(502).json({
        error: {
          message: 'De AI-dienst is tijdelijk niet bereikbaar.',
          code: 'upstream_unavailable',
        },
      });
    }

    if (!response.ok) {
      const promptChars = JSON.stringify(finalMessages).length;
      const errCode = data?.error?.code || data?.error?.type || 'unknown';
      // Log de volledige OpenAI error-body (afgekapt op 2000 tekens om logs niet
      // op te blazen) zodat we exact zien wat OpenAI teruggaf.
      const bodyStr = (() => {
        try { return JSON.stringify(data); } catch { return String(data); }
      })();
      console.error(`[/api/chat] OpenAI error status=${response.status} code=${errCode} promptChars=${promptChars} body=${bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + '…[truncated]' : bodyStr}`);
      return res.status(response.status).json(data);
    }

    // Reasoning-modellen (zoals gpt-5.2) kunnen een HTTP 200 met lege of
    // afgekapte content teruggeven (finish_reason: "length") wanneer de
    // reasoning-tokens het budget opslokken. Dit raakt vooral zware,
    // gestructureerde opdrachten zoals "Ik leg uit". Probeer in dat geval één
    // keer opnieuw met een ruimer tokenbudget (en lage reasoning-inspanning)
    // voordat we falen, zodat alle functies (chat én explain) profiteren.
    if (!stream && isEmptyOrTruncatedCompletion(data)) {
      const baseBudget = max_tokens ?? 512;
      const retryBudget = Math.max(baseBudget * 2, 2000);
      const retryBody = { ...chatBody, [MAX_TOKENS_PARAM]: retryBudget };
      if (IS_REASONING_MODEL) retryBody.reasoning_effort = REASONING_EFFORT;
      const prevFinish = data?.choices?.[0]?.finish_reason;
      console.warn(`[/api/chat] Lege/afgekapte respons (finish_reason=${prevFinish}) — opnieuw met ruimer tokenbudget (${retryBudget}).`);
      const retry = await postChatCompletion(retryBody);
      if (retry.r.ok) {
        // Behoud de retry-respons: die heeft minstens evenveel ruimte en bevat
        // doorgaans de volledige tekst. Zo niet, dan vangt de check hieronder af.
        data = retry.body;
      }
    }

    // Als er na een eventuele retry nog steeds geen bruikbare of volledige tekst
    // is, geef een duidelijke fout terug i.p.v. een misleidende lege/afgekapte
    // 200 — de frontend toont dan de juiste Nederlandse melding over te weinig
    // tokenruimte.
    const finalChoice = data?.choices?.[0];
    const finalContent = finalChoice?.message?.content;
    const finalFinish = finalChoice?.finish_reason;
    if (!finalContent || !String(finalContent).trim()) {
      console.error(`[/api/chat] Lege content na verwerking (finish_reason=${finalFinish}, model=${OPENAI_MODEL}).`);
      return res.status(502).json({
        error: {
          message: 'Het taalmodel gaf een lege reactie terug: er was te weinig tokenruimte voor het antwoord.',
          code: 'empty_response',
        },
      });
    }
    if (finalFinish === 'length') {
      // Niet-lege maar afgekapte respons: voor gestructureerde feedback ("Ik leg
      // uit") is een halve respons misleidend. Faal expliciet met een code die de
      // frontend op de tokenruimte-melding mapt, i.p.v. partiële tekst door te geven.
      console.error(`[/api/chat] Afgekapte respons na verwerking (finish_reason=length, model=${OPENAI_MODEL}).`);
      return res.status(502).json({
        error: {
          message: 'Het antwoord werd afgekapt: er was te weinig tokenruimte voor het volledige antwoord.',
          code: 'length',
        },
      });
    }

    return res.json(data);
  } catch (err) {
    console.error('[/api/chat] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Leerdagboek: cursus-herkomst van notities ───────────────────────────────
// Elke leerdagboek-notitie krijgt een course_id zodat de student ziet binnen
// welke cursus de notitie is aangemaakt. Voor projectflows is projects.course_id
// de autoritatieve bron (courseIdForProject); voor chat/quiz/uitleg geeft de
// frontend de actieve cursus mee. resolveJournalCourseId valideert een
// client-aangeleverde course_id (uuid + bestaat in courses) zodat een ongeldige
// waarde nooit een FK-fout veroorzaakt die het opslaan van de notitie blokkeert.
const JOURNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function courseIdForProject(projectId) {
  if (!projectId || !supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    return data?.course_id || null;
  } catch { return null; }
}
async function resolveJournalCourseId(courseId) {
  if (!courseId || typeof courseId !== 'string' || !JOURNAL_UUID_RE.test(courseId)) return null;
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('courses').select('id').eq('id', courseId).maybeSingle();
    return data?.id || null;
  } catch { return null; }
}

// Task #251 — "verwijderen" is sinds Task #250 een definitieve delete (geen
// soft-delete/archief meer). De canonieke route is /api/chat/delete;
// /api/chat/archive blijft als alias bestaan zodat oudere clients niet breken.
app.post(['/api/chat/delete', '/api/chat/archive'], async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header vereist' });
  }

  const { conversationId, generateSummary = false, lang = 'nl', courseId } = req.body;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is vereist' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Niet geauthenticeerd' });
    }

    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, title, user_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Gesprek niet gevonden' });
    }

    if (conversation.user_id !== user.id) {
      return res.status(403).json({ error: 'Geen toegang tot dit gesprek' });
    }

    let journalEntryId = null;

    if (generateSummary) {
      const apiKey = process.env.OPENAI_API_KEY;

      const { data: msgs, error: msgError } = await supabaseAdmin
        .from('messages')
        .select('role, content, retrieved_context')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (!msgError && msgs && msgs.length > 0) {
        const ragSources = new Set();
        for (const msg of msgs) {
          const chunks = msg.retrieved_context?.chunks;
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              if (chunk.documentTitle) ragSources.add(chunk.documentTitle);
            }
          }
        }

        const userLabel = lang === 'nl' ? 'Jij' : 'You';
        const tutorLabel = 'Tutor';
        const chatText = msgs
          .filter(m => m.role !== 'system')
          .map(m => `${m.role === 'user' ? userLabel : tutorLabel}: ${m.content}`)
          .join('\n\n');

        const sourcesText = ragSources.size > 0
          ? (lang === 'nl'
              ? `\n\nGebruikte cursusbronnen in dit gesprek: ${[...ragSources].join(', ')}`
              : `\n\nCourse sources used in this conversation: ${[...ragSources].join(', ')}`)
          : '';

        const summaryPrompt = (lang !== 'nl'
          ? `You are a "critical friend" for a student epidemiology/biostatistics at VU Amsterdam. Analyse the following study conversation and write a formative reflection report of 5 to 10 lines in English, addressed directly to the student.

Addressing rule (follow STRICTLY):
- Address the student directly using "you" / "your".
- NEVER use formulations like "the student", "this student", "the student has" or other third-person references to the student. Write as if giving feedback one-on-one.

Your report contains:
1. A reasoned formative judgement of what you have demonstrated and learned
2. Concrete strengths and areas for improvement in your contribution (honest but constructive)
3. A specific suggestion for further deepening, preferably with reference to available course sources${sourcesText}

Conversation title: "${conversation.title}"

Conversation (lines marked with "You:" are the student you are addressing):
${chatText}

Write the report directly without salutation. Be concrete, honest and motivating.`
          : `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Analyseer het volgende studiegesprek en schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd
2. Concrete sterke punten én verbeterpunten in jouw bijdrage (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping, bij voorkeur met verwijzing naar beschikbare cursusbronnen${sourcesText}

Gesprekstitel: "${conversation.title}"

Gesprek (regels gemarkeerd met "Jij:" zijn de student aan wie je het verslag richt):
${chatText}

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`) + buildLanguageInstruction(lang);

        if (AZURE_CHAT_READY) {
          try {
            const chatResp = await openaiChatCompletion({
              model: OPENAI_MODEL,
              messages: [{ role: 'user', content: summaryPrompt }],
              ...chatModelParams({ temperature: 0.5, maxTokens: 600 }),
            });

            if (chatResp.ok) {
              const chatData = await chatResp.json();
              const summaryContent = chatData.choices?.[0]?.message?.content;
              if (summaryContent) {
                const { data: entry, error: journalError } = await supabaseAdmin
                  .from('learning_journal_entries')
                  .insert({
                    user_id: user.id,
                    title: lang === 'nl' ? `Chatreflectie: ${conversation.title}` : `Chat reflection: ${conversation.title}`,
                    content: summaryContent,
                    activity_type: 'chat_reflection',
                    course_id: await resolveJournalCourseId(courseId),
                  })
                  .select('id')
                  .single();

                if (journalError) {
                  console.error('[chat-delete] Journal insert error:', journalError);
                } else {
                  journalEntryId = entry.id;
                  console.log(`[chat-delete] Journal entry aangemaakt: ${journalEntryId}`);
                }
              }
            } else {
              console.error('[chat-delete] OpenAI fout:', chatResp.status, await chatResp.text());
            }
          } catch (chatErr) {
            console.error('[chat-delete] OpenAI request mislukt:', chatErr.message);
          }
        } else {
          console.warn('[chat-delete] Azure OpenAI niet geconfigureerd — samenvatting overgeslagen');
        }
      }
    }

    const summaryCreated = generateSummary && journalEntryId !== null;
    const summaryFailed = generateSummary && journalEntryId === null;

    const { error: deleteError } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', user.id);

    if (deleteError) {
      return res.status(500).json({ error: `Verwijderen mislukt: ${deleteError.message}` });
    }

    console.log(`[chat-delete] Gesprek ${conversationId} definitief verwijderd (summaryCreated: ${summaryCreated})`);
    return res.json({ success: true, journalEntryId, summaryCreated, summaryFailed });
  } catch (err) {
    console.error('[chat-delete] Onverwachte fout:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/embeddings', async (req, res) => {
  if (!AZURE_EMBEDDINGS_READY) {
    return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });
  }

  const { texts } = req.body;
  if (!texts || !Array.isArray(texts)) {
    return res.status(400).json({ error: 'texts array required' });
  }

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: embeddingAuthHeaders(),
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('[/api/embeddings] Azure embeddings error response:', response.status, JSON.stringify(errData));
      return res.status(response.status).json({ error: errData.error?.message || errData.error || `Azure embeddings error ${response.status}` });
    }

    const data = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      console.error('[/api/embeddings] Unexpected Azure response shape:', JSON.stringify(data));
      return res.status(500).json({ error: 'Unexpected response from Azure embeddings API' });
    }
    const embeddings = data.data.map((item) => item.embedding);
    console.log(`[/api/embeddings] Generated ${embeddings.length} embeddings via Azure (dim=${embeddings[0]?.length})`);
    return res.json({ embeddings, provider: 'azure' });
  } catch (err) {
    console.error('[/api/embeddings] Azure embeddings request failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/rag-settings', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const { courseId } = req.query;
  try {
    const settings = await loadRagSettings(courseId || null);
    return res.json(settings);
  } catch (err) {
    console.error('[rag-settings GET] Error:', err.message);
    return res.json({ ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } });
  }
});

app.put('/api/rag-settings', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { courseId, settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object vereist' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

    // Per-cursus RAG: vereist staff voor die cursus. Globale defaults:
    // alleen admin.
    const isAllowed = courseId
      ? await isStaffForCourse(user, profile, courseId)
      : (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL);
    if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

    // Valideer en clamp settings per module
    const MODULES = ['chat', 'explain', 'quiz', 'project'];
    for (const mod of MODULES) {
      if (settings[mod]) {
        const m = settings[mod];
        if (m.similarity_threshold !== undefined) {
          const parsed = parseFloat(m.similarity_threshold);
          if (isNaN(parsed)) return res.status(400).json({ error: `similarity_threshold voor ${mod} is geen geldig getal` });
          m.similarity_threshold = Math.max(0.10, Math.min(0.95, parsed));
        }
        if (m.match_count !== undefined) {
          const parsed = parseInt(m.match_count);
          if (isNaN(parsed)) return res.status(400).json({ error: `match_count voor ${mod} is geen geldig getal` });
          m.match_count = Math.max(1, Math.min(20, parsed));
        }
        if (m.rag_strict_mode !== undefined) {
          m.rag_strict_mode = Boolean(m.rag_strict_mode);
        }
        if (m.query_expansion_enabled !== undefined) {
          m.query_expansion_enabled = Boolean(m.query_expansion_enabled);
        }
      }
    }
    // Aparte validatie voor extraction (andere shape: similarity_threshold + min_evidence_chunks)
    if (settings.extraction) {
      const e = settings.extraction;
      if (e.similarity_threshold !== undefined) {
        const parsed = parseFloat(e.similarity_threshold);
        if (isNaN(parsed)) return res.status(400).json({ error: 'similarity_threshold voor extraction is geen geldig getal' });
        e.similarity_threshold = Math.max(0.0, Math.min(0.95, parsed));
      }
      if (e.min_evidence_chunks !== undefined) {
        const parsed = parseInt(e.min_evidence_chunks);
        if (isNaN(parsed)) return res.status(400).json({ error: 'min_evidence_chunks is geen geldig getal' });
        e.min_evidence_chunks = Math.max(0, Math.min(10, parsed));
      }
    }

    const settingsKey = courseId ? `__rag_settings_${courseId}__` : '__rag_settings_global__';

    // Haal bestaande settings op en voeg samen om gedeeltelijke updates te steunen
    const { data: existingRow } = await supabaseAdmin
      .from('chatbot_prompts').select('id, content').eq('name', settingsKey).maybeSingle();

    let mergedSettings = { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
    if (existingRow?.content) {
      try {
        const prev = JSON.parse(existingRow.content);
        for (const mod of Object.keys(RAG_MODULE_DEFAULTS)) {
          if (prev[mod]) mergedSettings[mod] = { ...RAG_MODULE_DEFAULTS[mod], ...prev[mod] };
        }
        if (prev.extraction) {
          mergedSettings.extraction = { ...RAG_EXTRACTION_DEFAULTS, ...prev.extraction };
        }
      } catch { /* negeer parse-fouten, gebruik defaults */ }
    }
    // Schrijf de inkomende modules over de bestaande settings heen
    for (const mod of MODULES) {
      if (settings[mod]) mergedSettings[mod] = { ...mergedSettings[mod], ...settings[mod] };
    }
    // Schrijf inkomende extractie-instellingen over de bestaande heen
    if (settings.extraction) {
      mergedSettings.extraction = { ...mergedSettings.extraction, ...settings.extraction };
    }

    const content = JSON.stringify(mergedSettings);

    if (existingRow) {
      const { error: updateErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .update({ content, updated_at: new Date().toISOString() })
        .eq('name', settingsKey);
      if (updateErr) throw new Error(`DB update mislukt: ${updateErr.message}`);
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({ name: settingsKey, content, is_active: false });
      if (insertErr) throw new Error(`DB insert mislukt: ${insertErr.message}`);
    }

    console.log(`[rag-settings PUT] Saved settings for key=${settingsKey} by user=${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[rag-settings PUT] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/rag-settings/overrides', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

    const isAllowed = await isStaffAnywhere(user, profile);
    if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

    const { data, error } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('name')
      .like('name', '__rag_settings_%__')
      .neq('name', '__rag_settings_global__');
    if (error) throw new Error(error.message);
    let courseIds = (data || []).map(row => {
      const match = row.name.match(/^__rag_settings_(.+)__$/);
      return match ? match[1] : null;
    }).filter(Boolean);

    // Admin/superuser ziet alle override-cursussen; een docent ziet uitsluitend
    // de override-markers van de cursussen waaraan hij gekoppeld is. Zo lekken
    // andere cursussen niet via deze lijst.
    const isAdminLocal = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
    if (!isAdminLocal) {
      const { data: ownRows } = await supabaseAdmin
        .from('course_members')
        .select('course_id')
        .eq('user_id', user.id)
        .eq('member_role', 'teacher');
      const ownCourseIds = new Set((ownRows || []).map(r => r.course_id));
      courseIds = courseIds.filter(id => ownCourseIds.has(id));
    }
    return res.json({ courseIds });
  } catch (err) {
    console.error('[rag-settings/overrides GET] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rag-settings/:courseId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { courseId } = req.params;
  if (!courseId) return res.status(400).json({ error: 'courseId vereist' });

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

    const isAllowed = await isStaffForCourse(user, profile, courseId);
    if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

    const settingsKey = `__rag_settings_${courseId}__`;
    const { error: deleteErr } = await supabaseAdmin
      .from('chatbot_prompts')
      .delete()
      .eq('name', settingsKey);

    if (deleteErr) throw new Error(`DB delete mislukt: ${deleteErr.message}`);

    console.log(`[rag-settings DELETE] Removed override for courseId=${courseId} by user=${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[rag-settings DELETE] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Diagnose-endpoint: zoek de top-N chunks voor een willekeurige zoekterm,
// zonder drempel — handig om te kalibreren wat een realistische drempelwaarde is.
app.post('/api/admin/test-rag-similarity', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { courseId, query, expand, definition, keyPoints } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query (zoekterm) is vereist' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

    // Diagnose mag door admin én docent uitgevoerd worden
    // (consistent met /api/rag-settings: zelfde gebruikers die drempels mogen aanpassen,
    // mogen ook diagnoseren waarom bepaalde scores gehaald worden).
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    // Toegestaan: admin/superuser overal; anders docent (member_role='teacher')
    // van de opgegeven cursus.
    if (!isAdmin) {
      if (!courseId) {
        return res.status(403).json({ error: 'Docenten moeten een cursus opgeven om diagnose te draaien' });
      }
      if (!(await isCourseTeacher(user.id, courseId))) {
        return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      }
    }

    // Bepaal toegestane mappen op basis van cursus (zelfde logica als extract-concepts)
    let allowedFolderIds = null;
    if (courseId) {
      const { data: assignments } = await supabaseAdmin
        .from('course_folder_assignments')
        .select('folder_id')
        .eq('course_id', courseId);

      const assignedFolderIds = (assignments || []).map(a => a.folder_id);
      if (assignedFolderIds.length > 0) {
        const { data: ragFolders } = await supabaseAdmin
          .from('document_folders')
          .select('id')
          .in('id', assignedFolderIds)
          .eq('folder_type', 'rag_sources');
        allowedFolderIds = (ragFolders || []).map(f => f.id);
      } else {
        allowedFolderIds = [];
      }
    }

    // Haal top-N kandidaten op zonder drempel. Wanneer `expand` is meegegeven,
    // wordt de zoekterm verrijkt met synoniemen (en optioneel definition/keyPoints)
    // voordat het embedding-model wordt aangeroepen — handig om de winst van
    // query-uitbreiding direct in de admin-UI te demonstreren.
    const expansion = expand
      ? {
          enabled: true,
          definition: typeof definition === 'string' ? definition : undefined,
          keyPoints: Array.isArray(keyPoints) ? keyPoints : undefined,
        }
      : undefined;
    const result = await searchChunksServerSide(query.trim(), 0, 10, allowedFolderIds, expansion);

    if (!result || !result.matched) {
      return res.json({ query: query.trim(), chunks: [], maxScore: 0 });
    }

    // Verrijk met document-titels
    const chunkDocIds = [...new Set(result.matched.map(c => c.document_id))];
    let docTitleMap = {};
    if (chunkDocIds.length > 0) {
      const { data: docs } = await supabaseAdmin
        .from('documents')
        .select('id, title')
        .in('id', chunkDocIds);
      docTitleMap = Object.fromEntries((docs || []).map(d => [d.id, d.title]));
    }

    return res.json({
      query: query.trim(),
      embedQuery: result.embedQuery || query.trim(),
      expanded: Boolean(expansion),
      maxScore: result.maxScore,
      candidatesInAllowedFolders: result.candidatesInAllowed,
      chunks: result.matched.map(c => ({
        id: c.id,
        documentId: c.document_id,
        documentTitle: docTitleMap[c.document_id] || c.document_title || 'Onbekend',
        similarity: c.similarity,
        contentPreview: (c.content || '').slice(0, 220),
      })),
    });
  } catch (err) {
    console.error('[test-rag-similarity] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/*path', async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  // In Express 5 levert de named wildcard `*path` een array van segmenten op.
  // Voor backwards-compat met Express 4 (string) ondersteunen we beide vormen.
  const rawPath = req.params.path;
  const path = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '');
  const query = req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '';
  const url = `https://api.github.com/${path}${query}`;

  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'EpiLearning-App',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  try {
    const response = await fetch(url, { headers });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[/api/github] Error:', err);
    res.status(500).json({ error: 'GitHub proxy error' });
  }
});

app.get('/api/course-rag-folder-ids', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId } = req.query;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId query parameter is required' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: assignments, error: assignError } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id')
      .eq('course_id', courseId);

    if (assignError) {
      console.error('[course-rag-folder-ids] assignment query error:', assignError);
      return res.status(500).json({ error: assignError.message });
    }

    if (!assignments || assignments.length === 0) {
      return res.json({ ragFolderIds: [] });
    }

    const folderIds = assignments.map((a) => a.folder_id);

    const { data: ragFolders, error: folderError } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', folderIds)
      .eq('folder_type', 'rag_sources');

    if (folderError) {
      console.error('[course-rag-folder-ids] folder query error:', folderError);
      return res.status(500).json({ error: folderError.message });
    }

    return res.json({ ragFolderIds: ragFolders?.map((f) => f.id) ?? [] });
  } catch (err) {
    console.error('[course-rag-folder-ids] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Document-tree & CRUD endpoints ──────────────────────────────────────────

async function resolveAdminUser(req) {
  const auth = await authUser(req);
  if (auth.error) return { error: auth.error };
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
  if (!profile) return { error: { status: 403, body: { error: 'Profiel niet gevonden' } } };
  const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
  // Task #165: 'docent' is geen globale rol meer. Voor backward-compat
  // betekent isDocent nu "deze user is in minstens één cursus docent".
  // Per-endpoint moeten extra controles op de specifieke cursus gebeuren
  // (via isStaffForCourse / isCourseTeacher).
  const isDocent = !isAdmin && await userIsTeacherAnywhere(auth.user.id);
  return { user: auth.user, profile, isAdmin, isDocent };
}

function getFileMimeType(ext) {
  const map = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', omv: 'application/octet-stream', sav: 'application/octet-stream', jasp: 'application/octet-stream', rdata: 'application/octet-stream' };
  return map[ext] || 'application/octet-stream';
}

// GET /api/admin/document-tree — volledige mapboom met documentaantallen (admin only)
app.get('/api/admin/document-tree', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Admin-rol vereist' });
  try {
    const { data: folders, error: fErr } = await supabaseAdmin
      .from('document_folders').select('id, name, parent_folder_id, folder_type, is_root, description').order('name');
    if (fErr) return res.status(500).json({ error: fErr.message });
    const { data: docRows } = await supabaseAdmin.from('documents').select('folder_id');
    const countMap = {};
    for (const d of docRows || []) {
      if (d.folder_id) countMap[d.folder_id] = (countMap[d.folder_id] || 0) + 1;
    }
    const nodeMap = {};
    for (const f of folders || []) {
      nodeMap[f.id] = { ...f, document_count: countMap[f.id] || 0, children: [] };
    }
    const roots = [];
    for (const node of Object.values(nodeMap)) {
      if (node.parent_folder_id && nodeMap[node.parent_folder_id]) {
        nodeMap[node.parent_folder_id].children.push(node);
      } else {
        roots.push(node);
      }
    }
    function sortTree(nodes) {
      nodes.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
      nodes.forEach(n => sortTree(n.children));
    }
    sortTree(roots);
    return res.json({ folders: roots });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/folders/:folderId/documents (admin only)
app.get('/api/admin/folders/:folderId/documents', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Admin-rol vereist' });
  try {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_type, file_size, processing_status, created_at, bucket, file_path, mime_type')
      .eq('folder_id', req.params.folderId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ documents: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/folders — nieuwe map aanmaken
app.post('/api/admin/folders', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen mappen aanmaken' });
  const { name, parent_folder_id, folder_type } = req.body || {};
  if (!name || !parent_folder_id) return res.status(400).json({ error: 'name en parent_folder_id zijn verplicht' });
  try {
    const { data, error } = await supabaseAdmin
      .from('document_folders')
      .insert({ name, parent_folder_id, folder_type: folder_type || 'general', is_root: false, created_by: r.user.id })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabaseAdmin.from('folder_permissions').insert([
      { folder_id: data.id, role: 'admin',   can_view: true, can_edit: true  },
      { folder_id: data.id, role: 'docent',  can_view: true, can_edit: true  },
      { folder_id: data.id, role: 'student', can_view: true, can_edit: false },
    ]);
    return res.json({ folder: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/folders/:folderId — lege map verwijderen
app.delete('/api/admin/folders/:folderId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen mappen verwijderen' });
  const { folderId } = req.params;
  try {
    const { count: docCount } = await supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('folder_id', folderId);
    if (docCount > 0) return res.status(409).json({ error: 'Map bevat nog documenten. Verwijder de documenten eerst.' });
    const { count: childCount } = await supabaseAdmin.from('document_folders').select('id', { count: 'exact', head: true }).eq('parent_folder_id', folderId);
    if (childCount > 0) return res.status(409).json({ error: 'Map bevat nog submappen. Verwijder de submappen eerst.' });
    const { error } = await supabaseAdmin.from('document_folders').delete().eq('id', folderId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/rag/documents/:documentId/download — student/docent-vriendelijke
// download van een RAG-bron. Toegang volgt dezelfde folder_permissions-regels
// als de RAG-zoek: rol moet can_view hebben op de folder van het document.
app.get('/api/rag/documents/:documentId/download', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const role = auth.profile?.role || 'student';
  const isAdmin = role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  const { documentId } = req.params;
  try {
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
      .eq('id', documentId)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: `Document niet gevonden (id=${documentId}). De RAG-chunk verwijst mogelijk naar een verwijderd document — synchroniseer de RAG-index opnieuw.` });
    // Alleen RAG-bron documenten via deze route serveren.
    if (doc.bucket && doc.bucket !== 'rag_sources') {
      return res.status(403).json({ error: 'Dit document is geen RAG-bron.' });
    }
    if (!isAdmin) {
      if (!doc.folder_id) return res.status(403).json({ error: 'Geen toegang tot dit document.' });
      const { data: perm } = await supabaseAdmin
        .from('folder_permissions')
        .select('can_view')
        .eq('folder_id', doc.folder_id)
        .eq('role', role)
        .maybeSingle();
      if (!perm?.can_view) return res.status(403).json({ error: 'Geen toegang tot dit document.' });
    }
    const filename = String(doc.filename || doc.title || 'download').replace(/[\r\n"]/g, '_');
    // Web-bron (Task #234): geen renderbaar/bewaard bestand, maar een externe
    // URL. Geef die als JSON terug zodat de frontend de pagina in een tab opent.
    if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
      return res.json({ url: doc.file_path, filename });
    }
    const mimeType = doc.mime_type || getFileMimeType((doc.file_type || '').toLowerCase());
    if (!doc.file_path && pgPool) {
      const result = await pgPool.query(
        'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
        [documentId]
      );
      const row = result.rows[0];
      if (row?.file_bytes) {
        const resolvedMime = row.mime_type || mimeType;
        res.setHeader('Content-Type', resolvedMime);
        res.setHeader('Content-Length', row.file_bytes.length);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.end(row.file_bytes);
      }
    }
    if (doc.file_path && doc.bucket) {
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(doc.bucket)
        .createSignedUrl(doc.file_path, 120);
      if (signErr || !signed?.signedUrl) {
        return res.status(500).json({ error: 'Kon geen downloadlink aanmaken.' });
      }
      // De client kan een Bearer-token niet via een gewone <a href> meesturen.
      // Daarom geven we JSON met een tijdelijk getekende URL terug zodat de
      // frontend deze in een nieuw tabblad kan openen.
      return res.json({ url: signed.signedUrl, filename });
    }
    return res.status(404).json({ error: 'Dit document heeft geen downloadbaar bestand.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Gedeelde toegangscontrole voor de document-viewer-routes (/view én
// /translate): laadt de documentrij en dwingt exact dezelfde folder_permissions-
// regels af als de download-route. Stuurt zelf het foutantwoord en geeft dan
// null terug; bij succes retourneert het { doc, role, isAdmin }.
async function loadViewableDocument(req, res) {
  const auth = await requireAuthUser(req, res);
  if (!auth) return null;
  const role = auth.profile?.role || 'student';
  const isAdmin = role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  const { documentId } = req.params;
  try {
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id, updated_at')
      .eq('id', documentId)
      .maybeSingle();
    if (!doc) { res.status(404).json({ error: 'Document niet gevonden.' }); return null; }
    if (doc.bucket && doc.bucket !== 'rag_sources') {
      res.status(403).json({ error: 'Dit document is geen RAG-bron.' }); return null;
    }
    if (!isAdmin) {
      if (!doc.folder_id) { res.status(403).json({ error: 'Geen toegang tot dit document.' }); return null; }
      const { data: perm } = await supabaseAdmin
        .from('folder_permissions')
        .select('can_view')
        .eq('folder_id', doc.folder_id)
        .eq('role', role)
        .maybeSingle();
      if (!perm?.can_view) { res.status(403).json({ error: 'Geen toegang tot dit document.' }); return null; }
    }
    return { doc, role, isAdmin };
  } catch (err) {
    console.error('[viewer-auth] documenttoegang controleren mislukt:', err);
    res.status(500).json({ error: 'Kon documenttoegang niet controleren.' });
    return null;
  }
}

// GET /api/rag/documents/:documentId/view — bekijkbare versie voor de in-app
// documentviewer (Task #209). Zelfde toegangscontrole als de download-route.
// - pdf        → signed URL van het origineel
// - docx/pptx  → gecachte PDF-rendition (LibreOffice headless), signed URL
// - txt/md     → platte tekst inline
app.get('/api/rag/documents/:documentId/view', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const loaded = await loadViewableDocument(req, res);
  if (!loaded) return;
  const { doc } = loaded;
  const { documentId } = req.params;
  try {
    const title = String(doc.title || doc.filename || 'document');
    // Web-bron (Task #234): geen renderbaar bestand — geef de externe URL terug
    // zodat de viewer een link toont in plaats van te proberen te renderen.
    if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
      return res.json({ kind: 'url', title, sourceType: 'web', url: doc.file_path });
    }
    const ext = normalizeExt(doc.file_type || (doc.filename || '').split('.').pop());

    // Bronbytes ophalen uit storage (file_path) of uit de DB (file_bytes).
    const loadSourceBytes = async () => {
      if (doc.file_path && doc.bucket) {
        const { data, error } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
        if (error || !data) throw new Error('Kon bronbestand niet ophalen uit de opslag.');
        return Buffer.from(await data.arrayBuffer());
      }
      if (pgPool) {
        const result = await pgPool.query('SELECT file_bytes FROM documents WHERE id = $1', [documentId]);
        const row = result.rows[0];
        if (row?.file_bytes) return row.file_bytes;
      }
      throw new Error('Dit document heeft geen bestand om te tonen.');
    };

    if (TEXT_EXT.has(ext)) {
      const bytes = await loadSourceBytes();
      return res.json({ kind: 'text', title, sourceType: ext, text: bytes.toString('utf-8') });
    }

    if (NATIVE_PDF_EXT.has(ext)) {
      if (!doc.file_path || !doc.bucket) {
        return res.status(404).json({ error: 'PDF-bestand niet beschikbaar voor weergave.' });
      }
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(doc.bucket)
        .createSignedUrl(doc.file_path, 600);
      if (signErr || !signed?.signedUrl) {
        return res.status(500).json({ error: 'Kon geen weergavelink aanmaken.' });
      }
      return res.json({ kind: 'pdf', title, sourceType: 'pdf', url: signed.signedUrl });
    }

    if (CONVERT_TO_PDF_EXT.has(ext)) {
      const bucket = doc.bucket || 'rag_sources';
      // Cache-sleutel bevat updated_at zodat een vervangen bron een verse
      // rendition krijgt en niet de oude PDF blijft tonen.
      const stamp = doc.updated_at ? String(Date.parse(doc.updated_at) || '') : '';
      const renditionPath = `__renditions__/${documentId}${stamp ? `-${stamp}` : ''}.pdf`;
      let signed = (await supabaseAdmin.storage.from(bucket).createSignedUrl(renditionPath, 600)).data;
      if (!signed?.signedUrl) {
        // Nog geen rendition in cache — eenmalig converteren en opslaan.
        const sourceBytes = await loadSourceBytes();
        const pdfBuffer = await queueConversion(() => convertOfficeToPdf(sourceBytes, ext));
        const { error: upErr } = await supabaseAdmin.storage
          .from(bucket)
          .upload(renditionPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
        if (upErr) return res.status(500).json({ error: 'Kon de weergaveversie niet opslaan.' });
        signed = (await supabaseAdmin.storage.from(bucket).createSignedUrl(renditionPath, 600)).data;
        if (!signed?.signedUrl) return res.status(500).json({ error: 'Kon geen weergavelink aanmaken.' });
      }
      const sourceType = (ext === 'pptx' || ext === 'ppt' || ext === 'odp') ? 'pptx' : 'docx';
      return res.json({ kind: 'pdf', title, sourceType, url: signed.signedUrl });
    }

    return res.status(415).json({
      error: 'Dit bestandstype kan niet in de viewer worden getoond. Download het bestand in plaats daarvan.',
    });
  } catch (err) {
    // Interne details (incl. LibreOffice-stderr) niet naar de client lekken;
    // wel volledig serverside loggen voor debugging.
    console.error('[view] documentweergave mislukt:', err);
    return res.status(500).json({ error: 'Kon het document niet voorbereiden voor weergave.' });
  }
});

// POST /api/rag/documents/:documentId/translate — vertaalt op aanvraag een stuk
// reeds-geëxtraheerde bron-tekst (door de client uit de huidige pagina/dia
// gehaald) naar een doeltaal en cachet het resultaat per (document, eenheid,
// taal, bron-hash). Zelfde toegangscontrole als /view; fail-closed zonder Azure.
app.post('/api/rag/documents/:documentId/translate', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
  const loaded = await loadViewableDocument(req, res);
  if (!loaded) return;
  const { documentId } = req.params;

  const targetLang = normalizeTargetLang(req.body?.targetLang);
  if (!targetLang) return res.status(400).json({ error: 'Onbekende doeltaal.' });
  const pageKey = normalizePageKey(req.body?.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'Ongeldige pagina-aanduiding.' });
  const text = normalizeSourceText(typeof req.body?.text === 'string' ? req.body.text : '');
  if (!text) return res.status(400).json({ error: 'Geen tekst om te vertalen.' });
  if (text.length > TRANSLATION_MAX_SOURCE_CHARS) {
    return res.status(413).json({ error: 'Tekstfragment te groot om te vertalen.' });
  }
  const sourceType = typeof req.body?.sourceType === 'string' ? req.body.sourceType : '';
  const sourceHash = hashSource(text);

  try {
    // Cache-hit? (service-role: deze tabel heeft bewust geen client-leesbeleid).
    const { data: cached } = await supabaseAdmin
      .from('document_translations')
      .select('translated_text')
      .eq('document_id', documentId)
      .eq('page_key', pageKey)
      .eq('target_lang', targetLang)
      .eq('source_hash', sourceHash)
      .maybeSingle();
    if (cached?.translated_text) {
      return res.json({ translated: cached.translated_text, cached: true, targetLang });
    }

    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildTranslationPrompt(targetLang, sourceType) },
        { role: 'user', content: text },
      ],
      ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
    };
    const resp = await openaiChatCompletion(body);
    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`[translate] LLM-status ${resp.status} voor doc ${documentId} ${pageKey}->${targetLang}`);
      return res.status(502).json({ error: 'Vertaling mislukt.' });
    }
    const translated = data?.choices?.[0]?.message?.content?.trim();
    if (!translated) return res.status(502).json({ error: 'Vertaling leeg.' });

    // Persist (idempotent op de unique-constraint).
    await supabaseAdmin
      .from('document_translations')
      .upsert(
        { document_id: documentId, page_key: pageKey, target_lang: targetLang, source_hash: sourceHash, translated_text: translated },
        { onConflict: 'document_id,page_key,target_lang,source_hash' },
      );

    return res.json({ translated, cached: false, targetLang });
  } catch (err) {
    console.error('[translate] vertaling mislukt:', err);
    return res.status(500).json({ error: 'Kon de vertaling niet maken.' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Cursus-info (Task #202/#203) — de 7 endpoints staan in ./courseInfo.js zodat
// hun toegangsregels geautomatiseerd getest kunnen worden via dependency-
// injectie. Afhankelijkheden (Supabase, pg, auth-helpers, multer) gaan via deps.
// ───────────────────────────────────────────────────────────────────────────
registerCourseInfoRoutes(app, {
  supabaseAdmin,
  pgPool,
  getFileMimeType,
  requireAuthUser,
  userHasCourseAccess,
  isStaffForCourse,
  docUpload,
});

// GET /api/admin/documents/:documentId/download — download (file_bytes via pgPool én storage, admin only)
app.get('/api/admin/documents/:documentId/download', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Admin-rol vereist' });
  const { documentId } = req.params;
  try {
    // Haal metadata op via Supabase (geen binary-kolom hier)
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_path, bucket, mime_type, file_type')
      .eq('id', documentId)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    const filename = String(doc.filename || doc.title || 'download').replace(/[\r\n"]/g, '_');
    // Web-bron (Task #234): geen bestand, maar een externe URL — open in een tab.
    if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
      return res.json({ url: doc.file_path, filename });
    }
    const mimeType = doc.mime_type || getFileMimeType((doc.file_type || '').toLowerCase());
    // Route 1: binary opgeslagen in DB (bijv. .omv, .sav) — lees via pgPool voor correcte bytes
    if (!doc.file_path && pgPool) {
      const result = await pgPool.query(
        'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
        [documentId]
      );
      const row = result.rows[0];
      if (row?.file_bytes) {
        const resolvedMime = row.mime_type || mimeType;
        res.setHeader('Content-Type', resolvedMime);
        res.setHeader('Content-Length', row.file_bytes.length);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.end(row.file_bytes);
      }
    }
    // Route 2: bestand in Supabase Storage
    if (doc.file_path && doc.bucket) {
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(doc.bucket)
        .createSignedUrl(doc.file_path, 120);
      if (signErr || !signed?.signedUrl) {
        return res.status(500).json({ error: 'Kon geen downloadlink aanmaken.' });
      }
      return res.redirect(signed.signedUrl);
    }
    return res.status(404).json({ error: 'Dit document heeft geen downloadbaar bestand.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/documents/:documentId — document verwijderen
app.delete('/api/admin/documents/:documentId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen documenten verwijderen' });
  const { documentId } = req.params;
  try {
    const { data: doc } = await supabaseAdmin.from('documents').select('file_path, bucket').eq('id', documentId).maybeSingle();
    if (doc?.file_path && doc.bucket) {
      await supabaseAdmin.storage.from(doc.bucket).remove([doc.file_path]);
    }
    const { error } = await supabaseAdmin.from('documents').delete().eq('id', documentId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Embed een lijst teksten via OpenAI (text-embedding-3-small), gebatcht.
async function embedTextsServer(texts, _openaiKey, batchSize = 64) {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const resp = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: embeddingAuthHeaders(),
      body: JSON.stringify({ model: 'text-embedding-3-small', input: batch }),
    });
    const data = await resp.json();
    if (!resp.ok || !Array.isArray(data?.data)) {
      throw new Error(data?.error?.message || data?.error || `Azure embeddings error ${resp.status}`);
    }
    for (const row of data.data) out.push(row.embedding);
  }
  return out;
}

// LLM-chunking van één venster dia's. Retourneert genormaliseerde secties of
// null (caller valt dan terug op het deterministische vangnet).
async function chunkSlideWindow(win, openaiKey, lang = 'nl') {
  // Semantische LLM-chunking loopt via Azure-chat. Zonder Azure-config valt de
  // caller terug op het deterministische vangnet (fallbackChunks).
  if (!AZURE_CHAT_READY) return null;
  const minSlide = win[0].slide;
  const maxSlide = win[win.length - 1].slide;
  const deckText = win.map(slideToText).join('\n\n');
  const system = lang === 'en'
    ? 'You segment lecture slides into coherent, self-contained study passages for a retrieval (RAG) index. Group consecutive slides that belong together. Rewrite each group as a flowing Dutch-or-English passage (match the slide language) that preserves the facts, including speaker notes. Never invent content. Respond ONLY with JSON.'
    : 'Je verdeelt college-dia\'s in samenhangende, op zichzelf staande studiepassages voor een zoek-index (RAG). Groepeer opeenvolgende dia\'s die bij elkaar horen. Herschrijf elke groep als lopende tekst in de taal van de dia\'s, met behoud van alle feiten inclusief de sprekersnotities. Verzin niets. Antwoord UITSLUITEND met JSON.';
  const instruction = `Geef JSON in de vorm {"sections":[{"title":"...","slideStart":N,"slideEnd":M,"content":"..."}]}. slideStart/slideEnd verwijzen naar de "Dia N"-nummers hieronder (tussen ${minSlide} en ${maxSlide}). Elke sectie bevat lopende, op zichzelf staande tekst.\n\nDIA'S:\n${deckText}`;

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: instruction },
    ],
    ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await openaiChatCompletion(body);
      const data = await resp.json();
      if (!resp.ok) {
        console.warn(`[process-pptx] LLM-chunk venster ${minSlide}-${maxSlide} status=${resp.status}`);
        continue;
      }
      const raw = data?.choices?.[0]?.message?.content;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const sections = parsed ? validateSections(parsed, minSlide, maxSlide) : null;
      if (sections) return sections;
    } catch (err) {
      console.warn(`[process-pptx] LLM-chunk venster ${minSlide}-${maxSlide} fout: ${err.message}`);
    }
  }
  return null;
}

// Orkestreert semantische chunking over het hele deck met char-vensters.
// Faalt een venster, dan valt enkel dat venster terug op fallbackChunks.
async function semanticChunkDeck(slides, openaiKey, lang = 'nl') {
  const windows = [];
  let cur = [];
  let curChars = 0;
  for (const s of slides) {
    const t = slideToText(s);
    if (cur.length && curChars + t.length > 14000) {
      windows.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += t.length + 2;
  }
  if (cur.length) windows.push(cur);

  const all = [];
  let llmWindows = 0;
  let fallbackWindows = 0;
  for (const win of windows) {
    const sections = await chunkSlideWindow(win, openaiKey, lang);
    if (sections) {
      llmWindows++;
      all.push(...sections);
    } else {
      fallbackWindows++;
      all.push(...fallbackChunks(win));
    }
  }
  all.sort((a, b) => a.slideStart - b.slideStart || a.slideEnd - b.slideEnd);
  let mode = 'llm';
  if (fallbackWindows > 0) mode = llmWindows > 0 ? 'mixed' : 'fallback';
  return { sections: all, mode };
}

// Server-side tekstchunker voor pdf/docx/txt en andere platte-tekstbronnen.
// Spiegelt de client-chunker (STORAGE_CONFIG.chunkConfig): paragraaf-gebaseerd
// met overlap, en harde splitsing van te lange chunks.
function estimatePlainTokens(text) {
  return Math.ceil(String(text || '').split(/\s+/).filter(Boolean).length * 1.3);
}

function chunkPlainText(text, {
  targetTokens = 1000,
  maxTokens = 1200,
  overlapTokens = 150,
} = {}) {
  const paragraphs = String(text || '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    const test = current ? `${current}\n\n${para}` : para;
    if (estimatePlainTokens(test) > targetTokens && current) {
      chunks.push(current.trim());
      const words = current.split(/\s+/);
      const overlapWords = Math.max(0, Math.floor(overlapTokens / 1.3));
      const overlap = overlapWords > 0 ? words.slice(-overlapWords).join(' ') : '';
      current = overlap ? `${overlap}\n\n${para}` : para;
    } else {
      current = test;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Harde splitsing van chunks die alsnog te lang zijn.
  const result = [];
  const wordsPerChunk = Math.max(1, Math.floor(maxTokens / 1.3));
  for (const c of chunks) {
    if (estimatePlainTokens(c) <= maxTokens) {
      result.push(c);
      continue;
    }
    const words = c.split(/\s+/);
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const piece = words.slice(i, i + wordsPerChunk).join(' ').trim();
      if (piece) result.push(piece);
    }
  }
  return result.filter(Boolean);
}

// Kernverwerking voor .pptx: download, extractie van dia's + sprekersnotities,
// semantische chunking (LLM met vangnet), embeddings en persistentie. Zet de
// document-status zelf (failed bij fout, completed bij succes). Gooit bij fout
// een Error met optionele `.status` voor de HTTP-respons van de caller.
// Thin wrapper: de kernlogica leeft in ./ragProcessing.js (testbaar via
// dependency injection). Hier injecteren we de echte server-afhankelijkheden.
function processPptxCore(doc, openaiKey, lang = 'nl') {
  return processPptxCoreImpl(doc, openaiKey, lang, {
    supabaseAdmin,
    extractPptxStructured,
    semanticChunkDeck,
    splitLongSections,
    fallbackChunks,
    embedTextsServer,
    log: (...a) => console.log(...a),
  });
}

// Kernverwerking voor platte-tekstbronnen (.pdf/.docx/.txt/.xlsx/...): download,
// tekstextractie (officeparser voor kantoorformaten, utf8 voor tekst), chunking,
// embeddings en persistentie. Zet de document-status zelf.
function processPlainRagDocument(doc, openaiKey) {
  return processPlainRagDocumentImpl(doc, openaiKey, {
    supabaseAdmin,
    parseOfficeAsync,
    chunkPlainText,
    embedTextsServer,
    log: (...a) => console.log(...a),
  });
}

// Dispatcher: verwerkt een RAG-document op basis van het bestandstype. Wordt
// gebruikt door de admin-folder-upload-route zodat elk geüpload RAG-bestand
// automatisch chunks + embeddings krijgt en niet op 'pending' blijft hangen.
async function processRagDocumentById(documentId, lang = 'nl') {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const { data: doc } = await supabaseAdmin
    .from('documents')
    .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
    .eq('id', documentId)
    .maybeSingle();
  if (!doc) throw new Error('Document niet gevonden');
  const ext = (doc.file_type || '').toLowerCase().replace(/^\./, '');
  if (ext === 'pptx') return processPptxCore(doc, null, lang);
  return processPlainRagDocument(doc, null);
}

// POST /api/admin/process-pptx — server-side PowerPoint-extractie + semantische
// chunking. Body: { documentId, lang? }. Toegang: admin/superuser of staff van
// een cursus die aan de map van het document gekoppeld is.
app.post('/api/admin/process-pptx', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { user } = auth;
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

  const { documentId, lang = 'nl' } = req.body || {};
  if (!documentId) return res.status(400).json({ error: 'documentId vereist' });

  try {
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
      .eq('id', documentId)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });

    const ext = (doc.file_type || '').toLowerCase().replace(/^\./, '');
    if (ext !== 'pptx') {
      return res.status(400).json({ error: 'Dit endpoint verwerkt alleen .pptx-bestanden' });
    }

    // Autorisatie: admin/superuser of staff van een gekoppelde cursus.
    const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
    if (!isAdmin) {
      let allowed = false;
      if (doc.folder_id) {
        const { data: assignments } = await supabaseAdmin
          .from('course_folder_assignments')
          .select('course_id')
          .eq('folder_id', doc.folder_id);
        for (const a of assignments || []) {
          if (await isCourseTeacher(user.id, a.course_id)) { allowed = true; break; }
        }
      }
      if (!allowed) return res.status(403).json({ error: 'Geen rechten voor dit document' });
    }

    // Statusovergangen + extractie/chunking/embeddings in de gedeelde kern.
    const result = await processPptxCore(doc, null, lang);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[process-pptx] Fout:', err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/folders/:folderId/upload — upload als base64-JSON
app.post('/api/admin/folders/:folderId/upload', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen uploaden' });
  const { folderId } = req.params;
  const { filename, mimeType, data: base64Data } = req.body || {};
  if (!filename || !base64Data) return res.status(400).json({ error: 'filename en data zijn verplicht' });
  try {
    const { data: folder } = await supabaseAdmin.from('document_folders').select('folder_type').eq('id', folderId).maybeSingle();
    const bucket = (folder?.folder_type === 'rag_sources') ? 'rag_sources' : 'documents';
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
    const filePath = `${folderId}/${Date.now()}_${safeFilename}`;
    const fileExt = (filename.split('.').pop() || '').toLowerCase();
    const resolvedMime = mimeType || getFileMimeType(fileExt);
    const { error: storageErr } = await supabaseAdmin.storage.from(bucket).upload(filePath, fileBuffer, { contentType: resolvedMime, upsert: false });
    if (storageErr) return res.status(500).json({ error: `Storage upload mislukt: ${storageErr.message}` });
    const isRag = bucket === 'rag_sources';
    const { data: doc, error: dbErr } = await supabaseAdmin.from('documents').insert({
      title: filename, filename, file_path: filePath, file_type: fileExt,
      file_size: fileBuffer.length, folder_id: folderId, bucket,
      mime_type: resolvedMime, uploaded_by: r.user.id,
      processing_status: isRag ? 'processing' : 'pending',
    }).select().single();
    if (dbErr) {
      await supabaseAdmin.storage.from(bucket).remove([filePath]);
      return res.status(500).json({ error: dbErr.message });
    }
    // RAG-bestanden meteen verwerken (chunks + embeddings) zodat ze niet op
    // 'pending'/'processing' blijven hangen. Asynchroon zodat de upload-respons
    // snel terugkomt; de verwerking zet de status zelf op completed/failed.
    if (isRag) {
      processRagDocumentById(doc.id, 'nl').catch(async (err) => {
        console.error(`[folder-upload] verwerking mislukt voor doc=${doc.id}:`, err?.message || err);
        try {
          await supabaseAdmin.from('documents')
            .update({ processing_status: 'failed' }).eq('id', doc.id);
        } catch { /* best effort */ }
      });
    }
    return res.json({ document: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/create-rag-folder', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, courseName } = req.body;
  if (!courseId || !courseName) {
    return res.status(400).json({ error: 'courseId and courseName are required' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Could not verify user role' });
    }

    const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const { data: existingFolder } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .eq('name', `RAG - ${courseName}`)
      .maybeSingle();

    let folderId;
    if (existingFolder) {
      folderId = existingFolder.id;
      console.log(`[create-rag-folder] Reusing existing folder ${folderId} for course ${courseName}`);
    } else {
      const { data: newFolder, error: folderError } = await supabaseAdmin
        .from('document_folders')
        .insert({
          name: `RAG - ${courseName}`,
          description: `RAG-bronnen voor cursus ${courseName}`,
          parent_folder_id: null,
          created_by: user.id,
          folder_type: 'rag_sources',
          is_root: false,
        })
        .select()
        .single();

      if (folderError || !newFolder) {
        console.error('[create-rag-folder] folder insert error:', folderError);
        return res.status(500).json({ error: `Kon RAG-map niet aanmaken: ${folderError?.message}` });
      }

      folderId = newFolder.id;

      const { error: permError } = await supabaseAdmin
        .from('folder_permissions')
        .insert([
          { folder_id: folderId, role: 'admin', can_view: true, can_edit: true },
          { folder_id: folderId, role: 'docent', can_view: true, can_edit: true },
          { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
        ]);

      if (permError) {
        console.warn('[create-rag-folder] permissions insert error (non-fatal):', permError.message);
      }

      console.log(`[create-rag-folder] Created folder ${folderId} for course ${courseName}`);
    }

    const { data: existingAssignment } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('id')
      .eq('course_id', courseId)
      .eq('folder_id', folderId)
      .maybeSingle();

    if (!existingAssignment) {
      const { error: assignError } = await supabaseAdmin
        .from('course_folder_assignments')
        .insert({ course_id: courseId, folder_id: folderId });

      if (assignError) {
        console.error('[create-rag-folder] assignment insert error:', assignError);
        return res.status(500).json({ error: `Kon map niet koppelen aan cursus: ${assignError.message}` });
      }
      console.log(`[create-rag-folder] Linked folder ${folderId} to course ${courseId}`);
    }

    return res.json({ folderId, created: !existingFolder });
  } catch (err) {
    console.error('[create-rag-folder] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Zorgt dat er een RAG-map (`RAG - <cursusnaam>`) bestaat, met permissies en
// een koppeling aan de cursus. Hergebruikt een bestaande map (idempotent).
// Spiegelt de logica van /api/admin/create-rag-folder voor server-side gebruik
// door de web-import. Retourneert { folderId, created }.
async function ensureCourseRagFolder(courseId, courseName, userId) {
  // 1) Heeft de cursus al een gekoppelde RAG-map? Hergebruik die dan, ook als de
  //    cursusnaam intussen is gewijzigd. Dit voorkomt dubbele mappen.
  const { data: assignments } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('folder_id')
    .eq('course_id', courseId);
  const assignedIds = (assignments || []).map((a) => a.folder_id).filter(Boolean);
  if (assignedIds.length > 0) {
    const { data: ragFolder } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', assignedIds)
      .eq('folder_type', 'rag_sources')
      .limit(1)
      .maybeSingle();
    if (ragFolder) {
      return { folderId: ragFolder.id, created: false };
    }
  }

  // 2) Anders: zoek op naam (mogelijk al aangemaakt zonder koppeling) of maak nieuw.
  const { data: existingFolder } = await supabaseAdmin
    .from('document_folders')
    .select('id')
    .eq('name', `RAG - ${courseName}`)
    .eq('folder_type', 'rag_sources')
    .maybeSingle();

  let folderId;
  let created = false;
  if (existingFolder) {
    folderId = existingFolder.id;
  } else {
    const { data: newFolder, error: folderError } = await supabaseAdmin
      .from('document_folders')
      .insert({
        name: `RAG - ${courseName}`,
        description: `RAG-bronnen voor cursus ${courseName}`,
        parent_folder_id: null,
        created_by: userId,
        folder_type: 'rag_sources',
        is_root: false,
      })
      .select()
      .single();
    if (folderError || !newFolder) {
      throw new Error(`Kon RAG-map niet aanmaken: ${folderError?.message || 'onbekende fout'}`);
    }
    folderId = newFolder.id;
    created = true;

    const { error: permError } = await supabaseAdmin
      .from('folder_permissions')
      .insert([
        { folder_id: folderId, role: 'admin', can_view: true, can_edit: true },
        { folder_id: folderId, role: 'docent', can_view: true, can_edit: true },
        { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
      ]);
    if (permError) {
      console.warn('[ensureCourseRagFolder] permissions insert error (non-fatal):', permError.message);
    }
  }

  const { data: existingAssignment } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('id')
    .eq('course_id', courseId)
    .eq('folder_id', folderId)
    .maybeSingle();
  if (!existingAssignment) {
    const { error: assignError } = await supabaseAdmin
      .from('course_folder_assignments')
      .insert({ course_id: courseId, folder_id: folderId });
    if (assignError) {
      throw new Error(`Kon map niet koppelen aan cursus: ${assignError.message}`);
    }
  }

  return { folderId, created };
}

// POST /api/admin/import-web/discover — ontdek de pagina's van een webomgeving
// (Task #234). Body: { url }. Crawlt (sitemap of BFS) binnen dezelfde omgeving
// en geeft een lijst { url, title } terug zodat de docent kan kiezen wat te
// importeren. Beschikbaar voor staff (admin of docent ergens).
app.post('/api/admin/import-web/discover', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin && !r.isDocent) return res.status(403).json({ error: 'Alleen docenten of admins mogen importeren.' });

  const rawUrl = String(req.body?.url || '').trim();
  const start = normalizeWebUrl(rawUrl);
  if (!start) return res.status(400).json({ error: 'Ongeldige URL. Geef een volledige http(s)-URL op.' });
  if (isBlockedWebHost(start)) {
    return res.status(400).json({ error: 'Deze URL wijst naar een intern of niet-toegestaan adres.' });
  }

  try {
    const { pages, method, warnings } = await discoverWebPages(start, fetch, { lookup: resolveHostAddresses });
    return res.json({ pages, method, warnings, baseUrl: start });
  } catch (err) {
    console.error('[import-web/discover] fout:', err);
    return res.status(500).json({ error: err.message || 'Ontdekken van pagina\'s mislukt.' });
  }
});

// POST /api/admin/import-web/import — importeer geselecteerde pagina's als
// RAG-bronnen in de cursus (Task #234). Body: { courseId, baseUrl, pages: [{url,title?}] }.
// Per pagina: ophalen → schone tekst → chunks → embeddings → opslaan als
// documents-rij (file_type='web', file_path=url) + document_chunks. Idempotent
// per (folder, url): bestaande web-bron wordt hergebruikt en bijgewerkt.
app.post('/api/admin/import-web/import', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);

  const courseId = req.body?.courseId;
  const baseUrl = String(req.body?.baseUrl || '').trim();
  const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
  if (!courseId) return res.status(400).json({ error: 'courseId is verplicht.' });
  if (pages.length === 0) return res.status(400).json({ error: 'Geen pagina\'s geselecteerd om te importeren.' });

  if (!(await isStaffForCourse(r.user, r.profile, courseId))) {
    return res.status(403).json({ error: 'Je bent geen docent van deze cursus.' });
  }

  if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

  try {
    const { data: course } = await supabaseAdmin
      .from('courses').select('id, name').eq('id', courseId).maybeSingle();
    if (!course) return res.status(404).json({ error: 'Cursus niet gevonden.' });

    const { folderId } = await ensureCourseRagFolder(courseId, course.name, r.user.id);

    // De baseUrl bepaalt de toegestane scope: alleen pagina's binnen dezelfde
    // webomgeving mogen geïmporteerd worden. Zonder geldige baseUrl weigeren we,
    // zodat een client niet zomaar willekeurige URL's kan laten ophalen.
    const scope = normalizeWebUrl(baseUrl);
    if (!scope || isBlockedWebHost(scope)) {
      return res.status(400).json({ error: 'Ongeldige of niet-toegestane baseUrl.' });
    }

    // Pagina-URL's normaliseren, ontdubbelen, binnen de scope houden en niet naar
    // interne adressen laten wijzen. Buiten de scope/limiet wordt overgeslagen.
    const seen = new Set();
    const targets = [];
    let outOfScope = 0;
    for (const p of pages) {
      const url = normalizeWebUrl(String(p?.url || '').trim());
      if (!url || seen.has(url)) continue;
      if (isBlockedWebHost(url) || !sameWebEnv(scope, url)) { outOfScope++; continue; }
      seen.add(url);
      targets.push({ url, title: typeof p?.title === 'string' ? p.title.trim() : '' });
      if (targets.length >= WEB_IMPORT_LIMITS.MAX_PAGES) break;
    }
    if (targets.length === 0) {
      return res.status(400).json({ error: 'Geen geldige pagina\'s binnen de opgegeven website-scope.' });
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let totalChunks = 0;
    const results = [];

    // Vanaf hier streamen we de voortgang als NDJSON (één JSON-object per regel)
    // zodat de client live kan tonen welke pagina nu verwerkt wordt. Alle
    // validatie hierboven gebruikt nog gewone status-codes; vanaf nu is de
    // status altijd 200 en worden fouten als event gemeld.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const emit = (event) => {
      res.write(JSON.stringify(event) + '\n');
      if (typeof res.flush === 'function') res.flush();
    };
    emit({ type: 'start', total: targets.length });

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      emit({ type: 'progress', index: i + 1, total: targets.length, url: target.url, title: target.title || '' });
      try {
        const resp = await fetchWebPage(target.url, fetch, { scope, lookup: resolveHostAddresses });
        if (!resp.ok) {
          errors++;
          results.push({ url: target.url, status: 'error', message: resp.error || `HTTP ${resp.status || 'netwerkfout'}` });
          continue;
        }
        // Verdedigend: ook al checkt fetchWebPage redirects tegen de scope, valideer
        // de uiteindelijke URL nog eens zodat content buiten de webomgeving nooit
        // als RAG-bron belandt.
        if (resp.finalUrl && (isBlockedWebHost(resp.finalUrl) || !sameWebEnv(scope, resp.finalUrl))) {
          outOfScope++;
          results.push({ url: target.url, status: 'skipped', message: 'Redirect buiten de website-scope' });
          continue;
        }
        const text = webHtmlToText(resp.html);
        if (text.length < WEB_IMPORT_LIMITS.MIN_TEXT_CHARS) {
          skipped++;
          results.push({ url: target.url, status: 'skipped', message: 'Te weinig leesbare tekst' });
          continue;
        }
        const title = (target.title || webExtractTitle(resp.html) || target.url).slice(0, 280);
        const chunks = chunkPlainText(text);
        if (!chunks.length) {
          skipped++;
          results.push({ url: target.url, status: 'skipped', message: 'Geen chunks' });
          continue;
        }
        const embeddings = await embedTextsServer(chunks, null);

        // Idempotent: bestaande web-bron voor dezelfde URL in deze map hergebruiken.
        const { data: existingDoc } = await supabaseAdmin
          .from('documents')
          .select('id')
          .eq('folder_id', folderId)
          .eq('file_path', target.url)
          .eq('file_type', 'web')
          .maybeSingle();

        let docId;
        if (existingDoc) {
          docId = existingDoc.id;
          const { error: delErr } = await supabaseAdmin
            .from('document_chunks').delete().eq('document_id', docId);
          if (delErr) throw new Error(`Kon oude chunks niet verwijderen: ${delErr.message}`);
          const { error: updErr } = await supabaseAdmin.from('documents').update({
            title,
            filename: title,
            mime_type: 'text/html',
            processing_status: 'completed',
            total_chunks: chunks.length,
          }).eq('id', docId);
          if (updErr) throw new Error(`Kon document niet bijwerken: ${updErr.message}`);
        } else {
          const { data: newDoc, error: docErr } = await supabaseAdmin
            .from('documents')
            .insert({
              title,
              filename: title,
              file_path: target.url,
              file_type: 'web',
              bucket: 'rag_sources',
              folder_id: folderId,
              mime_type: 'text/html',
              processing_status: 'completed',
              total_chunks: chunks.length,
              uploaded_by: r.user.id,
            })
            .select('id')
            .single();
          if (docErr || !newDoc) throw new Error(docErr?.message || 'Kon document niet aanmaken');
          docId = newDoc.id;
        }

        const rows = chunks.map((content, i) => ({
          document_id: docId,
          content,
          embedding: embeddings[i],
          chunk_index: i,
          metadata: { source: 'web', sourceUrl: target.url },
        }));
        const { error: insErr } = await supabaseAdmin.from('document_chunks').insert(rows);
        if (insErr) throw new Error(insErr.message);

        imported++;
        totalChunks += chunks.length;
        results.push({ url: target.url, status: 'imported', title, chunks: chunks.length });
      } catch (err) {
        errors++;
        results.push({ url: target.url, status: 'error', message: err.message || 'Onbekende fout' });
        console.error(`[import-web/import] pagina mislukt (${target.url}):`, err.message);
      }
    }

    emit({ type: 'done', imported, skipped, errors, outOfScope, totalChunks, folderId, courseName: course.name, results });
    return res.end();
  } catch (err) {
    console.error('[import-web/import] fout:', err);
    // Als het streamen al begonnen is kunnen we de status niet meer wijzigen;
    // meld de fout dan als event en sluit de stream netjes af.
    if (res.headersSent) {
      try { res.write(JSON.stringify({ type: 'error', error: err.message || 'Web-import mislukt.' }) + '\n'); } catch {}
      return res.end();
    }
    return res.status(500).json({ error: err.message || 'Web-import mislukt.' });
  }
});

// POST /api/admin/courses — maak een nieuwe cursus aan met bijhorende
// parent-map ({naam}), RAG-submap en Projectdata-submap (analoog aan MenS1).
app.post('/api/admin/courses', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen aanmaken' });

  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (!rawName) return res.status(400).json({ error: 'Cursusnaam is verplicht' });
  if (rawName.length > 120) return res.status(400).json({ error: 'Cursusnaam is te lang (max 120 tekens)' });

  // Houd aangemaakte ID's bij zodat we bij een mislukking netjes kunnen opruimen
  // (Supabase JS-client kent geen multi-statement transacties).
  const createdFolderIds = [];
  let createdCourseId = null;

  const rollback = async (reason) => {
    console.warn(`[admin/courses] Rolling back na fout: ${reason}`);
    for (const fid of [...createdFolderIds].reverse()) {
      try { await supabaseAdmin.from('document_folders').delete().eq('id', fid); }
      catch (e) { console.warn('[admin/courses] rollback folder fout (genegeerd):', e?.message); }
    }
    if (createdCourseId) {
      try { await supabaseAdmin.from('courses').delete().eq('id', createdCourseId); }
      catch (e) { console.warn('[admin/courses] rollback course fout (genegeerd):', e?.message); }
    }
  };

  try {
    // 1) Voorkom dubbele cursusnaam OF dubbele folder_name (beide kolommen
    //    hebben een UNIQUE-constraint en zijn in onze flow altijd gelijk).
    //    We doen twee aparte gelijkheidsqueries i.p.v. .or() met string-
    //    interpolatie, omdat namen leestekens kunnen bevatten die de
    //    PostgREST-or-filter zouden breken. Een unieke index garandeert
    //    bovendien dat 23505 onder een race-conditie altijd opgevangen wordt.
    const [{ data: clashByName }, { data: clashByFolder }] = await Promise.all([
      supabaseAdmin.from('courses').select('id').eq('name', rawName).maybeSingle(),
      supabaseAdmin.from('courses').select('id').eq('folder_name', rawName).maybeSingle(),
    ]);
    if (clashByName || clashByFolder) {
      return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${rawName}"` });
    }

    // 2) Zoek de globale root-map (is_root=true). Nodig voor de parent-map.
    const { data: rootFolder, error: rootErr } = await supabaseAdmin
      .from('document_folders').select('id').eq('is_root', true).limit(1).maybeSingle();
    if (rootErr || !rootFolder) {
      return res.status(500).json({ error: 'Globale root-map (is_root=true) niet gevonden' });
    }

    // 3) Maak de cursus aan. courses.folder_name is NOT NULL UNIQUE en wordt
    //    altijd gelijkgehouden aan courses.name (zo zijn MenS1 en Basiscursus
    //    ook aangemaakt). Sync-tooling (src/services/courseSync.ts) gebruikt
    //    folder_name om met Supabase Storage-rootmappen te vergelijken.
    const { data: newCourse, error: courseErr } = await supabaseAdmin
      .from('courses')
      .insert({
        name: rawName,
        folder_name: rawName,
        description: description || null,
        is_active: true,
      })
      .select('id, name, folder_name, description, is_active')
      .single();
    if (courseErr || !newCourse) {
      // 23505 = unique_violation — race-conditie tussen pre-check en insert.
      if (courseErr && (courseErr.code === '23505' || /duplicate key/i.test(courseErr.message || ''))) {
        return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${rawName}"` });
      }
      return res.status(500).json({ error: `Kon cursus niet aanmaken: ${courseErr?.message}` });
    }
    createdCourseId = newCourse.id;

    const insertPerms = async (folderId) => {
      const { error } = await supabaseAdmin.from('folder_permissions').insert([
        { folder_id: folderId, role: 'admin',   can_view: true, can_edit: true },
        { folder_id: folderId, role: 'docent',  can_view: true, can_edit: true },
        { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
      ]);
      if (error) throw new Error(`folder_permissions insert mislukt voor ${folderId}: ${error.message}`);
    };

    // 4) Parent-cursusmap onder root.
    const { data: courseFolder, error: cfErr } = await supabaseAdmin
      .from('document_folders').insert({
        name: rawName,
        description: `Cursusmap ${rawName}`,
        parent_folder_id: rootFolder.id,
        created_by: r.user.id,
        folder_type: 'course',
        is_root: false,
      }).select('id').single();
    if (cfErr || !courseFolder) {
      await rollback(`cursusmap-insert: ${cfErr?.message}`);
      return res.status(500).json({ error: `Kon cursusmap niet aanmaken: ${cfErr?.message}` });
    }
    createdFolderIds.push(courseFolder.id);
    await insertPerms(courseFolder.id);

    // 5) RAG-submap.
    const { data: ragFolder, error: ragErr } = await supabaseAdmin
      .from('document_folders').insert({
        name: 'RAG',
        description: `RAG-documenten voor ${rawName}`,
        parent_folder_id: courseFolder.id,
        created_by: r.user.id,
        folder_type: 'rag_sources',
        is_root: false,
      }).select('id').single();
    if (ragErr || !ragFolder) {
      await rollback(`rag-folder-insert: ${ragErr?.message}`);
      return res.status(500).json({ error: `Kon RAG-map niet aanmaken: ${ragErr?.message}` });
    }
    createdFolderIds.push(ragFolder.id);
    await insertPerms(ragFolder.id);

    // 6) Projectdata-submap.
    const { data: dataFolder, error: dataErr } = await supabaseAdmin
      .from('document_folders').insert({
        name: 'Projectdata',
        description: `Projectbestanden voor ${rawName}`,
        parent_folder_id: courseFolder.id,
        created_by: r.user.id,
        folder_type: 'data',
        is_root: false,
      }).select('id').single();
    if (dataErr || !dataFolder) {
      await rollback(`projectdata-folder-insert: ${dataErr?.message}`);
      return res.status(500).json({ error: `Kon Projectdata-map niet aanmaken: ${dataErr?.message}` });
    }
    createdFolderIds.push(dataFolder.id);
    await insertPerms(dataFolder.id);

    // 6b) Uploads-submap voor studenten-inleveringen (Task #156).
    const { data: uploadsFolder, error: upErr } = await supabaseAdmin
      .from('document_folders').insert({
        name: 'Uploads',
        description: `Inleveringen voor ${rawName}`,
        parent_folder_id: courseFolder.id,
        created_by: r.user.id,
        folder_type: 'uploads',
        bucket_type: 'docs_general',
        is_root: false,
      }).select('id').single();
    if (upErr || !uploadsFolder) {
      await rollback(`uploads-folder-insert: ${upErr?.message}`);
      return res.status(500).json({ error: `Kon Uploads-map niet aanmaken: ${upErr?.message}` });
    }
    createdFolderIds.push(uploadsFolder.id);
    await insertPerms(uploadsFolder.id);

    // 7) Koppel beide submappen aan de cursus (verplicht — anders zien cursus en mappen elkaar niet).
    const { error: assignErr } = await supabaseAdmin
      .from('course_folder_assignments').insert([
        { course_id: createdCourseId, folder_id: ragFolder.id },
        { course_id: createdCourseId, folder_id: dataFolder.id },
        { course_id: createdCourseId, folder_id: uploadsFolder.id },
      ]);
    if (assignErr) {
      await rollback(`course_folder_assignments: ${assignErr.message}`);
      return res.status(500).json({ error: `Kon mappen niet koppelen aan cursus: ${assignErr.message}` });
    }

    // 8) Activeer RAG-modules voor de RAG-map (analoog aan MenS1). Niet-fataal.
    const { error: ragAssignErr } = await supabaseAdmin
      .from('folder_rag_assignments').insert([
        { folder_id: ragFolder.id, module_type: 'general', is_active: true },
        { folder_id: ragFolder.id, module_type: 'explain', is_active: true },
        { folder_id: ragFolder.id, module_type: 'quiz',    is_active: true },
      ]);
    if (ragAssignErr) {
      console.warn('[admin/courses] folder_rag_assignments insert (non-fatal):', ragAssignErr.message);
    }

    console.log(`[admin/courses] Cursus "${rawName}" aangemaakt (${createdCourseId}) met folders ${courseFolder.id}/${ragFolder.id}/${dataFolder.id}/${uploadsFolder.id}`);
    return res.status(201).json({
      course: newCourse,
      courseFolderId: courseFolder.id,
      ragFolderId: ragFolder.id,
      projectdataFolderId: dataFolder.id,
      uploadsFolderId: uploadsFolder.id,
      ragModulesWarning: ragAssignErr ? ragAssignErr.message : null,
    });
  } catch (err) {
    console.error('[admin/courses] Unexpected error:', err);
    await rollback(`exception: ${err?.message}`);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// DELETE /api/admin/courses/:id/members — verwijder in één keer alle leden van
// een cursus. Alleen voor admins. Bedoeld om de "cursus verwijderen"-flow te
// deblokkeren wanneer er nog gekoppelde leden zijn.
app.delete('/api/admin/courses/:id/members', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen leden bulk verwijderen' });

  const courseId = req.params.id;
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

  const { data: course, error: courseErr } = await supabaseAdmin
    .from('courses').select('id, name').eq('id', courseId).maybeSingle();
  if (courseErr) return res.status(500).json({ error: courseErr.message });
  if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });

  const { error: delErr, count } = await supabaseAdmin
    .from('course_members')
    .delete({ count: 'exact' })
    .eq('course_id', courseId);
  if (delErr) return res.status(500).json({ error: delErr.message });

  return res.json({ ok: true, removed: count ?? 0, course: { id: course.id, name: course.name } });
});

// GET /api/admin/courses/:id/members — lijst alle leden van een cursus met
// hun member_role ('student'|'teacher'). Toegankelijk voor admin/superuser
// en voor docenten van deze cursus. Joins met profiles voor weergave.
app.get('/api/admin/courses/:id/members', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  const courseId = req.params.id;
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

  if (!r.isAdmin && !(await isCourseTeacher(r.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }

  // We joinen course_members hier NIET via een PostgREST-embed
  // (`profiles(...)`). course_members.user_id verwijst naar auth.users, niet
  // naar profiles, dus PostgREST kent geen directe relatie en geeft anders
  // "Could not find a relationship between 'course_members' and 'profiles'".
  // Daarom halen we eerst de leden op en daarna de bijbehorende profiles in
  // een tweede query, die we in JS samenvoegen (defensief, niet afhankelijk
  // van de schema-cache).
  const { data: rows, error } = await supabaseAdmin
    .from('course_members')
    .select('user_id, member_role, joined_at')
    .eq('course_id', courseId)
    .order('joined_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const userIds = collectMemberUserIds(rows);
  let profs = [];
  if (userIds.length > 0) {
    const { data: profData, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role')
      .in('id', userIds);
    if (profErr) return res.status(500).json({ error: profErr.message });
    profs = profData || [];
  }

  const members = mergeCourseMembers(rows, profs);
  return res.json({ members });
});

// PUT /api/admin/courses/:id/members/:userId — wijzig de per-cursus rol
// ('student' of 'teacher'). Toegestaan voor admin/superuser OF voor een
// per-cursus docent van déze cursus (course_members.member_role='teacher').
// Laatste-docent-bescherming: het demoten of verwijderen van de laatste
// docent van een cursus geeft 409 zodat de cursus niet per ongeluk
// docentloos achterblijft. Admins mogen forceren met query ?force=1.
app.put('/api/admin/courses/:id/members/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);

  const { id: courseId, userId } = req.params;
  const { member_role } = req.body || {};
  if (!courseId || !userId) return res.status(400).json({ error: 'Cursus-ID of user-ID ontbreekt' });
  if (member_role !== 'student' && member_role !== 'teacher') {
    return res.status(400).json({ error: 'member_role moet "student" of "teacher" zijn' });
  }

  // Autorisatie: admin OR per-cursus docent van déze cursus. Strikt
  // courseId-gescoped — een docent van een andere cursus krijgt 403.
  const callerIsCourseTeacher = r.isAdmin ? false : await isCourseTeacher(r.user.id, courseId);
  const authz = authorizeMemberRoleChange({ isAdmin: r.isAdmin, isCourseTeacher: callerIsCourseTeacher });
  if (!authz.allowed) return res.status(authz.status).json(authz.body);

  const force = parseForceFlag(req.query.force);

  // Atomair pad via pgPool — voorkomt een race waarbij twee gelijktijdige
  // demoties beide "count=2" zien en de cursus docentloos achterlaten. We
  // openen één transactie, locken álle teacher-rijen van de cursus met
  // FOR UPDATE, en pas dan tellen + updaten. Bij ontbreken van pgPool
  // valt de code terug op het oudere non-atomic pad (best-effort).
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      // Lock alle membership-rijen van deze cursus om concurrent demoties
      // te serialiseren. We hebben de hele set nodig om correct te tellen.
      const { rows: lockedRows } = await client.query(
        'SELECT user_id, member_role FROM course_members WHERE course_id = $1 FOR UPDATE',
        [courseId]
      );
      const existing = lockedRows.find((row) => row.user_id === userId);
      if (!existing) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
      }
      const teacherCount = lockedRows.filter((row) => row.member_role === 'teacher').length;
      const guard = checkLastTeacherProtection({
        existingMemberRole: existing.member_role,
        newMemberRole: member_role,
        teacherCount,
        isAdmin: r.isAdmin,
        force,
      });
      if (!guard.ok) {
        await client.query('ROLLBACK');
        return res.status(guard.status).json(guard.body);
      }
      // Houd de legacy NOT NULL-kolom `role` in sync met member_role (behalve
      // voor superusers, waar role='superuser' bewaard blijft). Voorkomt dat
      // een demotie een role=teacher/member_role=student-drift achterlaat.
      await client.query(
        `UPDATE course_members
            SET member_role = $1,
                role = CASE WHEN role = 'superuser' THEN role ELSE $1 END
          WHERE course_id = $2 AND user_id = $3`,
        [member_role, courseId, userId]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, user_id: userId, course_id: courseId, member_role });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      console.error('[admin members PUT] tx error', txErr.message);
      return res.status(500).json({ error: txErr.message });
    } finally {
      client.release();
    }
  }

  // Fallback zonder directe DB-verbinding (best-effort, niet race-safe).
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('course_members')
    .select('member_role, role')
    .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!existing) return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
  {
    const { count, error: cntErr } = await supabaseAdmin
      .from('course_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('member_role', 'teacher');
    if (cntErr) return res.status(500).json({ error: cntErr.message });
    const guard = checkLastTeacherProtection({
      existingMemberRole: existing.member_role,
      newMemberRole: member_role,
      teacherCount: count || 0,
      isAdmin: r.isAdmin,
      force,
    });
    if (!guard.ok) return res.status(guard.status).json(guard.body);
  }
  // Spiegel member_role naar de legacy `role`-kolom (superuser blijft superuser).
  const nextLegacyRole = existing.role === 'superuser' ? 'superuser' : member_role;
  const { error: updErr } = await supabaseAdmin
    .from('course_members')
    .update({ member_role, role: nextLegacyRole })
    .eq('course_id', courseId)
    .eq('user_id', userId);
  if (updErr) return res.status(500).json({ error: updErr.message });
  return res.json({ ok: true, user_id: userId, course_id: courseId, member_role });
});

// POST /api/admin/courses/:id/members/:userId — voeg een gebruiker toe aan
// een cursus met een gegeven member_role ('student' of 'teacher'). Idempotent:
// als de gebruiker al lid is, wordt diens member_role bijgewerkt (handig om
// vanuit /admin → Gebruikers iemand direct als docent toe te voegen aan een
// cursus). Admin-only.
app.post('/api/admin/courses/:id/members/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen leden toevoegen' });
  const { id: courseId, userId } = req.params;
  const { member_role } = req.body || {};
  if (!courseId || !userId) return res.status(400).json({ error: 'Cursus-ID of user-ID ontbreekt' });
  // Dit endpoint is bedoeld om iemand als docent (of student) toe te voegen.
  // Demoties van bestaande docenten lopen via PUT (met last-teacher-bescherming);
  // hier laten we daarom een bestaande teacher-rol NOOIT door dit endpoint
  // omlaag worden gezet, zodat de invariant "elke cursus houdt minstens één
  // docent" niet via een upsert kan worden omzeild.
  if (member_role !== 'student' && member_role !== 'teacher') {
    return res.status(400).json({ error: 'member_role moet "student" of "teacher" zijn' });
  }
  try {
    const { data: course } = await supabaseAdmin
      .from('courses').select('id').eq('id', courseId).maybeSingle();
    if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('id').eq('id', userId).maybeSingle();
    if (!prof) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const { data: existing } = await supabaseAdmin
      .from('course_members')
      .select('member_role, role')
      .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (existing && existing.member_role === 'teacher' && member_role === 'student') {
      return res.status(409).json({
        error: 'Gebruik PUT /api/admin/courses/:id/members/:userId om een docent te degraderen (last-teacher-bescherming).',
        code: 'use_put_for_demotion',
      });
    }
    // course_members.role is een legacy NOT NULL kolom met CHECK
    // (role IN ('superuser','teacher','student')). We spiegelen member_role
    // expliciet zodat upserts ook werken in omgevingen waar migratie
    // 20260527220000 (default 'student') nog niet is toegepast.
    // Behoud een bestaande superuser-rol: superusers staan als role='superuser'
    // met member_role='student'; die mag een gewone toevoeging niet overschrijven.
    const nextLegacyRole = existing && existing.role === 'superuser' ? 'superuser' : member_role;
    const { error: upErr } = await supabaseAdmin
      .from('course_members')
      .upsert(
        { course_id: courseId, user_id: userId, member_role, role: nextLegacyRole },
        { onConflict: 'course_id,user_id' }
      );
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.json({ ok: true, user_id: userId, course_id: courseId, member_role });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper — gemeenschappelijk voor admin- en self-endpoint hieronder.
async function fetchTeacherCoursesForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('course_members')
    .select('course_id, courses(id, name, is_active)')
    .eq('user_id', userId)
    .eq('member_role', 'teacher');
  if (error) throw new Error(error.message);
  return (data || [])
    .map((row) => ({
      courseId: row.course_id,
      courseName: row.courses?.name || null,
      isActive: row.courses?.is_active ?? null,
    }))
    .filter((c) => c.courseName) // verwijderde cursussen weglaten
    .sort((a, b) => (a.courseName || '').localeCompare(b.courseName || '', 'nl'));
}

// GET /api/admin/users/:userId/teacher-courses — admin-only. Gebruikt door
// de /admin Gebruikers-tab om per gebruiker te tonen in welke cursussen
// zij/hij docent is. Niet-admins krijgen 403 (zij gebruiken /api/me/...).
app.get('/api/admin/users/:userId/teacher-courses', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'user-ID ontbreekt' });
  if (!r.isAdmin) {
    return res.status(403).json({ error: 'Alleen admins mogen andermans docent-cursussen opvragen' });
  }
  try {
    const courses = await fetchTeacherCoursesForUser(userId);
    return res.json({ courses });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:userId — admin-only. Verwijdert een gebruiker
// definitief via de Supabase service-role admin-API. Dit verwijdert de rij in
// auth.users, wat cascadeert naar profiles (ON DELETE CASCADE) en gerelateerde
// tabellen. Het e-mailadres komt daarmee weer vrij voor een nieuwe registratie.
// De eigen account en de superuser kunnen niet verwijderd worden.
app.delete('/api/admin/users/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) {
    return res.status(403).json({ error: 'Alleen admins mogen gebruikers verwijderen' });
  }
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'user-ID ontbreekt' });

  if (userId === r.user.id) {
    return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
  }

  try {
    // Doelprofiel ophalen om superuser-beveiliging te kunnen afdwingen.
    const { data: targetProfile } = await supabaseAdmin
      .from('profiles').select('id, email').eq('id', userId).maybeSingle();

    if (targetProfile?.email === SUPERUSER_EMAIL) {
      return res.status(400).json({ error: 'De superuser kan niet verwijderd worden' });
    }

    const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteErr) {
      if (/not found/i.test(deleteErr.message || '')) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      }
      throw new Error(deleteErr.message);
    }

    console.log(`[admin DELETE user] Removed user=${userId} by admin=${r.user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[admin DELETE user] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/me/teacher-courses — geeft de ingelogde gebruiker de lijst
// cursussen waarin zij/hij per-cursus docent is. Wordt door CoursesAdmin
// gebruikt om de 'Beheer leden'-knop te tonen voor non-admin docenten.
app.get('/api/me/teacher-courses', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  try {
    const courses = await fetchTeacherCoursesForUser(r.user.id);
    return res.json({ courses });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Bulk-accounts (Task #271) ───────────────────────────────────────────────
// Schrijft een gebruiker in als student in een cursus. Vult BEIDE rolkolommen:
// member_role (nieuw) én de legacy NOT NULL `role` (CHECK student/teacher/superuser).
// insertOnly=true gebruikt resolution=ignore-duplicates zodat een bestaande rij
// NOOIT wordt overschreven (een docent blijft docent, een superuser superuser).
// Retourneert null bij succes, anders een foutmelding-string.
async function enrollAsStudent(courseId, userId, { insertOnly } = {}) {
  try {
    const { error } = await supabaseAdmin
      .from('course_members')
      .upsert(
        { course_id: courseId, user_id: userId, member_role: 'student', role: 'student' },
        { onConflict: 'course_id,user_id', ignoreDuplicates: !!insertOnly }
      );
    if (error) return error.message;
    return null;
  } catch (e) {
    return e.message || 'onbekende fout';
  }
}

// POST /api/admin/bulk-accounts/parse-file — leest een geüpload bestand
// (.csv/.txt of office-formaat .xlsx/.docx/.pdf/…) en vist er e-mailadressen uit.
// Alleen voor staff (admin of docent ergens). Geeft een ontdubbelde lijst terug;
// de client laat de docent de lijst nog nakijken vóór het echte aanmaken.
app.post('/api/admin/bulk-accounts/parse-file', docUpload.single('file'), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin && !r.isDocent) {
    return res.status(403).json({ error: 'Alleen docent of admin mag bestanden inlezen' });
  }
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  let text = '';
  try {
    text = await extractTextFromUpload(req.file);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' });
  }
  const emails = dedupeEmails(extractEmails(text));
  return res.json({ emails, count: emails.length });
});

// POST /api/admin/bulk-accounts/provision — maakt in bulk studentaccounts aan
// vanuit een e-maillijst en schrijft ze in één gekozen cursus in. Service-role
// only. Autorisatie: admin (elke cursus) of docent van DÉZE cursus.
// Body: { courseId, emails: string[], redirectBase?: string }.
// Idempotent: bestaande adressen worden gerapporteerd als 'existed' en (alleen
// indien nog niet ingeschreven) als student bijgeschreven zonder hun bestaande
// rol of actieve cursus aan te raken. Nieuwe adressen krijgen een Supabase-
// activatie-uitnodiging (e-mail), worden als student ingeschreven en krijgen de
// gekozen cursus als actieve cursus.
app.post('/api/admin/bulk-accounts/provision', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await requireAuthUser(req, res);
  if (!auth) return;

  const courseId = req.body?.courseId;
  const rawEmails = Array.isArray(req.body?.emails) ? req.body.emails : [];
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

  // Autorisatie: admin/superuser overal; anders docent van déze cursus.
  const isAdmin = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  const teacherOfCourse = isAdmin ? false : await isCourseTeacher(auth.user.id, courseId);
  const decision = authorizeBulkProvision({ isAdmin, isCourseTeacher: teacherOfCourse });
  if (!decision.allowed) return res.status(decision.status).json(decision.body);

  // Cursus moet bestaan.
  const { data: course, error: courseErr } = await supabaseAdmin
    .from('courses').select('id, name').eq('id', courseId).maybeSingle();
  if (courseErr) return res.status(500).json({ error: courseErr.message });
  if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });

  // Normaliseer/valideer/ontdubbel + batch-cap.
  const { valid, invalid, duplicates } = normalizeEmailList(rawEmails);
  const sizeCheck = validateBatchSize(valid);
  if (!sizeCheck.ok) return res.status(sizeCheck.status).json(sizeCheck.body);

  // Bestaande accounts opzoeken (profiles.email is door de trigger gevuld).
  const existingByEmail = new Map();
  {
    const { data: existingProfiles, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, email').in('email', valid);
    if (profErr) return res.status(500).json({ error: profErr.message });
    for (const p of existingProfiles || []) {
      if (p.email) existingByEmail.set(String(p.email).toLowerCase(), p.id);
    }
  }

  const redirectTo = buildActivationRedirect({
    bodyBase: req.body?.redirectBase,
    originHeader: req.headers.origin,
    envBase: process.env.APP_PUBLIC_URL,
  });

  const results = [];
  let aborted = false;
  for (const email of valid) {
    if (aborted) {
      results.push({ email, status: 'failed', error: 'Niet verwerkt — batch afgebroken na e-mail-limiet' });
      continue;
    }
    const existingId = existingByEmail.get(email);
    if (existingId) {
      // Bestaand account: idempotent bijschrijven als student (overschrijft een
      // bestaande rol NIET) en hun actieve cursus NIET aanraken.
      const enrollErr = await enrollAsStudent(courseId, existingId, { insertOnly: true });
      if (enrollErr) results.push({ email, status: 'failed', error: 'Bestond al, maar inschrijven mislukte: ' + enrollErr });
      else results.push({ email, status: 'existed' });
      continue;
    }

    // Nieuw account: uitnodigen (maakt auth.users-rij + verstuurt activatiemail).
    const { data: inv, error: invErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email,
      { redirectTo, data: { full_name: '' } }
    );
    if (invErr) {
      const msg = invErr.message || '';
      if (/already.*(registered|been registered)|email.*(exists|registered)/i.test(msg)) {
        // Race: tussentijds aangemaakt → behandel als bestaand en schrijf bij.
        const { data: p2 } = await supabaseAdmin.from('profiles').select('id').eq('email', email).maybeSingle();
        if (p2?.id) await enrollAsStudent(courseId, p2.id, { insertOnly: true });
        results.push({ email, status: 'existed' });
        continue;
      }
      if (invErr.status === 429 || /rate limit|too many|over_email_send_rate/i.test(msg)) {
        results.push({ email, status: 'failed', error: 'E-mail-limiet bereikt — probeer later opnieuw of stel aangepaste SMTP in.' });
        aborted = true;
        continue;
      }
      results.push({ email, status: 'failed', error: msg || 'Uitnodigen mislukt' });
      continue;
    }
    const newId = inv?.user?.id;
    if (!newId) {
      results.push({ email, status: 'failed', error: 'Geen gebruiker-ID na uitnodiging' });
      continue;
    }
    // Inschrijven als student (beide rolkolommen) + cursus als actief instellen.
    const enrollErr = await enrollAsStudent(courseId, newId, { insertOnly: false });
    if (enrollErr) {
      results.push({ email, status: 'failed', error: 'Account aangemaakt maar inschrijven mislukte: ' + enrollErr });
      continue;
    }
    await supabaseAdmin.from('profiles').update({ last_active_course_id: courseId }).eq('id', newId);
    results.push({ email, status: 'created' });
  }

  const summary = {
    created: results.filter((x) => x.status === 'created').length,
    existed: results.filter((x) => x.status === 'existed').length,
    failed: results.filter((x) => x.status === 'failed').length,
    invalid: invalid.length,
    duplicates,
    total: valid.length,
  };
  return res.json({ results, summary, invalid, course: { id: course.id, name: course.name } });
});

// PATCH /api/admin/courses/:id — hernoem en/of werk beschrijving bij van een
// bestaande cursus. Houdt courses.name, courses.folder_name én de parent-
// cursusmap-naam in document_folders synchroon, zodat de structuur identiek
// blijft aan MenS1/Basiscursus.
app.patch('/api/admin/courses/:id', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen bewerken' });

  const courseId = req.params.id;
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

  const nameProvided = typeof req.body?.name === 'string';
  const descProvided = typeof req.body?.description === 'string';
  const activeProvided = typeof req.body?.is_active === 'boolean';
  const cueProvided = req.body?.cue_delta_max !== undefined;
  if (!nameProvided && !descProvided && !activeProvided && !cueProvided) {
    return res.status(400).json({ error: 'Geef minstens "name", "description", "is_active" of "cue_delta_max" mee' });
  }

  const newName = nameProvided ? req.body.name.trim() : null;
  const newDesc = descProvided ? req.body.description.trim() : null;
  const newActive = activeProvided ? req.body.is_active : null;
  let newCueMax = null;
  if (cueProvided) {
    const raw = Number(req.body.cue_delta_max);
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > 5) {
      return res.status(400).json({ error: 'cue_delta_max moet een geheel getal tussen 1 en 5 zijn' });
    }
    newCueMax = raw;
  }
  if (nameProvided) {
    if (!newName) return res.status(400).json({ error: 'Cursusnaam mag niet leeg zijn' });
    if (newName.length > 120) return res.status(400).json({ error: 'Cursusnaam is te lang (max 120 tekens)' });
  }

  // We voeren de wijzigingen uit binnen één Postgres-transactie via pgPool,
  // zodat een mislukte folder-rename de courses-update ook terugdraait. De
  // supabase-js client heeft geen transactiesupport, vandaar deze route.
  if (!pgPool) {
    return res.status(503).json({ error: 'Direct DB-verbinding (SUPABASE_DB_URL) niet beschikbaar voor transactionele rename' });
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1) Bestaande cursus ophalen + row-lock.
    const existingRes = await client.query(
      'SELECT id, name, folder_name, description FROM courses WHERE id = $1 FOR UPDATE',
      [courseId]
    );
    if (existingRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cursus niet gevonden' });
    }
    const existing = existingRes.rows[0];

    // 2) Bij naamwijziging: uniekheid op name én folder_name (excl. zichzelf).
    if (nameProvided && newName !== existing.name) {
      const clashRes = await client.query(
        `SELECT id FROM courses
         WHERE id <> $1 AND (name = $2 OR folder_name = $2)
         LIMIT 1`,
        [courseId, newName]
      );
      if (clashRes.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${newName}"` });
      }
    }

    // 3) courses-rij bijwerken. name én folder_name blijven gelijk.
    const setParts = [];
    const params = [];
    let i = 1;
    if (nameProvided) {
      setParts.push(`name = $${i++}`);
      params.push(newName);
      setParts.push(`folder_name = $${i++}`);
      params.push(newName);
    }
    if (descProvided) {
      setParts.push(`description = $${i++}`);
      params.push(newDesc || null);
    }
    if (activeProvided) {
      setParts.push(`is_active = $${i++}`);
      params.push(newActive);
    }
    if (cueProvided) {
      setParts.push(`cue_delta_max = $${i++}`);
      params.push(newCueMax);
    }
    params.push(courseId);
    let updRes;
    try {
      updRes = await client.query(
        `UPDATE courses SET ${setParts.join(', ')}
         WHERE id = $${i}
         RETURNING id, name, folder_name, description, is_active`,
        params
      );
    } catch (uErr) {
      // Defensief: oude DB zonder cue_delta_max-kolom → opnieuw zonder dat veld.
      if (cueProvided && (uErr.code === '42703' || /cue_delta_max/i.test(uErr.message || ''))) {
        await client.query('ROLLBACK');
        return res.status(503).json({ error: 'cue_delta_max-kolom ontbreekt in deze database — pas de migratie eerst toe.' });
      }
      throw uErr;
    }
    const updated = updRes.rows[0];

    // 4) Bij naamwijziging: parent-cursusmap synchroon hernoemen. De map is
    //    eenduidig identificeerbaar als (parent_folder_id = root, folder_type
    //    = 'course', name = oude cursusnaam) — er bestaat een UNIQUE-
    //    constraint op (parent_folder_id, name) in document_folders. Wij
    //    eisen exact 1 geüpdatete rij; bij 0 of meer dan 1 rollback.
    if (nameProvided && newName !== existing.name) {
      const rootRes = await client.query(
        "SELECT id FROM document_folders WHERE is_root = true LIMIT 1"
      );
      if (rootRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Globale root-map (is_root=true) niet gevonden — rename teruggedraaid' });
      }
      const rootId = rootRes.rows[0].id;
      const folderRes = await client.query(
        `UPDATE document_folders
         SET name = $1, description = $2
         WHERE parent_folder_id = $3
           AND folder_type = 'course'
           AND name = $4
         RETURNING id`,
        [newName, `Cursusmap ${newName}`, rootId, existing.name]
      );
      if (folderRes.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(500).json({
          error: `Verwacht 1 cursusmap te hernoemen, maar vond er ${folderRes.rowCount}. Wijziging teruggedraaid.`,
        });
      }
    }

    await client.query('COMMIT');
    console.log(`[admin/courses] Cursus ${courseId} bijgewerkt → name="${updated.name}"`);
    return res.json({ course: updated });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    // unique_violation = 23505 (mocht race-conditie er toch doorheen glippen)
    if (err && err.code === '23505') {
      return res.status(409).json({ error: `Naam is al in gebruik door een andere cursus` });
    }
    console.error('[admin/courses PATCH] Unexpected error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/courses/:id/availability — zet een cursus op beschikbaar/niet
// beschikbaar voor studenten (Task #270). Anders dan PATCH /api/admin/courses
// (admin-only, transactioneel over meerdere velden) mag hier óók de docent van
// déze cursus de zichtbaarheid wijzigen. We gaten met requireAuthUser + de pure
// authorizeAvailabilityChange-helper (admin OF per-cursus docent). De admin-
// PATCH blijft expres ongemoeid zodat die admin-only contract houdt.
app.patch('/api/courses/:id/availability', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const courseId = req.params.id;
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

  const parsed = parseStudentVisible(req.body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

  const isAdmin = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  const teacher = isAdmin ? false : await isCourseTeacher(auth.user.id, courseId);
  const decision = authorizeAvailabilityChange({ isAdmin, isCourseTeacher: teacher });
  if (!decision.allowed) return res.status(decision.status).json(decision.body);

  try {
    const { data, error } = await supabaseAdmin
      .from('courses')
      .update({ student_visible: parsed.value })
      .eq('id', courseId)
      .select('id, name, is_active, student_visible')
      .maybeSingle();
    if (error) {
      // Defensief: oude DB zonder student_visible-kolom → duidelijke 503.
      if (error.code === '42703' || /student_visible/.test(error.message || '')) {
        return res.status(503).json({ error: 'student_visible-kolom ontbreekt in deze database — pas de migratie eerst toe.' });
      }
      console.error('[courses/availability PATCH] update error:', error);
      return res.status(500).json({ error: error.message || 'Bijwerken mislukt' });
    }
    if (!data) return res.status(404).json({ error: 'Cursus niet gevonden' });
    console.log(`[courses/availability] Cursus ${courseId} student_visible → ${parsed.value}`);
    return res.json({ course: data });
  } catch (err) {
    console.error('[courses/availability PATCH] Unexpected error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

// DELETE /api/admin/courses/:id — verwijder een cursus definitief. Alleen
// toegestaan als er geen gekoppelde leden, projecten of extra mappen/documenten
// zijn. De drie standaard-stub-folders (course/RAG/Projectdata) en hun
// koppelingen (course_folder_assignments, folder_permissions,
// folder_rag_assignments) worden in één transactie meeverwijderd.
//
// Query-parameters:
//   ?preview=true  — voert geen delete uit, geeft alleen de tellingen terug.
//   ?cascade=true  — verwijdert in één transactie ALLES dat aan de cursus
//                    hangt (leden, projecten + hun sessies/threads/messages/
//                    persona's/groep-data/checkpoints, dagboek-notities die
//                    via source_ref aan de groepen/checkpoints hangen, en de
//                    volledige cursusmap-subtree inclusief extra mappen en
//                    documenten). Alleen voor admins, dubbele bevestiging
//                    aan de client-kant.
app.delete('/api/admin/courses/:id', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  const r = await resolveAdminUser(req);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen verwijderen' });

  const courseId = req.params.id;
  if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });
  if (!pgPool) {
    return res.status(503).json({ error: 'Direct DB-verbinding (SUPABASE_DB_URL) niet beschikbaar voor transactionele delete' });
  }

  const preview = req.query?.preview === 'true' || req.query?.preview === '1';
  const cascade = req.query?.cascade === 'true' || req.query?.cascade === '1';

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1) Cursus ophalen + row-lock.
    const existingRes = await client.query(
      'SELECT id, name FROM courses WHERE id = $1 FOR UPDATE',
      [courseId]
    );
    if (existingRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cursus niet gevonden' });
    }
    const existing = existingRes.rows[0];

    // 2) Standaard course-folder + sub-folders identificeren (RAG / Projectdata).
    const rootRes = await client.query(
      "SELECT id FROM document_folders WHERE is_root = true LIMIT 1"
    );
    const rootId = rootRes.rowCount > 0 ? rootRes.rows[0].id : null;
    let courseFolderId = null;
    const subFolderIds = [];
    if (rootId) {
      const cfRes = await client.query(
        `SELECT id FROM document_folders
         WHERE parent_folder_id = $1 AND folder_type = 'course' AND name = $2
         LIMIT 1`,
        [rootId, existing.name]
      );
      if (cfRes.rowCount > 0) {
        courseFolderId = cfRes.rows[0].id;
        const subRes = await client.query(
          `SELECT id FROM document_folders
           WHERE parent_folder_id = $1
             AND folder_type IN ('rag_sources', 'data', 'uploads')
             AND name IN ('RAG', 'Projectdata', 'Uploads')`,
          [courseFolderId]
        );
        for (const row of subRes.rows) subFolderIds.push(row.id);
      }
    }
    const standardFolderIds = courseFolderId ? [courseFolderId, ...subFolderIds] : [];

    // 3) Tellingen van gekoppelde data die deletion zou blokkeren. We correleren
    //    sessies en journal-entries strikt aan deze cursus (via projects.course_id
    //    en via UUID-segmenten in learning_journal_entries.source_ref) zodat de
    //    tellingen niet per ongeluk globale rijen meenemen.
    const [
      membersRes,
      projectsRes,
      sessionsRes,
      journalRes,
      extraFoldersRes,
      docsRes,
      submissionsRes,
      uploadsDocsRes,
    ] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS n FROM course_members WHERE course_id = $1', [courseId]),
      client.query('SELECT COUNT(*)::int AS n FROM projects WHERE course_id = $1', [courseId]),
      client.query(
        `SELECT COUNT(*)::int AS n
           FROM student_project_sessions sps
           JOIN projects p ON p.id = sps.project_id
          WHERE p.course_id = $1`,
        [courseId]
      ),
      client.query(
        `SELECT COUNT(*)::int AS n
           FROM learning_journal_entries lje
          WHERE lje.source_ref IS NOT NULL
            AND (
              (
                lje.source_ref LIKE 'group_evaluate:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT pg.id
                    FROM project_groups pg
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
              OR
              (
                lje.source_ref LIKE 'group_thread_checkpoint:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT cp.id
                    FROM group_checkpoints cp
                    JOIN project_groups pg ON pg.id = cp.group_id
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
            )`,
        [courseId]
      ),
      courseFolderId
        ? client.query(
            `WITH RECURSIVE subtree AS (
               SELECT id FROM document_folders WHERE id = $1
               UNION ALL
               SELECT df.id
                 FROM document_folders df
                 JOIN subtree s ON df.parent_folder_id = s.id
             )
             SELECT COUNT(*)::int AS n FROM subtree
              WHERE NOT (id = ANY($2::uuid[]))`,
            [courseFolderId, standardFolderIds]
          )
        : Promise.resolve({ rows: [{ n: 0 }] }),
      courseFolderId
        ? client.query(
            `WITH RECURSIVE subtree AS (
               SELECT id FROM document_folders WHERE id = $1
               UNION ALL
               SELECT df.id
                 FROM document_folders df
                 JOIN subtree s ON df.parent_folder_id = s.id
             )
             SELECT COUNT(*)::int AS n FROM documents
              WHERE folder_id IN (SELECT id FROM subtree)`,
            [courseFolderId]
          )
        : Promise.resolve({ rows: [{ n: 0 }] }),
      // Inleveringen (project_submissions) van alle projecten van deze cursus.
      client.query(
        `SELECT COUNT(*)::int AS n
           FROM project_submissions ps
           JOIN projects p ON p.id = ps.project_id
          WHERE p.course_id = $1`,
        [courseId]
      ),
      // Documenten specifiek in de Uploads-submap (aparte rapportage zodat de
      // delete-preview onderscheid kan maken tussen 'gewone' documenten en
      // uploads-documenten).
      courseFolderId
        ? client.query(
            `SELECT COUNT(*)::int AS n
               FROM documents d
               JOIN document_folders f ON f.id = d.folder_id
              WHERE f.parent_folder_id = $1
                AND f.folder_type = 'uploads'`,
            [courseFolderId]
          )
        : Promise.resolve({ rows: [{ n: 0 }] }),
    ]);

    const counts = {
      members: membersRes.rows[0].n,
      projects: projectsRes.rows[0].n,
      sessions: sessionsRes.rows[0].n,
      journal_entries: journalRes.rows[0].n,
      extra_folders: extraFoldersRes.rows[0].n,
      documents: docsRes.rows[0].n,
      submissions: submissionsRes.rows[0].n,
      uploadsDocuments: uploadsDocsRes?.rows?.[0]?.n ?? 0,
    };

    const blocked =
      counts.members > 0 ||
      counts.projects > 0 ||
      counts.sessions > 0 ||
      counts.journal_entries > 0 ||
      counts.extra_folders > 0 ||
      counts.documents > 0 ||
      counts.submissions > 0;

    // Preview-modus: alleen tellingen teruggeven, niets verwijderen.
    if (preview) {
      await client.query('ROLLBACK');
      return res.json({
        ok: true,
        preview: true,
        course: { id: existing.id, name: existing.name },
        counts,
      });
    }

    if (blocked && !cascade) {
      await client.query('ROLLBACK');
      const parts = [];
      if (counts.members > 0) parts.push(`${counts.members} lid/leden`);
      if (counts.projects > 0) parts.push(`${counts.projects} project(en)`);
      if (counts.sessions > 0) parts.push(`${counts.sessions} sessie(s)`);
      if (counts.journal_entries > 0) parts.push(`${counts.journal_entries} dagboek-notitie(s)`);
      if (counts.extra_folders > 0) parts.push(`${counts.extra_folders} extra (sub)map(pen)`);
      if (counts.documents > 0) parts.push(`${counts.documents} document(en)`);
      if (counts.submissions > 0) parts.push(`${counts.submissions} inlevering(en)`);
      return res.status(409).json({
        error: `Kan cursus "${existing.name}" niet verwijderen: er is nog gekoppelde data (${parts.join(', ')}). Verwijder die eerst of deactiveer de cursus.`,
        counts,
      });
    }

    // 3b) Cascade-modus: ruim eerst alle gekoppelde data op die niet via
    //     FK-cascades verdwijnt zodra de cursus weg is. Volgorde:
    //       a. learning_journal_entries (geen FK naar projects/courses;
    //          gekoppeld via source_ref) — alleen entries die strikt aan
    //          deze cursus hangen, identiek aan de counts-query hierboven.
    //       b. projects (cascade: project_personas, project_groups,
    //          project_group_members, group_chat_messages,
    //          group_persona_threads, group_persona_messages,
    //          group_checkpoints, project_documents,
    //          project_persona_documents, student_project_sessions,
    //          project_analyses).
    //       c. course_members (zou ook via courses-cascade gaan; expliciet
    //          zodat de teruggegeven 'deleted'-tellingen kloppen).
    //       d. documents in de hele cursusmap-subtree (documents.folder_id
    //          is ON DELETE SET NULL, dus zonder expliciete delete blijven
    //          ze als wezen achter).
    //       e. folder_permissions / folder_rag_assignments voor de hele
    //          subtree.
    //       f. document_folders subtree (top-folder verwijderen cascadet
    //          dankzij parent_folder_id ON DELETE CASCADE de rest mee).
    //       g. courses-rij (cascadet course_folder_assignments,
    //          quiz_sources/itembank-mapping/rag-mix-instellingen).
    let deleted = null;
    if (cascade && blocked) {
      // a. journal-notities verwijderen — exact dezelfde filter als de
      //    counts-query, zodat we niets meer of minder raken dan getoond.
      const journalDelRes = await client.query(
        `DELETE FROM learning_journal_entries lje
          WHERE lje.source_ref IS NOT NULL
            AND (
              (
                lje.source_ref LIKE 'group_evaluate:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT pg.id
                    FROM project_groups pg
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
              OR
              (
                lje.source_ref LIKE 'group_thread_checkpoint:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT cp.id
                    FROM group_checkpoints cp
                    JOIN project_groups pg ON pg.id = cp.group_id
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
            )`,
        [courseId]
      );

      // b. Projecten — cascadet alle project-sub-tabellen mee.
      const projectsDelRes = await client.query(
        'DELETE FROM projects WHERE course_id = $1',
        [courseId]
      );

      // c. Cursus-leden expliciet.
      const membersDelRes = await client.query(
        'DELETE FROM course_members WHERE course_id = $1',
        [courseId]
      );

      // d/e/f. Volledige folder-subtree onder de cursusmap.
      let documentsDeleted = 0;
      let extraFoldersDeleted = 0;
      if (courseFolderId) {
        // Documenten in elke folder onder de cursusmap.
        const docsDelRes = await client.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM document_folders WHERE id = $1
             UNION ALL
             SELECT df.id
               FROM document_folders df
               JOIN subtree s ON df.parent_folder_id = s.id
           )
           DELETE FROM documents
            WHERE folder_id IN (SELECT id FROM subtree)`,
          [courseFolderId]
        );
        documentsDeleted = docsDelRes.rowCount || 0;

        // Aantal niet-standaard mappen tellen vóór de cascade-delete.
        const extraRes = await client.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM document_folders WHERE id = $1
             UNION ALL
             SELECT df.id
               FROM document_folders df
               JOIN subtree s ON df.parent_folder_id = s.id
           )
           SELECT COUNT(*)::int AS n FROM subtree
            WHERE NOT (id = ANY($2::uuid[]))`,
          [courseFolderId, standardFolderIds]
        );
        extraFoldersDeleted = extraRes.rows[0].n;
      }

      // De expliciete folder-cleanup hieronder (course_folder_assignments,
      // folder_rag_assignments, folder_permissions en document_folders) is
      // gedeeld met het niet-cascade-pad en wordt zo dadelijk uitgevoerd.

      deleted = {
        journal_entries: journalDelRes.rowCount || 0,
        projects: projectsDelRes.rowCount || 0,
        members: membersDelRes.rowCount || 0,
        documents: documentsDeleted,
        extra_folders: extraFoldersDeleted,
        // project_submissions cascadet mee via projects ON DELETE CASCADE,
        // dus we rapporteren simpelweg de telling van vóór de delete.
        submissions: counts.submissions,
      };
    }

    // 4) Veilig opruimen: koppelingen → folders → cursus.
    //    course_folder_assignments cascadet via ON DELETE CASCADE op courses,
    //    maar we ruimen ze expliciet op zodat de folder-deletes daarna lukken
    //    zonder weeskoppelingen achter te laten.
    await client.query('DELETE FROM course_folder_assignments WHERE course_id = $1', [courseId]);

    if (subFolderIds.length > 0) {
      await client.query(
        'DELETE FROM folder_rag_assignments WHERE folder_id = ANY($1::uuid[])',
        [subFolderIds]
      );
    }
    if (standardFolderIds.length > 0) {
      await client.query(
        'DELETE FROM folder_permissions WHERE folder_id = ANY($1::uuid[])',
        [standardFolderIds]
      );
      // Eerst sub-folders, dan parent (FK-integriteit).
      if (subFolderIds.length > 0) {
        await client.query(
          'DELETE FROM document_folders WHERE id = ANY($1::uuid[])',
          [subFolderIds]
        );
      }
      if (courseFolderId) {
        await client.query('DELETE FROM document_folders WHERE id = $1', [courseFolderId]);
      }
    }

    const delRes = await client.query('DELETE FROM courses WHERE id = $1 RETURNING id', [courseId]);
    if (delRes.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Cursus-rij niet verwijderd (onverwachte rowCount)' });
    }

    await client.query('COMMIT');
    if (cascade && deleted) {
      console.log(
        `[admin/courses DELETE cascade] Cursus ${courseId} ("${existing.name}") verwijderd ` +
        `+ ${deleted.members} leden, ${deleted.projects} projecten, ${deleted.journal_entries} dagboek-notities, ` +
        `${deleted.documents} documenten, ${deleted.extra_folders} extra (sub)map(pen).`
      );
      return res.json({ ok: true, id: courseId, cascade: true, deleted });
    }
    console.log(`[admin/courses DELETE] Cursus ${courseId} ("${existing.name}") verwijderd.`);
    return res.json({ ok: true, id: courseId });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[admin/courses DELETE] Unexpected error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/rag-enabled-folders', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, moduleType } = req.query;

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    const isAdmin = callerProfile?.role === 'admin' || callerProfile?.email === SUPERUSER_EMAIL;

    if (!isAdmin && !courseId) {
      return res.status(403).json({ error: 'courseId is required for non-admin users' });
    }

    let ragFolderIds = [];

    if (courseId) {
      const { data: assignments, error: assignError } = await supabaseAdmin
        .from('course_folder_assignments')
        .select('folder_id')
        .eq('course_id', courseId);

      if (assignError) {
        console.error('[rag-enabled-folders] assignment query error:', assignError);
        return res.status(500).json({ error: assignError.message });
      }

      if (!assignments || assignments.length === 0) {
        return res.json({ folderIds: [] });
      }

      const assignedFolderIds = assignments.map((a) => a.folder_id);

      const { data: ragFolders, error: folderError } = await supabaseAdmin
        .from('document_folders')
        .select('id')
        .in('id', assignedFolderIds)
        .eq('folder_type', 'rag_sources');

      if (folderError) {
        console.error('[rag-enabled-folders] folder query error:', folderError);
        return res.status(500).json({ error: folderError.message });
      }

      ragFolderIds = ragFolders?.map((f) => f.id) ?? [];
    } else {
      const { data: allRagFolders, error: allFolderError } = await supabaseAdmin
        .from('document_folders')
        .select('id')
        .eq('folder_type', 'rag_sources');

      if (allFolderError) {
        console.error('[rag-enabled-folders] all-folders query error:', allFolderError);
        return res.status(500).json({ error: allFolderError.message });
      }

      ragFolderIds = allRagFolders?.map((f) => f.id) ?? [];
    }

    if (ragFolderIds.length === 0) {
      return res.json({ folderIds: [] });
    }

    if (moduleType) {
      const { data: ragAssignments, error: ragAssignError } = await supabaseAdmin
        .from('folder_rag_assignments')
        .select('folder_id')
        .in('folder_id', ragFolderIds)
        .eq('module_type', moduleType)
        .eq('is_active', true);

      if (ragAssignError) {
        console.error('[rag-enabled-folders] rag_assignments query error:', ragAssignError);
        return res.status(500).json({ error: ragAssignError.message });
      }

      if (ragAssignments && ragAssignments.length > 0) {
        return res.json({ folderIds: ragAssignments.map((a) => a.folder_id) });
      }
    }

    return res.json({ folderIds: ragFolderIds });
  } catch (err) {
    console.error('[rag-enabled-folders] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/folder-type', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { folderId } = req.query;
  if (!folderId) {
    return res.status(400).json({ error: 'folderId query parameter is required' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: folder, error: folderError } = await supabaseAdmin
      .from('document_folders')
      .select('folder_type')
      .eq('id', folderId)
      .maybeSingle();

    if (folderError) {
      console.error('[folder-type] query error:', folderError);
      return res.status(500).json({ error: folderError.message });
    }

    return res.json({ folderType: folder?.folder_type ?? null });
  } catch (err) {
    console.error('[folder-type] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/admin/record-doc-mutation', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header required' });

  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Not authenticated' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();

    if (!(await isStaffForCourse(user, profile, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }

    const mutationKey = `__doc_mutation_${courseId}__`;
    const content = JSON.stringify({ lastMutationAt: new Date().toISOString() });

    const { data: existing } = await supabaseAdmin
      .from('chatbot_prompts').select('id').eq('name', mutationKey).maybeSingle();

    if (existing) {
      const { error: updateErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .update({ content, updated_at: new Date().toISOString() })
        .eq('name', mutationKey);
      if (updateErr) throw new Error(`DB update mislukt: ${updateErr.message}`);
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({ name: mutationKey, content, is_active: false });
      if (insertErr) throw new Error(`DB insert mislukt: ${insertErr.message}`);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[record-doc-mutation] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/admin/concepts-meta', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId } = req.query;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Could not verify user role' });
    }

    if (!(await isStaffForCourse(user, profile, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }

    const courseMarker = `[RAG-geëxtraheerd uit cursusmateriaal]`;
    const courseTag = `course_id:${courseId}`;

    // Sommige Supabase-instances hebben de `concepts.course_id` migratie nog
    // niet doorgevoerd — dan staat de cursuskoppeling in `key_points` als
    // `course_id:<uuid>`. Probeer eerst de combineerde OR, val terug op de
    // key_points-vorm wanneer Postgres roept dat de kolom niet bestaat.
    async function fetchCourseConcepts() {
      if (conceptsHasCourseId) {
        const { data, error } = await supabaseAdmin
          .from('concepts')
          .select('id, key_points, extraction_method, extracted_at, created_at')
          .or(`course_id.eq.${courseId},key_points.cs.{"${courseTag}"}`);
        if (!error) return { data, error: null };
        if (!String(error.message || '').includes('course_id')) return { data: null, error };
      }
      const { data, error } = await supabaseAdmin
        .from('concepts')
        .select('id, key_points, extraction_method, extracted_at, created_at')
        .contains('key_points', [courseTag]);
      return { data, error };
    }

    const { data: concepts, error: conceptsError } = await fetchCourseConcepts();

    if (conceptsError) {
      console.error('[concepts-meta] query error:', conceptsError);
      return res.status(500).json({ error: conceptsError.message });
    }

    const all = concepts || [];
    const ragConcepts = all.filter(c => (c.key_points || []).includes(courseMarker));
    const manualConcepts = all.filter(c => !(c.key_points || []).includes(courseMarker));

    let lastExtraction = null;
    for (const c of ragConcepts) {
      const ts = c.extracted_at || c.created_at;
      if (ts && (!lastExtraction || ts > lastExtraction)) {
        lastExtraction = ts;
      }
    }

    let lastDocumentChange = null;
    try {
      const { data: assignments } = await supabaseAdmin
        .from('course_folder_assignments')
        .select('folder_id')
        .eq('course_id', courseId);

      if (assignments && assignments.length > 0) {
        const assignedFolderIds = assignments.map((a) => a.folder_id);

        const { data: ragFolders } = await supabaseAdmin
          .from('document_folders')
          .select('id')
          .in('id', assignedFolderIds)
          .eq('folder_type', 'rag_sources');

        if (ragFolders && ragFolders.length > 0) {
          const ragFolderIds = ragFolders.map((f) => f.id);

          const { data: latestDocs } = await supabaseAdmin
            .from('documents')
            .select('created_at')
            .in('folder_id', ragFolderIds)
            .order('created_at', { ascending: false })
            .limit(1);

          if (latestDocs && latestDocs.length > 0) {
            lastDocumentChange = latestDocs[0].created_at;
          }
        }
      }

      const mutationKey = `__doc_mutation_${courseId}__`;
      const { data: mutationRecord } = await supabaseAdmin
        .from('chatbot_prompts').select('content').eq('name', mutationKey).maybeSingle();

      if (mutationRecord?.content) {
        try {
          const { lastMutationAt } = JSON.parse(mutationRecord.content);
          if (lastMutationAt && (!lastDocumentChange || lastMutationAt > lastDocumentChange)) {
            lastDocumentChange = lastMutationAt;
          }
        } catch { /* ignore parse errors */ }
      }
    } catch (docErr) {
      console.warn('[concepts-meta] Could not determine lastDocumentChange:', docErr.message);
    }

    let lastSuccessfulRegeneration = null;
    try {
      const regenKey = `__concepts_regen_${courseId}__`;
      const { data: regenRecord } = await supabaseAdmin
        .from('chatbot_prompts').select('content').eq('name', regenKey).maybeSingle();
      if (regenRecord?.content) {
        const { lastRegenAt } = JSON.parse(regenRecord.content);
        if (lastRegenAt) lastSuccessfulRegeneration = lastRegenAt;
      }
    } catch { /* ignore */ }

    return res.json({
      ragCount: ragConcepts.length,
      manualCount: manualConcepts.length,
      lastExtraction,
      lastDocumentChange,
      lastSuccessfulRegeneration,
    });
  } catch (err) {
    console.error('[concepts-meta] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/admin/extract-concepts', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  if (!AZURE_EMBEDDINGS_READY) {
    return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, replace = false, documentIds, language } = req.body;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }
  const filterDocIds = Array.isArray(documentIds) && documentIds.length > 0 ? documentIds : null;
  // Doeltaal van de geëxtraheerde begrippen. 'nl'/'en' forceren de taal van
  // naam + definitie; 'auto' laat de LLM de taal van het bronmateriaal volgen.
  // Dit is cruciaal: de verificatiestap embed de begrípsnaam en vergelijkt die
  // met de chunks. Bij Engels cursusmateriaal scoort een Nederlandse term laag,
  // waardoor alle kandidaten worden afgewezen en de docent "niets" ziet.
  // Default is 'auto' zodat ook niet-UI-callers de taal van het materiaal volgen.
  const conceptLanguage = ['nl', 'en', 'auto'].includes(language) ? language : 'auto';

  const courseMarker = `course_id:${courseId}`;
  const regenKey = `__concepts_regen_${courseId}__`;

  async function writeRegenTimestamp() {
    const content = JSON.stringify({ lastRegenAt: new Date().toISOString() });
    const { data: existing } = await supabaseAdmin
      .from('chatbot_prompts').select('id').eq('name', regenKey).maybeSingle();
    if (existing) {
      await supabaseAdmin.from('chatbot_prompts')
        .update({ content, updated_at: new Date().toISOString() }).eq('name', regenKey);
    } else {
      await supabaseAdmin.from('chatbot_prompts')
        .insert({ name: regenKey, content, is_active: false });
    }
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Could not verify user role' });
    }

    const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
    const isDocent = !isAdmin && await isCourseTeacher(user.id, courseId);
    if (!isAdmin && !isDocent) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }

    if (isDocent && !isAdmin) {
      const { data: membership, error: memberErr } = await supabaseAdmin
        .from('course_members')
        .select('id')
        .eq('user_id', user.id)
        .eq('course_id', courseId)
        .maybeSingle();
      if (memberErr) {
        console.error('[extract-concepts] Course membership check error:', memberErr);
        return res.status(500).json({ error: 'Cursustoestemming kon niet worden gecontroleerd' });
      }
      if (!membership) {
        return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      }
    }

    // BELANGRIJK: de replace-actie (oude RAG-begrippen verwijderen) is
    // verplaatst naar NA een succesvolle LLM-extractie. Voorheen werd er
    // altijd eerst gewist; bij een rate-limit of andere LLM-fout bleef de
    // cursus dan met een lege begrippenlijst achter. We voeren de replace
    // pas uit zodra we daadwerkelijk nieuwe begrippen hebben om in te
    // voegen — zie verderop in deze handler (`runReplace`).
    async function runReplace(keepNames = new Set()) {
      if (!replace) return;
      const ragMarkerLocal = '[RAG-geëxtraheerd uit cursusmateriaal]';
      if (conceptsHasCourseId) {
        // Verwijder alleen verouderde RAG-begrippen: die wél RAG zijn maar in deze
        // run NIET opnieuw zijn voorgesteld. Zojuist (her)ingevoegde begrippen
        // staan in keepNames en blijven dus behouden.
        const { data: courseConcepts, error: fetchErr } = await supabaseAdmin
          .from('concepts')
          .select('id, name, key_points')
          .eq('course_id', courseId);
        if (fetchErr) {
          console.error('[extract-concepts] Fetch (replace) error:', fetchErr);
          throw new Error(`Ophalen mislukt: ${fetchErr.message}`);
        }
        const staleIds = (courseConcepts || [])
          .filter((c) => (c.key_points || []).includes(ragMarkerLocal))
          .filter((c) => !keepNames.has(String(c.name || '').toLowerCase().trim()))
          .map((c) => c.id);
        if (staleIds.length > 0) {
          const { error: delErr } = await supabaseAdmin
            .from('concepts')
            .delete()
            .in('id', staleIds);
          if (delErr) {
            console.error('[extract-concepts] Delete (replace) error:', delErr);
            throw new Error(`Verwijderen mislukt: ${delErr.message}`);
          }
        }
        console.log(`[extract-concepts] Replace (course_id): deleted ${staleIds.length} stale RAG concepts for course ${courseId}`);
        return;
      }
      const { data: taggedConcepts, error: taggedErr } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points')
        .contains('key_points', [courseMarker]);

      if (taggedErr) {
        console.error('[extract-concepts] Tagged concepts query error on replace:', taggedErr);
        throw new Error(`Ophalen mislukt: ${taggedErr.message}`);
      }

      // Cursusbewust opruimen: alleen verouderde RAG-begrippen van DEZE cursus
      // (niet meer voorgesteld); begrippen die ook bij een andere cursus horen
      // verliezen enkel deze markering. keepNames beschermt zojuist geschreven en
      // opnieuw voorgestelde begrippen.
      const { toDeleteIds, toUntag } = planConceptReplace(taggedConcepts, { courseMarker, keepNames });

      if (toDeleteIds.length > 0) {
        const { error: delErr } = await supabaseAdmin
          .from('concepts')
          .delete()
          .in('id', toDeleteIds);
        if (delErr) {
          console.error('[extract-concepts] Delete (replace fallback) error:', delErr);
          throw new Error(`Verwijderen mislukt: ${delErr.message}`);
        }
      }

      for (const u of toUntag) {
        const { error: untagErr } = await supabaseAdmin
          .from('concepts').update({ key_points: u.key_points }).eq('id', u.id);
        if (untagErr) {
          console.error('[extract-concepts] Untag (replace fallback) error:', untagErr);
          throw new Error(`Loskoppelen mislukt: ${untagErr.message}`);
        }
      }

      console.log(`[extract-concepts] Replace (fallback): deleted ${toDeleteIds.length} RAG-extracted, untagged ${toUntag.length} shared`);
    }

    const { data: assignments } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id')
      .eq('course_id', courseId);

    if (!assignments || assignments.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen RAG-mappen gevonden voor deze cursus' });
    }

    const assignedFolderIds = assignments.map((a) => a.folder_id);

    const { data: ragFolders } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', assignedFolderIds)
      .eq('folder_type', 'rag_sources');

    if (!ragFolders || ragFolders.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen RAG-bronmappen gevonden voor deze cursus' });
    }

    const ragFolderIds = ragFolders.map((f) => f.id);

    const { data: docs, error: docsError } = await supabaseAdmin
      .from('documents')
      .select('id')
      .in('folder_id', ragFolderIds)
      .eq('processing_status', 'completed');

    if (docsError) {
      console.error('[extract-concepts] docs query error:', docsError);
      return res.status(500).json({ error: `Documenten ophalen mislukt: ${docsError.message}` });
    }

    if (!docs || docs.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen verwerkte documenten gevonden in RAG-mappen' });
    }

    let docIds = docs.map((d) => d.id);
    if (filterDocIds) {
      const allowed = new Set(filterDocIds);
      docIds = docIds.filter((id) => allowed.has(id));
      if (docIds.length === 0) {
        await writeRegenTimestamp().catch(() => {});
        return res.json({ concepts: [], message: 'Geen geselecteerde documenten gevonden in de RAG-mappen' });
      }
    }

    const { data: chunks, error: chunksError } = await supabaseAdmin
      .from('document_chunks')
      .select('content, document_id')
      .in('document_id', docIds)
      .limit(80);

    if (chunksError) {
      console.error('[extract-concepts] chunks query error:', chunksError);
      return res.status(500).json({ error: `Chunks ophalen mislukt: ${chunksError.message}` });
    }

    if (!chunks || chunks.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen document-chunks gevonden' });
    }

    const combinedText = chunks
      .map((c) => c.content)
      .join('\n\n---\n\n')
      .slice(0, 14000);

    // Taal-instructie voor naam + definitie. De categorie blijft altijd de
    // Nederlandse enum-waarde ("epidemiologie"/"biostatistiek") omdat die
    // server-side gevalideerd wordt.
    const languageDirective = {
      nl: '- name: de gangbare Nederlandse vakterm (internationale Engelse termen mogen als ze zo in het Nederlandse veld gebruikt worden, bv. "odds ratio")\n- definition: een heldere definitie van 1-2 zinnen in het NEDERLANDS',
      en: '- name: the common English term for the concept\n- definition: a clear 1-2 sentence definition in ENGLISH',
      auto: '- name: the concept term in the SAME language as the course material below\n- definition: a clear 1-2 sentence definition in the SAME language as the course material below',
    }[conceptLanguage];

    const extractionPrompt = `Je bent een expert in epidemiologie en biostatistiek aan de VU Amsterdam.

Analyseer de onderstaande tekst uit universitair cursusmateriaal. Identificeer ALLE relevante vakbegrippen die studenten moeten kennen en kunnen uitleggen — ook als ze slechts terloops of impliciet in de tekst voorkomen. Wees volledig en breed: liever 30 begrippen dan 10.

BELANGRIJK: kies de begripsnamen zó dat ze letterlijk of bijna-letterlijk in het onderstaande cursusmateriaal voorkomen, want de namen worden daarna automatisch tegen dat materiaal geverifieerd.

Geschikte begrippen omvatten (maar zijn niet beperkt tot):
- Epidemiologie: incidentie, prevalentie, relatief risico, odds ratio, attributief risico, confounding, effect modification, selectiebias, informatiebias, cohortonderzoek, patiënt-controleonderzoek, cross-sectioneel onderzoek, gerandomiseerd gecontroleerd onderzoek, ecologisch onderzoek, case report, surveillance, screening, sensitiviteit, specificiteit, positief voorspellende waarde, negatief voorspellende waarde, DAG (gerichte acyclische graaf), mediatie, effect modificatie, interactie
- Biostatistiek: gemiddelde, mediaan, standaarddeviatie, variantie, normaalverdeling, binomiale verdeling, Poisson-verdeling, betrouwbaarheidsinterval, p-waarde, nulhypothese, statistische toets, t-toets, chi-kwadraattoets, regressieanalyse, logistische regressie, Kaplan-Meier, log-rank toets, hazard ratio, steekproefomvang, power, type I fout, type II fout, effectgrootte, multiple testing

Geef elk gevonden begrip de volgende velden:
${languageDirective}
- category: precies "epidemiologie" of "biostatistiek"

Geef UITSLUITEND een JSON-array terug, zonder extra tekst of uitleg:
[
  {"name": "Begrip naam", "category": "epidemiologie", "definition": "Definitie hier."}
]

CURSUSMATERIAAL:
${combinedText}`;

    // OpenAI heeft een tokens-per-minute-limiet; bij grote cursussen lopen
    // we daar snel tegenaan. We doen 1 retry met backoff (we lezen de
    // gevraagde wachttijd uit de foutmelding indien aanwezig). Als ook de
    // tweede poging faalt, geven we een Nederlandstalige melding terug
    // — en omdat de replace-stap pas later in deze handler draait,
    // verliest de cursus géén begrippen meer als de extractie crasht.
    async function callOpenAI(maxRetries = 1) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const resp = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: extractionPrompt }],
          ...chatModelParams({ temperature: 0.2, maxTokens: 8192 }),
        });
        if (resp.ok) return { resp, errData: null };
        const errData = await resp.json().catch(() => ({}));
        const isRateLimit = resp.status === 429 || errData?.error?.code === 'rate_limit_exceeded';
        if (!isRateLimit || attempt === maxRetries) return { resp, errData };
        const msg = errData?.error?.message || '';
        const m = msg.match(/try again in ([\d.]+)s/i);
        const waitMs = m ? Math.min(60000, Math.ceil(parseFloat(m[1]) * 1000) + 500) : 5000;
        console.warn(`[extract-concepts] OpenAI rate-limit, wacht ${waitMs}ms en probeer opnieuw…`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      return { resp: null, errData: { error: { message: 'Onbereikbaar' } } };
    }

    const { resp: llmResponse, errData: llmErrData } = await callOpenAI(1);

    if (!llmResponse || !llmResponse.ok) {
      console.error('[extract-concepts] LLM error:', llmErrData);
      const isRateLimit = llmErrData?.error?.code === 'rate_limit_exceeded';
      const friendly = isRateLimit
        ? 'De LLM-aanbieder heeft een token-limiet bereikt. Wacht een minuutje en probeer opnieuw, of selecteer minder documenten in één keer.'
        : 'LLM-extractie mislukt. Bestaande begrippen zijn ongemoeid gelaten.';
      return res.status(503).json({ error: friendly, details: llmErrData });
    }

    const llmData = await llmResponse.json();
    const rawContent = llmData.choices?.[0]?.message?.content || '';

    let extractedConcepts = [];
    try {
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        extractedConcepts = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      // Fallback: de LLM-respons is waarschijnlijk afgekapt (token-limiet).
      // Probeer individuele complete JSON-objecten te redden uit de afgekapte array.
      console.warn('[extract-concepts] Volledige JSON-parse mislukt, probeer partial recovery…', parseErr.message);
      try {
        const objectMatches = rawContent.matchAll(/\{\s*"name"\s*:\s*"[^"]+"\s*,[\s\S]*?\}/g);
        for (const m of objectMatches) {
          try {
            const obj = JSON.parse(m[0]);
            if (obj.name && obj.category && obj.definition) extractedConcepts.push(obj);
          } catch (_) { /* ongeldig object, skip */ }
        }
        if (extractedConcepts.length > 0) {
          console.log(`[extract-concepts] Partial recovery: ${extractedConcepts.length} begrippen gered uit afgekapte respons`);
        } else {
          console.error('[extract-concepts] Partial recovery leverde 0 begrippen op. Raw:', rawContent.slice(0, 300));
          return res.status(500).json({ error: 'Kon LLM-respons niet verwerken als JSON. De respons was waarschijnlijk te lang — probeer minder documenten tegelijk te selecteren.' });
        }
      } catch (recoverErr) {
        console.error('[extract-concepts] JSON parse + recovery mislukt:', recoverErr, 'raw:', rawContent.slice(0, 200));
        return res.status(500).json({ error: 'Kon LLM-respons niet verwerken als JSON. Probeer minder documenten tegelijk te selecteren.' });
      }
    }

    if (!Array.isArray(extractedConcepts) || extractedConcepts.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen begrippen gevonden in LLM-respons' });
    }

    const validCategories = ['epidemiologie', 'biostatistiek'];
    const rawValidConcepts = extractedConcepts.filter(
      (c) => c.name && c.category && validCategories.includes(c.category) && c.definition
    );

    // VERIFICATIE-STAP: vergelijk elk LLM-kandidaat-begrip met RAG-chunks
    // (eigen instellingen, los van chat/explain/quiz/project)
    const allSettings = await loadRagSettings(courseId);
    const extractionSettings = allSettings.extraction || RAG_EXTRACTION_DEFAULTS;
    const verifyThreshold = extractionSettings.similarity_threshold;
    const minEvidence = extractionSettings.min_evidence_chunks;

    console.log(`[extract-concepts] Verificatie: ${rawValidConcepts.length} kandidaten met drempel ${verifyThreshold.toFixed(2)} en min ${minEvidence} bewijschunks`);

    const verificationResults = await Promise.all(
      rawValidConcepts.map(async (c) => {
        const result = await searchChunksServerSide(c.name, verifyThreshold, 10, ragFolderIds);
        return {
          concept: c,
          matchedCount: result?.matched?.length || 0,
          maxScore: result?.maxScore || 0,
          candidates: result?.candidatesInAllowed || 0,
          // Task #243: bewaar de ondersteunende chunks zodat we ze later als
          // begrip-bronkoppeling kunnen wegschrijven (i.p.v. weggooien).
          matched: result?.matched || [],
        };
      })
    );

    const validConcepts = [];
    const rejectedConcepts = [];
    // Task #243: map begripsnaam (genormaliseerd) → top-bewijschunks. Wordt na
    // de insert/update gebruikt om de koppeling in concept_evidence te schrijven.
    const evidenceByName = new Map();
    for (const r of verificationResults) {
      if (r.matchedCount >= minEvidence) {
        validConcepts.push(r.concept);
        evidenceByName.set(r.concept.name.toLowerCase().trim(), r.matched);
      } else {
        rejectedConcepts.push(r);
      }
    }

    console.log(`[extract-concepts] Verificatie klaar: ${validConcepts.length} geaccepteerd, ${rejectedConcepts.length} afgewezen`);
    if (rejectedConcepts.length > 0) {
      const sample = rejectedConcepts.slice(0, 8).map(r =>
        `"${r.concept.name}" (max=${r.maxScore.toFixed(3)}, kandidaten=${r.candidates})`
      ).join(', ');
      console.log(`[extract-concepts] Voorbeeld afgewezen: ${sample}`);
    }

    // Gestructureerde lijst van afgewezen kandidaten (naam + hoogste score)
    // zodat de docent-UI precies kan tonen wat de AI vond en hoe dichtbij het
    // de drempel kwam.
    const rejectedSamples = rejectedConcepts
      .slice(0, 10)
      .map((r) => ({ name: r.concept.name, maxScore: Number(r.maxScore.toFixed(3)) }));

    // Niets te schrijven? Geef een duidelijke melding TERUG zonder de
    // bestaande begrippen weg te gooien. De gebruiker kan dan in
    // Beheer → RAG-instellingen → Extractie de drempels verlagen.
    if (validConcepts.length === 0) {
      const sampleNames = rejectedConcepts.slice(0, 6).map((r) => r.concept.name).join(', ');
      const msg = rawValidConcepts.length === 0
        ? 'De LLM vond geen begrippen in dit cursusmateriaal.'
        : `De LLM stelde ${rawValidConcepts.length} begrippen voor, maar geen enkele haalde de RAG-verificatiedrempel (similarity ≥ ${verifyThreshold.toFixed(2)}, ≥ ${minEvidence} chunks). Verlaag de drempel via Beheer → RAG-instellingen → Extractie en probeer opnieuw. Voorbeelden: ${sampleNames}.`;
      await writeRegenTimestamp().catch(() => {});
      return res.json({
        concepts: [],
        updated: 0,
        skipped: 0,
        verificationRejected: rejectedConcepts.length,
        candidatesFromLLM: rawValidConcepts.length,
        verificationThreshold: verifyThreshold,
        minEvidenceChunks: minEvidence,
        rejected: rejectedSamples,
        message: msg,
      });
    }

    // Volgorde (belangrijk): in replace/hergenereer-modus eerst de nieuwe
    // begrippen schrijven, dán pas de VEROUDERDE RAG-begrippen opruimen.
    // - Schrijven-eerst voorkomt dat de cursus leeg achterblijft als een
    //   DB-schrijfactie faalt (we keren dan met 500 terug vóór het opruimen).
    // - De opruimstap (`runReplace`) is "keep-aware": elke naam die in deze run
    //   is geëxtraheerd (keepNames) blijft behouden, dus de zojuist geschreven
    //   én de opnieuw voorgestelde begrippen worden nooit per ongeluk gewist
    //   (dat was de bug waardoor de Begrippen-tab leeg bleef). Alleen
    //   RAG-begrippen die NIET meer voorgesteld worden, worden opgeruimd.
    const ragMarker = '[RAG-geëxtraheerd uit cursusmateriaal]';
    const keepNames = new Set(validConcepts.map((c) => String(c.name || '').toLowerCase().trim()));
    let inserted = [];
    let updatedCount = 0;
    let skipped = 0;
    const verificationRejected = rejectedConcepts.length;

    if (conceptsHasCourseId) {
      const { data: existingForCourse } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points')
        .eq('course_id', courseId);

      const alreadyByCourse = new Set(
        (existingForCourse || []).map((c) => c.name.toLowerCase().trim())
      );

      const toInsert = [];
      const seenInBatch = new Set();
      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        if (alreadyByCourse.has(key)) { skipped++; continue; }
        if (seenInBatch.has(key)) { skipped++; continue; }
        seenInBatch.add(key);
        toInsert.push({
          name: c.name.trim(),
          category: c.category,
          definition: c.definition.trim(),
          key_points: [ragMarker],
          examples: [],
          course_id: courseId,
        });
      }

      if (toInsert.length > 0) {
        // Gebruik upsert met ignoreDuplicates zodat begrippen met dezelfde naam
        // die al bestaan (bv. in een andere cursus) worden overgeslagen in
        // plaats van een constraint-fout te geven.
        const { data: ins, error: insertError } = await supabaseAdmin
          .from('concepts')
          .upsert(toInsert, { onConflict: 'name', ignoreDuplicates: true })
          .select('id, name, category, definition');
        if (insertError) {
          console.error('[extract-concepts] Insert error (course_id path):', insertError);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
        }
        inserted = ins || [];
      }
    } else {
      // planConceptWrites herkent bestaande (gedeelde/handmatige) begrippen:
      // al voor deze cursus gemarkeerd → overslaan/behouden; zelfde naam in een
      // andere cursus → bijwerken (delen); anders → nieuw invoegen. De oude
      // RAG-begrippen worden pas ná deze schrijfstap opgeruimd (keep-aware).
      const { data: allExisting } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points');

      const { toInsert, toUpdate, skipped: skippedCount } = planConceptWrites(
        validConcepts, allExisting, { courseMarker, ragMarker }
      );
      skipped = skippedCount;

      for (const u of toUpdate) {
        const { error: updErr } = await supabaseAdmin
          .from('concepts')
          .update({ key_points: u.key_points })
          .eq('id', u.id);
        if (updErr) {
          // Hard falen vóór de opruimstap: een gedeeltelijke schrijfactie mag
          // nooit gevolgd worden door runReplace, anders verdwijnen verouderde
          // RAG-begrippen terwijl de bedoelde updates niet zijn doorgevoerd.
          console.error('[extract-concepts] Update error (key_points path):', updErr);
          return res.status(500).json({ error: `Begrippen bijwerken mislukt: ${updErr.message}` });
        }
        updatedCount += 1;
      }

      if (toInsert.length > 0) {
        // Gebruik upsert met ignoreDuplicates zodat begrippen waarvan de naam
        // al bestaat (bv. via een race-condition of een dubbel LLM-resultaat)
        // worden overgeslagen in plaats van een constraint-fout te geven.
        const { data: ins, error: insertError } = await supabaseAdmin
          .from('concepts')
          .upsert(toInsert, { onConflict: 'name', ignoreDuplicates: true })
          .select('id, name, category, definition');
        if (insertError) {
          console.error('[extract-concepts] Insert error (key_points path):', insertError);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
        }
        inserted = ins || [];
      }
    }

    // Schrijven gelukt — nu pas de VEROUDERDE RAG-begrippen opruimen
    // (keep-aware: namen uit deze run blijven behouden). Door dit ná de
    // succesvolle insert/update te doen blijft de cursus nooit leeg achter.
    try {
      await runReplace(keepNames);
    } catch (replaceErr) {
      console.error('[extract-concepts] runReplace na schrijven mislukt:', replaceErr);
      // De nieuwe begrippen staan al opgeslagen; we loggen de opruimfout maar
      // laten de geschreven begrippen staan in plaats van te falen.
    }

    // Task #243: schrijf de begrip ↔ bronfragment-koppeling weg. Voor elk
    // geaccepteerd begrip dat nu in de cursus bestaat (nieuw, bijgewerkt of
    // reeds aanwezig) bewaren we de top-bewijschunks uit de verificatiestap.
    // Bij opnieuw extraheren worden de oude koppelingen per begrip eerst
    // opgeruimd, zodat er geen verouderde fragmenten blijven rondslingeren.
    let evidenceWritten = 0;
    let conceptsLinked = 0;
    if (conceptEvidenceSchemaReady && validConcepts.length > 0) {
      try {
        const acceptedNames = validConcepts.map((c) => c.name.toLowerCase().trim());
        // Resolveer de concept-id's die nu bij deze cursus horen.
        let conceptRows = [];
        if (conceptsHasCourseId) {
          // Case-insensitief matchen: de duplicaat-detectie elders normaliseert
          // op lowercase, dus resolveren we hier net zo om geaccepteerde
          // begrippen niet te missen door hoofdletterverschillen.
          const { data } = await supabaseAdmin
            .from('concepts')
            .select('id, name')
            .eq('course_id', courseId);
          conceptRows = (data || []).filter((c) => acceptedNames.includes(c.name.toLowerCase().trim()));
        } else {
          const { data } = await supabaseAdmin
            .from('concepts')
            .select('id, name, key_points')
            .contains('key_points', [courseMarker]);
          conceptRows = (data || []).filter((c) => acceptedNames.includes(c.name.toLowerCase().trim()));
        }

        const idsToRefresh = conceptRows.map((c) => c.id);
        if (idsToRefresh.length > 0) {
          // Verouderde koppelingen voor deze begrippen verwijderen vóór de herinsert.
          await supabaseAdmin.from('concept_evidence').delete().in('concept_id', idsToRefresh);

          const evidenceRows = [];
          for (const row of conceptRows) {
            const matched = evidenceByName.get(row.name.toLowerCase().trim()) || [];
            const top = matched.slice(0, 5);
            if (top.length > 0) conceptsLinked++;
            for (const m of top) {
              evidenceRows.push({
                concept_id: row.id,
                course_id: courseId,
                document_id: m.document_id || null,
                chunk_id: m.id || null,
                snippet: typeof m.content === 'string' ? m.content.slice(0, 4000) : '',
                similarity: Number.isFinite(m.similarity) ? m.similarity : 0,
              });
            }
          }

          if (evidenceRows.length > 0) {
            const { error: evErr } = await supabaseAdmin.from('concept_evidence').insert(evidenceRows);
            if (evErr) {
              console.error('[extract-concepts] concept_evidence insert error:', evErr.message);
            } else {
              evidenceWritten = evidenceRows.length;
            }
          }
        }
        console.log(`[extract-concepts] Bewijskoppeling: ${conceptsLinked} begrippen, ${evidenceWritten} fragmenten`);
      } catch (evErr) {
        console.error('[extract-concepts] Bewijskoppeling wegschrijven mislukt:', evErr.message);
      }
    }

    const totalAdded = inserted.length + updatedCount;

    console.log(`[extract-concepts] Done for course ${courseId}: ${inserted.length} new, ${updatedCount} updated, ${skipped} already tagged, ${verificationRejected} afgewezen door verificatie`);

    await writeRegenTimestamp().catch(() => {});

    const verifMsg = verificationRejected > 0
      ? ` (${verificationRejected} kandidaten afgewezen door RAG-verificatie)`
      : '';

    return res.json({
      concepts: inserted,
      updated: updatedCount,
      skipped,
      verificationRejected,
      candidatesFromLLM: rawValidConcepts.length,
      verificationThreshold: verifyThreshold,
      minEvidenceChunks: minEvidence,
      rejected: rejectedSamples,
      language: conceptLanguage,
      evidenceWritten,
      conceptsLinked,
      message: `${totalAdded} begrippen toegevoegd/bijgewerkt voor deze cursus${verifMsg}`,
    });
  } catch (err) {
    console.error('[extract-concepts] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/concepts', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available' });
  }

  const { courseId } = req.query;

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: userError } = await callerClient.auth.getUser();
  if (userError) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    if (courseId) {
      if (conceptsHasCourseId) {
        const { data: courseConcepts, error: courseErr } = await supabaseAdmin
          .from('concepts')
          .select('*')
          .eq('course_id', courseId)
          .order('name');

        if (courseErr) {
          console.error('[concepts] course_id query error:', courseErr);
          return res.status(500).json({ error: courseErr.message });
        }

        if (courseConcepts && courseConcepts.length > 0) {
          return res.json({ concepts: courseConcepts, source: 'course' });
        }

        const { data: globalConcepts, error: globalErr } = await supabaseAdmin
          .from('concepts')
          .select('*')
          .is('course_id', null)
          .order('name');

        if (globalErr) {
          console.error('[concepts] global fallback query error:', globalErr);
          return res.status(500).json({ error: globalErr.message });
        }

        return res.json({ concepts: globalConcepts || [], source: globalConcepts?.length ? 'global' : 'empty' });
      } else {
        const courseMarker = `course_id:${courseId}`;
        const { data: courseConcepts, error: courseErr } = await supabaseAdmin
          .from('concepts')
          .select('*')
          .contains('key_points', [courseMarker])
          .order('name');

        if (courseErr) {
          console.error('[concepts] key_points query error:', courseErr);
          return res.status(500).json({ error: courseErr.message });
        }

        if (courseConcepts && courseConcepts.length > 0) {
          return res.json({ concepts: courseConcepts, source: 'course' });
        }

        const { data: globalConcepts, error: globalErr } = await supabaseAdmin
          .from('concepts')
          .select('*')
          .order('name');

        if (globalErr) {
          console.error('[concepts] global fallback (key_points) query error:', globalErr);
          return res.status(500).json({ error: globalErr.message });
        }

        const filtered = (globalConcepts || []).filter(
          (c) => !(c.key_points || []).some((kp) => kp.startsWith('course_id:'))
        );

        return res.json({ concepts: filtered, source: filtered.length ? 'global' : 'empty' });
      }
    }

    const { data: allConcepts, error: allErr } = await supabaseAdmin
      .from('concepts')
      .select('*')
      .order('name');

    if (allErr) {
      console.error('[concepts] all query error:', allErr);
      return res.status(500).json({ error: allErr.message });
    }

    return res.json({ concepts: allConcepts || [], source: 'global' });
  } catch (err) {
    console.error('[concepts] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Task #243: opgeslagen bewijsfragmenten per begrip. Wordt door "Ik leg uit"
// gebruikt als gegarandeerde basis-context uit het cursusmateriaal, los van de
// live RAG-zoekopdracht. Geeft een lege lijst terug als de migratie nog niet is
// toegepast, zodat de pagina blijft werken.
// GET /api/concepts/evidence — bron-bewijs per begrip (Task #243), cursus-scoped
// gefilterd (Task #244). De route en zijn filterhelper staan in
// server/conceptEvidence.js zodat de cursus-isolatie geautomatiseerd getest kan
// worden. conceptEvidenceSchemaReady wordt asynchroon gezet, dus we geven een
// getter mee i.p.v. de momentane waarde.
registerConceptEvidenceRoutes(app, {
  supabaseAdmin,
  requireAuthUser,
  userHasCourseAccess,
  getSchemaReady: () => conceptEvidenceSchemaReady,
});

app.delete('/api/admin/concepts/:id', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Concept ID is required' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Could not verify user role' });
    }

    const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('concepts')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('[delete-concept] Delete error:', deleteError);
      return res.status(500).json({ error: `Verwijderen mislukt: ${deleteError.message}` });
    }

    console.log(`[delete-concept] Concept ${id} verwijderd door ${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[delete-concept] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── Journal routes (admin-client om RLS te omzeilen) ────────────────────────

app.get('/api/journal', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data, error } = await supabaseAdmin
      .from('learning_journal_entries')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    const entries = data || [];
    // Verrijk met cursusnaam zodat de UI per notitie kan tonen in welke cursus
    // ze is aangemaakt. course_id kan null zijn (legacy of buiten cursuscontext).
    const courseIds = [...new Set(entries.map(e => e.course_id).filter(Boolean))];
    let courseNameById = {};
    if (courseIds.length > 0) {
      const { data: courses } = await supabaseAdmin
        .from('courses').select('id, name').in('id', courseIds);
      courseNameById = Object.fromEntries((courses || []).map(c => [c.id, c.name]));
    }
    const enriched = entries.map(e => ({
      ...e,
      course_name: e.course_id ? (courseNameById[e.course_id] || null) : null,
    }));
    return res.json(enriched);
  } catch (err) {
    console.error('[journal GET] Fout:', err.message);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

app.patch('/api/journal/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();
    // Alleen admin/superuser mag andermans journal-entries bewerken.
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);

    const { id } = req.params;
    const { title, content, activity_type } = req.body;

    // Controleer eigenaar tenzij admin
    if (!isAdmin) {
      const { data: entry } = await supabaseAdmin
        .from('learning_journal_entries').select('user_id').eq('id', id).maybeSingle();
      if (!entry || entry.user_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze notitie' });
    }

    const { data, error } = await supabaseAdmin
      .from('learning_journal_entries')
      .update({ title, content, activity_type, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    console.error('[journal PATCH] Fout:', err.message);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

app.delete('/api/journal/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', user.id).maybeSingle();
    // Alleen admin/superuser mag andermans journal-entries verwijderen.
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);

    const { id } = req.params;

    // Controleer eigenaar tenzij admin
    if (!isAdmin) {
      const { data: entry } = await supabaseAdmin
        .from('learning_journal_entries').select('user_id').eq('id', id).maybeSingle();
      if (!entry || entry.user_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze notitie' });
    }

    const { error } = await supabaseAdmin
      .from('learning_journal_entries')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    console.log(`[journal DELETE] Notitie ${id} verwijderd door ${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[journal DELETE] Fout:', err.message);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// ============================================================
// Ik Leg Uit – history, save, delete, archive (naar leerdagboek)
// ============================================================

app.get('/api/explain/history', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    // Cursus-scoping (Task #246): alleen uitleg van begrippen uit de actieve
    // cursus tonen. Begrippen zijn cursus-gekoppeld via een echte course_id-kolom
    // (nieuw schema) óf via de key_points-marker `course_id:<uuid>` (fallback).
    // We resolven eerst de begrip-ids van de cursus en filteren de uitleg daarop.
    const courseId = typeof req.query.courseId === 'string' ? req.query.courseId.trim() : '';

    let allowedConceptIds = null; // null = geen cursusfilter
    if (courseId) {
      // Resolve cursus-begrippen exact zoals /api/concepts: begrippen mét
      // cursus-koppeling tellen als cursus-begrippen; heeft de cursus geen eigen
      // begrippen, dan val terug op globale begrippen (zonder cursus-koppeling).
      if (conceptsHasCourseId) {
        const { data: courseConcepts, error: courseErr } = await supabaseAdmin
          .from('concepts').select('id').eq('course_id', courseId);
        if (courseErr) {
          console.error('[explain/history] cursus-begrip-query fout:', courseErr);
          return res.status(500).json({ error: courseErr.message });
        }
        if (courseConcepts && courseConcepts.length > 0) {
          allowedConceptIds = courseConcepts.map((c) => c.id);
        } else {
          const { data: globalConcepts, error: globalErr } = await supabaseAdmin
            .from('concepts').select('id').is('course_id', null);
          if (globalErr) {
            console.error('[explain/history] globale-begrip-query fout:', globalErr);
            return res.status(500).json({ error: globalErr.message });
          }
          allowedConceptIds = (globalConcepts || []).map((c) => c.id);
        }
      } else {
        const { data: courseConcepts, error: courseErr } = await supabaseAdmin
          .from('concepts').select('id').contains('key_points', [`course_id:${courseId}`]);
        if (courseErr) {
          console.error('[explain/history] cursus-begrip-query fout:', courseErr);
          return res.status(500).json({ error: courseErr.message });
        }
        if (courseConcepts && courseConcepts.length > 0) {
          allowedConceptIds = courseConcepts.map((c) => c.id);
        } else {
          const { data: allConcepts, error: allErr } = await supabaseAdmin
            .from('concepts').select('id, key_points');
          if (allErr) {
            console.error('[explain/history] globale-begrip-query fout:', allErr);
            return res.status(500).json({ error: allErr.message });
          }
          allowedConceptIds = (allConcepts || [])
            .filter((c) => !(c.key_points || []).some((kp) => kp.startsWith('course_id:')))
            .map((c) => c.id);
        }
      }
      // Geen begrippen in deze cursus ⇒ geen uitleg-geschiedenis.
      if (allowedConceptIds.length === 0) {
        return res.json({ items: [] });
      }
    }

    let query = supabaseAdmin
      .from('student_explanations')
      .select('id, concept_id, version, created_at, concepts(id, name, category)')
      .eq('student_id', user.id);
    if (allowedConceptIds !== null) {
      query = query.in('concept_id', allowedConceptIds);
    }
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('[explain/history] query error:', error);
      return res.status(500).json({ error: error.message });
    }

    const items = (data || []).map(r => ({
      id: r.id,
      conceptId: r.concept_id,
      conceptName: r.concepts?.name || '(onbekend begrip)',
      conceptCategory: r.concepts?.category || null,
      version: r.version || 1,
      createdAt: r.created_at,
    }));

    return res.json({ items });
  } catch (err) {
    console.error('[explain/history] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

app.get('/api/explain/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('student_explanations')
      .select('id, concept_id, explanation_text, feedback, version, created_at, student_id, concepts(id, name, category, definition, key_points)')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Uitleg niet gevonden' });
    if (data.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

    return res.json({
      id: data.id,
      conceptId: data.concept_id,
      explanationText: data.explanation_text,
      feedback: data.feedback?.content || (typeof data.feedback === 'string' ? data.feedback : null),
      version: data.version,
      createdAt: data.created_at,
      concept: data.concepts,
    });
  } catch (err) {
    console.error('[explain GET] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

app.post('/api/explain/save', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { conceptId, explanationText, feedback } = req.body;
  if (!conceptId || !explanationText) {
    return res.status(400).json({ error: 'conceptId en explanationText zijn vereist' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    // Bepaal nieuwe versie op basis van bestaande pogingen
    const { data: existing } = await supabaseAdmin
      .from('student_explanations')
      .select('id, version')
      .eq('concept_id', conceptId)
      .eq('student_id', user.id);

    const newVersion = existing && existing.length > 0
      ? Math.max(...existing.map(r => r.version || 1)) + 1
      : 1;

    // Verwijder oudere uitleg voor dit begrip (oudere uitleg verdwijnt automatisch).
    // Als dit mislukt MOETEN we stoppen — anders krijgen we duplicaten en blijft oude
    // uitleg zichtbaar in de "Eerder uitgelegd"-zijbalk.
    if (existing && existing.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from('student_explanations')
        .delete()
        .eq('concept_id', conceptId)
        .eq('student_id', user.id);
      if (delErr) {
        console.error('[explain/save] kon oude uitleg niet verwijderen:', delErr);
        return res.status(500).json({
          error: `Kon oudere uitleg niet verwijderen: ${delErr.message}. Nieuwe uitleg niet opgeslagen om duplicaten te voorkomen.`,
        });
      }
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('student_explanations')
      .insert({
        concept_id: conceptId,
        student_id: user.id,
        explanation_text: explanationText,
        feedback: feedback ? { content: feedback } : null,
        version: newVersion,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[explain/save] insert error:', insertErr);
      return res.status(500).json({ error: insertErr.message });
    }

    return res.json({ success: true, id: inserted.id, version: newVersion });
  } catch (err) {
    console.error('[explain/save] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

app.delete('/api/explain/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { id } = req.params;
    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('student_explanations')
      .select('id, student_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Uitleg niet gevonden' });
    if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

    const { error: delErr } = await supabaseAdmin
      .from('student_explanations')
      .delete()
      .eq('id', id);

    if (delErr) return res.status(500).json({ error: delErr.message });
    console.log(`[explain DELETE] Uitleg ${id} verwijderd door ${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[explain DELETE] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// Task #265 — net als bij chat (Task #251) is dit een definitieve delete (geen
// archief/soft-delete). De canonieke route is /api/explain/delete; de oude
// /api/explain/archive blijft als alias bestaan zodat oudere clients niet breken.
app.post(['/api/explain/delete', '/api/explain/archive'], async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { explanationId, generateSummary = true, lang = 'nl', courseId } = req.body;
  if (!explanationId) return res.status(400).json({ error: 'explanationId is vereist' });

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('student_explanations')
      .select('id, student_id, explanation_text, feedback, version, created_at, concepts(name, category, definition, key_points)')
      .eq('id', explanationId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Uitleg niet gevonden' });
    if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

    let journalEntryId = null;
    let summaryFailed = false;

    if (generateSummary) {
      const apiKey = process.env.OPENAI_API_KEY;
      const conceptName = row.concepts?.name || 'Onbekend begrip';
      const conceptDef = row.concepts?.definition || '';
      const keyPoints = Array.isArray(row.concepts?.key_points) ? row.concepts.key_points : [];
      const feedbackText = row.feedback?.content || (typeof row.feedback === 'string' ? row.feedback : '(geen feedback)');

      const summaryPrompt = (lang !== 'nl'
        ? `You are a "critical friend" for a student epidemiology/biostatistics at VU Amsterdam. A student has explained the concept "${conceptName}" in their own words and received feedback from the learning assistant. Write a formative reflection report of 5 to 10 lines in English, addressed directly to the student.

Addressing rule (follow STRICTLY):
- Address the student directly using "you" / "your".
- NEVER use formulations like "the student", "this student", "the student has" or other third-person references. Write as if giving feedback one-on-one.

Your report contains:
1. A reasoned formative judgement of what you have demonstrated and learned about this concept
2. Concrete strengths and areas for improvement in your explanation (honest but constructive)
3. A specific suggestion for further deepening or a next step

Concept: "${conceptName}"
Official definition: ${conceptDef || '(not provided)'}${keyPoints.length > 0 ? `\nKey points: ${keyPoints.join('; ')}` : ''}

Your explanation:
${row.explanation_text}

Feedback from the learning assistant:
${feedbackText}

Write the report directly without salutation. Be concrete, honest and motivating.`
        : `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft het begrip "${conceptName}" in eigen woorden uitgelegd en feedback ontvangen van de leerassistent. Schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd over dit begrip
2. Concrete sterke punten én verbeterpunten in jouw uitleg (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping of een vervolgstap

Begrip: "${conceptName}"
Officiële definitie: ${conceptDef || '(niet opgegeven)'}${keyPoints.length > 0 ? `\nKernpunten: ${keyPoints.join('; ')}` : ''}

Jouw uitleg:
${row.explanation_text}

Feedback van de leerassistent:
${feedbackText}

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`) + buildLanguageInstruction(lang);

      if (AZURE_CHAT_READY) {
        try {
          const chatResp = await openaiChatCompletion({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: summaryPrompt }],
            ...chatModelParams({ temperature: 0.5, maxTokens: 600 }),
          });

          if (chatResp.ok) {
            const chatData = await chatResp.json();
            const summaryContent = chatData.choices?.[0]?.message?.content;
            if (summaryContent) {
              const { data: entry, error: journalError } = await supabaseAdmin
                .from('learning_journal_entries')
                .insert({
                  user_id: user.id,
                  title: lang === 'nl' ? `Uitleg-reflectie: ${conceptName}` : `Explanation reflection: ${conceptName}`,
                  content: summaryContent,
                  activity_type: 'explanation_reflection',
                  course_id: await resolveJournalCourseId(courseId),
                })
                .select('id')
                .single();

              if (journalError) {
                console.error('[explain/delete] Journal insert error:', journalError);
                summaryFailed = true;
              } else {
                journalEntryId = entry.id;
                console.log(`[explain/delete] Journal entry aangemaakt: ${journalEntryId}`);
              }
            } else {
              summaryFailed = true;
            }
          } else {
            console.error('[explain/delete] OpenAI fout:', chatResp.status, await chatResp.text());
            summaryFailed = true;
          }
        } catch (chatErr) {
          console.error('[explain/delete] OpenAI request mislukt:', chatErr.message);
          summaryFailed = true;
        }
      } else {
        console.warn('[explain/delete] Azure OpenAI niet geconfigureerd — samenvatting overgeslagen');
        summaryFailed = true;
      }
    }

    // Verwijder de uitleg uit de actieve lijst
    const { error: delErr } = await supabaseAdmin
      .from('student_explanations')
      .delete()
      .eq('id', explanationId);

    if (delErr) {
      console.error('[explain/delete] kon uitleg niet verwijderen:', delErr);
      return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
    }

    return res.json({
      success: true,
      journalEntryId,
      summaryCreated: generateSummary && journalEntryId !== null,
      summaryFailed: generateSummary && summaryFailed,
    });
  } catch (err) {
    console.error('[explain/delete] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// ─── Gedeelde quiz-samenvattingsbouwer ──────────────────────────────────────
// Beide endpoints (/api/quiz/delete en /api/quiz/save-summary) gebruiken
// dezelfde notitie-stijl in het leerdagboek. De prompt schaalt mee in lengte
// en focus afhankelijk van het aantal vragen en het vraagtype: een korte
// 3-vragen meerkeuzequiz krijgt een compacte notitie van ~6 regels, een rijke
// 8-vragen open quiz krijgt een notitie tot ~18 regels met meer per-vraag-
// reflectie. De notitie spreekt de student altijd in de tweede persoon aan.
function buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage, lang = 'nl' }) {
  const safeTopics = Array.isArray(topics) && topics.length > 0 ? topics : ['(geen onderwerp opgegeven)'];
  const topicsLabel = safeTopics.join(', ');
  const qType = questionType === 'open' || questionType === 'casus' ? questionType : 'mcq';
  const typeLabel = lang !== 'nl'
    ? (qType === 'mcq' ? 'multiple choice questions' : qType === 'open' ? 'open questions' : 'case questions')
    : (qType === 'mcq' ? 'meerkeuzevragen' : qType === 'open' ? 'open vragen' : 'casusvragen');
  const safeDifficulty = difficulty || (lang === 'nl' ? 'gemiddeld' : 'medium');
  const qList = Array.isArray(questions) ? questions : [];
  const aList = Array.isArray(answers) ? answers : [];
  const totalQuestions = qList.length;
  const scorePct = scorePercentage == null ? null : Number(scorePercentage);

  // Lengtebudget op basis van vraagtype + aantal vragen.
  // Meerkeuze is feitelijker → vaste, korte notitie (6–8 regels) ongeacht aantal.
  // Open/casus is rijker → schaalt mee tot harde bovengrens (8–22 regels), met
  // gegarandeerde minLines <= maxLines.
  let minLines, maxLines, perQuestionLine;
  const HARD_MAX_LINES = 22;
  if (qType === 'mcq') {
    minLines = 6;
    maxLines = 8;
    perQuestionLine = '';
  } else {
    // Schaal: ~2 regels per vraag, met ondergrens 8 en bovengrens 22.
    minLines = Math.min(HARD_MAX_LINES - 4, Math.max(8, Math.round(totalQuestions * 1.5) + 4));
    maxLines = Math.min(HARD_MAX_LINES, Math.max(12, Math.round(totalQuestions * 2.5) + 4));
    if (minLines > maxLines) minLines = maxLines - 2;
    perQuestionLine = `Reflecteer kort op de meeste vragen afzonderlijk (zeker waar je antwoord opvallend sterk of opvallend zwak was), en koppel die aan het bredere beeld.`;
  }

  // Per-vraag-detail voor het taalmodel.
  const detailLines = qList.map((q, i) => {
    const a = aList[i] || {};
    const qText = q?.question || `(vraag ${i + 1})`;
    if (qType === 'mcq') {
      const opts = Array.isArray(q?.options) ? q.options : [];
      const noAns = lang !== 'nl' ? '(not answered)' : '(niet beantwoord)';
      const noCorrect = lang !== 'nl' ? '(unknown)' : '(onbekend)';
      const sel = typeof a.selectedIndex === 'number' ? opts[a.selectedIndex] : noAns;
      const correct = typeof q?.correctAnswer === 'number' ? opts[q.correctAnswer] : noCorrect;
      const status = lang !== 'nl' ? (a.isCorrect ? 'correct' : 'incorrect') : (a.isCorrect ? 'goed' : 'fout');
      const qLabel = lang !== 'nl' ? 'Question' : 'Vraag';
      const ansLabel = lang !== 'nl' ? 'Your answer' : 'Jouw antwoord';
      const corrLabel = lang === 'en' ? 'Correct' : 'Correct';
      return `${qLabel} ${i + 1}: ${qText}\n  - ${ansLabel}: ${sel} (${status})\n  - ${corrLabel}: ${correct}`;
    }
    const noAnsOpen = lang !== 'nl' ? '(no answer)' : '(geen antwoord)';
    const noScore = lang !== 'nl' ? '(no score)' : '(geen score)';
    const ans = (a.text || '').trim() || noAnsOpen;
    const ev = a.evaluation || {};
    const fb = (ev.feedback || '').trim();
    const ff = (ev.feedforward || '').trim();
    const sc = ev.score != null ? `${ev.score}/100` : noScore;
    const ctx = qType === 'casus' && q?.context
      ? (lang !== 'nl' ? `\n  - Case: ${q.context}` : `\n  - Casus: ${q.context}`)
      : '';
    const qLabel = lang !== 'nl' ? 'Question' : 'Vraag';
    const ansLabel = lang !== 'nl' ? 'Your answer' : 'Jouw antwoord';
    const scoreLabel = lang === 'en' ? 'Score' : 'Score';
    const fbLabel = lang === 'en' ? 'Feedback' : 'Feedback';
    const ffLabel = lang === 'en' ? 'Feed forward' : 'Feed forward';
    return `${qLabel} ${i + 1}: ${qText}${ctx}\n  - ${ansLabel}: ${ans}\n  - ${scoreLabel}: ${sc}\n  - ${fbLabel}: ${fb}\n  - ${ffLabel}: ${ff}`;
  }).join('\n\n');

  // Type-specifieke focusinstructie.
  const focusInstruction = lang !== 'nl'
    ? (qType === 'mcq'
      ? 'Focus on patterns: which concepts or reasoning steps went well, which needed correction. Reference specific question numbers where relevant.'
      : qType === 'open'
        ? 'Focus on the quality of your reasoning: how explicitly did you state your assumptions, how precise was your wording, how well did you support your conclusions? Be specific per question where helpful.'
        : 'Focus on your clinical-methodological reasoning in the case: how well did you connect theory to the scenario, which methodological choices did you justify, which nuances did you overlook? Be specific per case where helpful.')
    : (qType === 'mcq'
      ? 'Focus op patronen: welke begrippen of denkstappen gingen goed, welke vroegen om correctie. Verwijs waar relevant naar specifieke vraagnummers.'
      : qType === 'open'
        ? 'Focus op de kwaliteit van je redenering: hoe expliciet maakte je je aannames, hoe nauwkeurig was je formulering, hoe goed onderbouw je conclusies? Wees concreet per vraag waar dat helpt.'
        : 'Focus op je klinisch-methodisch redeneren in de casus: hoe goed verbond je theorie met het scenario, welke methodische keuzes onderbouwde je, welke nuances liet je liggen? Wees concreet per casus waar dat helpt.');

  const summaryPromptNL = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft zojuist een AI-gegenereerde quiz afgerond. Schrijf een formatief reflectieverslag van ${minLines} tot ${maxLines} regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat — in deze volgorde, met deze (vetgedrukte) kopjes op aparte regels:
**Wat je hebt laten zien**
- Concrete sterke punten op basis van jouw antwoorden en de gegeven feedback.

**Aandachtspunten**
- Waar het minder ging en waarom; verwijs waar relevant naar specifieke vraagnummers.

**Wat je hiermee kunt**
- Eén of twee concrete vervolgstappen — wat ga je nalezen, oefenen of toepassen om dit verder te brengen, en waarvoor is wat je nu kunt al genoeg?

Type-specifieke focus: ${focusInstruction}
${perQuestionLine}

Quiz-context:
- Onderwerp(en): ${topicsLabel}
- Vraagtype: ${typeLabel}
- Niveau: ${safeDifficulty}
- Aantal vragen: ${totalQuestions}${scorePct != null ? `\n- Totaalscore: ${scorePct}%` : ''}

Quiz-detail (per vraag):
${detailLines || '(geen details beschikbaar)'}

Schrijf het verslag direct, zonder aanhef en zonder afsluitende groet. Wees concreet, eerlijk en motiverend; vermijd vaagheden en clichés.`;

  const summaryPromptEN = `You are a "critical friend" for an epidemiology/biostatistics student at VU Amsterdam. The student has just completed an AI-generated quiz. Write a formative reflection report of ${minLines} to ${maxLines} lines in English, addressed directly to the student.

Address the student directly using "you/your" throughout. NEVER refer to "the student" in the third person.

Your report contains — in this order, with these (bold) headings on separate lines:
**What you demonstrated**
- Concrete strengths based on your answers and the feedback provided.

**Areas for attention**
- Where things went less well and why; reference specific question numbers where relevant.

**What you can do with this**
- One or two concrete next steps — what will you review, practise, or apply to improve further, and for what is your current level already sufficient?

Type-specific focus: ${focusInstruction}
${perQuestionLine}

Quiz context:
- Topic(s): ${topicsLabel}
- Question type: ${typeLabel}
- Difficulty: ${safeDifficulty}
- Number of questions: ${totalQuestions}${scorePct != null ? `\n- Total score: ${scorePct}%` : ''}

Quiz detail (per question):
${detailLines || '(no details available)'}

Write the report directly, without a greeting or closing. Be concrete, honest and motivating; avoid vague generalities and clichés.`;

  const summaryPrompt = (lang === 'nl' ? summaryPromptNL : summaryPromptEN) + buildLanguageInstruction(lang);

  return {
    summaryPrompt,
    topicsLabel,
    qType,
    typeLabel,
    minLines,
    maxLines,
    lang,
  };
}

// Roept OpenAI aan met de gegeven prompt en schrijft de notitie weg in
// learning_journal_entries. Returnt {journalEntryId, summaryFailed, errorReason}.
async function generateAndSaveQuizSummary({ user, summaryPrompt, topicsLabel, qType, maxLines, lang = 'nl', courseId = null }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!AZURE_CHAT_READY) {
    console.warn('[quiz/summary] Azure OpenAI niet geconfigureerd — samenvatting overgeslagen');
    return { journalEntryId: null, summaryFailed: true, errorReason: 'Geen taalmodel-toegang (Azure OpenAI niet geconfigureerd).' };
  }
  // Token-budget evenredig aan maximale regels (≈ 50 tokens/regel marge).
  const maxTokens = Math.min(2000, Math.max(600, maxLines * 60));

  let summaryContent;
  try {
    const chatResp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: summaryPrompt }],
      ...chatModelParams({ temperature: 0.5, maxTokens: maxTokens }),
    });

    if (!chatResp.ok) {
      const txt = await chatResp.text();
      console.error('[quiz/summary] OpenAI fout:', chatResp.status, txt);
      return { journalEntryId: null, summaryFailed: true, errorReason: `Het taalmodel reageerde met status ${chatResp.status}.` };
    }
    const chatData = await chatResp.json();
    summaryContent = chatData.choices?.[0]?.message?.content;
    if (!summaryContent) {
      return { journalEntryId: null, summaryFailed: true, errorReason: 'Het taalmodel gaf een leeg antwoord.' };
    }
  } catch (chatErr) {
    console.error('[quiz/summary] OpenAI request mislukt:', chatErr.message);
    return { journalEntryId: null, summaryFailed: true, errorReason: chatErr.message };
  }

  const titleTopics = topicsLabel.length > 80 ? `${topicsLabel.slice(0, 77)}...` : topicsLabel;
  const typePrefix = lang !== 'nl'
    ? (qType === 'mcq' ? 'MCQ quiz' : qType === 'open' ? 'Open quiz' : 'Case quiz')
    : (qType === 'mcq' ? 'Meerkeuzequiz' : qType === 'open' ? 'Open quiz' : 'Casusquiz');
  const reflectionLabel = lang === 'nl' ? 'reflectie' : 'reflection';
  const { data: entry, error: journalError } = await supabaseAdmin
    .from('learning_journal_entries')
    .insert({
      user_id: user.id,
      title: `${typePrefix}-${reflectionLabel}: ${titleTopics}`,
      content: summaryContent,
      activity_type: 'quiz_reflection',
      course_id: courseId,
    })
    .select('id')
    .single();

  if (journalError) {
    console.error('[quiz/summary] Journal insert error:', journalError);
    return { journalEntryId: null, summaryFailed: true, errorReason: journalError.message };
  }
  console.log(`[quiz/summary] Journal entry aangemaakt: ${entry.id}`);
  return { journalEntryId: entry.id, summaryFailed: false, errorReason: null };
}

// /api/quiz/save-summary — schrijft alleen een leerdagboek-notitie op basis
// van quizgegevens die direct in de body worden meegestuurd. Werkt onafhankelijk
// van de quiz_attempts-tabel, zodat de student de samenvatting altijd kan
// bewaren, ook als de quiz_attempts-migratie nog niet is toegepast.
app.post('/api/quiz/save-summary', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { topics, difficulty, questionType, questions, answers, scorePercentage, lang = 'nl', courseId } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions is vereist en mag niet leeg zijn' });
  }
  // Veiligheidsplafond op aantal vragen om abuse op een authenticated
  // OpenAI-genererend endpoint te beperken.
  if (questions.length > 30) {
    return res.status(400).json({ error: 'Te veel vragen (max 30 per samenvatting)' });
  }
  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers is vereist (array)' });
  }
  if (answers.length !== questions.length) {
    return res.status(400).json({ error: 'answers.length moet gelijk zijn aan questions.length' });
  }
  if (questionType && !['mcq', 'open', 'casus'].includes(questionType)) {
    return res.status(400).json({ error: 'Onbekend questionType' });
  }
  // Per vraagtype: minimale shape-checks zodat de prompt niet leeg loopt.
  const qt = questionType || 'mcq';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      return res.status(400).json({ error: `Vraag ${i + 1} mist een tekstveld` });
    }
    if (qt === 'mcq' && !Array.isArray(q.options)) {
      return res.status(400).json({ error: `Vraag ${i + 1} (mcq) mist options` });
    }
  }
  if (scorePercentage != null) {
    const n = Number(scorePercentage);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: 'scorePercentage moet tussen 0 en 100 liggen' });
    }
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const params = buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage, lang });
    const journalCourseId = await resolveJournalCourseId(courseId);
    const result = await generateAndSaveQuizSummary({ user, lang, courseId: journalCourseId, ...params });

    if (result.summaryFailed) {
      return res.status(502).json({
        error: 'De samenvatting kon niet worden opgesteld of opgeslagen.',
        detail: result.errorReason,
      });
    }
    return res.json({ success: true, journalEntryId: result.journalEntryId });
  } catch (err) {
    console.error('[quiz/save-summary] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout', detail: err?.message });
  }
});

// Task #265 — net als bij chat (Task #251) is dit een definitieve delete (geen
// archief/soft-delete). De canonieke route is /api/quiz/delete; de oude
// /api/quiz/archive blijft als alias bestaan zodat oudere clients niet breken.
app.post(['/api/quiz/delete', '/api/quiz/archive'], async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  if (!quizAttemptsHasNewSchema) {
    return res.status(503).json({
      error: 'De quiz-database is nog niet bijgewerkt naar het nieuwe model. ' +
        'Pas migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql toe in Supabase en herstart de server.',
    });
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { attemptId, generateSummary = true, lang = 'nl', courseId } = req.body;
  if (!attemptId) return res.status(400).json({ error: 'attemptId is vereist' });

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('quiz_attempts')
      .select('id, student_id, topics, difficulty, question_type, questions_data, answers, score_percentage, total_questions, score, created_at')
      .eq('id', attemptId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Quizpoging niet gevonden' });
    if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze quizpoging' });

    let journalEntryId = null;
    let summaryFailed = false;

    if (generateSummary) {
      const params = buildQuizSummaryParams({
        topics: row.topics,
        difficulty: row.difficulty,
        questionType: row.question_type,
        questions: row.questions_data,
        answers: row.answers,
        scorePercentage: row.score_percentage,
        lang,
      });
      const journalCourseId = await resolveJournalCourseId(courseId);
      const result = await generateAndSaveQuizSummary({ user, lang, courseId: journalCourseId, ...params });
      journalEntryId = result.journalEntryId;
      summaryFailed = result.summaryFailed;
    }

    // Defense-in-depth: filter ook op student_id, zodat een race-condition
    // tussen ownership-check en delete nooit andermans rij kan raken.
    const { error: delErr } = await supabaseAdmin
      .from('quiz_attempts')
      .delete()
      .eq('id', attemptId)
      .eq('student_id', user.id);

    if (delErr) {
      console.error('[quiz/delete] kon quizpoging niet verwijderen:', delErr);
      return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
    }

    return res.json({
      success: true,
      journalEntryId,
      summaryCreated: generateSummary && journalEntryId !== null,
      summaryFailed: generateSummary && summaryFailed,
    });
  } catch (err) {
    console.error('[quiz/delete] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// /api/projects/save-summary — vat een project (en de bijhorende sessie van
// de student) samen via OpenAI en bewaart het resultaat als een
// learning_journal_entries-rij met activity_type='project_reflection'. Werkt
// los van de status van het project; je kunt een lopend of afgerond project
// archiveren. De projectsessie zelf blijft bestaan — dit is puur een
// reflectie-snapshot in het leerdagboek.
app.post('/api/projects/save-summary', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { sessionId, force } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is vereist' });
  }
  if (force !== undefined && typeof force !== 'boolean') {
    return res.status(400).json({ error: 'force moet een boolean zijn' });
  }

  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('student_project_sessions')
      .select('id, student_id, project_id, current_phase, hypothesis, analysis_notes, conclusions, completed, started_at, last_activity, projects(title, description, research_question, difficulty)')
      .eq('id', sessionId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Projectsessie niet gevonden' });
    if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze projectsessie' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) {
      return res.status(503).json({
        error: 'De samenvatting kon niet worden opgesteld.',
        detail: 'Geen taalmodel-toegang (Azure OpenAI niet geconfigureerd).',
      });
    }

    const project = row.projects || {};
    const projectTitle = project.title || '(naamloos project)';
    const projectDescription = (project.description || '').trim();
    const researchQuestion = (project.research_question || '').trim();
    const difficulty = project.difficulty || 'onbekend';
    const phase = row.current_phase || 'onbekend';
    const hypothesis = (row.hypothesis || '').trim();
    const analysisNotes = (row.analysis_notes || '').trim();
    const conclusions = (row.conclusions || '').trim();
    const status = row.completed ? 'afgerond' : 'in uitvoering';

    // Voorkom hallucinatie op een lege sessie: als alle drie de werkvelden
    // leeg zijn, is er niets zinvols om te reflecteren en zou OpenAI de prompt
    // alsnog "creatief" invullen. Geef een duidelijke fout terug zodat de UI
    // de student kan vragen eerst iets in te vullen.
    if (!hypothesis && !analysisNotes && !conclusions) {
      return res.status(400).json({
        error: 'Er is nog niets om samen te vatten.',
        detail: 'Vul eerst je hypothese, analyse-aantekeningen of conclusies in voor je een samenvatting in je leerdagboek zet.',
      });
    }

    // Voorkom dubbele projectreflecties: check of er al een eerdere
    // reflectie voor exact dit project (zelfde titel) in het leerdagboek
    // van deze student staat. Zo ja, en de student heeft niet expliciet
    // bevestigd, vragen we eerst om bevestiging zodat het leerdagboek niet
    // volloopt en we niet onnodig OpenAI-tokens verbruiken.
    const titleProjectShort = projectTitle.length > 80 ? `${projectTitle.slice(0, 77)}...` : projectTitle;
    const journalTitle = `Projectreflectie: ${titleProjectShort}`;
    if (!force) {
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from('learning_journal_entries')
        .select('id, created_at')
        .eq('user_id', user.id)
        .eq('activity_type', 'project_reflection')
        .eq('title', journalTitle)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingErr) {
        console.warn('[projects/save-summary] Kon dubbele-check niet uitvoeren:', existingErr.message);
      } else if (existing) {
        return res.status(409).json({
          error: 'duplicate_reflection',
          message: 'Er staat al een projectreflectie voor dit project in je leerdagboek.',
          existingEntry: { id: existing.id, created_at: existing.created_at },
        });
      }
    }

    const summaryPrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft aan een data-analyseproject gewerkt en wil daar in het leerdagboek op reflecteren. Schrijf een formatief reflectieverslag van 8 tot 14 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat — in deze volgorde, met deze (vetgedrukte) kopjes op aparte regels:
**Wat je hebt laten zien**
- Concrete sterke punten op basis van je hypothese, analyse-aantekeningen en conclusies. Wees specifiek over methodische keuzes die opvallen.

**Aandachtspunten**
- Waar je redenering nog niet rond is, welke aannames of nuances je hebt laten liggen, en welke methodische valkuilen op de loer liggen voor het type onderzoek.

**Wat je hiermee kunt**
- Eén of twee concrete vervolgstappen — wat ga je nalezen, controleren of uitwerken om dit project (of een vergelijkbare analyse) verder te brengen.

Project-context:
- Titel: ${projectTitle}
- Status: ${status} (huidige fase: ${phase})
- Niveau: ${difficulty}${researchQuestion ? `\n- Onderzoeksvraag: ${researchQuestion}` : ''}${projectDescription ? `\n- Projectbeschrijving: ${projectDescription}` : ''}

Jouw werk tot nu toe:
- Hypothese: ${hypothesis || '(nog niet ingevuld)'}
- Analyse-aantekeningen: ${analysisNotes || '(nog niet ingevuld)'}
- Conclusies: ${conclusions || '(nog niet ingevuld)'}

Schrijf het verslag direct, zonder aanhef en zonder afsluitende groet. Wees concreet, eerlijk en motiverend; vermijd vaagheden en clichés.`;

    let summaryContent;
    try {
      const chatResp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: summaryPrompt }],
        ...chatModelParams({ temperature: 0.5, maxTokens: 1000 }),
      });
      if (!chatResp.ok) {
        const txt = await chatResp.text();
        console.error('[projects/save-summary] OpenAI fout:', chatResp.status, txt);
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: `Het taalmodel reageerde met status ${chatResp.status}.`,
        });
      }
      const chatData = await chatResp.json();
      summaryContent = chatData.choices?.[0]?.message?.content;
      if (!summaryContent) {
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: 'Het taalmodel gaf een leeg antwoord.',
        });
      }
    } catch (chatErr) {
      console.error('[projects/save-summary] OpenAI request mislukt:', chatErr.message);
      return res.status(502).json({
        error: 'De samenvatting kon niet worden opgesteld.',
        detail: chatErr.message,
      });
    }

    const { data: entry, error: journalError } = await supabaseAdmin
      .from('learning_journal_entries')
      .insert({
        user_id: user.id,
        title: journalTitle,
        content: summaryContent,
        activity_type: 'project_reflection',
        course_id: await courseIdForProject(row.project_id),
      })
      .select('id')
      .single();

    if (journalError) {
      console.error('[projects/save-summary] Journal insert error:', journalError);
      return res.status(500).json({
        error: 'De samenvatting kon niet worden opgeslagen in je leerdagboek.',
        detail: journalError.message,
      });
    }

    console.log(`[projects/save-summary] Journal entry aangemaakt: ${entry.id} voor sessie ${sessionId}`);
    return res.json({ success: true, journalEntryId: entry.id });
  } catch (err) {
    console.error('[projects/save-summary] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout', detail: err?.message });
  }
});

app.get('/api/admin/prompts-migration-status', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isAdminCheck = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    if (!isAdminCheck && !(await userIsTeacherAnywhere(user.id))) {
      return res.status(403).json({ error: 'Geen toegang' });
    }
  } catch {
    return res.status(401).json({ error: 'Authenticatie mislukt' });
  }
  const sqlToRun = promptsHasSection ? null : [
    "-- Stap 1: kolom toevoegen",
    "ALTER TABLE chatbot_prompts ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'chat';",
    "",
    "-- Stap 2: bestaande rijen op 'chat' zetten",
    "UPDATE chatbot_prompts SET section = 'chat' WHERE name NOT LIKE '__rag_settings%';",
  ].join('\n');
  return res.json({
    hasSection: promptsHasSection,
    sqlToRun,
  });
});

app.get('/api/admin/backfill-project-doc-folder-links/status', (_req, res) => {
  return res.json({ status: null });
});

// Per-cursus uitleg-prompt wordt — net als de RAG-instellingen — opgeslagen als
// een speciaal-genoemde chatbot_prompts-rij `__explain_prompt_<courseId>__`
// (section='internal', is_active=false) zodat de globale resolver en de
// admin-sectieweergave er niet door vervuild raken. Geen schemawijziging nodig.
const EXPLAIN_PROMPT_KEY_PREFIX = '__explain_prompt_';
function explainPromptKey(courseId) {
  return `${EXPLAIN_PROMPT_KEY_PREFIX}${courseId}__`;
}

async function loadGlobalExplainPrompt() {
  const { data, error } = await supabaseAdmin
    .from('chatbot_prompts')
    .select('id, content')
    .eq('section', 'explain')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[explain-prompt] Fout bij ophalen globale prompt:', error.message);
    return { id: null, content: DEFAULT_EXPLAIN_PROMPT };
  }
  return { id: data?.id ?? null, content: data?.content ?? DEFAULT_EXPLAIN_PROMPT };
}

app.get('/api/prompt/explain', async (req, res) => {
  if (!supabaseAdmin || !promptsHasSection) {
    return res.json({ content: DEFAULT_EXPLAIN_PROMPT, source: 'default' });
  }
  const { courseId } = req.query;
  try {
    // 1) Cursus-specifieke override (indien aanwezig en niet leeg).
    if (courseId) {
      const { data: override } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, content')
        .eq('name', explainPromptKey(courseId))
        .maybeSingle();
      if (override?.content && override.content.trim()) {
        return res.json({ id: override.id, content: override.content, source: 'course' });
      }
    }
    // 2) Globale actieve uitleg-prompt, anders ingebouwde standaard.
    const global = await loadGlobalExplainPrompt();
    const usedDefault = global.content === DEFAULT_EXPLAIN_PROMPT && global.id === null;
    return res.json({ id: global.id, content: global.content, source: usedDefault ? 'default' : 'global' });
  } catch (err) {
    console.error('[/api/prompt/explain] Exception:', err.message);
    return res.json({ content: DEFAULT_EXPLAIN_PROMPT, source: 'default' });
  }
});

// ── Beheer: per-cursus uitleg-prompt (Task #28) ─────────────────────────────
// GET geeft de cursus-override (indien aanwezig) plus de globale prompt als
// referentie. PUT slaat een override op, DELETE verwijdert hem (terug naar
// globaal). Auth: staff voor de betreffende cursus (admin/superuser overal).

app.get('/api/admin/explain-prompt', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId } = req.query;
  if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
  if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  try {
    const { data: override } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('content')
      .eq('name', explainPromptKey(courseId))
      .maybeSingle();
    const global = await loadGlobalExplainPrompt();
    const hasOverride = !!(override?.content && override.content.trim());
    return res.json({
      hasOverride,
      content: hasOverride ? override.content : '',
      globalContent: global.content,
    });
  } catch (err) {
    console.error('[/api/admin/explain-prompt GET] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/explain-prompt', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId, content } = req.body || {};
  if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content (niet-leeg) vereist' });
  }
  if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  try {
    const key = explainPromptKey(courseId);
    const { data: existing } = await supabaseAdmin
      .from('chatbot_prompts').select('id').eq('name', key).maybeSingle();
    if (existing) {
      const { error: updErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .update({ content, updated_at: new Date().toISOString() })
        .eq('name', key);
      if (updErr) throw new Error(`DB update mislukt: ${updErr.message}`);
    } else {
      const insertRow = { name: key, content, is_active: false };
      if (promptsHasSection) insertRow.section = 'internal';
      const { error: insErr } = await supabaseAdmin
        .from('chatbot_prompts').insert(insertRow);
      if (insErr) throw new Error(`DB insert mislukt: ${insErr.message}`);
    }
    console.log(`[explain-prompt PUT] Saved override for courseId=${courseId} by user=${auth.user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[/api/admin/explain-prompt PUT] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/explain-prompt/:courseId', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
  if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  try {
    const { error: delErr } = await supabaseAdmin
      .from('chatbot_prompts').delete().eq('name', explainPromptKey(courseId));
    if (delErr) throw new Error(`DB delete mislukt: ${delErr.message}`);
    console.log(`[explain-prompt DELETE] Removed override for courseId=${courseId} by user=${auth.user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[/api/admin/explain-prompt DELETE] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/explain-prompt/overrides', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  if (!(await isStaffAnywhere(auth.user, auth.profile))) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('name')
      .like('name', `${EXPLAIN_PROMPT_KEY_PREFIX}%`);
    if (error) throw new Error(error.message);
    const courseIds = (data || []).map(row => {
      const m = row.name.match(/^__explain_prompt_(.+)__$/);
      return m ? m[1] : null;
    }).filter(Boolean);
    return res.json({ courseIds });
  } catch (err) {
    console.error('[/api/admin/explain-prompt/overrides GET] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    azure: AZURE_CHAT_READY,
    azureEmbeddings: AZURE_EMBEDDINGS_READY,
    openai: !!process.env.OPENAI_API_KEY,
    github: !!process.env.GITHUB_TOKEN,
    supabase: !!process.env.SUPABASE_URL,
  });
});

// Debug endpoint: geeft per sectie terug welke prompt actief is (naam + bron).
// Alleen toegankelijk voor admins en docenten.
app.get('/api/debug/active-prompts', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  // Admin/superuser overal; anders moet de user in minstens één cursus
  // docent zijn (course_members.member_role='teacher').
  const isAdminDbg = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  if (!isAdminDbg && !(await userIsTeacherAnywhere(auth.user.id))) {
    return res.status(403).json({ error: 'Alleen beschikbaar voor admins en docenten' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

  const result = { chat: null, explain: null, quiz: [] };

  // Chat-prompt: actieve prompt met section='chat'. Spiegel de filters van
  // /api/chat exact (incl. uitsluiting van quiz_*-namen) en order+limit, zodat
  // meerdere chat-rijen niet leiden tot een "multiple rows"-fout op
  // .maybeSingle() en de badge nooit ten onrechte 'fallback' toont.
  try {
    const quizNamesExclude = Object.keys(QUIZ_PROMPT_DEFAULTS);
    let chatQuery = supabaseAdmin
      .from('chatbot_prompts')
      .select('id, name')
      .eq('is_active', true)
      .not('name', 'like', '__rag_settings%')
      .not('name', 'like', '__doc_mutation_%')
      .not('name', 'like', '__concepts_regen_%')
      .neq('name', '__quiz_itembank_config__')
      .not('name', 'in', `(${quizNamesExclude.map(n => `"${n}"`).join(',')})`)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (promptsHasSection) chatQuery = chatQuery.eq('section', 'chat');
    const { data } = await chatQuery.maybeSingle();
    result.chat = data
      ? { id: data.id, name: data.name, source: 'database' }
      : { name: 'FALLBACK_SYSTEM_PROMPT', source: 'fallback' };
  } catch (err) {
    result.chat = { name: 'FALLBACK_SYSTEM_PROMPT', source: 'fallback' };
  }

  // Explain-prompt: actieve prompt met section='explain'
  try {
    if (promptsHasSection) {
      const { data } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name')
        .eq('section', 'explain')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      result.explain = data
        ? { id: data.id, name: data.name, source: 'database' }
        : { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
    } else {
      result.explain = { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
    }
  } catch (err) {
    result.explain = { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
  }

  // Quiz-prompts: alle bekende quiz-prompts met hun actieve status
  try {
    const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
    if (promptsHasSection) {
      const { data } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, is_active')
        .in('name', quizNames);
      result.quiz = (data || []).map(r => ({ id: r.id, name: r.name, is_active: r.is_active !== false }));
    } else {
      result.quiz = quizNames.map(name => ({ name, is_active: true, source: 'fallback' }));
    }
  } catch (err) {
    result.quiz = [];
  }

  return res.json(result);
});

// Oude default — bewaard voor automatische DB-sync naar de nieuwe stijl in
// initChatbotPromptSection. Records die LETTERLIJK gelijk zijn aan deze
// tekst worden zonder vragen bijgewerkt; aangepaste records worden niet
// aangeraakt en getriggeren een waarschuwing in de console.
const OLD_DEFAULT_EXPLAIN_PROMPT_V1 = `Je bent een kritische en constructieve tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback.

Geef je feedback in vier onderdelen:
1. Wat de student goed heeft gedaan (noem specifieke sterke punten)
2. Wat ontbreekt of onduidelijk is (wees concreet)
3. Eventuele misconcepties die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student in de gezondheidswetenschappen.`;

const DEFAULT_EXPLAIN_PROMPT = `Je bent een kritische en constructieve tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback rechtstreeks aan de student.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Geef je feedback in vier onderdelen:
1. Wat je goed hebt gedaan (noem specifieke sterke punten in jouw uitleg)
2. Wat ontbreekt of onduidelijk is in jouw uitleg (wees concreet)
3. Eventuele misconcepties bij jou die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Notatie van formules (volg STRIKT):
- Schrijf elke wiskundige formule of elk symbool in LaTeX: $...$ voor een formule midden in een zin, $$...$$ voor een formule op een eigen regel.
- Plaats dollartekens ALTIJD in paren: voor elk openend $ of $$ exact één afsluitend $ of $$. Laat nooit een los dollarteken staan.
- Meng inline en display niet binnen één formule: kies $...$ óf $$...$$, niet allebei voor dezelfde formule.
- Gebruik LaTeX-commando's zoals \\cap, \\cdot, \\mid, \\Rightarrow, \\frac UITSLUITEND binnen $...$ of $$...$$, nooit in gewone tekst.

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student in de gezondheidswetenschappen.`;

// Task #166: standaard prompt-template voor document-reviews. De docent kan
// dit in de admin-UI overschrijven (Prompts → sectie 'project'). De template
// gebruikt geen placeholder-syntax — de server vouwt de runtime-velden
// (persona-prompt, rubric, document-tekst, etc.) als losse blokken eronder
// in zodat de prompt zelf-redactiebaar blijft zonder vaste sleutels.
const DEFAULT_DOCUMENT_REVIEW_PROMPT = `Je bent een formatieve beoordelaar voor een groep VU-studenten epi/biostat. Geef een gestructureerd oordeel over het hieronder bijgevoegde studentdocument.

Aanspraakvorm: spreek de groep aan met "jullie". Wees concreet, vermijd derde-persoonsformuleringen ("de groep heeft …").

Antwoord ALTIJD met geldig JSON, zonder extra tekst eromheen, volgens dit schema:
{
  "verdict": "accepted" | "conditional" | "rejected",
  "grade": getal tussen 0 en 10 (één decimaal toegestaan, bijv. 7.5),
  "reasoning": "2-4 zinnen feedback in het Nederlands, in tweede persoon: wat is er goed en wat schiet tekort",
  "feed_forward": "1-3 concrete vervolgstappen in het Nederlands, in tweede persoon: wat moeten jullie hierna doen om beter te scoren",
  "relationship_delta": geheel getal tussen -5 en +5
}

Betekenis verdict:
- "accepted" = je vindt het document inhoudelijk voldoende.
- "conditional" = bruikbaar mits jullie de genoemde punten aanpakken.
- "rejected" = nog niet op niveau; geef duidelijk aan wat eerst anders moet.

Betekenis grade: een cijfer van 0 t/m 10 voor de kwaliteit van het document, gebaseerd op de (verborgen) rubric(s) hierboven. Wees streng maar eerlijk; een 6 is voldoende, een 8+ is uitstekend.

Betekenis reasoning (feedback): waar staan jullie nu — benoem zowel sterke punten als tekortkomingen.
Betekenis feed_forward (feed-forward): wat is de volgende stap — concrete, uitvoerbare verbeteracties.

Betekenis relationship_delta: hoeveel verschuift jouw verstandhouding met deze groep door dit document?
+5 = sterk positief, 0 = neutraal, -5 = sterk negatief. Wees terughoudend; gebruik extremen alleen bij duidelijke aanleiding.

Geef GEEN markdown, GEEN code fences, alléén het JSON-object.`;

let promptsHasSection = false;

async function initChatbotPromptSection() {
  if (!supabaseAdmin) return;
  try {
    const { error: detectError } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('section')
      .limit(1);

    if (detectError && detectError.message?.includes('section')) {
      console.warn(
        '[init] chatbot_prompts.section kolom ontbreekt.\n' +
        '       Voer dit SQL uit in het Supabase dashboard om de kolom toe te voegen:\n\n' +
        "       ALTER TABLE chatbot_prompts ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'chat';\n" +
        "       UPDATE chatbot_prompts SET section = 'chat' WHERE name NOT LIKE '__rag_settings%';\n" +
        '       Herstart daarna de server om de uitleg-prompt automatisch aan te maken.\n'
      );
      promptsHasSection = false;
      return;
    }

    promptsHasSection = true;

    // Sectie-opschoning via directe SQL (pgPool). PostgREST-filters voor
    // LIKE-patronen op `__...%` en `.not('section','in', ...)` werken in
    // supabase-js onbetrouwbaar door underscore-wildcard escaping en
    // string-literaalafhandeling. Met directe SQL is dit eenduidig en
    // idempotent.
    if (pgPool) {
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        // 1) Interne config-rijen → section='internal'.
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'internal'
           WHERE (name = '__quiz_itembank_config__'
              OR name LIKE E'\\\\_\\\\_doc\\\\_mutation\\\\_%' ESCAPE E'\\\\'
              OR name LIKE E'\\\\_\\\\_concepts\\\\_regen\\\\_%' ESCAPE E'\\\\'
              OR name LIKE E'\\\\_\\\\_rag\\\\_settings%' ESCAPE E'\\\\')
             AND (section IS DISTINCT FROM 'internal')`
        );
        // 2) Quiz-prompts → section='quiz' (onvoorwaardelijk overschrijven).
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'quiz'
           WHERE name = ANY($1::text[])
             AND (section IS DISTINCT FROM 'quiz')`,
          [quizNames]
        );
        // 3) Rijen met section IS NULL: standaard 'chat'.
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'chat' WHERE section IS NULL`
        );
      } catch (sqlErr) {
        console.warn('[init] Sectie-opschoning via SQL mislukt:', sqlErr.message);
      }
    } else {
      // Fallback zonder pgPool: gebruik losse supabase-js calls. Vermijd
      // .or() met underscore-LIKE en .not('section','in',...) want die zijn
      // onbetrouwbaar in PostgREST.
      console.warn('[init] pgPool niet beschikbaar — sectie-opschoning via supabase-js fallback.');
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        // 1) Interne config-rijen (vier patronen, los uitgevoerd).
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'internal' })
          .eq('name', '__quiz_itembank_config__')
          .neq('section', 'internal');
        for (const prefix of ['__doc_mutation_', '__concepts_regen_', '__rag_settings']) {
          await supabaseAdmin
            .from('chatbot_prompts')
            .update({ section: 'internal' })
            .like('name', `${prefix}%`)
            .neq('section', 'internal');
        }
        // 2) Quiz-prompts → 'quiz'.
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'quiz' })
          .in('name', quizNames)
          .neq('section', 'quiz');
        // 3) NULL → 'chat'.
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'chat' })
          .is('section', null);
      } catch (fallbackErr) {
        console.warn('[init] Sectie-opschoning fallback mislukt:', fallbackErr.message);
      }
    }

    // Zorg dat er minstens één echte chat-prompt bestaat zodat /api/chat
    // niet meer naar de hard-coded FALLBACK_SYSTEM_PROMPT valt. Gebruik
    // pgPool zodat we niet weer tegen PostgREST-filterquirks aanlopen.
    let existingChatRow = null;
    if (pgPool) {
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        const r = await pgPool.query(
          `SELECT id FROM chatbot_prompts
           WHERE section = 'chat'
             AND is_active = true
             AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
             AND NOT (name = ANY($1::text[]))
           LIMIT 1`,
          [quizNames]
        );
        existingChatRow = r.rows[0] || null;
      } catch (pgErr) {
        console.warn('[init] Chat-prompt bestaanscheck via pgPool mislukt:', pgErr.message);
      }
    }
    if (!existingChatRow) {
      const { error: chatInsertErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({
          name: 'Chat evaluatie prompt',
          content: FALLBACK_SYSTEM_PROMPT,
          is_active: true,
          section: 'chat',
        });
      if (chatInsertErr) {
        console.warn('[init] Standaard chat-prompt aanmaken mislukt:', chatInsertErr.message);
      } else {
        console.log('[init] Standaard chat-prompt "Chat evaluatie prompt" aangemaakt');
      }
    }

    const { data: existingExplain } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('id')
      .eq('section', 'explain')
      .maybeSingle();

    if (!existingExplain) {
      const { error: insertError } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({
          name: 'Uitleg evaluatie prompt',
          content: DEFAULT_EXPLAIN_PROMPT,
          is_active: true,
          section: 'explain',
        });
      if (insertError) {
        console.warn('[init] Explain prompt aanmaken mislukt:', insertError.message);
      } else {
        console.log('[init] Standaard uitleg-prompt aangemaakt');
      }
    }

    // Eenmalige sync naar de tweede-persoon stijl: records die nog letterlijk
    // de oude default bevatten worden stil bijgewerkt; aangepaste records
    // worden NIET overschreven maar krijgen een waarschuwing.
    try {
      const { data: explainRecords, error: listErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, content')
        .eq('section', 'explain');
      if (listErr) {
        console.warn('[init] Uitleg-prompt sync overgeslagen:', listErr.message);
      } else if (Array.isArray(explainRecords)) {
        for (const rec of explainRecords) {
          if (rec.content === OLD_DEFAULT_EXPLAIN_PROMPT_V1) {
            const { error: updErr } = await supabaseAdmin
              .from('chatbot_prompts')
              .update({ content: DEFAULT_EXPLAIN_PROMPT })
              .eq('id', rec.id);
            if (updErr) {
              console.warn(`[init] Sync uitleg-prompt "${rec.name}" mislukt:`, updErr.message);
            } else {
              console.log(`[init] Uitleg-prompt "${rec.name}" automatisch bijgewerkt naar tweede-persoon stijl`);
            }
          } else if (/\b(de|deze) student\b/i.test(rec.content)) {
            console.warn(
              `[init] LET OP: aangepaste uitleg-prompt "${rec.name}" (id ${rec.id}) bevat nog "de student" / "deze student".\n` +
              '       Open de admin-UI (Prompts → sectie "explain") en pas de tekst aan zodat de student direct met "je"/"jij" wordt aangesproken.'
            );
          }
        }
      }
    } catch (syncErr) {
      console.warn('[init] Uitleg-prompt sync exception:', syncErr.message);
    }

    // Idem voor de chat system prompt(s). De huidige FALLBACK_SYSTEM_PROMPT
    // bevat geen derde-persoonsverwijzingen naar "de student", dus er valt
    // niets te auto-syncen. Wat wél nuttig is: een rapportage zodat de
    // superuser weet of zijn admin-aangepaste chat-prompts nog
    // "de student" / "deze student" bevatten — anders blijft de chat-tutor
    // dat overnemen in zijn antwoorden.
    try {
      const { data: chatRecords, error: chatListErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, content')
        .eq('section', 'chat');
      if (chatListErr) {
        console.warn('[init] Chat-prompt rapportage overgeslagen:', chatListErr.message);
      } else if (Array.isArray(chatRecords)) {
        let chatThirdPerson = 0;
        for (const rec of chatRecords) {
          if (/\b(de|deze) student\b/i.test(rec.content)) {
            chatThirdPerson++;
            console.warn(
              `[init] LET OP: chat-prompt "${rec.name}" (id ${rec.id}) bevat nog "de student" / "deze student".\n` +
              '       Open de admin-UI (Prompts → sectie "chat") en pas de tekst aan zodat de chat-tutor de student direct met "je"/"jij" aanspreekt.'
            );
          }
        }
        console.log(
          `[init] Chat-prompts gecontroleerd: ${chatRecords.length} record(s), ` +
          `${chatThirdPerson} met derde-persoonsverwijzingen naar de student.`
        );
      }
    } catch (chatSyncErr) {
      console.warn('[init] Chat-prompt rapportage exception:', chatSyncErr.message);
    }

    // Task #166: zorg dat er een 'document_review'-prompt in sectie 'project'
    // bestaat. Idempotent op (section='project', name='document_review').
    try {
      const { data: existingDR } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id')
        .eq('section', 'project')
        .eq('name', 'document_review')
        .maybeSingle();
      if (!existingDR) {
        const { error: drErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .insert({
            name: 'document_review',
            content: DEFAULT_DOCUMENT_REVIEW_PROMPT,
            is_active: false,
            section: 'project',
          });
        if (drErr) {
          console.warn('[init] document_review-prompt aanmaken mislukt:', drErr.message);
        } else {
          console.log('[init] Standaard document_review-prompt aangemaakt (sectie "project")');
        }
      }
    } catch (drSeedErr) {
      console.warn('[init] document_review-prompt seed exception:', drSeedErr.message);
    }

    console.log('[init] chatbot_prompts sectie-migratie voltooid (section kolom beschikbaar)');
  } catch (err) {
    console.warn('[init] initChatbotPromptSection exception:', err.message);
  }
}

// =============================================================================
// Task #57 — Beheer voor 3 quiz-bronnen (RAG, ItemBank, LLM-creatief)
// =============================================================================

// Defensieve schema-detectie voor de tabellen uit migratie
// 20260430160000_quiz_sources_management.sql. De server blijft draaien als
// de migratie nog niet is toegepast; endpoints geven dan een 503 met
// duidelijke uitleg.
let quizSourcesSchemaReady = false;
// Task #243: concept_evidence koppelt elk begrip aan zijn ondersteunende
// RAG-bronfragmenten bij extractie. Detecteer defensief of de migratie is
// toegepast, zodat extractie en "Ik leg uit" zonder de tabel blijven werken.
let conceptEvidenceSchemaReady = false;
async function detectConceptEvidenceSchema() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('concept_evidence').select('id').limit(1);
    conceptEvidenceSchemaReady = !error;
    if (error) {
      console.warn('[init] concept_evidence schema NIET gevonden:', error.message);
      console.warn('[init] Pas migratie 20260605100000_concept_evidence.sql toe in Supabase.');
    } else {
      console.log('[init] concept_evidence schema beschikbaar.');
    }
  } catch (e) {
    conceptEvidenceSchemaReady = false;
    console.warn('[init] concept_evidence schema detectie mislukt:', e.message);
  }
}
// Bron-agnostische itembank: alle 'itembank'-achtige bronnen die items in
// quiz_questions wegschrijven met een exsection_path. ShareStats is er één van;
// 'csv_import' is een tweede provider (docent-geüploade CSV). Lees-endpoints
// (secties, vraagselectie, dekking, suggesties, diagnose) gebruiken deze set
// zodat elke cursus een eigen itembank kan meebrengen. ShareStats-specifieke
// flows (auto-link, GitHub-sync) blijven hard op 'sharestats'.
const ITEMBANK_SOURCES = ['sharestats', 'csv_import'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bouwt het PostgREST `or`-filter voor itembank-bronnen. ShareStats is een
// gedeelde, cursus-overstijgende bank; CSV-imports horen bij één cursus
// (metadata.course_id). Zonder geldige courseId vallen we terug op enkel
// ShareStats zodat CSV-banken van andere cursussen NOOIT lekken. courseId
// wordt gevalideerd als UUID om injectie in de filterstring te voorkomen.
function itembankSourceOrFilter(courseId) {
  if (courseId && UUID_RE.test(String(courseId))) {
    return `source.eq.sharestats,and(source.eq.csv_import,metadata->>course_id.eq.${courseId})`;
  }
  return 'source.eq.sharestats';
}
async function detectQuizSourcesSchema() {
  if (!supabaseAdmin) return;
  try {
    const checks = await Promise.all([
      supabaseAdmin.from('concept_itembank_sections').select('id').limit(1),
      supabaseAdmin.from('concept_rag_sources').select('id').limit(1),
      supabaseAdmin.from('quiz_sources_mix').select('course_id').limit(1),
      supabaseAdmin.from('quiz_questions').select('exsection_path').limit(1),
    ]);
    const firstError = checks.find(c => c.error);
    quizSourcesSchemaReady = !firstError;
    if (firstError) {
      console.warn('[init] quiz_sources schema NIET gevonden:', firstError.error.message);
      console.warn('[init] Pas migratie 20260430160000_quiz_sources_management.sql toe in Supabase.');
    } else {
      console.log('[init] quiz_sources schema beschikbaar.');
    }
  } catch (e) {
    quizSourcesSchemaReady = false;
    console.warn('[init] quiz_sources schema detectie mislukt:', e.message);
  }
}

// Helper: vereis een geauthenticeerde gebruiker (alle rollen). Wordt gebruikt
// door endpoints die ook studenten mogen aanroepen — combineer met
// `userHasCourseAccess()` zodra de route per cursus filtert om cross-course
// dataleks te voorkomen.
async function requireAuthUser(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Admin client niet beschikbaar' });
    return null;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header vereist' });
    return null;
  }
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error } = await callerClient.auth.getUser();
    if (error || !user) {
      res.status(401).json({ error: 'Niet geauthenticeerd' });
      return null;
    }
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();
    return { user, profile: profile || { role: 'student' } };
  } catch (err) {
    res.status(401).json({ error: 'Authenticatie mislukt: ' + err.message });
    return null;
  }
}

// ── Per-cursus rollen (Task #165) ───────────────────────────────────────────
// 'docent' is geen globale rol meer. Iemand is docent IN een cursus als
// course_members.member_role = 'teacher' voor die cursus. Admin/superuser
// blijft overal staff.

async function isCourseTeacher(userId, courseId) {
  if (!userId || !courseId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .eq('member_role', 'teacher')
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

async function isStaffForCourse(user, profile, courseId) {
  if (!user) return false;
  if (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL) return true;
  return isCourseTeacher(user.id, courseId);
}

async function userIsTeacherAnywhere(userId) {
  if (!userId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('member_role', 'teacher')
      .limit(1);
    return !!(data && data.length);
  } catch { return false; }
}

async function isStaffAnywhere(user, profile) {
  if (!user) return false;
  if (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL) return true;
  return userIsTeacherAnywhere(user.id);
}

// Controleer of een gebruiker toegang heeft tot de inhoud van een cursus.
// Centrale regel via canAccessCourseContent: admins altijd; een actieve,
// zichtbare cursus is open voor élke ingelogde student (géén course_members
// nodig — spiegelt de courses-RLS); verborgen cursussen alléén voor de docent;
// inactieve maar zichtbare cursussen voor leden/docenten. Geen cursus = geen toegang.
async function userHasCourseAccess(user, profile, courseId) {
  if (!courseId || !user) return false;
  const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
  if (isAdmin) return true;
  try {
    // Laad de cursus-status eerst. Een actieve, zichtbare cursus is voor élke
    // student toegankelijk (spiegelt de courses-RLS van Task #270), zodat
    // zelf-geregistreerde studenten (Task #272) zonder course_members-rij de
    // inhoud zien. Membership wordt alléén opgevraagd op het inactieve pad.
    const courseCols = coursesHasStudentVisible ? 'is_active, student_visible' : 'is_active';
    const { data: course, error: courseErr } = await supabaseAdmin
      .from('courses')
      .select(courseCols)
      .eq('id', courseId)
      .maybeSingle();
    if (courseErr) {
      // 42703 = student_visible-kolom ontbreekt toch → behandel als zichtbaar en
      // lees enkel is_active opnieuw. Andere leesfouten: fail-closed.
      if (courseErr.code === '42703' || /student_visible/.test(courseErr.message || '')) {
        const { data: c2 } = await supabaseAdmin
          .from('courses').select('is_active').eq('id', courseId).maybeSingle();
        if (!c2) return false;
        if (c2.is_active !== false) return true;
        const isMember = await userHasCourseMembership(user.id, courseId);
        const teacher = isMember ? false : await isCourseTeacher(user.id, courseId);
        return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember, isActive: false, studentVisible: true });
      }
      return false;
    }
    if (!course) return false;
    const isActive = course.is_active !== false;
    const studentVisible = coursesHasStudentVisible ? (course.student_visible !== false) : true;
    // Verborgen cursus: alléén docent (geen membership-lookup nodig).
    if (!studentVisible) {
      const teacher = await isCourseTeacher(user.id, courseId);
      return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember: false, isActive, studentVisible: false });
    }
    // Actief + zichtbaar: open voor iedereen.
    if (isActive) {
      return canAccessCourseContent({ isAdmin: false, isCourseTeacher: false, isMember: false, isActive: true, studentVisible: true });
    }
    // Inactief (gearchiveerd) maar zichtbaar: lid óf docent behoudt toegang.
    const isMember = await userHasCourseMembership(user.id, courseId);
    const teacher = isMember ? false : await isCourseTeacher(user.id, courseId);
    return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember, isActive: false, studentVisible: true });
  } catch {
    return false;
  }
}

// Helper: heeft de gebruiker een course_members-rij in deze cursus?
async function userHasCourseMembership(userId, courseId) {
  if (!userId || !courseId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

// Helper: vereis admin/docent. Geeft op fout een response en `null` terug.
async function requireAdminOrDocent(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Admin client niet beschikbaar' });
    return null;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header vereist' });
    return null;
  }
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error } = await callerClient.auth.getUser();
    if (error || !user) {
      res.status(401).json({ error: 'Niet geauthenticeerd' });
      return null;
    }
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();
    const isSuperuser = profile?.email === SUPERUSER_EMAIL;
    // Toegestaan voor superuser/admin, of voor wie in minstens één cursus
    // docent is. Per-cursus checks volgen in de aanroepende endpoint.
    const isAdminLocal = isSuperuser || profile?.role === 'admin';
    if (!profile || (!isAdminLocal && !(await userIsTeacherAnywhere(user.id)))) {
      res.status(403).json({ error: 'Geen toegang' });
      return null;
    }
    return { user, profile, role: isAdminLocal ? 'admin' : 'teacher' };
  } catch (err) {
    res.status(401).json({ error: 'Authenticatie mislukt: ' + err.message });
    return null;
  }
}

// ---- Quiz-prompt templates --------------------------------------------------
// Vier prompts die expliciet beheerd worden in chatbot_prompts onder section
// 'quiz'. De keys (name) zijn stabiel; de inhoud kan vrij worden aangepast.
const QUIZ_PROMPT_DEFAULTS = {
  quiz_generate_strict: `Je bent een tentamenmaker voor epidemiologie en biostatistiek aan de VU Amsterdam. Je formuleert vragen UITSLUITEND op basis van het meegeleverde cursusmateriaal. Verzin geen feiten die niet in de context staan. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_generate_blended: `Je bent een tentamenmaker voor epidemiologie en biostatistiek aan de VU Amsterdam. Je gebruikt het meegeleverde cursusmateriaal als hoofdbron, maar mag dit aanvullen met algemeen geaccepteerde kennis uit het vakgebied. Maak helder onderscheid tussen wat in de context staat en wat algemene vakkennis is. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_generate_creative: `Je bent een creatieve tentamenmaker voor epidemiologie en biostatistiek aan de VU Amsterdam. Je formuleert toepassingsvragen, casusvragen en transferopdrachten die studenten uitdagen om de leerstof in nieuwe contexten toe te passen. Gebruik realistische scenario's uit gezondheidsonderzoek. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_evaluate_open: `Je bent een kritische maar constructieve beoordelaar van open antwoorden voor epidemiologie en biostatistiek. Je geeft feedback in vier punten: (1) wat goed is, (2) wat ontbreekt, (3) misconcepties, (4) concrete verbeterpunten. Spreek de student direct aan met "je"/"jij"/"jouw" — gebruik NOOIT "de student" of "deze student".`,
};

async function initQuizPromptDefaults() {
  if (!supabaseAdmin || !promptsHasSection) return;
  for (const [name, content] of Object.entries(QUIZ_PROMPT_DEFAULTS)) {
    try {
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id')
        .eq('name', name)
        .maybeSingle();
      if (!existing) {
        const { error } = await supabaseAdmin.from('chatbot_prompts').insert({
          name,
          content,
          is_active: true,
          section: 'quiz',
        });
        if (error) {
          console.warn(`[init] Quiz-prompt "${name}" aanmaken mislukt:`, error.message);
        } else {
          console.log(`[init] Quiz-prompt "${name}" aangemaakt`);
        }
      }
    } catch (err) {
      console.warn(`[init] Quiz-prompt "${name}" init exception:`, err.message);
    }
  }
}

// ---- Endpoints: quiz-prompts -----------------------------------------------
app.get('/api/admin/quiz-prompts', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  // Quiz-prompts zijn GLOBAAL (section='quiz', geen course_id): één edit raakt
  // álle cursussen. Daarom voorbehouden aan admin/superuser, niet aan docenten.
  if (auth.role !== 'admin') {
    return res.status(403).json({ error: 'Alleen admin/superuser mag globale quiz-prompts beheren' });
  }
  if (!promptsHasSection) {
    return res.json({ prompts: [], warning: 'chatbot_prompts.section ontbreekt — voer de section-migratie uit.' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('id, name, content, is_active, updated_at')
      .eq('section', 'quiz')
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ prompts: data || [], defaults: QUIZ_PROMPT_DEFAULTS });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/quiz-prompts/:name', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  // Globale quiz-prompts: alleen admin/superuser mag ze wijzigen (zie GET).
  if (auth.role !== 'admin') {
    return res.status(403).json({ error: 'Alleen admin/superuser mag globale quiz-prompts beheren' });
  }
  const { name } = req.params;
  const { content, is_active } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(QUIZ_PROMPT_DEFAULTS, name)) {
    return res.status(400).json({ error: `Onbekende quiz-prompt: ${name}` });
  }
  if (typeof content !== 'string' || content.trim().length < 10) {
    return res.status(400).json({ error: 'content is verplicht en minimaal 10 tekens' });
  }
  try {
    const { data: existing } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('id')
      .eq('name', name)
      .maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin
        .from('chatbot_prompts')
        .update({ content, is_active: is_active !== false })
        .eq('id', existing.id);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await supabaseAdmin.from('chatbot_prompts').insert({
        name, content, is_active: is_active !== false, section: 'quiz',
      });
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoints: itembank-mappings (concept ↔ exsection_path) ----------------
app.get('/api/admin/itembank-mappings/:courseId', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('concept_itembank_sections')
      .select('id, concept_id, course_id, exsection_path, created_at')
      .or(`course_id.eq.${courseId},course_id.is.null`);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ mappings: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/itembank-mappings/:courseId', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings)) {
    return res.status(400).json({ error: 'mappings moet een array zijn' });
  }
  // Vervang alle mappings voor deze cursus.
  try {
    await supabaseAdmin
      .from('concept_itembank_sections')
      .delete()
      .eq('course_id', courseId);
    const rows = mappings
      .filter(m => m && m.concept_id && Array.isArray(m.exsection_path) && m.exsection_path.length > 0)
      .map(m => ({
        concept_id: m.concept_id,
        course_id: courseId,
        exsection_path: m.exsection_path,
        created_by: auth.user.id,
      }));
    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from('concept_itembank_sections').insert(rows);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.json({ success: true, saved: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: auto-koppel ShareStats-imports aan begrippen in een cursus --
// Na een ShareStats-import bevatten de items een `exsection_path` (bv.
// ["Probability","ConditionalProbability"]). Studenten kunnen die items pas
// als quiz oefenen wanneer er een `concepts`-rij bestaat in hun cursus die
// via `concept_itembank_sections` aan dat pad gekoppeld is. Deze endpoint
// doet dat volautomatisch voor de top-level segmenten die door de import
// zijn aangeleverd: per segment een begrip aanmaken (als het nog niet
// bestaat) en een 1-op-1 mapping leggen op `[segment]`.
app.post('/api/admin/sharestats/auto-link-concepts', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  // Twee modi:
  //  - `selectedTopics`: lijst van GitHub-folder-namen die de docent zojuist
  //    heeft geïmporteerd. Server zoekt zélf de echte exsection_path[0]-
  //    waarden op in quiz_questions zodat we niets missen wanneer items
  //    al eerder waren geïmporteerd (skip-pad geeft anders een lege set).
  //  - `topSegments` (legacy): expliciete lijst van top-level
  //    exsection-segmenten. Behouden voor backwards-compat.
  const { courseId, topSegments, selectedTopics } = req.body || {};
  const hasSelected = Array.isArray(selectedTopics) && selectedTopics.length > 0;
  const hasSegments = Array.isArray(topSegments) && topSegments.length > 0;
  if (!courseId || (!hasSelected && !hasSegments)) {
    return res.status(400).json({ error: 'courseId en (niet-lege selectedTopics of topSegments) vereist' });
  }
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }

  // Engelse folder/segment-naam → leesbare Nederlandse begrip-naam.
  // Onbekende segmenten worden netjes genormaliseerd (koppeltekens en
  // underscores naar spaties, eerste letter hoofdletter) zodat ook nieuwe
  // ShareStats-topics een fatsoenlijk label krijgen zonder code-wijziging.
  const SEGMENT_TRANSLATIONS = {
    Probability: 'Kansrekening',
    ConditionalProbability: 'Voorwaardelijke kans',
    ElementaryProbability: 'Elementaire kans',
    Events: 'Gebeurtenissen',
    SampleSpace: 'Uitkomstenruimte',
    ExpectedValue: 'Verwachte waarde',
    Variance: 'Variantie',
    StandardDeviation: 'Standaardafwijking',
    Distributions: 'Verdelingen',
    NormalDistribution: 'Normale verdeling',
    BinomialDistribution: 'Binomiale verdeling',
    Assumptions: 'Aannames',
    Reliability: 'Betrouwbaarheid',
    'Descriptive-statistics': 'Beschrijvende statistiek',
    'Inferential_Statistics': 'Inferentiële statistiek',
    'Inferential-Statistics': 'Inferentiële statistiek',
    'Factor-analysis': 'Factoranalyse',
    'Measurement-Level': 'Meetniveau',
    'Variable-type': 'Variabele type',
    Union: 'Vereniging',
  };
  function humanizeSegment(seg) {
    if (SEGMENT_TRANSLATIONS[seg]) return SEGMENT_TRANSLATIONS[seg];
    const spaced = String(seg).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (!spaced) return seg;
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  }

  // Bouw een lijst van { topic, segments[] }-paren waar het endpoint
  // op gaat werken. Per topic krijg je één begrip; alle gevonden
  // exsection-segmenten worden daaraan gekoppeld zodat álle vragen
  // van dat topic zichtbaar worden in Quiz, ongeacht hoe diep hun
  // exsection-pad is gecodeerd.
  const topicJobs = [];
  if (hasSelected) {
    const cleanTopics = [...new Set(selectedTopics.map(s => String(s || '').trim()).filter(Boolean))];
    for (const topic of cleanTopics) {
      // Haal de werkelijk in de database aanwezige exsection-paden op voor
      // dit topic. We pakken álle items (mcq én open) van source=sharestats.
      const { data: rows, error: qErr } = await supabaseAdmin
        .from('quiz_questions')
        .select('exsection_path')
        .eq('source', 'sharestats')
        .eq('topic', topic);
      if (qErr) {
        console.error('[auto-link] Kon exsection-paden niet ophalen voor topic', topic, qErr);
      }
      const segs = new Set();
      for (const row of rows || []) {
        const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
        if (path.length > 0 && path[0]) segs.add(String(path[0]).trim());
      }
      // Fallback: nog geen items in de DB? Toch alvast het concept met
      // mapping op de foldernaam aanmaken zodat een latere import
      // automatisch in de quiz verschijnt.
      if (segs.size === 0) segs.add(topic);
      topicJobs.push({ topic, segments: [...segs] });
    }
  } else {
    // Legacy-pad: één topic-job per top-segment, label = segment zelf.
    const segs = [...new Set(topSegments.map(s => String(s || '').trim()).filter(Boolean))];
    for (const seg of segs) topicJobs.push({ topic: seg, segments: [seg] });
  }

  if (topicJobs.length === 0) {
    return res.json({ created: 0, linked: 0, conceptsByTopic: {} });
  }

  try {
    let created = 0;
    let linked = 0;
    const conceptsByTopic = {};

    // Bestaande concepten in deze cursus ophalen (zowel course_id-pad als
    // key_points-fallback) zodat we case-insensitive op naam kunnen matchen.
    const courseMarker = `[RAG-geëxtraheerd uit cursusmateriaal]`;
    let existingForCourse = [];
    if (conceptsHasCourseId) {
      const { data, error } = await supabaseAdmin
        .from('concepts')
        .select('id, name')
        .eq('course_id', courseId);
      if (error) throw error;
      existingForCourse = data || [];
    } else {
      // Fallback: alle concepts ophalen, filteren op course-marker.
      const { data, error } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points');
      if (error) throw error;
      existingForCourse = (data || []).filter(c => (c.key_points || []).includes(`course_id:${courseId}`));
    }
    const byNameLc = new Map(existingForCourse.map(c => [String(c.name || '').toLowerCase().trim(), c]));

    for (const job of topicJobs) {
      const dutchName = humanizeSegment(job.topic);
      const key = dutchName.toLowerCase().trim();
      let concept = byNameLc.get(key);

      // Begrip aanmaken als het nog niet bestaat.
      if (!concept) {
        // De `concepts.category`-CHECK-constraint laat alleen
        // 'epidemiologie' of 'biostatistiek' toe. ShareStats-items zijn
        // statistische vragen → 'biostatistiek'.
        const insertRow = conceptsHasCourseId
          ? {
              name: dutchName,
              category: 'biostatistiek',
              definition: `Begrip automatisch aangemaakt vanuit ShareStats-import (topic "${job.topic}"). Vul de definitie aan via de begrippen-beheerpagina.`,
              key_points: ['[Geïmporteerd vanuit ShareStats]'],
              examples: [],
              course_id: courseId,
            }
          : {
              name: dutchName,
              category: 'biostatistiek',
              definition: `Begrip automatisch aangemaakt vanuit ShareStats-import (topic "${job.topic}"). Vul de definitie aan via de begrippen-beheerpagina.`,
              key_points: [`course_id:${courseId}`, '[Geïmporteerd vanuit ShareStats]'],
              examples: [],
            };
        const { data: ins, error: insErr } = await supabaseAdmin
          .from('concepts')
          .insert(insertRow)
          .select('id, name')
          .single();
        if (insErr) {
          console.error('[auto-link] Begrip aanmaken mislukt voor', job.topic, insErr);
          continue;
        }
        concept = ins;
        created++;
        byNameLc.set(key, concept);
      }

      // Voor elk gevonden exsection-segment één mapping leggen via blinde
      // insert. De UNIQUE-constraint (concept_id, exsection_path) garandeert
      // idempotentie: een tweede aanroep met hetzelfde segment gooit een
      // duplicate-key fout, die we als "bestond al" interpreteren —
      // `linked` telt dus alléén daadwerkelijk nieuwe koppelingen.
      const mappedSegments = [];
      for (const seg of job.segments) {
        const { error: mapErr } = await supabaseAdmin
          .from('concept_itembank_sections')
          .insert({
            concept_id: concept.id,
            course_id: courseId,
            exsection_path: [seg],
            created_by: auth.user.id,
          });
        if (mapErr) {
          if (!/duplicate key|unique constraint|23505/i.test(mapErr.message || '')) {
            console.error('[auto-link] Mapping aanmaken mislukt voor', seg, mapErr);
            continue;
          }
        } else {
          linked++;
        }
        mappedSegments.push(seg);
      }

      conceptsByTopic[job.topic] = {
        conceptId: concept.id,
        conceptName: concept.name,
        mappedSegments,
      };
    }

    return res.json({ created, linked, conceptsByTopic });
  } catch (err) {
    console.error('[auto-link] Onverwachte fout:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
});

// Lijst van unieke exsection_path-waarden in de database — handig voor de
// docent-UI om uit te kiezen.
app.get('/api/admin/itembank-sections', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : null;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is verplicht' });
  }
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('quiz_questions')
      .select('exsection_path, topic, subtopic, item_type')
      .or(itembankSourceOrFilter(courseId))
      .not('exsection_path', 'is', null);
    if (error) return res.status(500).json({ error: error.message });
    const seen = new Map();
    for (const row of data || []) {
      const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
      if (path.length === 0) continue;
      const key = path.join(' / ');
      const entry = seen.get(key) || {
        exsection_path: path,
        count: 0,
        mcq_count: 0,
        open_count: 0,
        topic: row.topic,
        subtopic: row.subtopic,
      };
      entry.count += 1;
      if (row.item_type === 'open') entry.open_count += 1;
      else entry.mcq_count += 1;
      seen.set(key, entry);
    }
    const sections = [...seen.values()].sort((a, b) => a.exsection_path.join('/').localeCompare(b.exsection_path.join('/')));
    return res.json({ sections });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoints: concept ↔ primaire RAG-folder -------------------------------
app.get('/api/admin/concept-rag-sources/:courseId', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('concept_rag_sources')
      .select('id, concept_id, course_id, folder_id, created_at')
      .eq('course_id', courseId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ sources: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/concept-rag-sources/:courseId', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  const { sources } = req.body || {};
  if (!Array.isArray(sources)) {
    return res.status(400).json({ error: 'sources moet een array zijn' });
  }
  try {
    await supabaseAdmin
      .from('concept_rag_sources')
      .delete()
      .eq('course_id', courseId);
    const rows = sources
      .filter(s => s && s.concept_id && s.folder_id)
      .map(s => ({
        concept_id: s.concept_id,
        course_id: courseId,
        folder_id: s.folder_id,
        created_by: auth.user.id,
      }));
    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from('concept_rag_sources').insert(rows);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.json({ success: true, saved: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoints: bronnen-mix per cursus --------------------------------------
// `normalizeMix` is verhuisd naar ./quizSourcesMix.js zodat client (preview) en
// server (persist) dezelfde regels delen en het los unit-testbaar is.

app.get('/api/quiz-sources-mix/:courseId', async (req, res) => {
  // Lezen mag iedereen die toegang tot de cursus heeft (student of docent in
  // course_members, of admin/superuser).
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  // NB: requireAuthUser levert {user, profile} zonder `role`-veld, dus gebruik
  // isStaffForCourse (kijkt naar profile.role/email) i.p.v. een auth.role-check —
  // anders zou een admin/superuser die geen course_members-teacher is hier 403
  // krijgen en zou de mix in de UI terugvallen op de standaard 50:0:50.
  if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.json({ mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 }, schema_ready: false });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('quiz_sources_mix')
      .select('pct_rag, pct_itembank, pct_llm, updated_at')
      .eq('course_id', courseId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({
      mix: data ? { pct_rag: data.pct_rag, pct_itembank: data.pct_itembank, pct_llm: data.pct_llm } : { pct_rag: 50, pct_itembank: 0, pct_llm: 50 },
      schema_ready: true,
      updated_at: data?.updated_at,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/quiz-sources-mix/:courseId', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
  // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
  // teacher-anywhere docent instellingen van een andere cursus wijzigt.
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
  }
  const normalized = normalizeMix(req.body || {});
  try {
    const { data: existing } = await supabaseAdmin
      .from('quiz_sources_mix')
      .select('course_id')
      .eq('course_id', courseId)
      .maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin
        .from('quiz_sources_mix')
        .update({ ...normalized, updated_at: new Date().toISOString(), updated_by: auth.user.id })
        .eq('course_id', courseId);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await supabaseAdmin
        .from('quiz_sources_mix')
        .insert({ course_id: courseId, ...normalized, updated_by: auth.user.id });
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.json({ success: true, mix: normalized });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: itembank-vragen ophalen voor quiz ----------------------------
// Geeft een lijst itembank-vragen terug die matchen op de mappings van de
// gegeven concepten binnen een cursus. De client doet de mix-coördinatie.
app.post('/api/quiz/itembank-questions', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId, conceptIds = [], limit = 5, questionType = 'mcq' } = req.body || {};
  if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
    return res.status(400).json({ error: 'courseId en niet-lege conceptIds vereist' });
  }
  // ItemBank ondersteunt alleen mcq + open (geen casus). Casus → leeg resultaat.
  const wantedItemType = questionType === 'open' ? 'open' : (questionType === 'mcq' ? 'mcq' : null);
  if (!wantedItemType) {
    return res.json({ questions: [], reason: 'unsupported_question_type' });
  }
  // Cross-course leak voorkomen: itembank-vragen mogen alleen door cursusleden
  // (en admins/superuser) opgehaald worden.
  const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
  if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
  if (!quizSourcesSchemaReady) {
    return res.json({ questions: [], schema_ready: false });
  }
  try {
    // Mappings ophalen voor de concepten.
    const { data: mappings, error: mapErr } = await supabaseAdmin
      .from('concept_itembank_sections')
      .select('concept_id, exsection_path, course_id')
      .in('concept_id', conceptIds)
      .or(`course_id.eq.${courseId},course_id.is.null`);
    if (mapErr) return res.status(500).json({ error: mapErr.message });

    const sectionPaths = (mappings || [])
      .map(m => Array.isArray(m.exsection_path) ? m.exsection_path : null)
      .filter(p => p && p.length > 0);

    if (sectionPaths.length === 0) {
      return res.json({ questions: [], reason: 'no_mappings' });
    }

    // Trek kandidaten zonder exacte-string-prefilter. De ShareStats-bank kent
    // case-varianten ("Inferential Statistics" vs "inferential statistics") en
    // overlaps() in PostgREST is hoofdletter-gevoelig; daarom matchen we
    // hieronder in JS met genormaliseerde (lower-case) paden. 1564 items
    // passen ruim binnen de limit, dus we filteren in-memory.
    // Bronscoping (ShareStats + cursus-eigen CSV) gaat via één `.or()`. Het
    // item_type-filter wordt in-memory toegepast (zie hieronder) zodat we geen
    // tweede `.or()` op dezelfde query stapelen — dat houdt de bronscoping
    // ondubbelzinnig en voorkomt cross-course lekken.
    const candidatesQuery = supabaseAdmin
      .from('quiz_questions')
      .select('id, question_text, answer_options, correct_answer, explanation, sharestats_id, exsection_path, topic, subtopic, item_type, metadata')
      .or(itembankSourceOrFilter(courseId))
      .limit(5000);
    const { data: candidates, error: qErr } = await candidatesQuery;
    if (qErr) return res.status(500).json({ error: qErr.message });

    // item_type-kolom is pas vanaf migratie 20260507130000 aanwezig.
    // Voor mcq: accepteer item_type='mcq' óf NULL (oude rijen zijn historisch
    // mchoice). Voor open: vereis expliciet item_type='open'.
    const itemTypeMatches = (it) => wantedItemType === 'mcq'
      ? (it === 'mcq' || it === null || it === undefined)
      : it === 'open';

    const normalizePath = (p) => (Array.isArray(p) ? p : []).map(s => String(s ?? '').toLowerCase().trim());
    const targetsLower = sectionPaths.map(normalizePath);
    const matches = (candidates || []).filter(q => {
      if (!itemTypeMatches(q.item_type)) return false;
      const qPath = normalizePath(q.exsection_path);
      return targetsLower.some(target => {
        if (qPath.length < target.length) return false;
        for (let i = 0; i < target.length; i++) {
          if (qPath[i] !== target[i]) return false;
        }
        return true;
      });
    });

    // Shuffle en limiteer.
    for (let i = matches.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [matches[i], matches[j]] = [matches[j], matches[i]];
    }
    const picked = matches.slice(0, Math.max(1, Math.min(limit, 50)));

    // Normaliseer naar het frontend-format. Voor open vragen geven we het
    // modelantwoord terug (uit Solution + eventueel exsolution-numeric) plus
    // het R/exams-extype + exsolution + extol, zodat de evaluator kan kiezen
    // tussen numerieke tolerantie-check (extype=num) en tekstuele beoordeling
    // tegen het ShareStats-modelantwoord (Task #67).
    const parseNumberLoose = (raw) => {
      if (raw === null || raw === undefined) return null;
      const s = String(raw).replace(/,/g, '.').trim();
      const m = s.match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    };
    const questions = picked.map(q => {
      const itemType = q.item_type || 'mcq';
      if (itemType === 'open') {
        const meta = (q.metadata && typeof q.metadata === 'object') ? q.metadata : {};
        const extype = String(meta.extype || '').toLowerCase().trim() || undefined;
        const numericSolution = q.correct_answer || '';
        const writtenSolution = q.explanation || '';
        // Bij numerieke vragen houden we het exacte getal apart, zodat de
        // evaluator een echte tolerantie-check kan doen i.p.v. LLM-vergelijking.
        const numericExpected = extype === 'num' ? parseNumberLoose(numericSolution) : null;
        // R/exams `extol` is meestal een absolute tolerantie. Wanneer de
        // metadata een lijst/range bevat, nemen we het grootste positieve
        // verschil als tolerantie — strikt genoeg om vals-positieven te
        // voorkomen en ruim genoeg om afronding op te vangen.
        let numericTolerance = null;
        const extolRaw = meta.extol;
        if (Array.isArray(extolRaw)) {
          const nums = extolRaw.map(parseNumberLoose).filter(n => n !== null && n >= 0);
          if (nums.length > 0) numericTolerance = Math.max(...nums);
        } else if (extolRaw !== undefined && extolRaw !== null && String(extolRaw).trim() !== '') {
          const t = parseNumberLoose(extolRaw);
          if (t !== null && t >= 0) numericTolerance = t;
        }
        // Voor numerieke vragen is `modelAnswer` puur de geschreven uitleg
        // (Solution); het verwachte getal staat al apart in numericExpected.
        // Voor tekst/cloze vallen we terug op de oude samenvoeging zodat de
        // LLM zoveel mogelijk context krijgt.
        const modelAnswer = extype === 'num'
          ? writtenSolution
          : (numericSolution
              ? (writtenSolution ? `${numericSolution}\n\n${writtenSolution}` : numericSolution)
              : writtenSolution);
        return {
          id: `itembank-${q.id}`,
          type: 'open',
          source: 'itembank',
          sharestats_id: q.sharestats_id,
          question: q.question_text,
          modelAnswer,
          explanation: writtenSolution,
          exsection_path: q.exsection_path,
          extype,
          numericExpected: numericExpected ?? undefined,
          numericTolerance: numericTolerance ?? undefined,
        };
      }
      return {
        id: `itembank-${q.id}`,
        type: 'mcq',
        source: 'itembank',
        sharestats_id: q.sharestats_id,
        question: q.question_text,
        options: q.answer_options || {},
        correctAnswer: q.correct_answer,
        explanation: q.explanation || '',
        exsection_path: q.exsection_path,
      };
    });

    return res.json({ questions, total_candidates: matches.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: quiz-prompts ophalen voor de generator/evaluator -------------
// Iedere ingelogde gebruiker mag de actieve quiz-prompts inzien — de UI heeft
// ze nodig zodat generateQuiz/evaluateOpen de juiste persona meesturen.
app.get('/api/quiz/prompts', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: uErr } = await callerClient.auth.getUser();
    if (uErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const names = Object.keys(QUIZ_PROMPT_DEFAULTS);
    const result = { ...QUIZ_PROMPT_DEFAULTS };
    if (promptsHasSection) {
      const { data } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('name, content, is_active')
        .in('name', names);
      for (const row of data || []) {
        if (row.is_active !== false && typeof row.content === 'string' && row.content.trim().length > 0) {
          result[row.name] = row.content;
        }
      }
    }
    return res.json({ prompts: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: per-begrip beschikbaarheid (RAG-docs + ItemBank-vragen) ------
// Geeft per concept terug hoeveel RAG-documenten er in zijn primaire folder
// staan en hoeveel itembank-vragen via mappings overeenkomen. De student-UI
// gebruikt dit om te tonen wat er voor het geselecteerde begrip beschikbaar is.
app.post('/api/quiz/concept-availability', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId, conceptIds = [] } = req.body || {};
  if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
    return res.status(400).json({ error: 'courseId en niet-lege conceptIds vereist' });
  }
  // Cross-course leak voorkomen: alleen leden + admins zien availability voor
  // een cursus.
  const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
  if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
  if (!quizSourcesSchemaReady) {
    return res.json({ availability: {}, schema_ready: false });
  }
  try {
    // 1) Primaire RAG-folders per concept
    const { data: ragRows } = await supabaseAdmin
      .from('concept_rag_sources')
      .select('concept_id, folder_id')
      .eq('course_id', courseId)
      .in('concept_id', conceptIds);
    const folderByConcept = new Map((ragRows || []).map(r => [r.concept_id, r.folder_id]));

    // 2) Document-counts per folder
    const folderIds = [...new Set((ragRows || []).map(r => r.folder_id).filter(Boolean))];
    const docCountByFolder = new Map();
    if (folderIds.length > 0) {
      const { data: docs } = await supabaseAdmin
        .from('documents')
        .select('id, folder_id')
        .in('folder_id', folderIds)
        .eq('bucket', 'rag_sources');
      for (const d of docs || []) {
        docCountByFolder.set(d.folder_id, (docCountByFolder.get(d.folder_id) || 0) + 1);
      }
    }

    // 3) ItemBank-mappings per concept
    const { data: mapRows } = await supabaseAdmin
      .from('concept_itembank_sections')
      .select('concept_id, exsection_path, course_id')
      .in('concept_id', conceptIds)
      .or(`course_id.eq.${courseId},course_id.is.null`);

    // Voor performance: één query met alle sharestats-items, daarna in JS
    // case-insensitief groeperen op concept. Geen exacte-string-prefilter
    // (overlaps()) meer omdat de bank case-varianten kent ("Inferential
    // Statistics" vs "inferential statistics"); we matchen op lower-case.
    let allItems = [];
    let itemsTruncated = false;
    const ITEM_HARD_LIMIT = 5000;
    if ((mapRows || []).length > 0) {
      const { data: items, count } = await supabaseAdmin
        .from('quiz_questions')
        .select('id, exsection_path, item_type', { count: 'exact' })
        .or(itembankSourceOrFilter(courseId))
        .not('exsection_path', 'is', null)
        .limit(ITEM_HARD_LIMIT);
      allItems = items || [];
      if (typeof count === 'number' && count > ITEM_HARD_LIMIT) itemsTruncated = true;
    }

    const normPath = (p) => (Array.isArray(p) ? p : []).map(s => String(s ?? '').toLowerCase().trim());
    const itembankCountByConcept = new Map();
    for (const cid of conceptIds) {
      const conceptMaps = (mapRows || []).filter(r => r.concept_id === cid);
      if (conceptMaps.length === 0) { itembankCountByConcept.set(cid, { total: 0, mcq: 0, open: 0 }); continue; }
      const targets = conceptMaps
        .map(m => normPath(m.exsection_path))
        .filter(p => p.length > 0);
      let total = 0, mcq = 0, open = 0;
      for (const item of allItems) {
        const qPath = normPath(item.exsection_path);
        const match = targets.some(target => {
          if (qPath.length < target.length) return false;
          for (let i = 0; i < target.length; i++) if (qPath[i] !== target[i]) return false;
          return true;
        });
        if (match) {
          total++;
          if (item.item_type === 'open') open++;
          else mcq++;
        }
      }
      itembankCountByConcept.set(cid, { total, mcq, open });
    }

    // 4) Compose result. Wanneer de itembank-prefilter de hard-limit raakte,
    // markeren we per concept dat de count een ondergrens is — zodat de UI
    // dat niet als exact getal presenteert.
    const availability = {};
    for (const cid of conceptIds) {
      const fId = folderByConcept.get(cid) || null;
      const ibCounts = itembankCountByConcept.get(cid) || { total: 0, mcq: 0, open: 0 };
      availability[cid] = {
        primary_folder_id: fId,
        rag_doc_count: fId ? (docCountByFolder.get(fId) || 0) : null,
        itembank_question_count: ibCounts.total,
        itembank_mcq_count: ibCounts.mcq,
        itembank_open_count: ibCounts.open,
        itembank_count_truncated: itemsTruncated,
      };
    }
    return res.json({ availability, schema_ready: true, truncated: itemsTruncated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: primaire RAG-folder-IDs voor concept-set ---------------------
// Wordt gebruikt door de RAG-search om eerst binnen die folders te zoeken.
app.post('/api/quiz/primary-rag-folders', async (req, res) => {
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId, conceptIds = [] } = req.body || {};
  if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
    return res.json({ folderIds: [] });
  }
  // Cross-course leak voorkomen.
  const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
  if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
  if (!quizSourcesSchemaReady) {
    return res.json({ folderIds: [], schema_ready: false });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('concept_rag_sources')
      .select('folder_id')
      .eq('course_id', courseId)
      .in('concept_id', conceptIds);
    if (error) return res.status(500).json({ error: error.message });
    const folderIds = [...new Set((data || []).map(r => r.folder_id).filter(Boolean))];
    return res.json({ folderIds, schema_ready: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: ItemBank-mapping-suggesties via embeddings -------------------
// Voor een gegeven concept (naam + optionele definitie) ranken we alle
// itembank-secties op cosine-similarity en geven we de top-N terug.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function fetchOpenAIEmbeddings(texts) {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: embeddingAuthHeaders(),
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure embeddings error: ${err}`);
  }
  const data = await response.json();
  return (data.data || []).map(d => d.embedding);
}

app.post('/api/admin/itembank-mapping-suggestions', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
  }
  const { conceptName, conceptDefinition, courseId, topN = 3 } = req.body || {};
  if (!conceptName || typeof conceptName !== 'string') {
    return res.status(400).json({ error: 'conceptName is verplicht' });
  }
  if (!courseId || typeof courseId !== 'string') {
    return res.status(400).json({ error: 'courseId is verplicht' });
  }
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  // Bound de werkverzameling om timeouts en grote OpenAI-bills te voorkomen
  // bij onverwacht grote itembanks. 800 unieke secties is ruim voldoende voor
  // een cursus en kost ~1 OpenAI-call.
  const MAX_SECTIONS = 800;
  const ITEM_PAGE_LIMIT = 5000;
  try {
    // 1) Verzamel unieke secties met counts. We pagineren lichtjes om geheugen
    // te beperken: pak max ITEM_PAGE_LIMIT records, deduplate naar pad-key,
    // en cap daarna op MAX_SECTIONS (meest voorkomende paden eerst).
    const { data: rows, error: secErr } = await supabaseAdmin
      .from('quiz_questions')
      .select('exsection_path')
      .or(itembankSourceOrFilter(courseId))
      .not('exsection_path', 'is', null)
      .limit(ITEM_PAGE_LIMIT);
    if (secErr) return res.status(500).json({ error: secErr.message });
    const seen = new Map();
    for (const row of rows || []) {
      const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
      if (path.length === 0) continue;
      const key = path.join(' / ');
      const entry = seen.get(key) || { exsection_path: path, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
    let sections = [...seen.values()];
    let sectionsTruncated = false;
    if (sections.length > MAX_SECTIONS) {
      sections.sort((a, b) => b.count - a.count);
      sections = sections.slice(0, MAX_SECTIONS);
      sectionsTruncated = true;
    }
    if (sections.length === 0) return res.json({ suggestions: [], truncated: false });

    // 2) Bereken embeddings: één voor concept, één voor elke sectielabel
    const conceptText = conceptDefinition
      ? `${conceptName}. ${String(conceptDefinition).slice(0, 600)}`
      : conceptName;
    const sectionTexts = sections.map(s => s.exsection_path.join(' / '));
    const allTexts = [conceptText, ...sectionTexts];

    // OpenAI embeddings in chunks van max 100 om limieten te vermijden
    const embeddings = [];
    const CHUNK = 100;
    for (let i = 0; i < allTexts.length; i += CHUNK) {
      const part = await fetchOpenAIEmbeddings(allTexts.slice(i, i + CHUNK));
      embeddings.push(...part);
    }
    const conceptEmb = embeddings[0];
    const ranked = sections.map((s, idx) => ({
      ...s,
      similarity: cosineSimilarity(conceptEmb, embeddings[1 + idx]),
    }));
    ranked.sort((a, b) => b.similarity - a.similarity);
    return res.json({
      suggestions: ranked.slice(0, Math.max(1, Math.min(topN, 10))),
      truncated: sectionsTruncated,
      candidates_evaluated: sections.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Diagnose-endpoint: per concept tonen welke ShareStats-secties (case-
// insensitief, op substring van begripsnaam + queryExpansion-synoniemen +
// key_points) zouden matchen. Bedoeld om docenten te laten zien waarom een
// begrip leeg blijft in de itembank en om handmatige mapping-keuzes te
// ondersteunen — deterministisch, geen embeddings/LLM-call.
app.post('/api/admin/itembank-mapping-diagnose', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
  }
  const { conceptId, courseId, topN = 5 } = req.body || {};
  if (!conceptId || typeof conceptId !== 'string') {
    return res.status(400).json({ error: 'conceptId is verplicht' });
  }
  if (!courseId || typeof courseId !== 'string') {
    return res.status(400).json({ error: 'courseId is verplicht' });
  }
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  try {
    // 1) Laad begrip (naam + definitie + key_points).
    const { data: concept, error: conceptErr } = await supabaseAdmin
      .from('concepts')
      .select('id, name, definition, key_points')
      .eq('id', conceptId)
      .maybeSingle();
    if (conceptErr) return res.status(500).json({ error: conceptErr.message });
    if (!concept) return res.status(404).json({ error: 'Begrip niet gevonden' });

    // 2) Huidige mapping(s) voor dit begrip in deze cursus.
    let currentMappings = [];
    if (courseId) {
      const { data: mapRows } = await supabaseAdmin
        .from('concept_itembank_sections')
        .select('exsection_path, course_id')
        .eq('concept_id', conceptId)
        .or(`course_id.eq.${courseId},course_id.is.null`);
      currentMappings = (mapRows || [])
        .map(r => Array.isArray(r.exsection_path) ? r.exsection_path : null)
        .filter(p => p && p.length > 0);
    }

    // 3) Bouw zoek-tokens: begripsnaam + synoniemen (NL+EN) + key_points.
    const keyPoints = Array.isArray(concept.key_points)
      ? concept.key_points.filter(kp => typeof kp === 'string' && !kp.startsWith('course_id:') && !kp.startsWith('['))
      : [];
    const expandedNl = expandQuery(concept.name, { definition: concept.definition, keyPoints }, 'nl');
    const expandedEn = expandQuery(concept.name, { definition: concept.definition, keyPoints }, 'en');
    const STOP = new Set(['de','het','een','en','of','in','op','van','met','voor','door','aan','bij','te','dat','dan','als','is','zijn','the','a','an','of','to','in','on','for','and','or','with','by','at','is','are','this','that']);
    const tokens = [...new Set(
      `${expandedNl} ${expandedEn}`
        .toLowerCase()
        .split(/[^a-zà-ÿ0-9-]+/i)
        .map(t => t.trim())
        .filter(t => t.length >= 3 && !STOP.has(t))
    )];

    // 4) Trek alle unieke itembank-secties (cursus-scoped) met counts.
    const { data: rows, error: rowsErr } = await supabaseAdmin
      .from('quiz_questions')
      .select('exsection_path, item_type')
      .or(itembankSourceOrFilter(courseId))
      .not('exsection_path', 'is', null)
      .limit(5000);
    if (rowsErr) return res.status(500).json({ error: rowsErr.message });
    const sectionMap = new Map();
    for (const row of rows || []) {
      const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
      if (path.length === 0) continue;
      const key = path.join(' / ');
      const entry = sectionMap.get(key) || { exsection_path: path, count: 0, mcq_count: 0, open_count: 0 };
      entry.count += 1;
      if (row.item_type === 'open') entry.open_count += 1;
      else entry.mcq_count += 1;
      sectionMap.set(key, entry);
    }
    const sections = [...sectionMap.values()];

    // 5) Score per sectie: aantal unieke tokens dat (substring) voorkomt in
    // de gejoined-lower-case-pad-string. Hits-lijst voor transparantie.
    const ranked = sections.map(s => {
      const haystack = s.exsection_path.join(' / ').toLowerCase();
      const matchedTokens = tokens.filter(tok => haystack.includes(tok));
      return { ...s, matched_tokens: matchedTokens, score: matchedTokens.length };
    })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.count - a.count);

    return res.json({
      concept: { id: concept.id, name: concept.name },
      current_mappings: currentMappings,
      tokens_used: tokens.slice(0, 40),
      tokens_truncated: tokens.length > 40,
      total_sections_scanned: sections.length,
      candidates: ranked.slice(0, Math.max(1, Math.min(topN, 20))),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: automatische bulk-matching begrip ↔ itembank-sectie ---------
// Berekent in één embedding-pass de semantische gelijkenis tussen ELK begrip
// van de cursus en ELKE itembank-sectie, en geeft per begrip de top-N secties
// terug met een vlag of ze boven de drempel liggen. De docent reviewt het
// voorstel in de UI en slaat de geaccepteerde koppelingen op via het bestaande
// itembank-mappings-endpoint. Dit endpoint schrijft zelf NIETS weg (dry-run).
app.post('/api/admin/itembank-bulk-match', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
  }
  const { courseId, threshold = 0.35, topN = 3 } = req.body || {};
  if (!courseId || typeof courseId !== 'string') {
    return res.status(400).json({ error: 'courseId is verplicht' });
  }
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  const MAX_SECTIONS = 800;
  const MAX_CONCEPTS = 400;
  const ITEM_PAGE_LIMIT = 5000;
  const thr = Math.max(0, Math.min(1, Number(threshold) || 0.35));
  const top = Math.max(1, Math.min(Number(topN) || 3, 8));
  try {
    // 1) Begrippen van de cursus (zelfde filter als de admin-UI). Schema-bewust:
    // de kolom concepts.course_id bestaat niet in elke database — vraag haar
    // alleen op wanneer aanwezig (conceptsHasCourseId) en val anders terug op de
    // course_id:<uuid>-markering in key_points + ongetagde globale begrippen.
    const conceptSelect = conceptsHasCourseId
      ? 'id, name, definition, key_points, course_id'
      : 'id, name, definition, key_points';
    const { data: conceptRows, error: cErr } = await supabaseAdmin
      .from('concepts')
      .select(conceptSelect)
      .order('name');
    if (cErr) return res.status(500).json({ error: cErr.message });
    const marker = `course_id:${courseId}`;
    const concepts = (conceptRows || []).filter(c => {
      if (conceptsHasCourseId && c.course_id === courseId) return true;
      if (Array.isArray(c.key_points) && c.key_points.includes(marker)) return true;
      const hasCourseColValue = conceptsHasCourseId && c.course_id;
      const hasKeyPointMarker = Array.isArray(c.key_points) && c.key_points.some(kp => typeof kp === 'string' && kp.startsWith('course_id:'));
      if (!hasCourseColValue && !hasKeyPointMarker) return true;
      return false;
    }).slice(0, MAX_CONCEPTS);
    if (concepts.length === 0) return res.json({ results: [], threshold: thr, sections_evaluated: 0, truncated: false });

    // 2) Huidige mappings voor de cursus (om al-gekoppelde te markeren).
    const { data: mapRows } = await supabaseAdmin
      .from('concept_itembank_sections')
      .select('concept_id, exsection_path, course_id')
      .or(`course_id.eq.${courseId},course_id.is.null`);
    const currentByConcept = new Map();
    for (const m of mapRows || []) {
      if (!Array.isArray(m.exsection_path) || m.exsection_path.length === 0) continue;
      const arr = currentByConcept.get(m.concept_id) || [];
      arr.push(m.exsection_path);
      currentByConcept.set(m.concept_id, arr);
    }

    // 3) Unieke itembank-secties (cursus-scoped) met counts.
    const { data: rows, error: secErr } = await supabaseAdmin
      .from('quiz_questions')
      .select('exsection_path, item_type')
      .or(itembankSourceOrFilter(courseId))
      .not('exsection_path', 'is', null)
      .limit(ITEM_PAGE_LIMIT);
    if (secErr) return res.status(500).json({ error: secErr.message });
    const seen = new Map();
    for (const row of rows || []) {
      const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
      if (path.length === 0) continue;
      const key = path.join(' / ');
      const entry = seen.get(key) || { exsection_path: path, count: 0, mcq_count: 0, open_count: 0 };
      entry.count += 1;
      if (row.item_type === 'open') entry.open_count += 1; else entry.mcq_count += 1;
      seen.set(key, entry);
    }
    let sections = [...seen.values()];
    let truncated = false;
    if (sections.length > MAX_SECTIONS) {
      sections.sort((a, b) => b.count - a.count);
      sections = sections.slice(0, MAX_SECTIONS);
      truncated = true;
    }
    if (sections.length === 0) return res.json({ results: [], threshold: thr, sections_evaluated: 0, truncated: false });

    // 4) Embeddings: één per begrip + één per sectie, in één gebatchte reeks.
    const conceptTexts = concepts.map(c => c.definition
      ? `${c.name}. ${String(c.definition).slice(0, 600)}`
      : c.name);
    const sectionTexts = sections.map(s => s.exsection_path.join(' / '));
    const allTexts = [...conceptTexts, ...sectionTexts];
    const embeddings = [];
    const CHUNK = 100;
    for (let i = 0; i < allTexts.length; i += CHUNK) {
      const part = await fetchOpenAIEmbeddings(allTexts.slice(i, i + CHUNK));
      embeddings.push(...part);
    }
    const conceptEmbs = embeddings.slice(0, concepts.length);
    const sectionEmbs = embeddings.slice(concepts.length);

    // 5) Per begrip: rank secties, neem top-N, markeer boven drempel.
    const results = concepts.map((c, ci) => {
      const ranked = sections.map((s, si) => ({
        exsection_path: s.exsection_path,
        count: s.count,
        mcq_count: s.mcq_count,
        open_count: s.open_count,
        similarity: cosineSimilarity(conceptEmbs[ci], sectionEmbs[si]),
      })).sort((a, b) => b.similarity - a.similarity);
      const current = currentByConcept.get(c.id) || [];
      const currentKeys = new Set(current.map(p => p.join('/')));
      const candidates = ranked.slice(0, top).map(r => ({
        ...r,
        above_threshold: r.similarity >= thr,
        already_linked: currentKeys.has(r.exsection_path.join('/')),
      }));
      return {
        conceptId: c.id,
        conceptName: c.name,
        currentMappings: current,
        candidates,
      };
    });
    return res.json({ results, threshold: thr, sections_evaluated: sections.length, truncated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint: CSV-import van itembank-vragen (bron-agnostisch) -------------
// Laat docenten een eigen vragenbank als CSV aanleveren. De items komen met
// source='csv_import' in quiz_questions, met een exsection_path dat met het
// cursuslabel is genamespaced zodat secties niet botsen met die van andere
// cursussen. Daarna zijn ze koppelbaar (incl. bulk-match) en komen ze via de
// mix in studentquizzes.
app.post('/api/admin/itembank/import-csv', async (req, res) => {
  const auth = await requireAdminOrDocent(req, res);
  if (!auth) return;
  if (!quizSourcesSchemaReady) {
    return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
  }
  const { courseId, csvText, courseLabel } = req.body || {};
  if (!courseId || typeof courseId !== 'string') {
    return res.status(400).json({ error: 'courseId is verplicht' });
  }
  if (typeof csvText !== 'string' || csvText.trim().length === 0) {
    return res.status(400).json({ error: 'csvText is verplicht' });
  }
  if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
    return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
  }
  // Begrens omvang om geheugen/timeouts te beschermen (~2 MB CSV).
  if (csvText.length > 2_000_000) {
    return res.status(413).json({ error: 'CSV te groot (max ~2 MB)' });
  }
  try {
    const { records, errors, totalRows } = parseItembankCsv(csvText);
    if (records.length === 0) {
      return res.status(400).json({
        error: 'Geen geldige rijen gevonden in de CSV.',
        errors: errors.slice(0, 50),
        totalRows,
      });
    }
    const label = (typeof courseLabel === 'string' && courseLabel.trim()) ? courseLabel.trim().slice(0, 60) : null;
    const rows = records.map(r => csvRowToQuizQuestion(r, {
      sourceLabel: 'csv_import',
      courseLabel: label,
      courseId,
      createdBy: auth.user.id,
    }));
    let imported = 0;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const { error } = await supabaseAdmin.from('quiz_questions').insert(slice);
      if (error) return res.status(500).json({ error: error.message, imported });
      imported += slice.length;
    }
    return res.json({
      imported,
      skipped: errors.length,
      errors: errors.slice(0, 50),
      totalRows,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Task #78: Projectruimte MVP — endpoints
// =============================================================================

// Helper: identificeer de huidige user via Authorization-header.
async function authUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return { error: { status: 401, body: { error: 'Authorization header vereist' } } };
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await callerClient.auth.getUser();
  if (error || !user) return { error: { status: 401, body: { error: 'Niet geauthenticeerd' } } };
  return { user };
}

async function isGroupMember(groupId, userId) {
  const { data } = await supabaseAdmin
    .from('project_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

function genInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Toegestane RAG-folder-ids voor een cursus. Geeft `[]` terug als de cursus
// geen folders gekoppeld heeft — searchChunksServerSide retourneert dan geen
// resultaten. Geeft NOOIT `null` terug; null betekent "alle folders" en
// veroorzaakt een cross-course leak.
async function courseRagFolderIds(courseId) {
  if (!courseId) return [];
  const { data: assignments } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('folder_id')
    .eq('course_id', courseId);
  const assignedFolderIds = (assignments || []).map(a => a.folder_id);
  if (assignedFolderIds.length === 0) return [];
  const { data: ragFolders } = await supabaseAdmin
    .from('document_folders')
    .select('id')
    .in('id', assignedFolderIds)
    .eq('folder_type', 'rag_sources');
  return (ragFolders || []).map(f => f.id);
}

// Fallback-helper voor de persona-chat route: zet een course_persona om naar
// een project_persona als het project nog geen persona met die naam heeft.
// Maakt een verse, onafhankelijke kopie (source_persona_id = null) conform het
// sjablonen-model. Deduplicatie op naam is bewust: in dit chat-pad is dezelfde
// naam voldoende als sleutel — bij eventuele naambotsingen wordt de bestaande
// project_persona hergebruikt, zodat studenten hun gesprekshistorie behouden.
async function ensureProjectPersonaFromCourse(projectId, coursePersonaId) {
  const { data: cp } = await supabaseAdmin
    .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
  if (!cp) return null;
  // Dedupliceer op naam (source_persona_id wordt niet meer als FK gebruikt).
  const { data: existing } = await supabaseAdmin
    .from('project_personas')
    .select('*')
    .eq('project_id', projectId)
    .eq('name', cp.name)
    .maybeSingle();
  if (existing) return existing;
  const { data: existingCount } = await supabaseAdmin
    .from('project_personas').select('id').eq('project_id', projectId);
  const sortOrder = (existingCount?.length || 0);
  const { data: inserted, error } = await supabaseAdmin
    .from('project_personas')
    .insert({
      project_id: projectId,
      source_persona_id: null,
      name: cp.name,
      avatar_emoji: cp.avatar_emoji,
      system_prompt: cp.system_prompt,
      rag_enabled: cp.rag_enabled,
      rag_folder_ids: cp.rag_folder_ids,
      visible_from_phase: cp.visible_from_phase,
      sort_order: sortOrder,
      persona_type: cp.persona_type || 'conversational',
    })
    .select('*').single();
  if (error) {
    // Mogelijk race-condition: lees opnieuw op naam.
    const { data: retry } = await supabaseAdmin
      .from('project_personas')
      .select('*')
      .eq('project_id', projectId)
      .eq('name', cp.name)
      .maybeSingle();
    return retry || null;
  }
  return inserted;
}

// Bepaalt of de huidige user toegang heeft tot een project. Toegang =
// staff (admin/docent/superuser), of lid van een groep in dit project, of
// student met access tot project.course_id (gebruikt userHasCourseAccess).
async function userHasProjectAccess(user, profile, project) {
  if (!project) return false;
  const isStaff = await isStaffForCourse(user, profile, project.course_id);
  if (isStaff) return true;
  if (project.course_id) {
    if (await userHasCourseAccess(user, profile, project.course_id)) return true;
  }
  // Fallback: lid van enige groep in dit project.
  const { data: m } = await supabaseAdmin
    .from('project_group_members')
    .select('group_id, project_groups!inner(project_id)')
    .eq('user_id', user.id)
    .eq('project_groups.project_id', project.id)
    .limit(1);
  return !!(m && m.length > 0);
}

// POST /api/projects/groups — maak een nieuwe groep voor een project. De
// initiator wordt direct als 'owner' lid. Voor solo-werk: groep van 1.
app.post('/api/projects/groups', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, name } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId is vereist' });

  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, title, course_id, allow_self_signup, status').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    if (project.status === 'archived') return res.status(400).json({ error: 'Dit project is gearchiveerd' });

    // Autorisatie: alleen leden van de cursus (of staff) mogen een groep
    // aanmaken. Voorkomt dat een willekeurige ingelogde user buiten de cursus
    // groepen aanmaakt op andermans projecten.
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    if (!isStaff) {
      if (!project.course_id || !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
        return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
      }
      if (project.allow_self_signup === false) {
        return res.status(403).json({ error: 'Self-signup voor dit project staat uit' });
      }
    }

    const inviteCode = genInviteCode();
    const { data: group, error: gErr } = await supabaseAdmin
      .from('project_groups')
      .insert({
        project_id: projectId,
        name: name || `Groep van ${(auth.user.email || 'student').split('@')[0]}`,
        invite_code: inviteCode,
        created_by: auth.user.id,
      })
      .select('*')
      .single();
    if (gErr) return res.status(500).json({ error: gErr.message });

    const { error: mErr } = await supabaseAdmin
      .from('project_group_members')
      .insert({ group_id: group.id, user_id: auth.user.id, role: 'owner' });
    if (mErr) return res.status(500).json({ error: mErr.message });

    // Maak een sessie-record aan voor ALLE gebruikers (ook admin/docent die
    // het project als student gebruiken). Client-side inserts kunnen stil
    // mislukken door RLS — hier gebruiken we supabaseAdmin.
    // onConflict matcht de bestaande unique-constraint (project_id, student_id).
    await supabaseAdmin.from('student_project_sessions').upsert({
      student_id: auth.user.id,
      project_id: projectId,
      group_id: group.id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }, { onConflict: 'project_id,student_id' });

    return res.json({ group });
  } catch (err) {
    console.error('[projects/groups POST]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/groups/join — sluit aan bij een groep via invite-code.
app.post('/api/projects/groups/join', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'inviteCode is vereist' });

  try {
    const { data: group } = await supabaseAdmin
      .from('project_groups')
      .select('id, project_id, status')
      .eq('invite_code', String(inviteCode).toUpperCase())
      .maybeSingle();
    if (!group) return res.status(404).json({ error: 'Geen groep gevonden bij deze code' });
    if (group.status === 'finalized') {
      return res.status(400).json({ error: 'Deze groep is al afgesloten' });
    }

    // Autorisatie: alleen users met toegang tot de cursus van dit project
    // mogen aansluiten. Een geldige invite-code is niet voldoende — anders kan
    // een gelekte code een buitenstaander toegang tot de chat geven.
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', group.project_id).maybeSingle();
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project?.course_id);
    if (!isStaff && project?.course_id && !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
      return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
    }

    // Idempotent — als je al lid bent, gewoon de groep teruggeven. Race-safe:
    // bij gelijktijdige join kan de unique-constraint (group_id, user_id) een
    // 23505-fout geven; behandel die als succes.
    const { data: existing } = await supabaseAdmin
      .from('project_group_members')
      .select('id').eq('group_id', group.id).eq('user_id', auth.user.id).maybeSingle();
    if (!existing) {
      const { error: mErr } = await supabaseAdmin
        .from('project_group_members')
        .insert({ group_id: group.id, user_id: auth.user.id, role: 'member' });
      if (mErr && mErr.code !== '23505' && !/duplicate key/i.test(mErr.message || '')) {
        return res.status(500).json({ error: mErr.message });
      }
    }

    // Maak (of herstel) een sessie-record voor ALLE gebruikers zodat de
    // overzichtspagina "Ga verder" kan tonen.
    // onConflict matcht de bestaande unique-constraint (project_id, student_id).
    await supabaseAdmin.from('student_project_sessions').upsert({
      student_id: auth.user.id,
      project_id: group.project_id,
      group_id: group.id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }, { onConflict: 'project_id,student_id' });

    return res.json({ group });
  } catch (err) {
    console.error('[projects/groups/join]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/room?groupId=... — alle data die de
// projectruimte nodig heeft in één call: project, groep, leden, personas
// (project-eigen, anders course-bibliotheek), checkpoints, en thread-ids per
// persona (worden lazy aangemaakt).
app.get('/api/projects/:projectId/room', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  const { groupId } = req.query;

  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('*').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

    // Authorisatie: ook zonder groupId moeten we project-toegang afdwingen
    // (anders lekken we projectinhoud + persona-bibliotheek aan iedere ingelogde
    // user, ongeacht cursus-toegang).
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    if (!isStaff && !(await userHasProjectAccess(auth.user, profile, project))) {
      return res.status(403).json({ error: 'Geen toegang tot dit project' });
    }

    let group = null;
    let members = [];
    if (groupId) {
      const { data: g } = await supabaseAdmin
        .from('project_groups').select('*').eq('id', groupId).maybeSingle();
      if (!g) return res.status(404).json({ error: 'Groep niet gevonden' });
      if (g.project_id !== projectId) return res.status(400).json({ error: 'Groep hoort niet bij dit project' });

      const isMember = await isGroupMember(g.id, auth.user.id);
      if (!isMember && !isStaff) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      group = g;

      const { data: m } = await supabaseAdmin
        .from('project_group_members')
        .select('id, user_id, role, joined_at, profiles(id, full_name, email)')
        .eq('group_id', g.id);
      members = m || [];
    }

    // Personas: project-eigen heeft voorrang; anders bibliotheek van de cursus.
    // Studenten zien evaluator-persona's NIET; staff wel (zodat ze in de
    // beheer-flow zichtbaar blijven en de evaluate-knop in de UI verschijnt).
    let personas = [];
    let evaluatorCount = 0;
    const { data: pp } = await supabaseAdmin
      .from('project_personas').select('*').eq('project_id', projectId).order('sort_order');
    if (pp && pp.length > 0) {
      // Alleen project-eigen evaluators tellen mee voor hasEvaluator zodat de
      // UI-knop precies overeenkomt met wat /evaluate kan beoordelen
      // (course-fallback-personas zijn nooit evaluator-bronnen).
      evaluatorCount = pp.filter(p => p.persona_type === 'evaluator').length;
      const filtered = isStaff ? pp : pp.filter(p => p.persona_type !== 'evaluator');
      personas = filtered.map(p => ({ ...p, _source: 'project' }));
    } else if (project.course_id) {
      const { data: cp } = await supabaseAdmin
        .from('course_personas').select('*').eq('course_id', project.course_id).order('is_default', { ascending: false });
      const list = cp || [];
      // evaluatorCount blijft 0: course-fallback-personas worden niet door
      // /evaluate gebruikt — geen UI-knop tonen.
      const filtered = isStaff ? list : list.filter(p => p.persona_type !== 'evaluator');
      personas = filtered.map(p => ({ ...p, _source: 'course' }));
    }
    // Default Consultant als er nog niets is.
    if (personas.length === 0) {
      personas = [{
        id: '__default__',
        name: 'Consultant',
        avatar_emoji: '🧑‍🏫',
        system_prompt: 'Je bent een rustige onderzoeks-consultant voor een groep VU-studenten epi/biostat. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".',
        rag_enabled: true,
        rag_folder_ids: [],
        _source: 'default',
      }];
    }

    let checkpoints = [];
    if (group) {
      const { data: cps } = await supabaseAdmin
        .from('group_checkpoints').select('*').eq('group_id', group.id).order('created_at', { ascending: false });
      checkpoints = cps || [];
    }

    // Project-brede docent-documenten (read-only voor studenten).
    // Studenten zien alleen bestanden die is_visible_to_students = true hebben.
    let pdQuery = supabaseAdmin
      .from('project_documents')
      .select('id, filename, byte_size, mime_type, document_ref_id, is_visible_to_students, uploaded_by, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (!isStaff) pdQuery = pdQuery.eq('is_visible_to_students', true);
    const { data: projectDocs } = await pdQuery;

    // Task #166: minimale evaluator-info voor non-staff zodat de
    // document-review UI per upload de avatars + "Vraag oordeel aan"-knop kan
    // tonen, zonder de evaluators door de persona-dropdown te leaken.
    let evaluators = [];
    {
      const { data: evRows } = await supabaseAdmin
        .from('project_personas')
        .select('id, name, avatar_emoji, persona_type')
        .eq('project_id', projectId)
        .eq('persona_type', 'evaluator')
        .order('sort_order');
      const evIds = (evRows || []).map(p => p.id);
      // Task #253: voor studenten zichtbaar gemaakte rubrics per evaluator.
      // Staff ziet ook alle rubrics (incl. niet-zichtbare) met hun status.
      const rubricsByPersona = new Map();
      if (evIds.length > 0) {
        let rq = supabaseAdmin
          .from('project_persona_documents')
          .select('id, persona_id, filename, byte_size, is_hidden_rubric, visible_to_students, created_at')
          .eq('project_id', projectId).in('persona_id', evIds)
          .eq('is_hidden_rubric', true);
        if (!isStaff) rq = rq.eq('visible_to_students', true);
        let { data: rubricRows, error: rErr } = await rq.order('created_at', { ascending: false });
        // Defensief: oude DB zonder visible_to_students-kolom.
        if (rErr && (rErr.code === '42703' || /visible_to_students/i.test(rErr.message || ''))) {
          if (isStaff) {
            ({ data: rubricRows } = await supabaseAdmin
              .from('project_persona_documents')
              .select('id, persona_id, filename, byte_size, is_hidden_rubric, created_at')
              .eq('project_id', projectId).in('persona_id', evIds)
              .eq('is_hidden_rubric', true)
              .order('created_at', { ascending: false }));
          } else {
            rubricRows = [];
          }
        }
        (rubricRows || []).forEach(d => {
          const list = rubricsByPersona.get(d.persona_id) || [];
          list.push({
            id: d.id, filename: d.filename, byte_size: d.byte_size,
            visible_to_students: d.visible_to_students === true,
          });
          rubricsByPersona.set(d.persona_id, list);
        });
      }
      evaluators = (evRows || []).map(p => ({
        id: p.id, name: p.name, avatar_emoji: p.avatar_emoji,
        rubrics: rubricsByPersona.get(p.id) || [],
      }));
    }

    // Task #252: raadpleeglimiet per project-persona voor deze groep. Lui
    // worden stille open threads eerst afgerond (op basis van auto_close_hours).
    let consultations = [];
    if (group) {
      const lang = normalizeLang(req.query.lang);
      const projectPersonas = personas.filter(p => p._source === 'project');
      // Lui auto-close per persona met een ingesteld venster.
      for (const p of projectPersonas) {
        if (conNormalizeAutoCloseHours(p.auto_close_hours) === null) continue;
        try {
          await autoCloseStaleThreads({
            groupId: group.id, personaId: p.id,
            autoCloseHours: p.auto_close_hours,
            closedBy: auth.user.id, lang,
          });
        } catch (e) {
          console.warn('[room] auto-close mislukte:', e.message);
        }
      }
      // Verbruik (threads, open + gesloten) per persona tellen.
      const { data: allThreads } = await supabaseAdmin
        .from('group_persona_threads')
        .select('persona_id, closed_at')
        .eq('group_id', group.id);
      const usedByPersona = new Map();
      const openByPersona = new Set();
      (allThreads || []).forEach(t => {
        usedByPersona.set(t.persona_id, (usedByPersona.get(t.persona_id) || 0) + 1);
        if (!t.closed_at) openByPersona.add(t.persona_id);
      });
      // Extra toekenningen per persona (defensief tegen ontbrekende tabel).
      const extraByPersona = new Map();
      const { data: grants, error: grantErr } = await supabaseAdmin
        .from('project_persona_consultation_grants')
        .select('persona_id, extra_consultations')
        .eq('project_id', projectId).eq('group_id', group.id);
      if (!grantErr) {
        (grants || []).forEach(g => extraByPersona.set(g.persona_id, conNormalizeExtra(g.extra_consultations)));
      }
      consultations = projectPersonas.map(p => {
        const used = usedByPersona.get(p.id) || 0;
        const extra = extraByPersona.get(p.id) || 0;
        const limit = conComputeEffectiveLimit(p.max_consultations, extra);
        return {
          personaId: p.id,
          used,
          extra,
          baseLimit: conNormalizeMax(p.max_consultations),
          limit,
          remaining: conComputeRemaining(used, limit),
          // "blocked" = er kan geen NIEUWE raadpleging gestart worden.
          blocked: conIsBlocked(used, limit),
          hasOpenThread: openByPersona.has(p.id),
          autoCloseHours: conNormalizeAutoCloseHours(p.auto_close_hours),
        };
      });
    }

    return res.json({
      project, group, members, personas, checkpoints,
      projectDocuments: projectDocs || [],
      evaluators,
      hasEvaluator: evaluatorCount > 0,
      consultations,
    });
  } catch (err) {
    console.error('[projects/:id/room]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/persona-chat — stuur een bericht naar een persona binnen
// een groep. Server zoekt/maakt thread, slaat user-bericht op, roept OpenAI aan
// (met optionele RAG via project.course_id en persona.rag_folder_ids), slaat
// assistant-antwoord op, en geeft beide terug.
app.post('/api/projects/persona-chat', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId, personaId, message, lang = 'nl' } = req.body || {};
  if (!groupId || !personaId || !message) {
    return res.status(400).json({ error: 'groupId, personaId, message vereist' });
  }

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }

    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', group.project_id).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

    // Persona ophalen — moet uiteindelijk een project_persona zijn (FK op
    // group_persona_threads). Wanneer een course_persona-id binnenkomt,
    // kopiëren we hem eerst naar dit project. '__default__' blijft uniek
    // en krijgt nooit een thread.
    let persona = null;
    if (personaId === '__default__') {
      persona = {
        id: '__default__',
        name: 'Consultant',
        system_prompt: 'Je bent een rustige onderzoeks-consultant voor een groep VU-studenten epi/biostat. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".',
        rag_enabled: true,
        rag_folder_ids: [],
      };
    } else {
      // Eerst proberen als project_persona binnen DIT project.
      const { data: pp } = await supabaseAdmin
        .from('project_personas').select('*')
        .eq('id', personaId).eq('project_id', project.id).maybeSingle();
      if (pp) {
        persona = pp;
      } else {
        // Fallback: course-persona; kopieer naar project en gebruik kopie.
        const { data: cp } = await supabaseAdmin
          .from('course_personas').select('*').eq('id', personaId).maybeSingle();
        if (cp && project.course_id && cp.course_id === project.course_id) {
          persona = await ensureProjectPersonaFromCourse(project.id, cp.id);
        }
      }
    }
    if (!persona) return res.status(404).json({ error: 'Persona niet gevonden of niet in dit project' });
    // Evaluator-persona's mogen niet door studenten worden aangesproken in
    // de gewone chat — die worden alleen via /evaluate aangeroepen.
    if (persona.persona_type === 'evaluator') {
      return res.status(403).json({ error: 'Deze persona is een beoordelaar en kan niet worden aangesproken via de chat.' });
    }

    // Task #167: relatie-staat ophalen vóór alles wat schrijft of LLM-calls
    // doet. Bij score ≤ -8 blokkeren we nieuwe chat-turns met een vaste
    // melding en slaan we niets op (geen thread-creatie, geen user-bericht).
    let relationship = { score: 0, history: [] };
    if (persona.id !== '__default__') {
      try {
        relationship = await loadRelationship(project.id, groupId, persona.id);
      } catch (e) {
        console.warn('[persona-chat] relatie laden mislukte:', e.message);
      }
      if (relIsBlocked(relationship.score)) {
        return res.json({
          reply: relBlockedMessage(lang),
          ragSources: [],
          threadId: null,
          relationshipBlocked: true,
          relationship: {
            score: relationship.score,
            bucket: relScoreToBucket(relationship.score),
            label: relScoreToLabel(relationship.score, lang),
          },
        });
      }
    }

    // Thread ophalen of aanmaken (alleen voor echte persona's met uuid).
    let threadId = null;
    let consultation = null;
    if (persona.id !== '__default__') {
      // Task #252: lui stille open thread eerst afronden (op basis van
      // auto_close_hours). Zo telt voortzetten na het venster als een nieuwe
      // raadpleging en wordt de limiet correct gehandhaafd.
      try {
        await autoCloseStaleThreads({
          groupId, personaId: persona.id,
          autoCloseHours: persona.auto_close_hours,
          closedBy: auth.user.id, lang,
        });
      } catch (e) {
        console.warn('[persona-chat] auto-close mislukte:', e.message);
      }

      const { data: existingThread } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id').eq('group_id', groupId).eq('persona_id', persona.id).is('closed_at', null).maybeSingle();
      if (existingThread) {
        threadId = existingThread.id;
      } else {
        // Nieuwe raadpleging → limiet handhaven. Effectieve limiet =
        // persona.max_consultations + per-groep toegekende extra. null = onbeperkt.
        let used = 0;
        let extra = 0;
        try {
          // group_persona_threads is een kerntabel die altijd bestaat; een
          // telfout is dus transient. Fail CLOSED zodat de limiet niet stil
          // wordt omzeild bij een tijdelijke DB-fout.
          used = await countConsultations(groupId, persona.id);
        } catch (e) {
          console.error('[persona-chat] raadpleging tellen mislukte:', e.message);
          return res.status(503).json({
            error: 'Raadpleeglimiet kon niet worden gecontroleerd. Probeer het zo opnieuw.',
          });
        }
        try {
          // Extra grants verhogen de limiet alléén; bij twijfel 0 = strenger =
          // veilig (en ontbrekende tabel levert intern al 0 op).
          extra = await loadConsultationGrant(project.id, groupId, persona.id);
        } catch (e) {
          console.warn('[persona-chat] extra raadplegingen laden mislukte:', e.message);
        }
        const effLimit = conComputeEffectiveLimit(persona.max_consultations, extra);
        if (conIsBlocked(used, effLimit)) {
          return res.json({
            reply: conLimitMessage(lang, effLimit),
            ragSources: [],
            threadId: null,
            consultationLimitReached: true,
            consultation: { used, limit: effLimit, remaining: 0 },
          });
        }
        const { data: newThread, error: tErr } = await supabaseAdmin
          .from('group_persona_threads')
          .insert({ group_id: groupId, persona_id: persona.id })
          .select('id').single();
        if (tErr) return res.status(500).json({ error: tErr.message });
        threadId = newThread.id;
        const newUsed = used + 1;
        consultation = {
          used: newUsed,
          limit: effLimit,
          remaining: conComputeRemaining(newUsed, effLimit),
        };
      }
    }

    // Vorige berichten ophalen voor context.
    let history = [];
    if (threadId) {
      const { data: prev } = await supabaseAdmin
        .from('group_persona_messages')
        .select('role, content')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
        .limit(20);
      history = prev || [];
    }

    // User-bericht opslaan.
    if (threadId) {
      await supabaseAdmin.from('group_persona_messages').insert({
        thread_id: threadId,
        user_id: auth.user.id,
        role: 'user',
        content: message,
      });
    }

    // RAG: chunks zoeken (alleen als persona.rag_enabled). We scopen ALTIJD
    // op de cursusfolders — anders zou een persona zonder rag_folder_ids
    // (`null`) feitelijk over alle cursussen heen kunnen zoeken.
    let context = '';
    let ragSources = [];
    if (persona.rag_enabled) {
      const ragSettings = await loadRagSettings(project?.course_id || null);
      const cfg = ragSettings.project;
      const courseFolders = await courseRagFolderIds(project?.course_id || null);
      let folderIds;
      if (Array.isArray(persona.rag_folder_ids) && persona.rag_folder_ids.length > 0) {
        // Persona-folders intersecten met cursusfolders zodat een verkeerd
        // ingestelde persona nooit buiten de cursus-scope kan zoeken.
        const allowed = new Set(courseFolders);
        folderIds = persona.rag_folder_ids.filter(id => allowed.has(id));
      } else {
        folderIds = courseFolders;
      }
      const { matched } = await searchChunksServerSide(
        message, cfg.similarity_threshold, cfg.match_count, folderIds,
        { enabled: cfg.query_expansion_enabled }, lang
      );
      if (matched && matched.length > 0) {
        context = matched.map((c, i) => `[Bron ${i + 1}] ${c.content}`).join('\n\n');
        ragSources = matched.map(c => ({
          documentId: c.document_id,
          similarity: c.similarity,
          excerpt: (c.content || '').slice(0, 200),
        }));
      }
    }

    // Geüploade documenten voor deze persona ophalen — uitsluitend van de
    // huidige groep, zodat parallelle groepen elkaars uploads niet mengen.
    let uploadedContext = '';
    if (persona.id !== '__default__') {
      const { data: docs } = await supabaseAdmin
        .from('project_persona_documents')
        .select('filename, content_text')
        .eq('project_id', project.id).eq('persona_id', persona.id).eq('group_id', groupId)
        .order('created_at', { ascending: true })
        .limit(10);
      if (docs && docs.length > 0) {
        // Beperk per-doc tot ~6k tekens om context-window niet te overschrijden.
        uploadedContext = docs.map(d =>
          `[Document: ${d.filename}]\n${(d.content_text || '').slice(0, 6000)}`
        ).join('\n\n');
      }
    }

    // Project-brede docent-uploads (zichtbaar voor alle groepen + alle persona's).
    let projectDocContext = '';
    {
      const { data: pdocs } = await supabaseAdmin
        .from('project_documents')
        .select('filename, content_text')
        .eq('project_id', project.id)
        .eq('is_visible_to_students', true)
        .not('content_text', 'is', null)
        .order('created_at', { ascending: true })
        .limit(10);
      if (pdocs && pdocs.length > 0) {
        projectDocContext = pdocs.map(d =>
          `[Projectdocument: ${d.filename}]\n${(d.content_text || '').slice(0, 6000)}`
        ).join('\n\n');
      }
    }

    // Eerdere gemaakte afspraken ophalen uit afgesloten gesprekken met dezelfde persona.
    let priorAgreements = [];
    if (persona.id !== '__default__') {
      const { data: closedThreads } = await supabaseAdmin
        .from('group_persona_threads')
        .select('agreements, closed_at')
        .eq('group_id', groupId)
        .eq('persona_id', persona.id)
        .not('closed_at', 'is', null)
        .order('closed_at', { ascending: false })
        .limit(3);
      priorAgreements = (closedThreads || []).flatMap(t => t.agreements || []).filter(Boolean);
    }

    const agreementsBlock = priorAgreements.length > 0
      ? `\n\nGemaakte afspraken in eerdere gesprekken:\n${priorAgreements.map(a => `- ${a}`).join('\n')}`
      : '';
    const ragBlock = context ? `\n\nContext uit cursusmateriaal:\n${context}` : '';
    const docBlock = uploadedContext ? `\n\nGeüploade documenten van de groep:\n${uploadedContext}` : '';
    const projectDocBlock = projectDocContext ? `\n\nProjectmateriaal van de docent:\n${projectDocContext}` : '';
    const langSuffix = buildLanguageInstruction(lang);
    // Task #167: relatie-blok altijd injecteren voor echte persona's, ook bij
    // score 0 — zo blijft de instructie consistent en weet de persona dat de
    // verstandhouding gewogen wordt.
    const relationshipBlock = persona.id !== '__default__'
      ? relBuildPromptBlock(relationship.score, relationship.history, lang, 3)
      : '';
    const systemContent = `${persona.system_prompt}${relationshipBlock}${agreementsBlock}${ragBlock}${projectDocBlock}${docBlock}${langSuffix}`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    const chatResp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemContent },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ],
      ...chatModelParams({ temperature: 0.7, maxTokens: 700 }),
    });
    if (!chatResp.ok) {
      const txt = await chatResp.text();
      return res.status(502).json({ error: `Taalmodel-fout (${chatResp.status})`, detail: txt.slice(0, 500) });
    }
    const chatData = await chatResp.json();
    const reply = chatData.choices?.[0]?.message?.content || '(Geen antwoord)';

    if (threadId) {
      await supabaseAdmin.from('group_persona_messages').insert({
        thread_id: threadId,
        role: 'assistant',
        content: reply,
        rag_sources: ragSources,
      });
    }

    return res.json({ reply, ragSources, threadId, consultation });
  } catch (err) {
    console.error('[projects/persona-chat]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/persona-thread?groupId=...&personaId=... — bestaande
// berichten van een persona-thread.
app.get('/api/projects/persona-thread', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId, personaId } = req.query;
  if (!groupId || !personaId) return res.status(400).json({ error: 'groupId en personaId vereist' });

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang' });
    }
    if (personaId === '__default__') return res.json({ messages: [], threadId: null });
    const { data: thread } = await supabaseAdmin
      .from('group_persona_threads').select('id, closed_at')
      .eq('group_id', groupId).eq('persona_id', personaId).is('closed_at', null).maybeSingle();
    if (!thread) return res.json({ messages: [], threadId: null });
    const { data: msgs } = await supabaseAdmin
      .from('group_persona_messages')
      .select('id, role, content, rag_sources, created_at, user_id')
      .eq('thread_id', thread.id).order('created_at', { ascending: true });
    return res.json({ messages: msgs || [], threadId: thread.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/groups/:groupId/threads/:threadId/close-preview
// Genereert een AI-samenvatting (topics + agreements) zonder te schrijven naar de DB.
app.post('/api/projects/groups/:groupId/threads/:threadId/close-preview', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId, threadId } = req.params;
  const lang = normalizeLang(req.body?.lang);

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }
    const { data: thread } = await supabaseAdmin
      .from('group_persona_threads')
      .select('id, group_id, closed_at')
      .eq('id', threadId).eq('group_id', groupId).is('closed_at', null).maybeSingle();
    if (!thread) return res.status(404).json({ error: 'Thread niet gevonden of al afgesloten' });

    const { data: msgs } = await supabaseAdmin
      .from('group_persona_messages')
      .select('role, content')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    const allMsgs = msgs || [];
    // Te weinig berichten: lege neerslag teruggeven zodat afsluiten altijd werkt.
    if (allMsgs.length < 2) {
      return res.json({ topics: [], agreements: [] });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

    const conversationText = allMsgs
      .map(m => `${m.role === 'user' ? 'Student' : 'Persona'}: ${(m.content || '').slice(0, 2000)}`)
      .join('\n').slice(0, 12000);

    const msgCount = allMsgs.filter(m => m.role === 'user').length;
    const topicsInstruction = lang !== 'nl'
      ? (msgCount <= 3 ? '2-3 short topics' : msgCount <= 8 ? '3-5 topics' : '5-8 topics')
      : (msgCount <= 3 ? '2-3 korte onderwerpen' : msgCount <= 8 ? '3-5 onderwerpen' : '5-8 onderwerpen');

    const langInstruction = lang === 'nl'
      ? 'Schrijf in het Nederlands.'
      : `Write everything in ${languageEnglishName(lang)}. Keep every JSON property name exactly as written in the structure above (do not translate the keys); only the string values may be in ${languageEnglishName(lang)}.`;
    const prompt = lang !== 'nl'
      ? `You are a minute-taker. Analyse the following conversation between a student and an AI persona.\n\nRespond ONLY with valid JSON in this structure:\n{\n  "topics": [...],\n  "agreements": [...]\n}\n\n- "topics": array of ${topicsInstruction}. Each item is one discussed topic (concise, max 1 sentence).\n- "agreements": array of 0 or more strings. Only concrete agreements or commitments. Leave empty if none.\n\n${langInstruction} No markdown outside the JSON, no explanation.\n\nConversation:\n${conversationText}`
      : `Je bent een notulist. Analyseer het volgende gesprek tussen een student en een AI-persona.\n\nGeef je antwoord UITSLUITEND als geldige JSON met deze structuur:\n{\n  "topics": [...],\n  "agreements": [...]\n}\n\n- "topics": array van ${topicsInstruction}. Elk item is één besproken onderwerp (bondig, maximaal 1 zin).\n- "agreements": array van 0 of meer strings. Alleen concrete afspraken of toezeggingen. Laat leeg als er geen zijn.\n\n${langInstruction} Geen markdown buiten de JSON, geen uitleg.\n\nGesprek:\n${conversationText}`;

    let topics = [];
    let agreements = [];
    try {
      const chatResp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        ...chatModelParams({ temperature: 0.2, maxTokens: 600 }),
        response_format: { type: 'json_object' },
      });
      if (chatResp.ok) {
        const raw = ((await chatResp.json()).choices?.[0]?.message?.content || '{}').trim();
        const parsed = JSON.parse(raw);
        topics = Array.isArray(parsed.topics) ? parsed.topics.filter(t => typeof t === 'string' && t.trim()) : [];
        agreements = Array.isArray(parsed.agreements) ? parsed.agreements.filter(a => typeof a === 'string' && a.trim()) : [];
      }
    } catch (e) {
      console.error('[close-preview] LLM/parse fout:', e.message);
    }
    // Fallback als het model geen bruikbare output geeft.
    if (topics.length === 0) {
      topics = allMsgs.filter(m => m.role === 'user')
        .map(m => (m.content || '').slice(0, 100))
        .filter(Boolean).slice(0, 3);
    }
    return res.json({ topics, agreements });
  } catch (err) {
    console.error('[threads/close-preview]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/groups/:groupId/threads/:threadId/close
// Genereert server-side de AI-samenvatting en markeert de thread als afgesloten.
// Accepteert GEEN topics/agreements van de client — de server is de enige bron.
//
// Task #171 / Fase 3 — Cue-emissie: bij afsluiten vraagt de server in
// hetzelfde JSON-antwoord ook één `relationship_delta` (-2..+2) +
// `relationship_reason` op basis van de docent-cue-tabel in de
// system_prompt van de persona. Stil voor studenten (niet in response),
// zichtbaar voor staff in het Verstandhoudingen-paneel. Persona's met
// `cue_emission_enabled=false` (alle evaluators standaard) leveren altijd 0.

// --- Task #252: raadpleeglimiet-helpers (DB-toegang; pure logica zit in
// server/consultationLimit.js). ---

// Tel hoeveel raadplegingen (= threads, open + gesloten) een groep al met deze
// persona heeft gestart. De teller wordt verbruikt bij het OPENEN van een thread.
async function countConsultations(groupId, personaId) {
  const { count, error } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId).eq('persona_id', personaId);
  if (error) throw error;
  return count || 0;
}

// Lees de per (project, groep, persona) toegekende extra raadplegingen.
// Defensief tegen ontbrekende tabel (oude DB) → 0.
async function loadConsultationGrant(projectId, groupId, personaId) {
  const { data, error } = await supabaseAdmin
    .from('project_persona_consultation_grants')
    .select('extra_consultations')
    .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01' || /project_persona_consultation_grants/i.test(error.message || '')) return 0;
    throw error;
  }
  return conNormalizeExtra(data?.extra_consultations);
}

// Voer de afronding van één thread uit: server-side samenvatting (topics/
// agreements), DB-update en — indien van toepassing — cue-emissie op de
// relatie. Wordt gedeeld door het /close-endpoint én de lazy auto-close.
async function performThreadClose({ thread, groupId, lang, closedBy }) {
  // Persona + project ophalen voor cue-context en relatie-update.
  let persona = null;
  let projectIdForRel = null;
  if (thread.persona_id) {
    const { data: p } = await supabaseAdmin
      .from('project_personas')
      .select('id, name, project_id, system_prompt, cue_emission_enabled, persona_type')
      .eq('id', thread.persona_id).maybeSingle();
    persona = p || null;
    projectIdForRel = persona?.project_id || null;
  }
  if (!projectIdForRel) {
    const { data: g } = await supabaseAdmin
      .from('project_groups').select('project_id').eq('id', groupId).maybeSingle();
    projectIdForRel = g?.project_id || null;
  }
  // Task #173 — per-cursus cue-bereik ophalen. Defensief: ontbrekende
  // kolom (oude DB) of geen cursus → val terug op de default (2).
  let courseCueDeltaMax = 2;
  if (projectIdForRel) {
    try {
      const { data: proj } = await supabaseAdmin
        .from('projects').select('course_id').eq('id', projectIdForRel).maybeSingle();
      const courseId = proj?.course_id || null;
      if (courseId) {
        const { data: course, error: cErr } = await supabaseAdmin
          .from('courses').select('cue_delta_max').eq('id', courseId).maybeSingle();
        if (cErr && cErr.code !== '42703' && !/cue_delta_max/i.test(cErr.message || '')) {
          console.warn('[threads/close] courses.cue_delta_max read warn:', cErr.message);
        }
        if (course && Number.isFinite(Number(course.cue_delta_max))) {
          courseCueDeltaMax = Number(course.cue_delta_max);
        }
      }
    } catch (e) {
      console.warn('[threads/close] cue_delta_max lookup faalde, default 2 wordt gebruikt:', e.message);
    }
  }
  // Cue-emissie alleen voor conversational persona's die expliciet aan
  // staan ÉN waarvan de system_prompt een herkenbare cue-tabel bevat.
  // Zonder cue-tabel ontbreekt de docent-rubric en zou het LLM op losse
  // gronden kunnen oordelen — dat forceren we hier hard naar delta=0
  // (architect-review eis: "geen cue-tabel ⇒ altijd 0"). Defensief:
  // ontbrekende kolom (oude DB) telt als 'true'.
  const cueTablePresent = relHasCueTable(persona?.system_prompt || '');
  const emissionEnabled = !!persona
    && (persona.persona_type || 'conversational') === 'conversational'
    && (persona.cue_emission_enabled !== false)
    && cueTablePresent;
  if (persona
      && (persona.persona_type || 'conversational') === 'conversational'
      && persona.cue_emission_enabled !== false
      && !cueTablePresent) {
    console.warn(`[threads/close] cue-emissie uit voor persona ${persona.id}: geen cue-tabel in system_prompt → delta geforceerd op 0`);
  }

  // --- Server-side samenvatting genereren (zelfde logica als /close-preview) ---
  const { data: msgs } = await supabaseAdmin
    .from('group_persona_messages')
    .select('role, content')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true });
  const allMsgs = msgs || [];
  let topics = [];
  let agreements = [];
  let cue = { delta: 0, reason: '' };

  if (AZURE_CHAT_READY) {
    const conversationText = allMsgs
      .map(m => `${m.role === 'user' ? 'Student' : 'Persona'}: ${(m.content || '').slice(0, 2000)}`)
      .join('\n').slice(0, 12000);
    const msgCount = allMsgs.filter(m => m.role === 'user').length;
    const topicsInstruction = lang !== 'nl'
      ? (msgCount <= 3 ? '2-3 short topics' : msgCount <= 8 ? '3-5 topics' : '5-8 topics')
      : (msgCount <= 3 ? '2-3 korte onderwerpen' : msgCount <= 8 ? '3-5 onderwerpen' : '5-8 onderwerpen');
    const langInstruction = lang === 'nl'
      ? 'Schrijf in het Nederlands.'
      : `Write everything in ${languageEnglishName(lang)}. Keep every JSON property name exactly as written in the structure above (do not translate the keys); only the string values may be in ${languageEnglishName(lang)}.`;

    const cueJson = emissionEnabled ? `\n${relCueJsonInstruction(lang, courseCueDeltaMax)}` : '';
    const cueSchemaSnippet = emissionEnabled
      ? ',\n  "relationship_delta": 0,\n  "relationship_reason": ""'
      : '';
    const prompt = lang !== 'nl'
      ? `You are a minute-taker. Analyse the following conversation between a student and an AI persona.\n\nRespond ONLY with valid JSON in this structure:\n{\n  "topics": [...],\n  "agreements": [...]${cueSchemaSnippet}\n}\n\n- "topics": array of ${topicsInstruction}. Each item is one discussed topic (concise, max 1 sentence).\n- "agreements": array of 0 or more strings. Only concrete agreements or commitments. Leave empty if none.${cueJson}\n\n${langInstruction} No markdown outside the JSON, no explanation.\n\nConversation:\n${conversationText}`
      : `Je bent een notulist. Analyseer het volgende gesprek tussen een student en een AI-persona.\n\nGeef je antwoord UITSLUITEND als geldige JSON met deze structuur:\n{\n  "topics": [...],\n  "agreements": [...]${cueSchemaSnippet}\n}\n\n- "topics": array van ${topicsInstruction}. Elk item is één besproken onderwerp (bondig, maximaal 1 zin).\n- "agreements": array van 0 of meer strings. Alleen concrete afspraken of toezeggingen. Laat leeg als er geen zijn.${cueJson}\n\n${langInstruction} Geen markdown buiten de JSON, geen uitleg.\n\nGesprek:\n${conversationText}`;

    // Bouw de system-prompt: docent-cue-tabel (persona.system_prompt) + meta-blok.
    const systemContent = emissionEnabled
      ? `${persona.system_prompt || ''}${relCueInstructionBlock(lang, courseCueDeltaMax)}`
      : (persona?.system_prompt || '');

    try {
      const messages = systemContent
        ? [{ role: 'system', content: systemContent }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }];
      const chatResp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages,
        ...chatModelParams({ temperature: 0.2, maxTokens: 700 }),
        response_format: { type: 'json_object' },
      });
      if (chatResp.ok) {
        const raw = ((await chatResp.json()).choices?.[0]?.message?.content || '{}').trim();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }
        topics = Array.isArray(parsed.topics) ? parsed.topics.filter(t => typeof t === 'string' && t.trim()) : [];
        agreements = Array.isArray(parsed.agreements) ? parsed.agreements.filter(a => typeof a === 'string' && a.trim()) : [];
        cue = relValidateCueResponse(parsed, { emissionEnabled, maxDelta: courseCueDeltaMax });
      }
    } catch (e) {
      console.error('[threads/close] LLM/parse fout:', e.message);
    }
  }
  // Fallback als het model geen bruikbare output geeft.
  if (topics.length === 0) {
    topics = allMsgs.filter(m => m.role === 'user')
      .map(m => (m.content || '').slice(0, 100))
      .filter(Boolean).slice(0, 3);
  }

  // --- Schrijf naar DB: alleen server gegenereerde waarden ---
  const { error: updErr } = await supabaseAdmin
    .from('group_persona_threads')
    .update({
      closed_at: new Date().toISOString(),
      closed_by: closedBy || null,
      topics,
      agreements,
    })
    .eq('id', thread.id);
  if (updErr) throw new Error(updErr.message);

  // Cue-emissie toepassen op de relatie. Idempotent via thread_close-refId.
  // Stil voor studenten — niet in response.
  if (emissionEnabled && cue.delta !== 0 && projectIdForRel) {
    try {
      await applyRelationshipDelta({
        projectId: projectIdForRel,
        groupId,
        personaId: thread.persona_id,
        delta: cue.delta,
        event: {
          source: 'persona_chat_close',
          refId: `thread_close:${thread.id}`,
          delta: cue.delta,
          note: cue.reason,
        },
      });
    } catch (relErr) {
      console.warn('[threads/close] relationship-update mislukte:', relErr.message);
    }
  }

  return { topics, agreements, cue, emissionEnabled, personaName: persona?.name || null };
}

// Lazy auto-close: rond stille open threads van (groep, persona) automatisch af
// wanneer de laatste activiteit langer dan auto_close_hours geleden was. Geen
// cron — wordt aangeroepen vanuit room-load en persona-chat. Best-effort:
// fouten per thread worden gelogd, niet gegooid. Retourneert het aantal
// afgesloten threads.
async function autoCloseStaleThreads({ groupId, personaId, autoCloseHours, closedBy, lang }) {
  const hours = conNormalizeAutoCloseHours(autoCloseHours);
  if (hours === null) return 0;
  const { data: openThreads, error } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id, persona_id, created_at')
    .eq('group_id', groupId).eq('persona_id', personaId).is('closed_at', null);
  if (error || !openThreads || openThreads.length === 0) return 0;
  const now = Date.now();
  let closed = 0;
  for (const th of openThreads) {
    const { data: lastMsg } = await supabaseAdmin
      .from('group_persona_messages')
      .select('created_at')
      .eq('thread_id', th.id)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    const lastTs = lastMsg?.created_at || th.created_at;
    if (conIsThreadStale(lastTs, hours, now)) {
      try {
        await performThreadClose({ thread: th, groupId, lang, closedBy: closedBy || null });
        closed++;
      } catch (e) {
        console.warn(`[auto-close] thread ${th.id} afronden mislukte:`, e.message);
      }
    }
  }
  return closed;
}

app.post('/api/projects/groups/:groupId/threads/:threadId/close', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId, threadId } = req.params;
  const lang = normalizeLang(req.body?.lang);

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }
    const { data: thread } = await supabaseAdmin
      .from('group_persona_threads')
      .select('id, group_id, persona_id, closed_at')
      .eq('id', threadId).eq('group_id', groupId).is('closed_at', null).maybeSingle();
    if (!thread) return res.status(404).json({ error: 'Thread niet gevonden of al afgesloten' });

    const { topics, agreements, cue, emissionEnabled, personaName } = await performThreadClose({
      thread, groupId, lang, closedBy: auth.user.id,
    });

    // Task #172: cue-uitslag retourneren aan staff zodat ze direct feedback
    // krijgen. Studenten zien dit veld NIET.
    const { data: profForStaff } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const { data: grpRowForStaff } = await supabaseAdmin
      .from('project_groups').select('projects(course_id)').eq('id', groupId).maybeSingle();
    const courseIdForStaff = grpRowForStaff?.projects?.course_id || null;
    const isStaffRequester = await isStaffForCourse(auth.user, profForStaff, courseIdForStaff);

    const response = { ok: true, threadId, topics, agreements };
    if (isStaffRequester) {
      response.cue = {
        delta: cue.delta,
        reason: cue.reason,
        emissionEnabled,
        personaName,
      };
    }
    return res.json(response);
  } catch (err) {
    console.error('[threads/close]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/groups/:groupId/conversation-log — alle afgesloten gesprekken.
app.get('/api/projects/groups/:groupId/conversation-log', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId } = req.params;

  try {
    const isMember = await isGroupMember(groupId, auth.user.id);
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    // Cursus van de groep ophalen om docent-staff per cursus te checken.
    const { data: grpRow } = await supabaseAdmin
      .from('project_groups').select('project_id, projects(course_id)').eq('id', groupId).maybeSingle();
    const grpCourseId = grpRow?.projects?.course_id || null;
    const isStaffUser = await isStaffForCourse(auth.user, prof, grpCourseId);
    if (!isMember && !isStaffUser) return res.status(403).json({ error: 'Geen toegang tot deze groep' });

    const { data: threads } = await supabaseAdmin
      .from('group_persona_threads')
      .select('id, persona_id, closed_at, closed_by, topics, agreements')
      .eq('group_id', groupId)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false });
    if (!threads || threads.length === 0) return res.json({ conversations: [] });

    const personaIds = [...new Set(threads.map(t => t.persona_id))];
    const { data: personas } = await supabaseAdmin
      .from('project_personas').select('id, name, avatar_emoji').in('id', personaIds);
    const personaMap = Object.fromEntries((personas || []).map(p => [p.id, p]));

    // Task #172: voor staff koppelen we per thread de cue (delta + reden)
    // uit project_persona_relationships.history (source=persona_chat_close,
    // refId=thread_close:<threadId>). Studenten krijgen dit veld NIET.
    let cueByThread = new Map();
    if (isStaffUser) {
      const projectIdForRel = grpRow?.project_id || null;
      if (projectIdForRel) {
        const { data: rels } = await supabaseAdmin
          .from('project_persona_relationships')
          .select('persona_id, history')
          .eq('project_id', projectIdForRel)
          .eq('group_id', groupId)
          .in('persona_id', personaIds);
        for (const r of rels || []) {
          for (const ev of Array.isArray(r.history) ? r.history : []) {
            if (ev && ev.source === 'persona_chat_close' && typeof ev.refId === 'string'
                && ev.refId.startsWith('thread_close:')) {
              const tid = ev.refId.slice('thread_close:'.length);
              cueByThread.set(tid, {
                delta: typeof ev.delta === 'number' ? ev.delta : 0,
                reason: typeof ev.note === 'string' ? ev.note : '',
              });
            }
          }
        }
      }
    }

    const conversations = threads.map(t => {
      const p = personaMap[t.persona_id] || {};
      const out = {
        threadId: t.id,
        personaId: t.persona_id,
        personaName: p.name || 'Gesprek',
        avatarEmoji: p.avatar_emoji || '💬',
        closedAt: t.closed_at,
        topics: t.topics || [],
        agreements: t.agreements || [],
      };
      if (isStaffUser && cueByThread.has(t.id)) {
        out.cue = cueByThread.get(t.id);
      }
      return out;
    });
    return res.json({ conversations });
  } catch (err) {
    console.error('[conversation-log]', err);
    return res.status(500).json({ error: err.message });
  }
});

// Helper: genereert cross-agent synthese op basis van afgesloten gesprekken.
// Geeft null terug als er minder dan 2 afgesloten gesprekken zijn.
async function generateCrossAgentSynthesis(groupId, apiKey, lang = 'nl') {
  const enMode = lang !== 'nl';
  const { data: closedThreads } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id, persona_id, topics, agreements')
    .eq('group_id', groupId)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false });

  if (!closedThreads || closedThreads.length < 2) return null;

  const personaIds = [...new Set(closedThreads.map(t => t.persona_id))];
  const { data: personas } = await supabaseAdmin
    .from('project_personas').select('id, name, avatar_emoji').in('id', personaIds);
  const personaMap = Object.fromEntries((personas || []).map(p => [p.id, p]));

  const convText = closedThreads.map(t => {
    const p = personaMap[t.persona_id] || {};
    const topics = (t.topics || []).join('; ');
    const agreements = (t.agreements || []).join('; ');
    return enMode
      ? `${p.avatar_emoji || '💬'} ${p.name || 'Persona'}:\n- Discussed: ${topics || '(none)'}\n- Agreed: ${agreements || '(none)'}`
      : `${p.avatar_emoji || '💬'} ${p.name || 'Persona'}:\n- Besproken: ${topics || '(geen)'}\n- Afgesproken: ${agreements || '(geen)'}`;
  }).join('\n\n');

  const prompt = (enMode
    ? `You are analysing conversations a group of students has had with different AI personas in a research project.\n\nConversation summary per persona:\n${convText}\n\nReturn your answer ONLY as valid JSON:\n{\n  "overeenstemming": ["...", ...],\n  "spanningspunten": ["...", ...],\n  "suggesties": ["...", ...]\n}\n\n- "overeenstemming": 2-4 points that multiple personas agreed on or gave similar information about.\n- "spanningspunten": 1-3 points where personas clearly disagreed or gave contradictory information. Leave the array empty if there are none.\n- "suggesties": 2-3 concrete next steps the group can take based on the conversations.\n\nWrite in English, concise and concrete. No markdown outside the JSON.`
    : `Je analyseert gesprekken die een groep studenten heeft gevoerd met verschillende AI-personas in een onderzoeksproject.\n\nGesprekssamenvatting per persona:\n${convText}\n\nGeef je antwoord UITSLUITEND als geldige JSON:\n{\n  "overeenstemming": ["...", ...],\n  "spanningspunten": ["...", ...],\n  "suggesties": ["...", ...]\n}\n\n- "overeenstemming": 2-4 punten waarover meerdere personas het eens zijn of vergelijkbare informatie gaven.\n- "spanningspunten": 1-3 punten waarover personas duidelijk anders denken of tegenstrijdige informatie gaven. Laat de array leeg als er geen zijn.\n- "suggesties": 2-3 concrete volgende stappen die de groep kan zetten op basis van de gesprekken.\n\nSchrijf in het Nederlands, bondig en concreet. Geen markdown buiten de JSON.`) + buildLanguageInstruction(lang, { json: true });

  try {
    const resp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...chatModelParams({ temperature: 0.3, maxTokens: 800 }),
      response_format: { type: 'json_object' },
    });
    if (resp.ok) {
      const raw = ((await resp.json()).choices?.[0]?.message?.content || '{}').trim();
      const parsed = JSON.parse(raw);
      return {
        overeenstemming: Array.isArray(parsed.overeenstemming) ? parsed.overeenstemming.filter(s => typeof s === 'string' && s.trim()) : [],
        spanningspunten: Array.isArray(parsed.spanningspunten) ? parsed.spanningspunten.filter(s => typeof s === 'string' && s.trim()) : [],
        suggesties: Array.isArray(parsed.suggesties) ? parsed.suggesties.filter(s => typeof s === 'string' && s.trim()) : [],
        lang,
      };
    }
  } catch (e) {
    console.error('[cross-agent-synthese] LLM fout:', e.message);
  }
  return null;
}

// POST /api/projects/groups/:groupId/checkpoint-preview — genereer AI-samenvattingen
// per persona-thread ter preview vóór opslaan. Geen DB-schrijven.
// Response: { threads: [{ threadId, personaId, personaName, avatarEmoji, studentSummary, personaSummary }], synthesis? }
app.post('/api/projects/groups/:groupId/checkpoint-preview', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId } = req.params;
  const lang = req.body?.lang || 'nl';
  const enMode = lang !== 'nl';

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

    // Gebruik berichten ná de laatste checkpoint.
    const { data: prevCps } = await supabaseAdmin
      .from('group_checkpoints')
      .select('created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(1);
    const sinceTs = prevCps && prevCps[0] ? prevCps[0].created_at : '1970-01-01T00:00:00Z';

    const { data: threads } = await supabaseAdmin
      .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);

    const result = [];
    for (const t of (threads || [])) {
      const { data: newMsgs } = await supabaseAdmin
        .from('group_persona_messages')
        .select('role, content')
        .eq('thread_id', t.id)
        .gt('created_at', sinceTs)
        .order('created_at', { ascending: true });
      if (!newMsgs || newMsgs.length === 0) continue;

      const { data: persona } = await supabaseAdmin
        .from('project_personas').select('name, avatar_emoji').eq('id', t.persona_id).maybeSingle();
      const personaName = persona?.name || 'Gesprek';
      const avatarEmoji = persona?.avatar_emoji || '💬';

      const userText = newMsgs.filter(m => m.role === 'user').map(m => (m.content || '').slice(0, 2000)).join('\n\n').slice(0, 8000);
      const asstText = newMsgs.filter(m => m.role === 'assistant').map(m => (m.content || '').slice(0, 2000)).join('\n\n').slice(0, 12000);

      let studentSummary = '';
      let personaSummary = '';
      try {
        if (userText.trim()) {
          const r1 = await openaiChatCompletion({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: (enMode
              ? `Below are the messages a student sent in a conversation with "${personaName}". Write a factual summary in at most 4 sentences. Describe what the student asked and contributed. Write in the third person ("the student"). No greeting, no closing.\n\nMessages:\n${userText}`
              : `Hieronder staan de berichten die een student stuurde in een gesprek met "${personaName}". Schrijf een feitelijke samenvatting in maximaal 4 zinnen. Beschrijf wat de student vroeg en inbracht. Schrijf in de derde persoon ("de student"). Geen aanhef, geen afsluitende groet.\n\nBerichten:\n${userText}`) + buildLanguageInstruction(lang) }],
            ...chatModelParams({ temperature: 0.3, maxTokens: 300 }),
          });
          if (r1.ok) studentSummary = ((await r1.json()).choices?.[0]?.message?.content || '').trim();
        }
        if (asstText.trim()) {
          const r2 = await openaiChatCompletion({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: (enMode
              ? `Below are the responses of "${personaName}" in a conversation with a student. Write a summary in at most 8 sentences. Describe the key points ${personaName} raised. Write in the third person. No greeting, no closing.\n\nResponses:\n${asstText}`
              : `Hieronder staan de reacties van "${personaName}" in een gesprek met een student. Schrijf een samenvatting in maximaal 8 zinnen. Beschrijf de kernpunten die ${personaName} aanhaalde. Schrijf in derde persoon. Geen aanhef, geen afsluitende groet.\n\nReacties:\n${asstText}`) + buildLanguageInstruction(lang) }],
            ...chatModelParams({ temperature: 0.3, maxTokens: 600 }),
          });
          if (r2.ok) personaSummary = ((await r2.json()).choices?.[0]?.message?.content || '').trim();
        }
      } catch (e) {
        console.error('[checkpoint-preview] OpenAI fout:', e.message);
      }
      if (!studentSummary) {
        const first = newMsgs.find(m => m.role === 'user');
        studentSummary = (first?.content || '').slice(0, 400);
      }
      if (!personaSummary) {
        const first = newMsgs.find(m => m.role === 'assistant');
        personaSummary = (first?.content || '').slice(0, 600);
      }
      result.push({ threadId: t.id, personaId: t.persona_id, personaName, avatarEmoji, studentSummary, personaSummary });
    }

    // Cross-agent synthese (alleen als ≥ 2 afgesloten gesprekken).
    let synthesis = null;
    try {
      synthesis = await generateCrossAgentSynthesis(groupId, apiKey, lang);
    } catch (e) {
      console.error('[checkpoint-preview] synthese fout:', e.message);
    }

    return res.json({ threads: result, synthesis });
  } catch (err) {
    console.error('[checkpoint-preview]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/groups/:groupId/checkpoint — sla een checkpoint op.
// kind = 'checkpoint' (tussentijds) of 'final' (afronden).
// Bij 'checkpoint': AI vat reflectie samen → één journal-entry per lid.
// Bij 'final': AI scoort tegen rubric → uitgebreide journal-entry per lid.
app.post('/api/projects/groups/:groupId/checkpoint', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId } = req.params;
  const { kind = 'checkpoint', reflection, requestId, personaSummaries, lang = 'nl' } = req.body || {};
  const enMode = lang !== 'nl';
  if (!['checkpoint', 'final'].includes(kind)) {
    return res.status(400).json({ error: "kind moet 'checkpoint' of 'final' zijn" });
  }
  // Bij kind='checkpoint' met AI-preview-samenvattingen is een handmatige reflectie niet vereist.
  const hasPersonaSummaries = kind === 'checkpoint' && Array.isArray(personaSummaries) && personaSummaries.length > 0;
  if (!hasPersonaSummaries) {
    if (!reflection || typeof reflection !== 'string' || reflection.trim().length < 20) {
      return res.status(400).json({ error: 'Reflectie van minimaal 20 tekens vereist' });
    }
  }

  try {
    if (!(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }

    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id, status, name').eq('id', groupId).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
    if (group.status === 'finalized' && kind === 'final') {
      return res.status(400).json({ error: 'Deze groep is al afgesloten' });
    }

    // Idempotentie: als de client een requestId meestuurt en er bestaat al een
    // checkpoint met diezelfde request_id binnen deze groep, geef dat terug
    // i.p.v. opnieuw te schrijven (voorkomt dubbele journal-entries bij retry
    // of dubbele submit). Stille degradatie als de kolom (nog) ontbreekt.
    if (requestId) {
      try {
        const { data: dup } = await supabaseAdmin
          .from('group_checkpoints')
          .select('*').eq('group_id', groupId).eq('request_id', requestId).maybeSingle();
        if (dup) return res.json({ checkpoint: dup, deduped: true });
      } catch { /* request_id-kolom nog niet aanwezig — negeren */ }
    }

    const { data: project } = await supabaseAdmin
      .from('projects').select('id, title, briefing_markdown, rubric_criteria, research_question')
      .eq('id', group.project_id).maybeSingle();
    const checkpointCourseId = await courseIdForProject(group.project_id);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

    const rubric = Array.isArray(project?.rubric_criteria) ? project.rubric_criteria : [];
    const rubricText = rubric.length > 0
      ? rubric.map((r, i) => typeof r === 'string' ? `${i + 1}. ${r}` : `${i + 1}. ${r.title || r.name || JSON.stringify(r)}`).join('\n')
      : '(geen rubriek beschikbaar)';

    let aiSummary = '';
    let rubricFeedback = null;

    if (kind === 'final') {
      const prompt = (enMode
        ? `You are a "critical friend" for a group of VU students (epi/biostat). The group has completed a research project and submits a joint final reflection below. Assess the work per rubric criterion — honestly, formatively and concretely. Address the group as "you" (plural).

Project: ${project?.title || '(unnamed)'}
Research question: ${project?.research_question || '(none)'}

Rubric:
${rubricText}

Group's final reflection:
${reflection}

Return ONLY valid JSON with this structure:
{
  "samenvatting": "<2-4 sentences overall assessment, second person>",
  "per_criterium": [{"criterium": "<name>", "oordeel": "<strong/sufficient/needs attention>", "feedback": "<2-3 sentences>"}],
  "vervolgstappen": "<1-3 concrete suggestions>"
}

No text outside the JSON.`
        : (`Je bent een "critical friend" voor een groep VU-studenten epi/biostat. De groep heeft een onderzoeksproject afgerond en geeft hieronder een gezamenlijke eindreflectie. Beoordeel het werk per rubriekspunt — eerlijk, formatief en concreet. Spreek de groep aan met "jullie".

Project: ${project?.title || '(naamloos)'}
Onderzoeksvraag: ${project?.research_question || '(geen)'}

Rubriek:
${rubricText}

Eindreflectie van de groep:
${reflection}

Geef je antwoord ALLEEN als geldige JSON met deze structuur:
{
  "samenvatting": "<2-4 zinnen overall oordeel, in tweede persoon>",
  "per_criterium": [{"criterium": "<naam>", "oordeel": "<sterk/voldoende/aandacht>", "feedback": "<2-3 zinnen>"}],
  "vervolgstappen": "<1-3 concrete suggesties>"
}

Geen tekst buiten de JSON.`)) + buildLanguageInstruction(lang, { json: true });
      const chatResp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        ...chatModelParams({ temperature: 0.4, maxTokens: 1500 }),
        response_format: { type: 'json_object' },
      });
      if (!chatResp.ok) {
        const txt = await chatResp.text();
        return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
      }
      const data = await chatResp.json();
      const raw = data.choices?.[0]?.message?.content || '{}';
      try {
        rubricFeedback = JSON.parse(raw);
        aiSummary = rubricFeedback.samenvatting || '';
      } catch {
        aiSummary = raw;
      }
    } else if (!hasPersonaSummaries) {
      // Geen AI-preview-samenvattingen: vat de handmatige reflectietekst samen.
      const prompt = (enMode
        ? `You are a "critical friend" for a group of VU students (epi/biostat). Below, a group writes a mid-project reflection. In 6-10 lines, addressed to the group ("you"), write a formative report: what stands out about their approach, where is there still doubt or a gap, and what concrete next step is most obvious. No greeting, no closing.

Project: ${project?.title || '(unnamed)'}
Reflection:
${reflection}`
        : `Je bent een "critical friend" voor een groep VU-studenten epi/biostat. Hieronder schrijft een groep een tussentijdse reflectie op hun project. Schrijf in 6-10 regels, in het Nederlands, gericht aan de groep ("jullie"), een formatief verslag: wat valt op aan jullie aanpak, waar zit nog twijfel of een gat, en welke concrete vervolgstap ligt voor de hand. Geen aanhef, geen afsluitende groet.

Project: ${project?.title || '(naamloos)'}
Reflectie:
${reflection}`) + buildLanguageInstruction(lang);
      const chatResp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        ...chatModelParams({ temperature: 0.5, maxTokens: 700 }),
      });
      if (!chatResp.ok) {
        const txt = await chatResp.text();
        return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
      }
      const data = await chatResp.json();
      aiSummary = data.choices?.[0]?.message?.content || '';
    }
    // hasPersonaSummaries: aiSummary blijft leeg — journalinhoud zit in personaSummaries.

    // Bouw reflectietekst op: bij AI-preview is de reflectie de samenvattingen zelf.
    const storedReflection = hasPersonaSummaries
      ? (personaSummaries || []).map(s =>
          `${s.avatarEmoji || '💬'} ${s.personaName || 'Gesprek'}\nStudent: ${s.studentSummary || ''}\nPersona: ${s.personaSummary || ''}`
        ).join('\n\n')
      : (reflection || '');

    const insertRow = {
      group_id: groupId,
      kind,
      reflection: storedReflection,
      ai_summary: aiSummary,
      rubric_feedback: rubricFeedback,
      created_by: auth.user.id,
      request_id: requestId || null,
    };
    let cp;
    let cpErr;
    {
      const r = await supabaseAdmin.from('group_checkpoints').insert(insertRow).select('*').single();
      cp = r.data; cpErr = r.error;
    }
    // Defensief: kolom request_id bestaat pas vanaf migratie 20260508140000.
    if (cpErr && /request_id/i.test(cpErr.message || '')) {
      const { request_id, ...rest } = insertRow;
      const r = await supabaseAdmin.from('group_checkpoints').insert(rest).select('*').single();
      cp = r.data; cpErr = r.error;
    }
    // Race-conditie: gelijktijdige retry met dezelfde request_id leverde 23505
    // op — lees de winnaar terug en geef die.
    if (cpErr && (cpErr.code === '23505' || /duplicate key/i.test(cpErr.message || ''))) {
      const { data: dup } = await supabaseAdmin
        .from('group_checkpoints')
        .select('*').eq('group_id', groupId).eq('request_id', requestId).maybeSingle();
      if (dup) return res.json({ checkpoint: dup, deduped: true });
    }
    if (cpErr) return res.status(500).json({ error: cpErr.message });

    // Journal-entry per lid.
    const { data: members } = await supabaseAdmin
      .from('project_group_members').select('user_id').eq('group_id', groupId);
    const projectTitle = project?.title || '(naamloos project)';
    const titleLabel = kind === 'final' ? `Eindreflectie: ${projectTitle}` : `Projectreflectie: ${projectTitle}`;
    let entryContent = aiSummary || reflection;
    if (kind === 'final' && rubricFeedback) {
      const perCrit = Array.isArray(rubricFeedback.per_criterium)
        ? rubricFeedback.per_criterium.map(c => `**${c.criterium}** (${c.oordeel}): ${c.feedback}`).join('\n\n')
        : '';
      entryContent = [
        rubricFeedback.samenvatting || '',
        perCrit,
        rubricFeedback.vervolgstappen ? `**Vervolgstappen**\n${rubricFeedback.vervolgstappen}` : '',
        `\n---\n*Gezamenlijke reflectie van de groep:*\n${reflection}`,
      ].filter(Boolean).join('\n\n');
    }

    if (members && members.length > 0) {
      const sourceRef = `group_checkpoint:${cp.id}`;
      const rows = members.map(m => ({
        user_id: m.user_id,
        title: titleLabel,
        content: entryContent,
        activity_type: kind === 'final' ? 'project_reflection' : 'project_reflection',
        source_ref: sourceRef,
        course_id: checkpointCourseId,
      }));
      // Probeer met source_ref; bij ontbrekende kolom val terug zonder.
      const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert(rows);
      if (jErr && /source_ref/i.test(jErr.message || '')) {
        await supabaseAdmin.from('learning_journal_entries').insert(
          rows.map(({ source_ref, ...rest }) => rest)
        );
      }
    }

    // Cross-agent synthese journal-entry (alleen bij tussentijds checkpoint).
    let synthesisAdded = false;
    if (kind === 'checkpoint' && members && members.length > 0) {
      try {
        const synthesis = await generateCrossAgentSynthesis(groupId, apiKey, lang);
        if (synthesis) {
          const synthLang = synthesis.lang || lang;
          const synthEnMode = synthLang !== 'nl';
          const sections = [
            synthesis.overeenstemming.length > 0
              ? `**${synthEnMode ? 'Agreement' : 'Overeenstemming'}**\n${synthesis.overeenstemming.map(s => `• ${s}`).join('\n')}`
              : '',
            synthesis.spanningspunten.length > 0
              ? `**${synthEnMode ? 'Tensions' : 'Spanningspunten'}**\n${synthesis.spanningspunten.map(s => `• ${s}`).join('\n')}`
              : '',
            synthesis.suggesties.length > 0
              ? `**${synthEnMode ? 'Suggestions for next steps' : 'Suggesties voor vervolg'}**\n${synthesis.suggesties.map(s => `• ${s}`).join('\n')}`
              : '',
          ].filter(Boolean);
          if (sections.length > 0) {
            const synthesisContent = sections.join('\n\n');
            const synthSourceRef = `group_checkpoint_synthesis:${cp.id}`;
            const synthRows = members.map(m => ({
              user_id: m.user_id,
              title: synthEnMode
                ? `🔗 Overview across all conversations: ${projectTitle}`
                : `🔗 Overzicht over alle gesprekken: ${projectTitle}`,
              content: synthesisContent,
              activity_type: 'project_reflection',
              source_ref: synthSourceRef,
              course_id: checkpointCourseId,
            }));
            const { error: synthErr } = await supabaseAdmin.from('learning_journal_entries').insert(synthRows);
            if (synthErr && (synthErr.code === '42703' || /source_ref/i.test(synthErr.message || ''))) {
              await supabaseAdmin.from('learning_journal_entries').insert(
                synthRows.map(({ source_ref: _ignored, ...rest }) => rest)
              );
            } else if (!synthErr) {
              synthesisAdded = true;
            }
          }
        }
      } catch (e) {
        console.error('[checkpoint] synthese journal-entry fout:', e.message);
      }
    }

    // Per-persona-thread journal-entries:
    // Pad A: personaSummaries meegestuurd (AI-preview-flow) → gebruik die direct.
    // Pad B: geen personaSummaries (handmatige reflectie-flow) → genereer 4-regels-samenvatting.
    let threadSummariesAdded = 0;
    try {
      if (hasPersonaSummaries) {
        // Pad A: sla de door de student bewerkte samenvattingen op als journal-entries.
        // Haal de geldige thread-ids op voor deze groep zodat een kwaadaardige payload
        // geen willekeurige threadId kan injecteren.
        const { data: validThreadRows } = await supabaseAdmin
          .from('group_persona_threads').select('id').eq('group_id', groupId);
        const validThreadIds = new Set((validThreadRows || []).map(r => r.id));

        for (const s of personaSummaries) {
          if (!s.threadId || !validThreadIds.has(s.threadId)) continue;
          const content = [
            s.studentSummary ? `**Inbreng student:**\n${s.studentSummary}` : '',
            s.personaSummary ? `**Reactie van ${s.personaName || 'persona'}:**\n${s.personaSummary}` : '',
          ].filter(Boolean).join('\n\n');
          if (!content.trim()) continue;

          const sourceRef = `group_thread_checkpoint:${cp.id}:${s.threadId}`;
          const titleLabel = `${s.avatarEmoji || '💬'} ${s.personaName || 'Gesprek'}`;
          const tRows = (members || []).map(m => ({
            user_id: m.user_id,
            title: titleLabel,
            content,
            activity_type: 'project_reflection',
            source_ref: sourceRef,
            course_id: checkpointCourseId,
          }));
          if (tRows.length > 0) {
            const { error: tjErr } = await supabaseAdmin.from('learning_journal_entries').insert(tRows);
            if (tjErr) {
              if (tjErr.code === '42703' || /source_ref/i.test(tjErr.message || '')) {
                await supabaseAdmin.from('learning_journal_entries').insert(
                  tRows.map(({ source_ref: _ignored, ...rest }) => rest)
                );
                threadSummariesAdded += 1;
              } else if (tjErr.code !== '23505') {
                console.error('[checkpoint thread summary insert A]', tjErr.message);
              }
            } else {
              threadSummariesAdded += 1;
            }
          }
        }
      } else {
        // Pad B: genereer 4-regels-samenvatting per thread (bestaande logica).
        const { data: prevCps } = await supabaseAdmin
          .from('group_checkpoints')
          .select('created_at')
          .eq('group_id', groupId)
          .lt('created_at', cp.created_at)
          .order('created_at', { ascending: false })
          .limit(1);
        const sinceTs = prevCps && prevCps[0] ? prevCps[0].created_at : '1970-01-01T00:00:00Z';

        const { data: threads } = await supabaseAdmin
          .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);

        for (const t of (threads || [])) {
          const { data: newMsgs } = await supabaseAdmin
            .from('group_persona_messages')
            .select('role, content')
            .eq('thread_id', t.id)
            .gt('created_at', sinceTs)
            .order('created_at', { ascending: true });
          if (!newMsgs || newMsgs.length === 0) continue;

          const { data: persona } = await supabaseAdmin
            .from('project_personas').select('name, avatar_emoji').eq('id', t.persona_id).maybeSingle();
          const personaName = persona?.name || 'Gesprek';
          const transcript = newMsgs.map(m =>
            `${m.role === 'user' ? 'Student' : personaName}: ${(m.content || '').slice(0, 1500)}`
          ).join('\n\n').slice(0, 12000);

          let summaryText = '';
          if (AZURE_CHAT_READY) {
            try {
              const sumPrompt = (lang !== 'nl'
                ? `Summarise the following conversation with "${personaName}" in EXACTLY 4 short lines. Address the student as "you". Line 1: core question. Line 2: key insight. Line 3: open point or misconception. Line 4: next step. No bullet points, no heading, only four sentences on separate lines.\n\nConversation:\n${transcript}`
                : `Vat het volgende gesprek met "${personaName}" samen in EXACT 4 korte regels. Spreek de student aan met "je"/"jij". Eerste regel: kernvraag. Tweede regel: belangrijkste inzicht. Derde regel: open punt of misvatting. Vierde regel: vervolgstap. Geen lijst-tekens, geen kop, alleen vier zinnen op aparte regels.\n\nGesprek:\n${transcript}`) + buildLanguageInstruction(lang);
              const sr = await openaiChatCompletion({
                model: OPENAI_MODEL,
                messages: [{ role: 'user', content: sumPrompt }],
                ...chatModelParams({ temperature: 0.3, maxTokens: 350 }),
              });
              if (sr.ok) summaryText = ((await sr.json()).choices?.[0]?.message?.content || '').trim();
            } catch { /* val terug */ }
          }
          if (!summaryText) {
            const firstUser = newMsgs.find(m => m.role === 'user');
            summaryText = (firstUser?.content || '(geen samenvatting beschikbaar)').slice(0, 400);
          }

          const sourceRef = `group_thread_checkpoint:${cp.id}:${t.id}`;
          const titleLabel = `${persona?.avatar_emoji || '💬'} ${personaName}`;
          const tRows = (members || []).map(m => ({
            user_id: m.user_id,
            title: titleLabel,
            content: summaryText,
            activity_type: 'project_reflection',
            source_ref: sourceRef,
            course_id: checkpointCourseId,
          }));
          if (tRows.length > 0) {
            const { error: tjErr } = await supabaseAdmin.from('learning_journal_entries').insert(tRows);
            if (tjErr) {
              if (tjErr.code === '42703' || /source_ref/i.test(tjErr.message || '')) {
                await supabaseAdmin.from('learning_journal_entries').insert(
                  tRows.map(({ source_ref: _ignored, ...rest }) => rest)
                );
                threadSummariesAdded += 1;
              } else if (tjErr.code === '23505') {
                // Reeds aanwezig — geen fout.
              } else {
                console.error('[checkpoint thread summary insert B]', tjErr.message);
              }
            } else {
              threadSummariesAdded += 1;
            }
          }
        }
      }
    } catch (e) {
      console.error('[checkpoint thread summaries]', e.message);
    }

    // BEWUST GEEN DELETE/TRUNCATE op group_persona_messages of group_chat_messages.
    // Een tussentijds checkpoint (kind='checkpoint') mag NOOIT gesprekken wissen.
    // Berichten blijven altijd bewaard zodat studenten dagen later kunnen doorgaan.
    // Alleen kind='final' sluit de groep (status → finalized) — gesprekken blijven leesbaar.
    if (kind === 'final') {
      await supabaseAdmin.from('project_groups')
        .update({ status: 'finalized', finalized_at: new Date().toISOString() })
        .eq('id', groupId);
    }

    return res.json({ checkpoint: cp, threadSummariesAdded, synthesisAdded });
  } catch (err) {
    console.error('[projects/groups/checkpoint]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/copy-personas-from-library — kopieer alle course_personas
// van een cursus naar project_personas voor dit project. Idempotent: doet
// niets als er al project_personas zijn.
app.post('/api/projects/copy-personas-from-library', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId vereist' });

  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    // Cursus van het project ophalen om docent-status per cursus te checken.
    const { data: projForRole } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, projForRole?.course_id);
    if (!isStaff) return res.status(403).json({ error: 'Alleen docent/admin van deze cursus' });

    const { data: existing } = await supabaseAdmin
      .from('project_personas').select('id').eq('project_id', projectId);
    if (existing && existing.length > 0) {
      return res.json({ copied: 0, alreadyExists: true });
    }
    const { data: project } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    if (!project?.course_id) return res.status(400).json({ error: 'Project heeft geen course_id' });

    const { data: lib } = await supabaseAdmin
      .from('course_personas').select('*').eq('course_id', project.course_id);
    if (!lib || lib.length === 0) return res.json({ copied: 0 });

    // Task #171: persona_type én cue_emission_enabled meekopiëren zodat
    // evaluators ook bij bulk-import nooit cues uitzenden.
    const rows = lib.map((p, i) => ({
      project_id: projectId,
      source_persona_id: null,
      name: p.name,
      avatar_emoji: p.avatar_emoji,
      system_prompt: p.system_prompt,
      rag_enabled: p.rag_enabled,
      rag_folder_ids: p.rag_folder_ids,
      visible_from_phase: p.visible_from_phase,
      sort_order: i,
      persona_type: p.persona_type === 'evaluator' ? 'evaluator' : 'conversational',
      cue_emission_enabled: p.persona_type === 'evaluator' ? false : true,
      // Task #252: raadpleeglimiet + auto-close meekopiëren uit de bibliotheek.
      max_consultations: conNormalizeMax(p.max_consultations),
      auto_close_hours: conNormalizeAutoCloseHours(p.auto_close_hours),
      // Task #253: badge-toekenningsmodus meekopiëren uit de bibliotheek.
      badge_award_mode: normalizeBadgeAwardMode(p.badge_award_mode),
    }));
    let { error: iErr } = await supabaseAdmin.from('project_personas').insert(rows);
    if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
      // Oude DB zonder Task #252-kolommen: opnieuw zonder die velden.
      const rowsNoCon = rows.map(({ max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
      ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoCon));
    }
    if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
      // Oude DB zonder kolom: opnieuw zonder veld.
      const rowsNoCue = rows.map(({ cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
      ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoCue));
    }
    if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
      // Oude DB zonder Task #253-kolom: opnieuw zonder veld. Cumulatief: ook de
      // eventueel ontbrekende Task #252-kolommen weglaten zodat één retry volstaat.
      const rowsNoBadge = rows.map(({ badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
      ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoBadge));
    }
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.json({ copied: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper: alleen admin/superuser óf een docent die lid is van de cursus
// waar het project onder valt. Voor docenten zónder course-lidmaatschap
// (= een andere cursus) is het project niet bewerkbaar.
async function requireProjectStaff(projectId, user, profile) {
  if (!projectId || !user) return { ok: false, status: 401, error: 'Niet geauthenticeerd' };
  const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
  if (isAdmin) {
    const { data: project } = await supabaseAdmin
      .from('projects').select('*').eq('id', projectId).maybeSingle();
    if (!project) return { ok: false, status: 404, error: 'Project niet gevonden' };
    return { ok: true, project };
  }
  const { data: project } = await supabaseAdmin
    .from('projects').select('*').eq('id', projectId).maybeSingle();
  if (!project) return { ok: false, status: 404, error: 'Project niet gevonden' };
  if (!project.course_id) {
    return { ok: false, status: 403, error: 'Project zonder cursus is alleen door admin te beheren' };
  }
  if (!(await isCourseTeacher(user.id, project.course_id))) {
    return { ok: false, status: 403, error: 'Je bent geen docent van de cursus van dit project' };
  }
  return { ok: true, project };
}

// PATCH /api/projects/:projectId — docent/admin werkt projectvelden bij
// (titel, onderzoeksvraag, briefing, doelen, rubrics, min/max, status,
// allow_self_signup). Onbekende velden worden genegeerd.
app.patch('/api/projects/:projectId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // course_id bewust niet wijzigbaar: een lopend project verplaatsen tussen
    // cursussen laat groepslidmaatschappen + cursus-toegang inconsistent achter.
    const allowed = ['title', 'research_question', 'description', 'briefing_markdown',
      'goals', 'rubric_criteria', 'min_group_size', 'max_group_size',
      'allow_self_signup', 'status', 'submissions_enabled'];
    const patch = {};
    for (const k of allowed) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Geen wijzigingen' });
    if (patch.min_group_size != null && patch.max_group_size != null
        && Number(patch.min_group_size) > Number(patch.max_group_size)) {
      return res.status(400).json({ error: 'Minimum groepsgrootte mag niet groter zijn dan het maximum' });
    }
    const { data, error: e } = await supabaseAdmin
      .from('projects').update(patch).eq('id', projectId).select('*').single();
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ project: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/personas — voeg één persona toe aan dit
// project. Body: { coursePersonaId } om uit de bibliotheek te kopiëren, óf
// { name, system_prompt, avatar_emoji, rag_enabled, rag_folder_ids } voor een
// project-eigen persona.
app.post('/api/projects/:projectId/personas', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const project = access.project;

    const { coursePersonaId, name, system_prompt, avatar_emoji,
      rag_enabled, rag_folder_ids } = req.body || {};
    // Task #171: cue-emissie aan/uit. Evaluators staan altijd uit.
    const cueEmissionInput = req.body?.cue_emission_enabled;
    // Task #252: raadpleeglimiet + auto-close (null = onbeperkt / uit).
    const maxConsultInput = conNormalizeMax(req.body?.max_consultations);
    const autoCloseInput = conNormalizeAutoCloseHours(req.body?.auto_close_hours);

    // Bepaal volgorde-index achteraan.
    const { data: existing } = await supabaseAdmin
      .from('project_personas').select('sort_order').eq('project_id', projectId)
      .order('sort_order', { ascending: false }).limit(1);
    const nextOrder = (existing && existing[0] ? Number(existing[0].sort_order || 0) : -1) + 1;

    let row;
    if (coursePersonaId) {
      const { data: cp } = await supabaseAdmin
        .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
      if (!cp) return res.status(404).json({ error: 'Bibliotheek-persona niet gevonden' });
      if (project.course_id && cp.course_id !== project.course_id) {
        return res.status(400).json({ error: 'Persona hoort bij een andere cursus' });
      }
      row = {
        project_id: projectId, source_persona_id: null,
        name: cp.name, avatar_emoji: cp.avatar_emoji,
        system_prompt: cp.system_prompt, rag_enabled: cp.rag_enabled,
        rag_folder_ids: cp.rag_folder_ids, visible_from_phase: cp.visible_from_phase,
        sort_order: nextOrder,
        persona_type: cp.persona_type || 'conversational',
        // Task #171: evaluators emitteren nooit cues, conversational default aan.
        cue_emission_enabled: (cp.persona_type === 'evaluator') ? false : true,
        // Task #252: raadpleeglimiet + auto-close uit de bibliotheek.
        max_consultations: conNormalizeMax(cp.max_consultations),
        auto_close_hours: conNormalizeAutoCloseHours(cp.auto_close_hours),
        // Task #253: badge-toekenningsmodus uit de bibliotheek.
        badge_award_mode: normalizeBadgeAwardMode(cp.badge_award_mode),
      };
    } else {
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is vereist' });
      const personaType = req.body?.persona_type === 'evaluator' ? 'evaluator' : 'conversational';
      const cueEmission = personaType === 'evaluator'
        ? false
        : (cueEmissionInput === false ? false : true);
      row = {
        project_id: projectId, source_persona_id: null,
        name: String(name).trim(),
        avatar_emoji: avatar_emoji || '🤖',
        system_prompt: system_prompt || '',
        rag_enabled: rag_enabled !== false,
        rag_folder_ids: Array.isArray(rag_folder_ids) ? rag_folder_ids : [],
        sort_order: nextOrder,
        persona_type: personaType,
        cue_emission_enabled: cueEmission,
        // Task #252: raadpleeglimiet + auto-close (null = onbeperkt / uit).
        max_consultations: maxConsultInput,
        auto_close_hours: autoCloseInput,
        // Task #253: badge-toekenningsmodus (individual | group).
        badge_award_mode: normalizeBadgeAwardMode(req.body?.badge_award_mode),
      };
    }
    let { data: inserted, error: iErr } = await supabaseAdmin
      .from('project_personas').insert(row).select('*').single();
    // Defensief: oude DB zonder Task #252-kolommen — opnieuw zonder die velden.
    if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
      const { max_consultations: _m, auto_close_hours: _a, ...rowNoCon } = row;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoCon).select('*').single());
    }
    // Defensief: oude DB zonder cue_emission_enabled-kolom — opnieuw zonder veld.
    if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
      const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rowNoCue } = row;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoCue).select('*').single());
    }
    // Defensief: oude DB zonder Task #253 badge_award_mode-kolom. Cumulatief: ook
    // de eventueel ontbrekende Task #252-kolommen weglaten zodat één retry volstaat.
    if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
      const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rowNoBadge } = row;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoBadge).select('*').single());
    }
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.json({ persona: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/personas/from-library/:coursePersonaId
// Maakt altijd een verse, onafhankelijke kopie van een bibliotheek-sjabloon.
// Geen deduplicatie: meerdere kopieën van hetzelfde sjabloon zijn toegestaan.
// Toegankelijk voor admin en docent (requireProjectStaff).
app.post('/api/projects/:projectId/personas/from-library/:coursePersonaId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, coursePersonaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const project = access.project;
    const { data: cp } = await supabaseAdmin
      .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
    if (!cp) return res.status(404).json({ error: 'Bibliotheek-sjabloon niet gevonden' });
    if (project.course_id && cp.course_id !== project.course_id) {
      return res.status(400).json({ error: 'Sjabloon hoort bij een andere cursus' });
    }
    const { data: existing } = await supabaseAdmin
      .from('project_personas').select('sort_order').eq('project_id', projectId)
      .order('sort_order', { ascending: false }).limit(1);
    const nextOrder = (existing && existing[0] ? Number(existing[0].sort_order || 0) : -1) + 1;
    const baseRow = {
      project_id: projectId,
      source_persona_id: null,
      name: cp.name,
      avatar_emoji: cp.avatar_emoji,
      system_prompt: cp.system_prompt,
      rag_enabled: cp.rag_enabled,
      rag_folder_ids: cp.rag_folder_ids,
      visible_from_phase: cp.visible_from_phase,
      sort_order: nextOrder,
      persona_type: cp.persona_type || 'conversational',
      // Task #171: evaluators emitteren nooit cues.
      cue_emission_enabled: (cp.persona_type === 'evaluator') ? false : true,
      // Task #252: raadpleeglimiet + auto-close uit de bibliotheek.
      max_consultations: conNormalizeMax(cp.max_consultations),
      auto_close_hours: conNormalizeAutoCloseHours(cp.auto_close_hours),
      // Task #253: badge-toekenningsmodus uit de bibliotheek.
      badge_award_mode: normalizeBadgeAwardMode(cp.badge_award_mode),
    };
    let { data: inserted, error: iErr } = await supabaseAdmin
      .from('project_personas').insert(baseRow).select('*').single();
    if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
      const { max_consultations: _m, auto_close_hours: _a, ...rowNoCon } = baseRow;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoCon).select('*').single());
    }
    if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
      const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rowNoCue } = baseRow;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoCue).select('*').single());
    }
    if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
      const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rowNoBadge } = baseRow;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(rowNoBadge).select('*').single());
    }
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.status(201).json({ persona: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:projectId/personas/:personaId — bewerk één persona.
app.patch('/api/projects/:projectId/personas/:personaId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const allowed = ['name', 'avatar_emoji', 'system_prompt', 'rag_enabled', 'rag_folder_ids', 'sort_order', 'persona_type', 'cue_emission_enabled', 'max_consultations', 'auto_close_hours', 'badge_award_mode'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.persona_type && !['conversational', 'evaluator'].includes(patch.persona_type)) {
      return res.status(400).json({ error: "persona_type moet 'conversational' of 'evaluator' zijn" });
    }
    // Evaluator-persona's emitteren nooit cues.
    if (patch.persona_type === 'evaluator') patch.cue_emission_enabled = false;
    if ('cue_emission_enabled' in patch) patch.cue_emission_enabled = !!patch.cue_emission_enabled;
    // Task #252: normaliseer raadpleeglimiet + auto-close (null = onbeperkt / uit).
    if ('max_consultations' in patch) patch.max_consultations = conNormalizeMax(patch.max_consultations);
    if ('auto_close_hours' in patch) patch.auto_close_hours = conNormalizeAutoCloseHours(patch.auto_close_hours);
    // Task #253: normaliseer badge-toekenningsmodus.
    if ('badge_award_mode' in patch) patch.badge_award_mode = normalizeBadgeAwardMode(patch.badge_award_mode);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Geen wijzigingen' });
    let { data, error: e } = await supabaseAdmin
      .from('project_personas').update(patch)
      .eq('id', personaId).eq('project_id', projectId).select('*').single();
    // Defensief: Task #252-kolommen ontbreken in oude DB — verwijder en retry.
    if (e && (e.code === '42703' || /max_consultations|auto_close_hours/i.test(e.message || ''))) {
      const { max_consultations: _m, auto_close_hours: _a, ...patchNoCon } = patch;
      if (Object.keys(patchNoCon).length === 0) return res.json({ persona: null });
      ({ data, error: e } = await supabaseAdmin
        .from('project_personas').update(patchNoCon)
        .eq('id', personaId).eq('project_id', projectId).select('*').single());
    }
    if (e && (e.code === '42703' || /cue_emission_enabled/i.test(e.message || ''))) {
      // Defensief: kolom ontbreekt in oude DB — verwijder veld en probeer opnieuw.
      const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...patchNoCue } = patch;
      if (Object.keys(patchNoCue).length === 0) return res.json({ persona: null });
      ({ data, error: e } = await supabaseAdmin
        .from('project_personas').update(patchNoCue)
        .eq('id', personaId).eq('project_id', projectId).select('*').single());
    }
    if (e && (e.code === '42703' || /badge_award_mode/i.test(e.message || ''))) {
      // Defensief: Task #253-kolom ontbreekt in oude DB — verwijder en retry.
      // Cumulatief: ook de eventueel ontbrekende Task #252-kolommen weglaten.
      const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...patchNoBadge } = patch;
      if (Object.keys(patchNoBadge).length === 0) return res.json({ persona: null });
      ({ data, error: e } = await supabaseAdmin
        .from('project_personas').update(patchNoBadge)
        .eq('id', personaId).eq('project_id', projectId).select('*').single());
    }
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ persona: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:projectId/personas/:personaId — verwijder één persona
// uit dit project. Threads/berichten worden via FK ON DELETE CASCADE opgeruimd.
app.delete('/api/projects/:projectId/personas/:personaId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { error: e } = await supabaseAdmin
      .from('project_personas').delete()
      .eq('id', personaId).eq('project_id', projectId);
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/personas/:personaId/documents?groupId=... —
// lijst van documenten die deze groep voor deze persona heeft geüpload.
// Documenten zijn group-scoped: parallelle groepen binnen hetzelfde project
// zien elkaars uploads niet. Staff mag van iedere groep de lijst opvragen.
app.get('/api/projects/:projectId/personas/:personaId/documents', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId } = req.params;
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  if (!groupId) return res.status(400).json({ error: 'groupId vereist' });
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    // Toegang: groepslid, óf staff van de cursus van dit project. Een docent
    // van een andere cursus krijgt geen toegang.
    const staffAccess = await requireProjectStaff(projectId, auth.user, profile);
    if (!staffAccess.ok && !(await isGroupMember(groupId, auth.user.id))) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep of dit project' });
    }
    const isStaffViewer = staffAccess.ok;
    const cols = 'id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric, visible_to_students';
    const buildQuery = (selectCols, withVisibleCol) => {
      let q = supabaseAdmin
        .from('project_persona_documents')
        .select(selectCols)
        .eq('project_id', projectId).eq('persona_id', personaId).eq('group_id', groupId);
      // Studenten zien geen verborgen rubrics, behalve die de docent expliciet
      // zichtbaar heeft gemaakt (visible_to_students=true).
      if (!isStaffViewer) {
        q = withVisibleCol
          ? q.or('is_hidden_rubric.eq.false,visible_to_students.eq.true')
          : q.eq('is_hidden_rubric', false);
      }
      return q.order('created_at', { ascending: false });
    };
    let { data, error: e } = await buildQuery(cols, true);
    // Defensief: oude DB zonder visible_to_students-kolom.
    if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
      ({ data, error: e } = await buildQuery('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric', false));
    }
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ documents: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/personas/:personaId/documents — upload bestand
// als multipart/form-data. Velden: file (binary), groupId. Ondersteunde
// formaten: tekst (.txt/.md/.csv/.tsv/.json) en kantoor-formaten (.pdf,
// .docx, .pptx, .xlsx, .odt, .ods, .odp). Voor kantoor-formaten wordt de
// platte tekst geëxtraheerd via officeparser.
const MAX_DOC_CHARS = 200000;
const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|log)$/i;
const OFFICE_EXT_RE = /\.(pdf|docx|pptx|xlsx|odt|ods|odp)$/i;

async function extractTextFromUpload(file) {
  const name = file.originalname || 'upload';
  if (TEXT_EXT_RE.test(name) || (file.mimetype || '').startsWith('text/')) {
    return file.buffer.toString('utf8');
  }
  if (OFFICE_EXT_RE.test(name)) {
    // officeparser herkent het type aan de inhoud van de buffer.
    const text = await parseOfficeAsync(file.buffer);
    return String(text || '').trim();
  }
  throw new Error('Bestandstype niet ondersteund — kies .txt, .md, .csv, .tsv, .json, .pdf, .docx, .pptx, .xlsx, .odt, .ods of .odp');
}

app.post('/api/projects/:projectId/personas/:personaId/documents',
  docUpload.single('file'),
  async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId } = req.params;
  const rawGroupId = req.body?.groupId;
  const requestedHiddenEarly = req.body?.isHiddenRubric === '1' || req.body?.isHiddenRubric === 'true';
  // Voor verborgen rubrics is groupId optioneel (project/persona-scoped opslag,
  // niet aan een specifieke groep gebonden). Voor reguliere uploads blijft
  // groupId verplicht.
  if (!rawGroupId && !requestedHiddenEarly) return res.status(400).json({ error: 'groupId vereist' });
  const groupId = rawGroupId || null;
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  let text;
  try {
    text = await extractTextFromUpload(req.file);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' });
  }
  if (!text || text.length === 0) {
    return res.status(400).json({ error: 'Geen leesbare tekst gevonden in dit bestand' });
  }
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS) + `\n\n…[afgekapt op ${MAX_DOC_CHARS.toLocaleString('nl-NL')} tekens]`;
  }
  const filename = req.file.originalname || 'upload';
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    // Schrijven = groepsleden. Admin/superuser mag als noodgreep ook
    // uploaden (bijv. om voor een groep een document recht te zetten);
    // docent zonder groepslidmaatschap mag niet schrijven.
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    // Cursus van het project ophalen om docent-staff per cursus te checken.
    const { data: projForStaff } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    const isStaffForProject = await isStaffForCourse(auth.user, profile, projForStaff?.course_id);
    // Groepslidmaatschap is alleen vereist voor reguliere uploads.
    if (groupId) {
      if (!isAdmin && !(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Alleen groepsleden mogen documenten uploaden' });
      }
      const { data: group } = await supabaseAdmin
        .from('project_groups').select('project_id').eq('id', groupId).maybeSingle();
      if (!group || group.project_id !== projectId) {
        return res.status(400).json({ error: 'Groep hoort niet bij dit project' });
      }
    } else if (!requestedHiddenEarly) {
      return res.status(400).json({ error: 'groupId vereist' });
    }
    // Persona moet bij dit project horen.
    const { data: persona } = await supabaseAdmin
      .from('project_personas').select('id, persona_type').eq('id', personaId).eq('project_id', projectId).maybeSingle();
    if (!persona) return res.status(404).json({ error: 'Persona niet in dit project' });
    // Studenten/groepsleden mogen NOOIT documenten op een evaluator-persona
    // plaatsen — dat zou de beoordelingsinput kunnen vervuilen.
    if (persona.persona_type === 'evaluator' && !isStaffForProject) {
      return res.status(403).json({ error: 'Geen uploads toegestaan op een beoordelaar-persona' });
    }
    // is_hidden_rubric: alleen staff mag dit zetten, en alleen op een
    // evaluator-persona. Project-scoped (group_id mag NULL zijn).
    let isHiddenRubric = false;
    if (requestedHiddenEarly) {
      if (!isStaffForProject) return res.status(403).json({ error: 'Alleen docent/admin mag een verborgen rubric uploaden' });
      // Docent moet bij dit project horen (geen kruis-cursus-uploads).
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error || 'Geen toegang tot dit project' });
      if (persona.persona_type !== 'evaluator') {
        return res.status(400).json({ error: 'Verborgen rubric kan alleen aan een beoordelaar-persona worden gekoppeld' });
      }
      isHiddenRubric = true;
    }
    // Task #253: docent kan een rubric zichtbaar maken voor studenten. Alleen
    // van toepassing op verborgen rubrics (evaluator-input); reguliere uploads
    // van studenten blijven false.
    const visibleToStudents = isHiddenRubric
      && (req.body?.visibleToStudents === '1' || req.body?.visibleToStudents === 'true');
    const insertRow = {
      project_id: projectId, persona_id: personaId, group_id: groupId,
      filename: String(filename).slice(0, 200),
      content_text: text, byte_size: req.file.size || Buffer.byteLength(text, 'utf8'),
      uploaded_by: auth.user.id,
      is_hidden_rubric: isHiddenRubric,
      visible_to_students: visibleToStudents,
    };
    const insertCols = 'id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric, visible_to_students';
    let { data, error: e } = await supabaseAdmin
      .from('project_persona_documents').insert(insertRow).select(insertCols).single();
    // Defensief: oude DB zonder visible_to_students-kolom.
    if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
      const { visible_to_students: _v, ...rowNoVis } = insertRow;
      ({ data, error: e } = await supabaseAdmin
        .from('project_persona_documents').insert(rowNoVis)
        .select('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric').single());
    }
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ document: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:projectId/personas/:personaId/documents/:docId?groupId=...
// Alleen de uploader of een docent mag verwijderen; URL-parameters worden
// strikt op de DELETE-query toegepast zodat een willekeurige docId niet
// kan worden meegegeven met een onjuiste project/persona-combinatie.
app.delete('/api/projects/:projectId/personas/:personaId/documents/:docId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId, docId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const staffAccess = await requireProjectStaff(projectId, auth.user, profile);
    const isCourseStaff = staffAccess.ok;
    const { data: doc } = await supabaseAdmin
      .from('project_persona_documents').select('uploaded_by, group_id')
      .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    if (!isCourseStaff) {
      if (doc.uploaded_by !== auth.user.id) {
        return res.status(403).json({ error: 'Alleen de uploader of een docent van deze cursus mag verwijderen' });
      }
      // Extra check: huidige user moet nog steeds lid zijn van de groep waar
      // het document bij hoort. Voorkomt verwijderen na verlaten van groep.
      if (doc.group_id && !(await isGroupMember(doc.group_id, auth.user.id))) {
        return res.status(403).json({ error: 'Niet langer lid van deze groep' });
      }
    }
    const { error: e } = await supabaseAdmin
      .from('project_persona_documents').delete()
      .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId);
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:projectId/personas/:personaId/documents/:docId/visibility
// Task #253: alleen staff mag de zichtbaarheid van een verborgen rubric voor
// studenten in-/uitschakelen. Werkt alleen op is_hidden_rubric=true rijen.
app.patch('/api/projects/:projectId/personas/:personaId/documents/:docId/visibility', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId, docId } = req.params;
  const visibleToStudents = req.body?.visibleToStudents;
  if (typeof visibleToStudents !== 'boolean') {
    return res.status(400).json({ error: 'visibleToStudents moet een boolean zijn' });
  }
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const staffAccess = await requireProjectStaff(projectId, auth.user, profile);
    if (!staffAccess.ok) {
      return res.status(403).json({ error: 'Alleen een docent van deze cursus mag de zichtbaarheid wijzigen' });
    }
    const { data: doc } = await supabaseAdmin
      .from('project_persona_documents').select('id, is_hidden_rubric')
      .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    if (doc.is_hidden_rubric !== true) {
      return res.status(400).json({ error: 'Zichtbaarheid kan alleen op een rubric worden ingesteld' });
    }
    const { data: updated, error: e } = await supabaseAdmin
      .from('project_persona_documents')
      .update({ visible_to_students: visibleToStudents })
      .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId)
      .select('id, visible_to_students').single();
    if (e) {
      if (e.code === '42703' || /visible_to_students/i.test(e.message || '')) {
        return res.status(503).json({
          error: 'Migratie 20260608130000_evaluator_grading_badges.sql is nog niet toegepast in Supabase.',
        });
      }
      return res.status(500).json({ error: e.message });
    }
    return res.json({ document: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/personas/:personaId/documents/:docId/download
// Task #253: download van een rubric. Staff altijd; studenten alleen als de
// rubric op visible_to_students=true staat.
app.get('/api/projects/:projectId/personas/:personaId/documents/:docId/download', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId, docId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    if (!isStaff && !(await userHasProjectAccess(auth.user, profile, project))) {
      return res.status(403).json({ error: 'Geen toegang tot dit project' });
    }
    let { data: doc, error: e } = await supabaseAdmin
      .from('project_persona_documents')
      .select('id, filename, content_text, is_hidden_rubric, visible_to_students')
      .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
    // Defensief: oude DB zonder visible_to_students-kolom.
    if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
      ({ data: doc, error: e } = await supabaseAdmin
        .from('project_persona_documents')
        .select('id, filename, content_text, is_hidden_rubric')
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle());
    }
    if (e) return res.status(500).json({ error: e.message });
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    if (!isStaff && doc.visible_to_students !== true) {
      return res.status(403).json({ error: 'Deze rubric is niet zichtbaar voor studenten' });
    }
    const filename = doc.filename || 'rubric';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(doc.content_text || '');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/student-overview — lijst per cursus van projecten en
// laatste sessie-status. Wordt door /projects gebruikt voor de drie keuzes
// (start nieuw, vervolg laatste, herstart).
app.get('/api/projects/student-overview', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  try {
    // Cursussen waarvan de student projecten mag zien. Spiegelt de centrale
    // toegangsregel (canAccessCourseContent): élke actieve, zichtbare cursus is
    // open voor iedere student (géén course_members nodig — zo zien ook
    // zelf-geregistreerde studenten een vers aangemaakt project meteen), plus de
    // cursussen waar de student lid/docent van is en die de regel doorlaten
    // (bv. een gearchiveerde maar zichtbare cursus). De frontend filtert
    // vervolgens op de actieve cursus.
    const courseMap = new Map(); // id -> { id, name }

    // 1) Open cursussen: actief (+ zichtbaar wanneer de kolom bestaat).
    let openQuery = supabaseAdmin
      .from('courses')
      .select(coursesHasStudentVisible ? 'id, name, is_active, student_visible' : 'id, name, is_active')
      .eq('is_active', true);
    if (coursesHasStudentVisible) openQuery = openQuery.eq('student_visible', true);
    const { data: openCourses } = await openQuery;
    for (const c of (openCourses || [])) {
      if (c?.id) courseMap.set(c.id, { id: c.id, name: c.name });
    }

    // 2) Lidmaatschappen: voeg cursussen toe die de toegangsregel doorlaten maar
    //    nog niet in de open-lijst staan (bv. inactief maar zichtbaar, of de
    //    docent van een verborgen cursus).
    const memberCols = coursesHasStudentVisible
      ? 'course_id, member_role, courses(id, name, is_active, student_visible)'
      : 'course_id, member_role, courses(id, name, is_active)';
    const { data: memberships } = await supabaseAdmin
      .from('course_members').select(memberCols).eq('user_id', auth.user.id);
    for (const m of (memberships || [])) {
      const c = m.courses;
      if (!c?.id || courseMap.has(c.id)) continue;
      const studentVisible = coursesHasStudentVisible ? (c.student_visible !== false) : true;
      const isActive = c.is_active !== false;
      const allowed = canAccessCourseContent({
        isAdmin: false,
        isCourseTeacher: m.member_role === 'teacher',
        isMember: true,
        isActive,
        studentVisible,
      });
      if (allowed) courseMap.set(c.id, { id: c.id, name: c.name });
    }

    const courses = [...courseMap.values()];
    const courseIds = courses.map(c => c.id);
    if (courseIds.length === 0) return res.json({ courses: [] });

    const { data: projects } = await supabaseAdmin
      .from('projects').select('id, title, research_question, course_id, status, briefing_markdown, max_group_size, min_group_size')
      .in('course_id', courseIds).eq('status', 'active');
    const projectIds = (projects || []).map(p => p.id);

    let sessions = [];
    if (projectIds.length > 0) {
      const { data: s } = await supabaseAdmin
        .from('student_project_sessions').select('*')
        .eq('student_id', auth.user.id).in('project_id', projectIds)
        .order('started_at', { ascending: false });
      sessions = s || [];
    }

    // Groepslidmaatschappen voor "vervolg in groep".
    // Inclusief created_at zodat we de meest recente actieve groep kunnen kiezen.
    const { data: groupRows } = await supabaseAdmin
      .from('project_group_members')
      .select('group_id, project_groups!inner(id, project_id, name, status, invite_code, created_at)')
      .eq('user_id', auth.user.id);
    const groupsByProject = new Map();
    for (const g of (groupRows || [])) {
      const grp = g.project_groups;
      if (!grp) continue;
      const list = groupsByProject.get(grp.project_id) || [];
      list.push(grp);
      groupsByProject.set(grp.project_id, list);
    }

    // Haal het meest recente checkpoint op voor elke actieve groep zodat de
    // UI "Ga verder (checkpoint: ...)" kan tonen.
    const allActiveGroupIds = [];
    for (const [, groups] of groupsByProject) {
      const ag = groups.find(g => g.status === 'active');
      if (ag) allActiveGroupIds.push(ag.id);
    }
    const lastCheckpointByGroup = new Map();
    if (allActiveGroupIds.length > 0) {
      const { data: cpRows } = await supabaseAdmin
        .from('group_checkpoints')
        .select('group_id, created_at')
        .in('group_id', allActiveGroupIds)
        .order('created_at', { ascending: false });
      for (const row of (cpRows || [])) {
        if (!lastCheckpointByGroup.has(row.group_id)) {
          lastCheckpointByGroup.set(row.group_id, row.created_at);
        }
      }
    }

    const result = courses.map(c => {
      const cps = (projects || []).filter(p => p.course_id === c.id).map(p => {
        const pSessions = sessions.filter(s => s.project_id === p.id);
        const lastSession = pSessions[0] || null;
        const groups = groupsByProject.get(p.id) || [];
        // Kies de "beste" actieve groep: eerst op meest recente checkpoint,
        // daarna op meest recent aangemaakt (bij meerdere actieve groepen door
        // eerder mislukte herstart-pogingen).
        const activeGroups = groups.filter(g => g.status === 'active');
        activeGroups.sort((a, b) => {
          const cpA = lastCheckpointByGroup.get(a.id) || null;
          const cpB = lastCheckpointByGroup.get(b.id) || null;
          if (cpA && !cpB) return -1;
          if (!cpA && cpB) return 1;
          if (cpA && cpB) return new Date(cpB) - new Date(cpA);
          return new Date(b.created_at) - new Date(a.created_at);
        });
        const activeGroup = activeGroups[0] || null;
        const activeGroupWithCp = activeGroup
          ? { ...activeGroup, lastCheckpointAt: lastCheckpointByGroup.get(activeGroup.id) || null }
          : null;
        return { ...p, sessions: pSessions, lastSession, activeGroup: activeGroupWithCp };
      });
      return { course: c, projects: cps };
    });
    return res.json({ courses: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/student-restart — sluit lopende sessies/groepslidmaatschap
// af en start opnieuw. Body: { projectId }.
app.post('/api/projects/student-restart', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId vereist' });
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id, status').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    if (project.status === 'archived') return res.status(400).json({ error: 'Project is gearchiveerd' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    if (!isStaff && project.course_id && !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
      return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
    }

    // Markeer lopende sessies als afgerond zodat de student de oude voortgang
    // terug kan vinden in de Afgerond-lijst.
    await supabaseAdmin.from('student_project_sessions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('student_id', auth.user.id).eq('project_id', projectId).neq('status', 'completed');

    // Verlaat alle actieve groepen voor dit project zodat een nieuwe sessie
    // niet in de oude groep terechtkomt. Lege groepen worden gearchiveerd
    // zodat ze niet meer als "actief" verschijnen voor de overige leden.
    const { data: myGroups } = await supabaseAdmin
      .from('project_group_members')
      .select('group_id, project_groups!inner(id, project_id, status)')
      .eq('user_id', auth.user.id);
    const groupIdsThisProject = (myGroups || [])
      .filter(g => g.project_groups && g.project_groups.project_id === projectId
        && g.project_groups.status !== 'archived')
      .map(g => g.group_id);
    for (const gid of groupIdsThisProject) {
      await supabaseAdmin.from('project_group_members')
        .delete().eq('group_id', gid).eq('user_id', auth.user.id);
      const { count } = await supabaseAdmin
        .from('project_group_members')
        .select('user_id', { count: 'exact', head: true }).eq('group_id', gid);
      if ((count || 0) === 0) {
        await supabaseAdmin.from('project_groups')
          .update({ status: 'archived' }).eq('id', gid);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Project-brede documenten (datasets/opdracht) — staff uploadt, alle leden
// van elke groep in dit project zien ze read-only en alle persona's krijgen
// de tekst automatisch als context.
// =============================================================================

app.get('/api/projects/:projectId/documents', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('*').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    if (!(await userHasProjectAccess(auth.user, profile, project))) {
      return res.status(403).json({ error: 'Geen toegang tot dit project' });
    }
    const isStaffDocs = await isStaffForCourse(auth.user, profile, project.course_id);
    let docsQuery = supabaseAdmin
      .from('project_documents')
      .select('id, filename, byte_size, mime_type, document_ref_id, is_visible_to_students, uploaded_by, created_at')
      .eq('project_id', projectId).order('created_at', { ascending: false });
    if (!isStaffDocs) docsQuery = docsQuery.eq('is_visible_to_students', true);
    const { data, error: e } = await docsQuery;
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ documents: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Binaire bestandstypes die wel gedownload mogen worden door studenten,
// maar NIET als chat-context worden geïnjecteerd (geen tekst-extractie).
// Jamovi (.omv) is hierin de eerste use-case.
const BINARY_DOWNLOAD_EXT_RE = /\.(omv|omt|sav|jasp|rdata|rds|sps|do|dta)$/i;

// Zoek of maak de cursus-Projectdata-map aan en geef het id terug.
// Structuur: [cursusmap] → Projectdata → [projectnaam] → bestanden
// courseId en uploadedById zijn verplicht; parentCourseId mag null zijn.
async function findOrCreateCourseProjectdataFolder(courseId, uploadedById) {
  if (!pgPool) return null;
  try {
    // Zoek een bestaande "Projectdata"-map die al gekoppeld is aan DEZE cursus
    // via course_folder_assignments (!inner join = alleen mappen mét koppeling).
    const { data: existingRows } = await supabaseAdmin
      .from('document_folders')
      .select('id, course_folder_assignments!inner(course_id)')
      .eq('name', 'Projectdata')
      .eq('course_folder_assignments.course_id', courseId)
      .limit(1);
    const existingId = existingRows?.[0]?.id;
    if (existingId) return existingId;

    // Geen map voor deze cursus — zoek de parent-cursusmap van DEZE cursus
    // (folder_type 'course' of 'general', gekoppeld via course_folder_assignments).
    const { data: courseAssigned } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id, document_folders!inner(id, folder_type)')
      .eq('course_id', courseId);
    const courseParent = (courseAssigned || []).find(
      a => a.document_folders?.folder_type === 'course' || a.document_folders?.folder_type === 'general'
    );
    let parentId = courseParent?.folder_id || null;

    // Geen cursusmap gevonden via assignments — weiger de aanmaak in plaats van
    // een zwevende map onder de globale root te creëren. Elke cursus moet een
    // expliciete course_folder_assignment hebben met een map van folder_type='course'.
    // Zie migratie 20260511130000 voor het opzetten van de correcte structuur.
    if (!parentId) {
      console.error(`[projectdata-folder] Cursus ${courseId} heeft geen cursusmap (folder_type='course') via course_folder_assignments. Stel de mapstructuur in via de admin-UI vóórdat projecten bestanden uploaden.`);
      return null;
    }

    // Subtree-fallback: als er al een "Projectdata"-map bestaat als direct kind
    // van de gevonden parent-map (maar zonder assignment-rij), gebruik die dan
    // en voeg alsnog de assignment toe — zo voorkomen we dubbele mappen.
    if (parentId) {
      const { data: subtreeRows } = await supabaseAdmin
        .from('document_folders')
        .select('id')
        .eq('name', 'Projectdata')
        .eq('parent_folder_id', parentId)
        .limit(1);
      const subtreeId = subtreeRows?.[0]?.id;
      if (subtreeId) {
        await supabaseAdmin.from('course_folder_assignments').upsert(
          { course_id: courseId, folder_id: subtreeId },
          { onConflict: 'course_id,folder_id', ignoreDuplicates: true }
        );
        console.log(`[projectdata-folder] Hergebruikt via subtree: ${subtreeId} voor cursus ${courseId}`);
        return subtreeId;
      }
    }


    const result = await pgPool.query(
      `INSERT INTO document_folders (name, description, parent_folder_id, created_by, folder_type, is_root)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['Projectdata', 'Projectdata — bestanden per project', parentId, uploadedById, 'data', false]
    );
    const folderId = result.rows[0]?.id;
    if (!folderId) return null;

    await pgPool.query(
      `INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
       VALUES ($1,'admin',true,true),($1,'docent',true,true),($1,'student',true,false)
       ON CONFLICT DO NOTHING`,
      [folderId]
    );
    await supabaseAdmin.from('course_folder_assignments').upsert(
      { course_id: courseId, folder_id: folderId },
      { onConflict: 'course_id,folder_id', ignoreDuplicates: true }
    );
    console.log(`[projectdata-folder] Projectdata aangemaakt: ${folderId} voor cursus ${courseId}`);
    return folderId;
  } catch (e) {
    console.error('[projectdata-folder] fout bij Projectdata-map:', e.message);
    return null;
  }
}

// Zoek of maak een per-project submap aan binnen de Projectdata-map.
// Geeft het subfolder-id terug (of null bij fout).
async function findOrCreateProjectSubfolder(projectId, projectTitle, uploadedById) {
  if (!pgPool) return null;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    if (!project?.course_id) return null;

    const projectdataId = await findOrCreateCourseProjectdataFolder(project.course_id, uploadedById);
    if (!projectdataId) return null;

    const safeName = String(projectTitle || '').slice(0, 200).trim() || projectId.slice(0, 36);

    // Zoek bestaande submap strikt op projectId in de description.
    // Fallback op naam alleen als de description-markering nog niet bestaat
    // (bijv. mappen aangemaakt vóór dit schema).
    const { data: existingSubs } = await supabaseAdmin
      .from('document_folders')
      .select('id, name, description')
      .eq('parent_folder_id', projectdataId);
    const byProjectId = (existingSubs || []).find(
      f => f.description && f.description.includes(`projectId:${projectId}`)
    );
    if (byProjectId?.id) return byProjectId.id;

    // Aanmaken via pg zodat RLS geen invloed heeft.
    // Sla projectId op in description zodat we later deterministisch kunnen opzoeken.
    const result = await pgPool.query(
      `INSERT INTO document_folders (name, description, parent_folder_id, created_by, folder_type, is_root)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [safeName, `Projectbestanden — projectId:${projectId}`, projectdataId, uploadedById, 'data', false]
    );
    const subfolderId = result.rows[0]?.id;
    if (!subfolderId) return null;

    await pgPool.query(
      `INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
       VALUES ($1,'admin',true,true),($1,'docent',true,true),($1,'student',true,false)
       ON CONFLICT DO NOTHING`,
      [subfolderId]
    );
    console.log(`[projectdata-folder] Projectsubmap aangemaakt: ${subfolderId} ("${safeName}")`);
    return subfolderId;
  } catch (e) {
    console.error('[projectdata-folder] fout bij projectsubmap:', e.message);
    return null;
  }
}

app.post('/api/projects/:projectId/documents', docUpload.single('file'), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  const filename = req.file.originalname || 'upload';
  const isBinaryDownload = BINARY_DOWNLOAD_EXT_RE.test(filename);
  let text = null;
  if (!isBinaryDownload) {
    try { text = await extractTextFromUpload(req.file); }
    catch (e) { return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' }); }
    if (!text || text.length === 0) return res.status(400).json({ error: 'Geen leesbare tekst gevonden in dit bestand' });
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + `\n\n…[afgekapt op ${MAX_DOC_CHARS.toLocaleString('nl-NL')} tekens]`;
    }
  }
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    let documentRefId = null;

    if (isBinaryDownload) {
      // Binaire bestanden worden in de `documents`-tabel opgeslagen zodat ze
      // zichtbaar zijn in de cursusboom. We gebruiken de directe pg-verbinding
      // zodat de bytea-kolom correct wordt gevuld (PostgREST snapt geen raw
      // Buffer via JSON).
      if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });

      const folderId = await findOrCreateProjectSubfolder(projectId, access.project?.title, auth.user.id);
      const mimeType = req.file.mimetype || 'application/octet-stream';
      const safeFilename = String(filename).slice(0, 200);

      const docResult = await pgPool.query(
        `INSERT INTO documents
           (title, filename, file_path, file_type, file_size, folder_id,
            uploaded_by, processing_status, total_chunks, file_bytes, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', 0, $8, $9)
         RETURNING id`,
        [
          safeFilename,
          safeFilename,
          '',                          // lege placeholder (file_path heeft default '')
          mimeType,
          req.file.size || 0,
          folderId,                    // null is ok als map niet aangemaakt kon worden
          auth.user.id,
          req.file.buffer,             // pg stuurt Buffer direct als bytea
          mimeType,
        ]
      );
      documentRefId = docResult.rows[0]?.id;
      if (!documentRefId) return res.status(500).json({ error: 'Kon bestandsrecord niet aanmaken' });
    } else if (pgPool && text) {
      // Tekst-bestanden krijgen ook een `documents`-tabel-entry zodat ze
      // zichtbaar zijn in de Projectdata-submap van de bestandsbeheerder.
      // Geen file_bytes — de inhoud wordt als content_text in project_documents
      // bewaard en via die rij gedownload.
      try {
        const folderId = await findOrCreateProjectSubfolder(projectId, access.project?.title, auth.user.id);
        const mimeType = req.file.mimetype || 'text/plain';
        const safeFilename = String(filename).slice(0, 200);
        const docResult = await pgPool.query(
          `INSERT INTO documents
             (title, filename, file_path, file_type, file_size, folder_id,
              uploaded_by, processing_status, total_chunks, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', 0, $8)
           RETURNING id`,
          [safeFilename, safeFilename, '', mimeType, req.file.size || 0, folderId, auth.user.id, mimeType]
        );
        documentRefId = docResult.rows[0]?.id || null;
        if (!documentRefId) console.warn('[project-doc upload] tekst-doc folder-entry aangemaakt maar geen id teruggekregen');
      } catch (e) {
        // Niet fataal: document_ref_id blijft null, bestand is wel opgeslagen.
        console.warn('[project-doc upload] tekst-doc folder-entry mislukt:', e.message);
      }
    }

    // Sla op in project_documents voor de project-eigen boekhoudingslijst.
    const { data, error: e } = await supabaseAdmin
      .from('project_documents').insert({
        project_id: projectId,
        filename: String(filename).slice(0, 200),
        content_text: text,
        byte_size: req.file.size || (text ? Buffer.byteLength(text, 'utf8') : 0),
        mime_type: req.file.mimetype || (isBinaryDownload ? 'application/octet-stream' : null),
        uploaded_by: auth.user.id,
        document_ref_id: documentRefId,
        is_visible_to_students: true,
      }).select('id, filename, byte_size, mime_type, document_ref_id, is_visible_to_students, uploaded_by, created_at').single();
    if (e) return res.status(500).json({ error: e.message });
    const folderLinkFailed = !isBinaryDownload && text && !data.document_ref_id;
    return res.json({ document: data, ...(folderLinkFailed ? { warning: 'Bestand opgeslagen, maar kon niet in de Projectdata-map worden geplaatst (controleer de serverlogs).' } : {}) });
  } catch (err) {
    console.error('[project-doc upload]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/documents/:docId/download — streamt het
// originele bestand. Toegankelijk voor groepsleden van het project en staff.
app.get('/api/projects/:projectId/documents/:docId/download', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, docId } = req.params;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    if (!(await userHasProjectAccess(auth.user, profile, project))) {
      return res.status(403).json({ error: 'Geen toegang tot dit project' });
    }
    const isStaffDl = await isStaffForCourse(auth.user, profile, project.course_id);
    const { data: doc } = await supabaseAdmin
      .from('project_documents')
      .select('filename, content_text, mime_type, document_ref_id, is_visible_to_students')
      .eq('id', docId).eq('project_id', projectId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    // Studenten mogen verborgen bestanden niet downloaden.
    if (!isStaffDl && !doc.is_visible_to_students) {
      return res.status(403).json({ error: 'Dit bestand is niet beschikbaar voor studenten' });
    }
    let buffer;
    let mimeType = doc.mime_type || 'application/octet-stream';
    if (doc.document_ref_id) {
      // Binair of tekst-bestand: zoek de documents-tabel-entry op.
      // Binair: file_bytes aanwezig → stuur die.
      // Tekst: file_bytes NULL → val terug op content_text uit project_documents.
      if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
      const result = await pgPool.query(
        'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
        [doc.document_ref_id]
      );
      if (result.rows[0]?.file_bytes) {
        buffer = result.rows[0].file_bytes;
        if (result.rows[0].mime_type) mimeType = result.rows[0].mime_type;
      } else if (doc.content_text != null) {
        // Tekst-bestand met folder-entry maar zonder file_bytes.
        buffer = Buffer.from(doc.content_text, 'utf8');
        mimeType = doc.mime_type || 'text/plain; charset=utf-8';
      } else {
        return res.status(404).json({ error: 'Bestandsinhoud niet gevonden' });
      }
    } else if (doc.content_text != null) {
      buffer = Buffer.from(doc.content_text, 'utf8');
      mimeType = doc.mime_type || 'text/plain; charset=utf-8';
    } else {
      return res.status(404).json({ error: 'Bestand bevat geen inhoud' });
    }
    const safeName = String(doc.filename || 'download').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return res.end(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:projectId/documents/:docId — zichtbaarheid voor studenten wijzigen
app.patch('/api/projects/:projectId/documents/:docId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, docId } = req.params;
  const { is_visible_to_students } = req.body;
  if (typeof is_visible_to_students !== 'boolean') {
    return res.status(400).json({ error: 'is_visible_to_students moet een boolean zijn' });
  }
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { data, error: e } = await supabaseAdmin
      .from('project_documents')
      .update({ is_visible_to_students })
      .eq('id', docId).eq('project_id', projectId)
      .select('id, is_visible_to_students').single();
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ document: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:projectId/documents/:docId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, docId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    // Haal eerst document_ref_id op zodat we de documents-rij ook kunnen verwijderen.
    const { data: docRow } = await supabaseAdmin
      .from('project_documents').select('document_ref_id')
      .eq('id', docId).eq('project_id', projectId).maybeSingle();
    const { error: e } = await supabaseAdmin
      .from('project_documents').delete()
      .eq('id', docId).eq('project_id', projectId);
    if (e) return res.status(500).json({ error: e.message });
    // Verwijder ook de bijbehorende rij in documents (binaire bestanden).
    if (docRow?.document_ref_id) {
      await supabaseAdmin.from('documents').delete().eq('id', docRow.document_ref_id);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Task #166 — Documentoordelen (Fase 1). Een evaluator-persona geeft een
// gestructureerd JSON-oordeel over een geüpload student-document. Het oordeel
// (verdict, reasoning, relationship_delta) wordt opgeslagen in
// project_document_reviews én gespiegeld in learning_journal_entries per
// groepslid (idempotent op source_ref).
// =============================================================================

const VERDICT_LABELS_NL = {
  accepted: 'Aanvaard',
  conditional: 'Onder voorwaarden',
  rejected: 'Afgewezen',
};

// Task #253: badge-labels + emoji voor journal-spiegeling (server-side weergave).
const BADGE_LABELS_NL = {
  platina: 'Platina',
  goud: 'Goud',
  zilver: 'Zilver',
  brons: 'Brons',
};
const BADGE_EMOJI = {
  platina: '💎',
  goud: '🥇',
  zilver: '🥈',
  brons: '🥉',
};

app.get('/api/projects/:projectId/documents/:docId/reviews', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, docId } = req.params;
  const groupId = req.query.groupId;
  if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    if (!(await userHasProjectAccess(auth.user, profile, project))) {
      return res.status(403).json({ error: 'Geen toegang tot dit project' });
    }
    // Coherentie-check: groep + document moeten écht bij dit project horen,
    // anders kan een docent uit project A reviews uit project B uitlezen door
    // een vreemde groupId/docId in de URL te zetten (IDOR).
    const [{ data: groupCheck }, { data: docCheck }] = await Promise.all([
      supabaseAdmin.from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle(),
      supabaseAdmin.from('project_documents').select('id, project_id').eq('id', docId).maybeSingle(),
    ]);
    if (!groupCheck || groupCheck.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
    }
    if (!docCheck || docCheck.project_id !== projectId) {
      return res.status(404).json({ error: 'Document niet gevonden in dit project' });
    }
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    const memberOfGroup = await isGroupMember(groupId, auth.user.id);
    if (!isStaff && !memberOfGroup) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }
    let { data, error: e } = await supabaseAdmin
      .from('project_document_reviews')
      .select('id, document_id, persona_id, group_id, verdict, grade, reasoning, feed_forward, relationship_delta, requested_by, created_at')
      .eq('document_id', docId).eq('group_id', groupId)
      .order('created_at', { ascending: false });
    // Defensief: oude DB zonder grade/feed_forward-kolommen.
    if (e && (e.code === '42703' || /grade|feed_forward/i.test(e.message || ''))) {
      ({ data, error: e } = await supabaseAdmin
        .from('project_document_reviews')
        .select('id, document_id, persona_id, group_id, verdict, reasoning, relationship_delta, requested_by, created_at')
        .eq('document_id', docId).eq('group_id', groupId)
        .order('created_at', { ascending: false }));
    }
    if (e) {
      // Tabel bestaat nog niet → defensief leeg antwoord met duidelijke uitleg.
      if (e.code === '42P01' || /project_document_reviews/i.test(e.message || '')) {
        return res.status(503).json({
          error: 'Migratie 20260528100000_project_document_reviews.sql is nog niet toegepast in Supabase.',
          reviews: [],
        });
      }
      return res.status(500).json({ error: e.message });
    }
    const reviews = data || [];
    // Task #253: badges per review voor deze groep ophalen. Studenten zien
    // alleen hun eigen badges; staff ziet ze allemaal.
    let badges = [];
    if (reviews.length > 0) {
      const reviewIds = reviews.map(r => r.id);
      let bq = supabaseAdmin
        .from('project_review_badges')
        .select('review_id, user_id, grade, badge, award_mode')
        .in('review_id', reviewIds);
      if (!isStaff) bq = bq.eq('user_id', auth.user.id);
      const { data: bData, error: bErr } = await bq;
      if (!bErr) badges = bData || [];
    }
    return res.json({ reviews, badges });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/documents/:docId/reviews', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, docId } = req.params;
  const { personaId, groupId, lang } = req.body || {};
  const reviewLang = normalizeLang(lang);
  if (!personaId || !groupId) {
    return res.status(400).json({ error: 'personaId en groupId zijn vereist' });
  }
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id, title, research_question, goals, briefing_markdown')
      .eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    const memberOfGroup = await isGroupMember(groupId, auth.user.id);
    const authzCheck = canRequestDocumentReview({ isStaff, isGroupMember: memberOfGroup });
    if (!authzCheck.allowed) {
      return res.status(authzCheck.status).json({ error: authzCheck.error });
    }

    // Groep moet bij dit project horen.
    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id, name').eq('id', groupId).maybeSingle();
    if (!group || group.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
    }

    // Persona moet evaluator zijn én bij dit project horen.
    let { data: persona } = await supabaseAdmin
      .from('project_personas').select('id, project_id, name, avatar_emoji, system_prompt, persona_type, badge_award_mode')
      .eq('id', personaId).maybeSingle();
    // Defensief: oude DB zonder badge_award_mode-kolom.
    if (!persona) {
      ({ data: persona } = await supabaseAdmin
        .from('project_personas').select('id, project_id, name, avatar_emoji, system_prompt, persona_type')
        .eq('id', personaId).maybeSingle());
    }
    if (!persona || persona.project_id !== projectId) {
      return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
    }
    if (persona.persona_type !== 'evaluator') {
      return res.status(400).json({ error: 'Alleen evaluator-persona\'s kunnen oordelen afgeven' });
    }

    // Document moet bij dit project horen en moet tekst-extraheerbaar zijn.
    const { data: doc } = await supabaseAdmin
      .from('project_documents')
      .select('id, project_id, filename, content_text, is_visible_to_students')
      .eq('id', docId).eq('project_id', projectId).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
    if (BINARY_DOWNLOAD_EXT_RE.test(doc.filename || '')) {
      return res.status(400).json({
        error: 'Dit bestand is binair (bv. Jamovi/SPSS) — daarover kan geen tekstueel oordeel worden gegeven.',
      });
    }
    if (!doc.content_text || !doc.content_text.trim()) {
      return res.status(400).json({ error: 'Document bevat geen leesbare tekst om te beoordelen' });
    }
    if (!isStaff && !doc.is_visible_to_students) {
      return res.status(403).json({ error: 'Dit document is niet zichtbaar voor studenten' });
    }

    // Hidden rubrics van deze evaluator (alleen verborgen — voorkomt
    // prompt-injection via door studenten geüploade rubric-bestanden).
    const { data: rubricDocs } = await supabaseAdmin
      .from('project_persona_documents').select('filename, content_text')
      .eq('project_id', projectId).eq('persona_id', persona.id)
      .eq('is_hidden_rubric', true);
    const rubricBlock = (rubricDocs || []).map(d =>
      `[Rubric: ${d.filename}]\n${(d.content_text || '').slice(0, 6000)}`
    ).join('\n\n').slice(0, 20000);

    // Actieve document_review-prompt uit chatbot_prompts (sectie 'project').
    const { data: drPromptRow } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('content')
      .eq('section', 'project').eq('name', 'document_review')
      .maybeSingle();
    const systemTemplate = (drPromptRow?.content || DEFAULT_DOCUMENT_REVIEW_PROMPT).trim();

    const documentText = doc.content_text.slice(0, 20000);
    const personaIntro = (persona.system_prompt || '').trim();

    const userBlock = `Persona-achtergrond:
${personaIntro || '(geen extra persona-instructies)'}

Project: ${project.title || '(naamloos)'}
Onderzoeksvraag: ${project.research_question || '(geen)'}
Leerdoelen: ${project.goals || '(geen)'}

Verborgen rubric/criteria (alleen voor jou):
${rubricBlock || '(geen rubric-bestand gekoppeld; gebruik dan de leerdoelen hierboven)'}

Groep: ${group.name}

Studentdocument "${doc.filename}":
${documentText}

Geef nu je oordeel als JSON-object volgens het eerder beschreven schema.`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

    // Roep de LLM aan in JSON-mode. Bij ongeldig JSON-antwoord doen we één
    // retry met een striktere herinnering; daarna geven we netjes op.
    async function callModel(extraReminder) {
      const messages = [
        { role: 'system', content: systemTemplate + buildLanguageInstruction(reviewLang, { json: true }) },
        { role: 'user', content: userBlock + (extraReminder ? `\n\n${extraReminder}` : '') },
      ];
      const r = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages,
        response_format: { type: 'json_object' },
        ...chatModelParams({ temperature: 0.2, maxTokens: 800 }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Taalmodel-fout (${r.status}): ${txt.slice(0, 200)}`);
      }
      const j = await r.json();
      return (j.choices?.[0]?.message?.content || '').trim();
    }

    let rawResponse;
    let validation;
    try {
      rawResponse = await callModel(null);
      validation = validateReviewResponse(rawResponse);
      if (!validation.ok) {
        rawResponse = await callModel(`Je vorige antwoord was ongeldig: ${validation.error}. Antwoord nu uitsluitend met het JSON-object volgens het schema.`);
        validation = validateReviewResponse(rawResponse);
      }
    } catch (modelErr) {
      return res.status(502).json({ error: modelErr.message });
    }
    if (!validation.ok) {
      return res.status(502).json({
        error: `Persona gaf geen geldig JSON-oordeel: ${validation.error}`,
        raw: rawResponse?.slice(0, 500),
      });
    }

    // Task #253: bepaal de badge deterministisch uit het cijfer.
    const grade = validation.value.grade;
    const feedForward = validation.value.feed_forward || '';
    const badge = badgeForGrade(grade);
    const awardMode = normalizeBadgeAwardMode(persona.badge_award_mode);

    // Persisteer review. Cijfer + feed-forward worden meegeschreven; bij een
    // oude DB zonder die kolommen valt de insert terug op het oude schema.
    const reviewRow = {
      document_id: docId,
      persona_id: persona.id,
      group_id: groupId,
      verdict: validation.value.verdict,
      grade,
      reasoning: validation.value.reasoning,
      feed_forward: feedForward,
      relationship_delta: validation.value.relationship_delta,
      requested_by: auth.user.id,
      raw_llm_response: { content: rawResponse },
    };
    const reviewCols = 'id, document_id, persona_id, group_id, verdict, grade, reasoning, feed_forward, relationship_delta, requested_by, created_at';
    let { data: inserted, error: insErr } = await supabaseAdmin
      .from('project_document_reviews').insert(reviewRow).select(reviewCols).single();
    if (insErr && (insErr.code === '42703' || /grade|feed_forward/i.test(insErr.message || ''))) {
      const { grade: _g, feed_forward: _f, ...rowNoGrade } = reviewRow;
      ({ data: inserted, error: insErr } = await supabaseAdmin
        .from('project_document_reviews').insert(rowNoGrade)
        .select('id, document_id, persona_id, group_id, verdict, reasoning, relationship_delta, requested_by, created_at').single());
    }
    if (insErr) {
      if (insErr.code === '42P01') {
        return res.status(503).json({
          error: 'Migratie 20260528100000_project_document_reviews.sql is nog niet toegepast in Supabase.',
        });
      }
      return res.status(500).json({ error: insErr.message });
    }

    const { data: groupMembers } = await supabaseAdmin
      .from('project_group_members').select('user_id').eq('group_id', groupId);
    const docReviewCourseId = await courseIdForProject(projectId);

    // Task #253: ken badge-rijen toe. group → elk groepslid; individual → alleen
    // de indienende student (mits groepslid). Idempotent via unique(review_id,user_id).
    let badgeRecipients = [];
    if (badge) {
      const memberIds = (groupMembers || []).map(m => m.user_id);
      if (awardMode === 'group') {
        badgeRecipients = memberIds;
      } else if (memberIds.includes(auth.user.id)) {
        badgeRecipients = [auth.user.id];
      }
      if (badgeRecipients.length > 0) {
        const badgeRows = badgeRecipients.map(uid => ({
          review_id: inserted.id,
          persona_id: persona.id,
          group_id: groupId,
          user_id: uid,
          grade,
          badge,
          award_mode: awardMode,
        }));
        const { error: bErr } = await supabaseAdmin.from('project_review_badges').insert(badgeRows);
        if (bErr && bErr.code !== '23505' && bErr.code !== '42P01') {
          console.warn('[document_review] badge-toekenning mislukte:', bErr.message);
        }
      }
    }

    // Spiegel in journal per groepslid (idempotent op source_ref). Het cijfer,
    // de feedback én feed-forward gaan mee; de badge alleen voor de ontvangers.
    const sourceRef = `document_review:${docId}:${persona.id}:${inserted.id}`;
    const verdictLabel = VERDICT_LABELS_NL[validation.value.verdict] || validation.value.verdict;
    const gradeStr = Number.isFinite(Number(grade)) ? Number(grade).toFixed(1).replace('.', ',') : null;
    const badgeLabelNl = badge ? (BADGE_LABELS_NL[badge] || badge) : null;
    const titleBase = gradeStr
      ? `${persona.avatar_emoji || '🧑‍⚖️'} Cijfer ${gradeStr} (${verdictLabel}) — ${persona.name} over "${doc.filename}"`
      : `${persona.avatar_emoji || '🧑‍⚖️'} Oordeel ${verdictLabel} — ${persona.name} over "${doc.filename}"`;
    const contentParts = [];
    if (gradeStr) contentParts.push(`Cijfer: ${gradeStr}`);
    contentParts.push(`Feedback: ${validation.value.reasoning}`);
    if (feedForward) contentParts.push(`Feed-forward: ${feedForward}`);
    const journalContentBase = contentParts.join('\n\n');
    const badgeRecipientSet = new Set(badgeRecipients);
    const rows = (groupMembers || []).map(m => {
      const hasBadge = badge && badgeRecipientSet.has(m.user_id);
      return {
        user_id: m.user_id,
        title: hasBadge ? `${BADGE_EMOJI[badge] || '🏅'} ${titleBase}` : titleBase,
        content: hasBadge
          ? `${journalContentBase}\n\nBadge: ${BADGE_EMOJI[badge] || '🏅'} ${badgeLabelNl}`
          : journalContentBase,
        activity_type: 'project_reflection',
        source_ref: sourceRef,
        course_id: docReviewCourseId,
      };
    });
    if (rows.length > 0) {
      const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert(rows);
      if (jErr) {
        // Defensief: source_ref-kolom kan ontbreken in oudere DBs, en unique
        // violation duidt op idempotentie (dubbele post).
        if (jErr.code === '42703' || /source_ref/i.test(jErr.message || '')) {
          await supabaseAdmin.from('learning_journal_entries').insert(
            rows.map(({ source_ref: _ignored, ...rest }) => rest)
          );
        } else if (jErr.code !== '23505') {
          console.warn('[document_review] journal-spiegeling mislukte:', jErr.message);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Task #167: persoonlijke relatie-score bijwerken op basis van de
    // relationship_delta. Idempotent op review-id (refId). Best-effort:
    // valt stil terug als de tabel nog niet bestaat (migratie ontbreekt).
    // ────────────────────────────────────────────────────────────────────
    try {
      await applyRelationshipDelta({
        projectId,
        groupId,
        personaId: persona.id,
        delta: validation.value.relationship_delta,
        event: {
          source: 'document_review',
          refId: inserted.id,
          delta: validation.value.relationship_delta,
          note: validation.value.verdict,
        },
      });
    } catch (relErr) {
      console.warn('[document_review] relationship-update mislukte:', relErr.message);
    }

    return res.json({
      review: { ...inserted, badge: badge || null, award_mode: awardMode, badge_recipients: badgeRecipients },
    });
  } catch (err) {
    console.error('[document_review]', err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Task #167 — Persona-relaties (Fase 2). Eén rij per (project, groep, persona)
// met score (-10..+10) + history-events. Deltas komen uit Fase 1 of uit een
// handmatige staff-correctie. De huidige staat wordt geïnjecteerd in de
// systeemprompt van elke persona-chat en gate't nieuwe turns bij score ≤ -8.
// =============================================================================

// Pas een delta toe op de relatie en append history. Idempotent: als
// event.refId al in history zit (zelfde source+refId), wordt niets bijgewerkt.
// Race-safe (Task #171, Fase 2-fix uit architect-review): gebruikt pgPool
// voor een atomic INSERT … ON CONFLICT DO UPDATE met arithmetic op score en
// `jsonb` history-concat — zo gaan twee parallelle deltas (bv. close + review
// op hetzelfde moment) niet verloren. Retourneert de bijgewerkte rij of null
// als de tabel nog niet bestaat. Bij conflict-loss op de WHERE-clausule
// (idempotente hit) wordt 1× herlezen.
async function applyRelationshipDelta(args) {
  return applyRelationshipDeltaImpl({ supabaseAdmin, pgPool }, args);
}

// Lees de huidige relatie-rij of geef een neutrale defaults-rij terug.
async function loadRelationship(projectId, groupId, personaId) {
  if (!supabaseAdmin) return { score: 0, history: [] };
  const { data, error } = await supabaseAdmin
    .from('project_persona_relationships')
    .select('score, history')
    .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01' || /project_persona_relationships/i.test(error.message || '')) {
      return { score: 0, history: [] };
    }
    throw error;
  }
  return {
    score: data?.score ?? 0,
    history: Array.isArray(data?.history) ? data.history : [],
  };
}

// GET /api/projects/:projectId/groups/:groupId/relationships — overzicht per
// project-persona. Staff krijgt score + laatste 5 history-events; studenten
// krijgen alleen score+label (geen exact getal in UI; getal blijft hier
// voor consistentie maar de student-UI toont enkel het label).
app.get('/api/projects/:projectId/groups/:groupId/relationships', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, groupId } = req.params;
  const lang = normalizeLang(req.query.lang);
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    const memberOfGroup = await isGroupMember(groupId, auth.user.id);
    if (!isStaff && !memberOfGroup) {
      return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }
    const { data: groupCheck } = await supabaseAdmin
      .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
    if (!groupCheck || groupCheck.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
    }
    const { data: personas } = await supabaseAdmin
      .from('project_personas')
      .select('id, name, avatar_emoji, persona_type, sort_order')
      .eq('project_id', projectId)
      .order('sort_order');
    const personaList = personas || [];
    const { data: rels, error: relErr } = await supabaseAdmin
      .from('project_persona_relationships')
      .select('persona_id, score, history, updated_at')
      .eq('project_id', projectId).eq('group_id', groupId);
    if (relErr && !(relErr.code === '42P01' || /project_persona_relationships/i.test(relErr.message || ''))) {
      return res.status(500).json({ error: relErr.message });
    }
    const byPersona = new Map((rels || []).map(r => [r.persona_id, r]));
    const out = personaList.map(p => {
      const r = byPersona.get(p.id);
      const score = r?.score ?? 0;
      const history = Array.isArray(r?.history) ? r.history : [];
      const recent = history.slice(-5).reverse();
      return {
        personaId: p.id,
        personaName: p.name,
        avatarEmoji: p.avatar_emoji,
        personaType: p.persona_type || 'conversational',
        score: isStaff ? score : null,
        bucket: relScoreToBucket(score),
        label: relScoreToLabel(score, lang),
        blocked: relIsBlocked(score),
        updatedAt: r?.updated_at || null,
        history: isStaff ? recent : recent.map(e => ({
          ts: e?.ts || null,
          source: e?.source || null,
        })),
      };
    });
    return res.json({ relationships: out, isStaff });
  } catch (err) {
    console.error('[relationships]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust
// — staff-only handmatige correctie van de relatie. Route + autorisatie zijn
// geëxtraheerd naar server/relationshipAdjust.js (Task #178) zodat de wiring
// naar applyRelationshipDelta en de staff-check geïntegreerd testbaar zijn.
registerRelationshipAdjustRoute(app, {
  supabaseAdmin,
  authUser,
  isStaffForCourse,
  applyRelationshipDelta,
  scoreToBucket: relScoreToBucket,
});

// POST /api/projects/:projectId/groups/:groupId/personas/:personaId/consultations-grant
// — Task #252: staff-only toekenning van EXTRA raadplegingen voor één groep.
// `extra` is het absolute aantal extra raadplegingen (0..1000) bovenop
// persona.max_consultations. Idempotente upsert per (project, groep, persona).
app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/consultations-grant', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, groupId, personaId } = req.params;
  const extra = conNormalizeExtra(req.body?.extra);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
    if (!isStaff) return res.status(403).json({ error: 'Alleen staff van deze cursus mag raadplegingen toekennen' });

    const { data: groupCheck } = await supabaseAdmin
      .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
    if (!groupCheck || groupCheck.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
    }
    const { data: personaCheck } = await supabaseAdmin
      .from('project_personas').select('id, project_id, max_consultations').eq('id', personaId).maybeSingle();
    if (!personaCheck || personaCheck.project_id !== projectId) {
      return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
    }

    const { data: grant, error: gErr } = await supabaseAdmin
      .from('project_persona_consultation_grants')
      .upsert({
        project_id: projectId, group_id: groupId, persona_id: personaId,
        extra_consultations: extra, note,
        granted_by: auth.user.id, updated_at: new Date().toISOString(),
      }, { onConflict: 'project_id,group_id,persona_id' })
      .select('extra_consultations, note, updated_at').single();
    if (gErr) {
      if (gErr.code === '42P01' || /project_persona_consultation_grants/i.test(gErr.message || '')) {
        return res.status(503).json({
          error: 'Migratie 20260608120000_persona_consultation_limits.sql is nog niet toegepast in Supabase.',
        });
      }
      return res.status(500).json({ error: gErr.message });
    }

    // Verbruik herberekenen voor directe UI-update.
    let used = 0;
    try { used = await countConsultations(groupId, personaId); } catch { /* best-effort */ }
    const limit = conComputeEffectiveLimit(personaCheck.max_consultations, grant.extra_consultations);
    return res.json({
      consultation: {
        personaId,
        used,
        extra: grant.extra_consultations,
        baseLimit: conNormalizeMax(personaCheck.max_consultations),
        limit,
        remaining: conComputeRemaining(used, limit),
        blocked: conIsBlocked(used, limit),
        note: grant.note,
        updated_at: grant.updated_at,
      },
    });
  } catch (err) {
    console.error('[consultations-grant]', err);
    return res.status(500).json({ error: err.message });
  }
});


// =============================================================================
// Projectproduct-inleveringen (Task #156). Eén bestand per groep is de huidige
// regel — vervangen vervangt door een nieuwe rij + verwijdert oudere rijen
// voor dezelfde (project, groep). Architectuur staat versie-historie toe als
// het beleid later verandert (geen UNIQUE op (project_id, group_id)).
// =============================================================================

const SUBMISSION_MAX_BYTES = 15 * 1024 * 1024;
const SUBMISSION_ACCEPT_RE = /\.(pdf|docx|pptx|xlsx|odt|ods|odp|zip|txt|md|markdown|csv|tsv|json|rtf|jpg|jpeg|png|html|htm)$/i;

// GET /api/projects/:projectId/submissions?groupId=X
//   - groupId opgegeven: lijst voor die groep (lid of staff).
//   - geen groupId: alleen staff — alle groepen van het project.
async function listProjectSubmissionsHandler(req, res) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  const { groupId } = req.query;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id, submissions_enabled').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    // 'Staff' = admin/superuser OF docent met cursus-lidmaatschap. Een docent
    // van een andere cursus mag deze submissions niet zien.
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    const isCourseStaff = isAdmin
      || (project.course_id && await isCourseTeacher(auth.user.id, project.course_id));

    if (!isCourseStaff) {
      // Niet-staff: moet lid zijn van de opgevraagde groep.
      if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
      const member = await isGroupMember(groupId, auth.user.id);
      if (!member) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }

    let q = supabaseAdmin
      .from('project_submissions')
      .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (groupId) q = q.eq('group_id', groupId);
    const { data, error: e } = await q;
    if (e) return res.status(500).json({ error: e.message });

    const rows = data || [];
    const uploaderIds = Array.from(new Set(rows.map(r => r.uploaded_by).filter(Boolean)));
    let uploaderMap = new Map();
    if (uploaderIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, email, full_name').in('id', uploaderIds);
      uploaderMap = new Map((profs || []).map(p => [p.id, p]));
    }
    return res.json({
      submissions: rows.map(s => {
        const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
        return {
          id: s.id,
          project_id: s.project_id,
          group_id: s.group_id,
          group_name: s.project_groups?.name || null,
          uploaded_by: s.uploaded_by,
          uploaded_by_name: up?.full_name || up?.email || null,
          uploaded_by_email: up?.email || null,
          filename: s.filename,
          mime_type: s.mime_type,
          byte_size: s.byte_size,
          created_at: s.created_at,
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

app.get('/api/projects/:projectId/submissions', listProjectSubmissionsHandler);

// POST /api/projects/:projectId/submissions — student uploadt projectproduct
// voor de eigen groep. Vervangt eventuele oudere rij(en) voor deze groep.
async function uploadProjectSubmissionHandler(req, res) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  const groupId = req.body?.groupId;
  if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  const filename = String(req.file.originalname || 'upload').slice(0, 200);
  if (!SUBMISSION_ACCEPT_RE.test(filename)) {
    return res.status(400).json({ error: 'Niet-ondersteund bestandstype' });
  }
  if ((req.file.size || 0) > SUBMISSION_MAX_BYTES) {
    return res.status(400).json({ error: 'Bestand te groot (max 15 MB)' });
  }

  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, submissions_enabled, status').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    if (!project.submissions_enabled) {
      return res.status(403).json({ error: 'Inleveren is niet ingeschakeld voor dit project' });
    }
    if (project.status && project.status !== 'active') {
      return res.status(403).json({ error: 'Project is niet meer actief' });
    }

    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id, status').eq('id', groupId).maybeSingle();
    if (!group || group.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden voor dit project' });
    }
    if (group.status === 'archived') {
      return res.status(403).json({ error: 'Groep is gearchiveerd' });
    }

    const member = await isGroupMember(groupId, auth.user.id);
    if (!member) return res.status(403).json({ error: 'Je bent geen lid van deze groep' });

    // Vervang oudere inleveringen in één transactie: nieuwe rij invoegen,
    // dan alle eerdere rijen voor deze (project, groep) verwijderen.
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const insRes = await client.query(
        `INSERT INTO project_submissions
           (project_id, group_id, uploaded_by, filename, mime_type, file_bytes, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at`,
        [
          projectId, groupId, auth.user.id, filename,
          req.file.mimetype || 'application/octet-stream',
          req.file.buffer,
          req.file.size || 0,
        ]
      );
      const newId = insRes.rows[0].id;
      await client.query(
        'DELETE FROM project_submissions WHERE project_id = $1 AND group_id = $2 AND id <> $3',
        [projectId, groupId, newId]
      );
      await client.query('COMMIT');
      return res.json({ submission: insRes.rows[0] });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[project-submission POST]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
app.post('/api/projects/:projectId/submissions', docUpload.single('file'), uploadProjectSubmissionHandler);

// GET /api/projects/:projectId/submissions/:subId/download — leden van de
// groep + staff mogen downloaden.
app.get('/api/projects/:projectId/submissions/:subId/download', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, subId } = req.params;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    const isCourseStaff = isAdmin
      || (project.course_id && await isCourseTeacher(auth.user.id, project.course_id));

    const { data: sub } = await supabaseAdmin
      .from('project_submissions')
      .select('id, project_id, group_id, filename, mime_type')
      .eq('id', subId).eq('project_id', projectId).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'Inlevering niet gevonden' });

    if (!isCourseStaff) {
      const member = await isGroupMember(sub.group_id, auth.user.id);
      if (!member) return res.status(403).json({ error: 'Geen toegang tot deze inlevering' });
    }

    const result = await pgPool.query(
      'SELECT file_bytes, mime_type FROM project_submissions WHERE id = $1',
      [subId]
    );
    const buffer = result.rows[0]?.file_bytes;
    if (!buffer) return res.status(404).json({ error: 'Bestandsinhoud niet gevonden' });
    const mimeType = result.rows[0]?.mime_type || sub.mime_type || 'application/octet-stream';
    const safeName = String(sub.filename || 'download').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return res.end(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:projectId/submissions/:subId — alleen staff.
app.delete('/api/projects/:projectId/submissions/:subId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, subId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { error: e } = await supabaseAdmin
      .from('project_submissions').delete()
      .eq('id', subId).eq('project_id', projectId);
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Alias-routes (taakcontract): /api/projects/:projectId/groups/:groupId/submissions
// — semantisch identiek aan ?groupId=... maar als pad-parameter. We hergebruiken
// de handlers direct (geen interne re-dispatch) zodat multer maar één keer
// langs de multipart-stream gaat.
app.get('/api/projects/:projectId/groups/:groupId/submissions', (req, res) => {
  req.query.groupId = req.params.groupId;
  return listProjectSubmissionsHandler(req, res);
});
app.post('/api/projects/:projectId/groups/:groupId/submissions', docUpload.single('file'), (req, res) => {
  req.body = req.body || {};
  req.body.groupId = req.params.groupId;
  return uploadProjectSubmissionHandler(req, res);
});

// GET /api/admin/courses/:courseId/submissions — cursus-brede staff overzicht:
// alle inleveringen van alle projecten van deze cursus, met groep- en
// project-context. Alleen admin/superuser of docent met course_members-record.
app.get('/api/admin/courses/:courseId/submissions', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { courseId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    const isCourseStaff = isAdmin
      || (await isCourseTeacher(auth.user.id, courseId));
    if (!isCourseStaff) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });

    const { data: projects } = await supabaseAdmin
      .from('projects').select('id, title').eq('course_id', courseId);
    const projectIds = (projects || []).map(p => p.id);
    if (!projectIds.length) return res.json({ submissions: [] });
    const projectMap = new Map((projects || []).map(p => [p.id, p]));

    const { data: rows, error: e } = await supabaseAdmin
      .from('project_submissions')
      .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false });
    if (e) return res.status(500).json({ error: e.message });

    const uploaderIds = Array.from(new Set((rows || []).map(r => r.uploaded_by).filter(Boolean)));
    let uploaderMap = new Map();
    if (uploaderIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, email, full_name').in('id', uploaderIds);
      uploaderMap = new Map((profs || []).map(p => [p.id, p]));
    }
    return res.json({
      submissions: (rows || []).map(s => {
        const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
        const proj = projectMap.get(s.project_id);
        return {
          id: s.id,
          project_id: s.project_id,
          project_title: proj?.title || null,
          group_id: s.group_id,
          group_name: s.project_groups?.name || null,
          uploaded_by: s.uploaded_by,
          uploaded_by_name: up?.full_name || up?.email || null,
          uploaded_by_email: up?.email || null,
          filename: s.filename,
          mime_type: s.mime_type,
          byte_size: s.byte_size,
          created_at: s.created_at,
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/uploads-folder/:folderId/submissions — staff browse-pad voor
// de Documenten-UI: resolve cursus via course_folder_assignments + folder_type
// 'uploads', delegeer dan naar de cursus-brede submissions-listing.
app.get('/api/admin/uploads-folder/:folderId/submissions', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { folderId } = req.params;
  try {
    const { data: folder } = await supabaseAdmin
      .from('document_folders').select('id, folder_type').eq('id', folderId).maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Map niet gevonden' });
    if (folder.folder_type !== 'uploads') {
      return res.status(400).json({ error: 'Map is geen Uploads-map' });
    }
    const { data: assign } = await supabaseAdmin
      .from('course_folder_assignments').select('course_id').eq('folder_id', folderId).maybeSingle();
    if (!assign) return res.status(404).json({ error: 'Uploads-map is niet aan een cursus gekoppeld' });
    const courseId = assign.course_id;

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    const isCourseStaff = isAdmin
      || (await isCourseTeacher(auth.user.id, courseId));
    if (!isCourseStaff) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });

    const { data: projects } = await supabaseAdmin
      .from('projects').select('id, title').eq('course_id', courseId);
    const projectIds = (projects || []).map(p => p.id);
    if (!projectIds.length) return res.json({ courseId, submissions: [] });
    const projectMap = new Map((projects || []).map(p => [p.id, p]));

    const { data: rows, error: e } = await supabaseAdmin
      .from('project_submissions')
      .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false });
    if (e) return res.status(500).json({ error: e.message });

    const uploaderIds = Array.from(new Set((rows || []).map(r => r.uploaded_by).filter(Boolean)));
    let uploaderMap = new Map();
    if (uploaderIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, email, full_name').in('id', uploaderIds);
      uploaderMap = new Map((profs || []).map(p => [p.id, p]));
    }
    return res.json({
      courseId,
      submissions: (rows || []).map(s => {
        const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
        const proj = projectMap.get(s.project_id);
        return {
          id: s.id,
          project_id: s.project_id,
          project_title: proj?.title || null,
          group_id: s.group_id,
          group_name: s.project_groups?.name || null,
          uploaded_by: s.uploaded_by,
          uploaded_by_name: up?.full_name || up?.email || null,
          uploaded_by_email: up?.email || null,
          filename: s.filename,
          mime_type: s.mime_type,
          byte_size: s.byte_size,
          created_at: s.created_at,
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Beoordeling opvragen — voor elke evaluator-persona van het project: rubric
// + alle persona-gesprekken van de groep + projectdocumenten naar OpenAI, en
// schrijf één journal-entry per groepslid per evaluator. Alleen leden of staff.
// =============================================================================

app.post('/api/projects/groups/:groupId/evaluate', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId } = req.params;
  const requestId = req.body?.requestId || null;
  const lang = req.body?.lang || 'nl';
  const enMode = lang !== 'nl';
  try {
    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id, name').eq('id', groupId).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isMember = await isGroupMember(groupId, auth.user.id);
    if (!isMember) {
      // Niet-leden moeten staff zijn ÉN aan dit specifieke project gekoppeld.
      // Dit voorkomt dat een docent uit een andere cursus een willekeurige
      // groep kan beoordelen.
      const access = await requireProjectStaff(group.project_id, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error || 'Geen toegang tot deze groep' });
    }
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, title, research_question, goals, briefing_markdown')
      .eq('id', group.project_id).maybeSingle();

    const { data: evaluators } = await supabaseAdmin
      .from('project_personas').select('*')
      .eq('project_id', group.project_id).eq('persona_type', 'evaluator');
    if (!evaluators || evaluators.length === 0) {
      return res.status(400).json({ error: 'Dit project heeft geen beoordelaar-persona' });
    }

    // Alle persona-gesprekken van de groep verzamelen.
    const { data: threads } = await supabaseAdmin
      .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);
    let conversationsBlock = '';
    for (const t of (threads || [])) {
      const { data: persona } = await supabaseAdmin
        .from('project_personas').select('name, persona_type')
        .eq('id', t.persona_id).maybeSingle();
      if (!persona || persona.persona_type === 'evaluator') continue;
      const { data: msgs } = await supabaseAdmin
        .from('group_persona_messages').select('role, content')
        .eq('thread_id', t.id).order('created_at', { ascending: true });
      if (!msgs || msgs.length === 0) continue;
      const transcript = msgs.map(m =>
        `${m.role === 'user' ? 'Student' : persona.name}: ${(m.content || '').slice(0, 1500)}`
      ).join('\n');
      conversationsBlock += `\n\n## Gesprek met ${persona.name}\n${transcript}`;
    }
    conversationsBlock = conversationsBlock.slice(0, 30000);

    const { data: pDocs } = await supabaseAdmin
      .from('project_documents').select('filename, content_text')
      .eq('project_id', group.project_id);
    const projectDocsBlock = (pDocs || []).map(d =>
      `[Projectdocument: ${d.filename}]\n${(d.content_text || '').slice(0, 4000)}`
    ).join('\n\n').slice(0, 20000);

    const { data: members } = await supabaseAdmin
      .from('project_group_members').select('user_id').eq('group_id', groupId);
    const evalCourseId = await courseIdForProject(group.project_id);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

    const results = [];
    for (const evalPersona of evaluators) {
      // Idempotency: als deze (groep, persona, requestId)-combinatie al een
      // journal-entry heeft, sla de OpenAI-call over — bespaart tokens en tijd
      // bij netwerk-retries van dezelfde knopdruk.
      if (requestId) {
        const sourceRefCandidate = `group_evaluate:${groupId}:${evalPersona.id}:${requestId}`;
        const { data: existingEntry } = await supabaseAdmin
          .from('learning_journal_entries')
          .select('id').eq('source_ref', sourceRefCandidate).limit(1);
        if (existingEntry && existingEntry.length > 0) {
          results.push({ persona: evalPersona.name, ok: true, alreadyExisted: true });
          continue;
        }
      }
      // Belangrijk: alleen verborgen rubrics meenemen — anders zouden door
      // studenten geüploade documenten de beoordeling kunnen sturen
      // (prompt-injection van formatieve assessment).
      const { data: rubricDocs } = await supabaseAdmin
        .from('project_persona_documents').select('filename, content_text')
        .eq('project_id', group.project_id).eq('persona_id', evalPersona.id)
        .eq('is_hidden_rubric', true);
      const rubricBlock = (rubricDocs || []).map(d =>
        `[Rubric/criteria: ${d.filename}]\n${(d.content_text || '').slice(0, 8000)}`
      ).join('\n\n').slice(0, 30000);

      const langInstruction = lang === 'nl'
        ? 'BELANGRIJK: Antwoord volledig in het Nederlands.'
        : `IMPORTANT: Respond entirely in ${languageEnglishName(lang)}.`;
      const defaultPersonaPrompt = enMode
        ? 'You are a formative assessor for a group of VU students (epi/biostat).'
        : 'Je bent een formatieve beoordelaar voor een groep VU-studenten epi/biostat.';
      const prompt = `${evalPersona.system_prompt || defaultPersonaPrompt}

${langInstruction}

${enMode
  ? `Below you will find the learning objectives/rubric (for your eyes only — students cannot see this), the project material, and all conversations the group has had with the other personas. Provide a formative assessment per learning objective/criterion. Address the students as "you" (plural).

Project: ${project?.title || '(unnamed)'}
Research question: ${project?.research_question || '(none)'}
Learning objectives: ${project?.goals || '(none)'}

Hidden rubric/criteria:
${rubricBlock || '(no rubric file linked; use the learning objectives above)'}

Project material:
${projectDocsBlock || '(none)'}

Group conversations:
${conversationsBlock || '(no conversations found)'}

Write your assessment as markdown with per criterion:
- **<criterion name>** (strong / sufficient / needs attention): 2–3 sentences of feedback with a concrete example from the conversations.

End with a short heading "Next steps" with 2-3 suggestions. Do NOT quote exact rubric text and do not spoil the criteria.`
  : `Je krijgt hieronder de leerdoelen/rubric (alléén voor jou — de studenten zien deze niet), het projectmateriaal, en alle gesprekken die de groep met de andere persona's heeft gevoerd. Geef een formatieve beoordeling per leerdoel/criterium. Spreek de studenten aan met "jullie".

Project: ${project?.title || '(naamloos)'}
Onderzoeksvraag: ${project?.research_question || '(geen)'}
Leerdoelen: ${project?.goals || '(geen)'}

Verborgen rubric/criteria:
${rubricBlock || '(geen rubric-bestand gekoppeld; gebruik dan de leerdoelen hierboven)'}

Projectmateriaal:
${projectDocsBlock || '(geen)'}

Gesprekken van de groep:
${conversationsBlock || '(geen gesprekken gevonden)'}

Schrijf je beoordeling als markdown met per criterium:
- **<naam criterium>** (sterk / voldoende / aandacht nodig): 2–3 zinnen feedback met concreet voorbeeld uit de gesprekken.

Sluit af met een kort kopje "Vervolgstappen" met 2-3 suggesties. Noem GEEN exacte rubric-tekst letterlijk en spoiler de criteria niet.`}`;

      const gr = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        ...chatModelParams({ temperature: 0.4, maxTokens: 1800 }),
      });
      if (!gr.ok) {
        const txt = await gr.text();
        results.push({ persona: evalPersona.name, ok: false, error: `Taalmodel-fout (${gr.status}): ${txt.slice(0, 200)}` });
        continue;
      }
      const gd = await gr.json();
      const feedback = (gd.choices?.[0]?.message?.content || '').trim();
      if (!feedback) {
        results.push({ persona: evalPersona.name, ok: false, error: 'Leeg antwoord' });
        continue;
      }

      const sourceRef = `group_evaluate:${groupId}:${evalPersona.id}${requestId ? ':' + requestId : ''}`;
      const titleLabel = `${evalPersona.avatar_emoji || '🎓'} ${lang === 'nl' ? 'Beoordeling' : 'Assessment'} — ${evalPersona.name}`;
      const rows = (members || []).map(m => ({
        user_id: m.user_id,
        title: titleLabel,
        content: feedback,
        activity_type: 'project_reflection',
        source_ref: sourceRef,
        course_id: evalCourseId,
      }));
      if (rows.length > 0) {
        const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert(rows);
        if (jErr) {
          // Kolom source_ref ontbreekt nog (oudere DB) → schrijf zonder die kolom.
          // We controleren expliciet op de Postgres-foutcode 42703 (undefined column).
          if (jErr.code === '42703' || /source_ref/i.test(jErr.message || '')) {
            const { error: jErr2 } = await supabaseAdmin.from('learning_journal_entries').insert(
              rows.map(({ source_ref: _ignored, ...rest }) => rest)
            );
            if (jErr2) {
              results.push({ persona: evalPersona.name, ok: false, error: jErr2.message });
              continue;
            }
          } else if (jErr.code === '23505') {
            // Unique violation op source_ref → reeds aanwezig, geen fout.
            results.push({ persona: evalPersona.name, ok: true, alreadyExisted: true });
            continue;
          } else {
            results.push({ persona: evalPersona.name, ok: false, error: jErr.message });
            continue;
          }
        }
      }
      results.push({ persona: evalPersona.name, ok: true, length: feedback.length });
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[projects/groups/evaluate]', err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Kopieer een project-persona terug naar de cursus-bibliotheek (course_personas).
// Alleen staff. Idempotent: als er al een course_persona met dezelfde naam in
// dezelfde cursus bestaat, geven we die terug zonder duplicate.
// =============================================================================

app.post('/api/projects/:projectId/personas/:personaId/copy-to-library', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId, personaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    if (!isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen persona\'s naar de bibliotheek kopiëren' });
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const project = access.project;
    if (!project.course_id) return res.status(400).json({ error: 'Project hangt niet aan een cursus' });
    const { data: pp } = await supabaseAdmin
      .from('project_personas').select('*')
      .eq('id', personaId).eq('project_id', projectId).maybeSingle();
    if (!pp) return res.status(404).json({ error: 'Persona niet gevonden' });

    const { data: existing } = await supabaseAdmin
      .from('course_personas').select('id, name')
      .eq('course_id', project.course_id).eq('name', pp.name).maybeSingle();
    if (existing) return res.json({ persona: existing, alreadyExists: true });

    const libRow = {
      course_id: project.course_id,
      name: pp.name,
      avatar_emoji: pp.avatar_emoji,
      system_prompt: pp.system_prompt,
      rag_enabled: pp.rag_enabled,
      rag_folder_ids: pp.rag_folder_ids,
      visible_from_phase: pp.visible_from_phase,
      is_default: false,
      persona_type: pp.persona_type || 'conversational',
      // Task #253: badge-toekenningsmodus mee terug naar de bibliotheek.
      badge_award_mode: normalizeBadgeAwardMode(pp.badge_award_mode),
      created_by: auth.user.id,
    };
    let { data: inserted, error: iErr } = await supabaseAdmin
      .from('course_personas').insert(libRow).select('*').single();
    if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
      const { badge_award_mode: _b, ...rowNoBadge } = libRow;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('course_personas').insert(rowNoBadge).select('*').single());
    }
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.json({ persona: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Admin-only CRUD voor de persona-bibliotheek (course_personas).
// POST   /api/admin/course-personas          — nieuwe sjabloon aanmaken
// PATCH  /api/admin/course-personas/:id      — sjabloon bewerken
// DELETE /api/admin/course-personas/:id      — sjabloon verwijderen
// Alle drie uitsluitend voor admins (en superuser).
// =============================================================================

app.post('/api/admin/course-personas', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    if (!isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen bibliotheek-persona\'s aanmaken' });
    const { course_id, name, avatar_emoji, system_prompt, rag_enabled, rag_folder_ids, persona_type, badge_award_mode } = req.body || {};
    if (!course_id || !name?.trim()) return res.status(400).json({ error: 'course_id en name zijn verplicht' });
    const libRow = {
      course_id,
      name: String(name).trim(),
      avatar_emoji: avatar_emoji || '🤖',
      system_prompt: system_prompt || '',
      rag_enabled: rag_enabled !== false,
      rag_folder_ids: Array.isArray(rag_folder_ids) ? rag_folder_ids : [],
      is_default: false,
      persona_type: persona_type === 'evaluator' ? 'evaluator' : 'conversational',
      // Task #253: badge-toekenningsmodus (individual | group).
      badge_award_mode: normalizeBadgeAwardMode(badge_award_mode),
      created_by: auth.user.id,
    };
    let { data: inserted, error: iErr } = await supabaseAdmin
      .from('course_personas').insert(libRow).select('*').single();
    if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
      const { badge_award_mode: _b, ...rowNoBadge } = libRow;
      ({ data: inserted, error: iErr } = await supabaseAdmin
        .from('course_personas').insert(rowNoBadge).select('*').single());
    }
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.status(201).json({ persona: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/course-personas/:personaId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { personaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    if (!isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen bibliotheek-persona\'s bewerken' });
    const { name, avatar_emoji, system_prompt, rag_enabled, rag_folder_ids, persona_type, badge_award_mode } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim();
    if (avatar_emoji !== undefined) patch.avatar_emoji = avatar_emoji;
    if (system_prompt !== undefined) patch.system_prompt = system_prompt;
    if (rag_enabled !== undefined) patch.rag_enabled = rag_enabled;
    if (rag_folder_ids !== undefined) patch.rag_folder_ids = Array.isArray(rag_folder_ids) ? rag_folder_ids : [];
    if (persona_type !== undefined) patch.persona_type = persona_type === 'evaluator' ? 'evaluator' : 'conversational';
    if (badge_award_mode !== undefined) patch.badge_award_mode = normalizeBadgeAwardMode(badge_award_mode);
    let { data: updated, error: uErr } = await supabaseAdmin
      .from('course_personas').update(patch).eq('id', personaId).select('*').maybeSingle();
    if (uErr && (uErr.code === '42703' || /badge_award_mode/i.test(uErr.message || ''))) {
      const { badge_award_mode: _b, ...patchNoBadge } = patch;
      if (Object.keys(patchNoBadge).length === 0) return res.json({ persona: null });
      ({ data: updated, error: uErr } = await supabaseAdmin
        .from('course_personas').update(patchNoBadge).eq('id', personaId).select('*').maybeSingle());
    }
    if (uErr) return res.status(500).json({ error: uErr.message });
    if (!updated) return res.status(404).json({ error: 'Persona niet gevonden' });
    return res.json({ persona: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/course-personas/:personaId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { personaId } = req.params;
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    if (!isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen bibliotheek-persona\'s verwijderen' });
    const { error: delErr } = await supabaseAdmin
      .from('course_personas').delete().eq('id', personaId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Serveer de gebouwde Vite-frontend als dist/index.html bestaat (productie).
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(path.join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// In de testomgeving importeren we de app zonder de poort te openen of de
// schema-detectie/seeding te draaien; integratietests mounten `app` zelf op een
// efemere poort (zie server/__tests__/chatEndpoint.test.js).
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[API Server] Running on port ${PORT}`);
    console.log(`[API Server] Chat-model: ${OPENAI_MODEL}`);
    if (AZURE_CHAT_READY) {
      console.log(`[API Server] Chat-provider: Azure OpenAI (deployment=${AZURE_OPENAI_DEPLOYMENT}, api-version=${AZURE_OPENAI_API_VERSION})`);
    } else {
      console.warn('[API Server] Azure OpenAI NIET geconfigureerd (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY) — chat-endpoints geven 503 tot dit is ingesteld.');
    }
    if (AZURE_EMBEDDINGS_READY) {
      console.log(`[API Server] Embedding-provider: Azure OpenAI (deployment=${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}, api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION})`);
    } else {
      console.warn('[API Server] Azure-embeddings NIET geconfigureerd (AZURE_OPENAI_EMBEDDING_DEPLOYMENT ontbreekt) — RAG/ingestie/concept-extractie geven 503 tot dit is ingesteld. Géén terugval naar publieke OpenAI.');
    }
    detectConceptsCourseIdColumn();
    detectCoursesStudentVisibleColumn();
    detectQuizAttemptsSchema();
    detectQuizSourcesSchema();
    detectConceptEvidenceSchema();
    initChatbotPromptSection();
    // Wacht kort tot promptsHasSection geinitialiseerd is alvorens quiz-prompts
    // aan te maken (initChatbotPromptSection draait async).
    setTimeout(() => { initQuizPromptDefaults(); }, 2000);
  });
}

export { app };
