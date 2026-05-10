import express from 'express';
import cors from 'cors';
import multer from 'multer';
import officeParserPkg from 'officeparser';
const parseOfficeAsync = (buffer) => new Promise((resolve, reject) => {
  officeParserPkg.parseOffice(buffer, (data, err) => {
    if (err) reject(err); else resolve(data);
  });
});
import { createClient } from '@supabase/supabase-js';
import { expandQuery } from './queryExpansion.js';

// 15 MB ruwe upload-cap; tekstextractie kan kleiner uitkomen en wordt
// daarna nog eens beperkt door MAX_DOC_CHARS.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const app = express();
const PORT = process.env.API_PORT || 3001;

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

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

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
async function searchChunksServerSide(queryText, threshold, matchCount, allowedFolderIds, expansion) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || !supabaseAdmin) return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };

  // Expliciet lege toegestane mappen → geen toegang
  if (Array.isArray(allowedFolderIds) && allowedFolderIds.length === 0) {
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };
  }

  // Verrijk de zoekterm wanneer expansion-opties zijn meegegeven (synoniemen,
  // definitie, key_points). Dit geeft het embedding-model meer signaal voor
  // korte Nederlandse vaktermen waar text-embedding-3-small anders laag scoort.
  const embedQuery = (expansion && expansion.enabled)
    ? expandQuery(queryText, { definition: expansion.definition, keyPoints: expansion.keyPoints })
    : queryText;

  try {
    const embRes = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: [embedQuery] }),
    });
    if (!embRes.ok) return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    const embData = await embRes.json();
    const embedding = embData.data?.[0]?.embedding;
    if (!embedding) return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };

    const { data: allChunks, error } = await supabaseAdmin.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: 0,
      match_count: Math.max(matchCount * 3, 15),
    });
    if (error || !allChunks) return { matched: [], maxScore: 0, candidatesInAllowed: 0 };

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

// Task #52 (Quiz-omgeving herontwerp fase 1) breidt quiz_attempts uit met
// nieuwe kolommen (topics text[], difficulty, question_type, questions_data,
// answers, score_percentage, created_at). Detecteer of de migratie
// `20260430120000_extend_quiz_attempts_for_multi_type.sql` is toegepast,
// zodat /api/quiz/archive en de nieuwe insert-flow vroegtijdig en duidelijk
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
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'GROQ_API_KEY not configured on server' });
  }

  const {
    messages = [],
    context,
    model = 'llama-3.3-70b-versatile',
    temperature = 0.7,
    top_p = 1,
    stream = false,
    max_tokens,
    skipSystemPrompt = false,
    ragStrictMode = false,
    systemPromptOverride,
  } = req.body;

  const userMessages = Array.isArray(messages) ? messages.filter(m => m.role !== 'system') : [];

  let finalMessages;
  if (skipSystemPrompt) {
    if (systemPromptOverride) {
      finalMessages = [{ role: 'system', content: systemPromptOverride }, ...userMessages];
    } else {
      finalMessages = userMessages;
    }
  } else {
    let systemPromptContent = FALLBACK_SYSTEM_PROMPT;
    if (supabaseAdmin) {
      try {
        let promptQuery = supabaseAdmin
          .from('chatbot_prompts')
          .select('content')
          .eq('is_active', true)
          .not('name', 'like', '__rag_settings%');
        if (promptsHasSection) {
          promptQuery = promptQuery.eq('section', 'chat');
        }
        const { data: promptData, error: promptError } = await promptQuery.maybeSingle();
        if (promptError) {
          console.warn('[/api/chat] Prompt ophalen mislukt, fallback gebruikt:', promptError.message);
        } else if (promptData?.content) {
          systemPromptContent = promptData.content;
          console.log('[/api/chat] Actieve chat-prompt uit database geladen');
        } else {
          console.warn('[/api/chat] Geen actieve chat-prompt in database — fallback gebruikt');
        }
      } catch (err) {
        console.warn('[/api/chat] Prompt ophalen exception, fallback gebruikt:', err.message);
      }
    }
    let systemContent;
    if (ragStrictMode) {
      if (context) {
        systemContent = `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}${RAG_STRICT_INSTRUCTION}`;
      } else {
        systemContent = `${systemPromptContent}${RAG_STRICT_INSTRUCTION}\n\nEr zijn geen relevante cursusteksten gevonden voor deze vraag. Informeer de student hierover.`;
      }
    } else {
      systemContent = context
        ? `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}`
        : systemPromptContent;
    }
    finalMessages = [{ role: 'system', content: systemContent }, ...userMessages];
  }

  const groqBody = {
    model,
    messages: finalMessages,
    temperature,
    max_tokens: max_tokens ?? 512,
    top_p,
    stream,
  };

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(groqBody),
    });

    const data = await response.json();
    if (!response.ok) {
      const promptChars = JSON.stringify(finalMessages).length;
      const errCode = data?.error?.code || data?.error?.type || 'unknown';
      // Log de volledige Groq error-body (afgekapt op 2000 tekens om logs niet
      // op te blazen) zodat we exact zien wat Groq teruggaf.
      const bodyStr = (() => {
        try { return JSON.stringify(data); } catch { return String(data); }
      })();
      console.error(`[/api/chat] Groq error status=${response.status} code=${errCode} promptChars=${promptChars} body=${bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + '…[truncated]' : bodyStr}`);
      return res.status(response.status).json(data);
    }
    return res.json(data);
  } catch (err) {
    console.error('[/api/chat] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/chat/archive', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header vereist' });
  }

  const { conversationId, generateSummary = false } = req.body;
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
      const apiKey = process.env.GROQ_API_KEY;

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

        const chatText = msgs
          .filter(m => m.role !== 'system')
          .map(m => `${m.role === 'user' ? 'Jij' : 'Tutor'}: ${m.content}`)
          .join('\n\n');

        const sourcesText = ragSources.size > 0
          ? `\n\nGebruikte cursusbronnen in dit gesprek: ${[...ragSources].join(', ')}`
          : '';

        const summaryPrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Analyseer het volgende studiegesprek en schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

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

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`;

        if (apiKey) {
          try {
            const groqResp = await fetch(GROQ_API_URL, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: summaryPrompt }],
                temperature: 0.5,
                max_tokens: 600,
              }),
            });

            if (groqResp.ok) {
              const groqData = await groqResp.json();
              const summaryContent = groqData.choices?.[0]?.message?.content;
              if (summaryContent) {
                const { data: entry, error: journalError } = await supabaseAdmin
                  .from('learning_journal_entries')
                  .insert({
                    user_id: user.id,
                    title: `Chatreflectie: ${conversation.title}`,
                    content: summaryContent,
                    activity_type: 'chat_reflection',
                  })
                  .select('id')
                  .single();

                if (journalError) {
                  console.error('[archive] Journal insert error:', journalError);
                } else {
                  journalEntryId = entry.id;
                  console.log(`[archive] Journal entry aangemaakt: ${journalEntryId}`);
                }
              }
            } else {
              console.error('[archive] Groq fout:', groqResp.status, await groqResp.text());
            }
          } catch (groqErr) {
            console.error('[archive] Groq request mislukt:', groqErr.message);
          }
        } else {
          console.warn('[archive] GROQ_API_KEY niet beschikbaar — samenvatting overgeslagen');
        }
      }
    }

    const summaryCreated = generateSummary && journalEntryId !== null;
    const summaryFailed = generateSummary && journalEntryId === null;

    const { error: archiveError } = await supabaseAdmin
      .from('conversations')
      .update({ status: 'archived' })
      .eq('id', conversationId)
      .eq('user_id', user.id);

    if (archiveError) {
      return res.status(500).json({ error: `Archiveren mislukt: ${archiveError.message}` });
    }

    console.log(`[archive] Gesprek ${conversationId} gearchiveerd (summaryCreated: ${summaryCreated})`);
    return res.json({ success: true, journalEntryId, summaryCreated, summaryFailed });
  } catch (err) {
    console.error('[archive] Onverwachte fout:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/embeddings', async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!openaiKey) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });
  }

  const { texts } = req.body;
  if (!texts || !Array.isArray(texts)) {
    return res.status(400).json({ error: 'texts array required' });
  }

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('[/api/embeddings] OpenAI error response:', response.status, JSON.stringify(errData));
      return res.status(response.status).json({ error: errData.error?.message || errData.error || `OpenAI error ${response.status}` });
    }

    const data = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      console.error('[/api/embeddings] Unexpected OpenAI response shape:', JSON.stringify(data));
      return res.status(500).json({ error: 'Unexpected response from OpenAI embeddings API' });
    }
    const embeddings = data.data.map((item) => item.embedding);
    console.log(`[/api/embeddings] Generated ${embeddings.length} embeddings via OpenAI (dim=${embeddings[0]?.length})`);
    return res.json({ embeddings, provider: 'openai' });
  } catch (err) {
    console.error('[/api/embeddings] OpenAI request failed:', err.message);
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

    const isAllowed = profile && (
      profile.role === 'admin' ||
      profile.role === 'docent' ||
      profile.email === SUPERUSER_EMAIL
    );
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

    const isAllowed = profile && (
      profile.role === 'admin' ||
      profile.role === 'docent' ||
      profile.email === SUPERUSER_EMAIL
    );
    if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

    const { data, error } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('name')
      .like('name', '__rag_settings_%__')
      .neq('name', '__rag_settings_global__');
    if (error) throw new Error(error.message);
    const courseIds = (data || []).map(row => {
      const match = row.name.match(/^__rag_settings_(.+)__$/);
      return match ? match[1] : null;
    }).filter(Boolean);
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

    const isAllowed = profile && (
      profile.role === 'admin' ||
      profile.role === 'docent' ||
      profile.email === SUPERUSER_EMAIL
    );
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
    const isDocent = profile && profile.role === 'docent';
    if (!isAdmin && !isDocent) return res.status(403).json({ error: 'Onvoldoende rechten' });

    // Voor docenten: course-membership controleren wanneer een courseId is opgegeven,
    // anders kunnen ze willekeurige cursussen aftasten.
    if (isDocent && !isAdmin) {
      if (!courseId) {
        return res.status(403).json({ error: 'Docenten moeten een cursus opgeven om diagnose te draaien' });
      }
      const { data: membership, error: memberErr } = await supabaseAdmin
        .from('course_members')
        .select('id')
        .eq('user_id', user.id)
        .eq('course_id', courseId)
        .maybeSingle();
      if (memberErr) {
        console.error('[test-rag-similarity] Course membership check error:', memberErr);
        return res.status(500).json({ error: 'Cursustoestemming kon niet worden gecontroleerd' });
      }
      if (!membership) {
        return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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

    const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
    const isDocent = profile?.role === 'docent';
    if (!isAdmin && !isDocent) return res.status(403).json({ error: 'Admin of docent rol vereist' });

    if (isDocent && !isAdmin) {
      const { data: membership } = await supabaseAdmin
        .from('course_members').select('id').eq('user_id', user.id).eq('course_id', courseId).maybeSingle();
      if (!membership) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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

    const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
    const isDocent = profile.role === 'docent';
    if (!isAdmin && !isDocent) {
      return res.status(403).json({ error: 'Admin of docent rol vereist' });
    }

    if (isDocent && !isAdmin) {
      const { data: membership, error: memberErr } = await supabaseAdmin
        .from('course_members')
        .select('id')
        .eq('user_id', user.id)
        .eq('course_id', courseId)
        .maybeSingle();
      if (memberErr) {
        console.error('[concepts-meta] Course membership check error:', memberErr);
        return res.status(500).json({ error: 'Cursustoestemming kon niet worden gecontroleerd' });
      }
      if (!membership) {
        return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      }
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

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return res.status(503).json({ error: 'GROQ_API_KEY not configured on server' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, replace = false, documentIds } = req.body;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }
  const filterDocIds = Array.isArray(documentIds) && documentIds.length > 0 ? documentIds : null;

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
    const isDocent = profile.role === 'docent';
    if (!isAdmin && !isDocent) {
      return res.status(403).json({ error: 'Admin of docent rol vereist' });
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
    async function runReplace() {
      if (!replace) return;
      if (conceptsHasCourseId) {
        const { error: delErr } = await supabaseAdmin
          .from('concepts')
          .delete()
          .eq('course_id', courseId)
          .contains('key_points', ['[RAG-geëxtraheerd uit cursusmateriaal]']);
        if (delErr) {
          console.error('[extract-concepts] Delete (replace) error:', delErr);
          throw new Error(`Verwijderen mislukt: ${delErr.message}`);
        }
        console.log(`[extract-concepts] Deleted extracted concepts for course ${courseId} (replace mode, course_id)`);
        return;
      }
      const { data: taggedConcepts, error: taggedErr } = await supabaseAdmin
        .from('concepts')
        .select('id, key_points')
        .contains('key_points', [courseMarker]);

      if (taggedErr) {
        console.error('[extract-concepts] Tagged concepts query error on replace:', taggedErr);
        throw new Error(`Ophalen mislukt: ${taggedErr.message}`);
      }

      const ragMarkerLocal = '[RAG-geëxtraheerd uit cursusmateriaal]';
      const toDeleteIds = [];
      const toUntag = [];

      for (const concept of taggedConcepts || []) {
        const isRagExtracted = (concept.key_points || []).includes(ragMarkerLocal);
        if (isRagExtracted) {
          toDeleteIds.push(concept.id);
        } else {
          toUntag.push({ id: concept.id, key_points: (concept.key_points || []).filter((kp) => kp !== courseMarker) });
        }
      }

      if (toDeleteIds.length > 0) {
        const { error: delErr } = await supabaseAdmin
          .from('concepts')
          .delete()
          .in('id', toDeleteIds);
        if (delErr) console.error('[extract-concepts] Delete (replace fallback) error:', delErr);
      }

      for (const u of toUntag) {
        await supabaseAdmin.from('concepts').update({ key_points: u.key_points }).eq('id', u.id);
      }

      console.log(`[extract-concepts] Replace (fallback): deleted ${toDeleteIds.length} RAG-extracted, untagged ${toUntag.length} seeds`);
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

    const extractionPrompt = `Je bent een expert in epidemiologie en biostatistiek aan de VU Amsterdam.

Analyseer de onderstaande tekst uit universitair cursusmateriaal. Identificeer ALLE relevante vakbegrippen die studenten moeten kennen en kunnen uitleggen — ook als ze slechts terloops of impliciet in de tekst voorkomen. Wees volledig en breed: liever 30 begrippen dan 10.

Geschikte begrippen omvatten (maar zijn niet beperkt tot):
- Epidemiologie: incidentie, prevalentie, relatief risico, odds ratio, attributief risico, confounding, effect modification, selectiebias, informatiebias, cohortonderzoek, patiënt-controleonderzoek, cross-sectioneel onderzoek, gerandomiseerd gecontroleerd onderzoek, ecologisch onderzoek, case report, surveillance, screening, sensitiviteit, specificiteit, positief voorspellende waarde, negatief voorspellende waarde, DAG (gerichte acyclische graaf), mediatie, effect modificatie, interactie
- Biostatistiek: gemiddelde, mediaan, standaarddeviatie, variantie, normaalverdeling, binomiale verdeling, Poisson-verdeling, betrouwbaarheidsinterval, p-waarde, nulhypothese, statistische toets, t-toets, chi-kwadraattoets, regressieanalyse, logistische regressie, Kaplan-Meier, log-rank toets, hazard ratio, steekproefomvang, power, type I fout, type II fout, effectgrootte, multiple testing

Geef elk gevonden begrip de volgende velden:
- name: de gangbare Nederlandse (of internationaal gebruikte) term
- category: precies "epidemiologie" of "biostatistiek"
- definition: een heldere definitie van 1-2 zinnen in het Nederlands

Geef UITSLUITEND een JSON-array terug, zonder extra tekst of uitleg:
[
  {"name": "Begrip naam", "category": "epidemiologie", "definition": "Definitie hier."}
]

CURSUSMATERIAAL:
${combinedText}`;

    // Groq heeft een tokens-per-minute-limiet; bij grote cursussen lopen
    // we daar snel tegenaan. We doen 1 retry met backoff (we lezen de
    // gevraagde wachttijd uit de foutmelding indien aanwezig). Als ook de
    // tweede poging faalt, geven we een Nederlandstalige melding terug
    // — en omdat de replace-stap pas later in deze handler draait,
    // verliest de cursus géén begrippen meer als de extractie crasht.
    async function callGroq(maxRetries = 1) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const resp = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: extractionPrompt }],
            temperature: 0.2,
            max_tokens: 6000,
          }),
        });
        if (resp.ok) return { resp, errData: null };
        const errData = await resp.json().catch(() => ({}));
        const isRateLimit = resp.status === 429 || errData?.error?.code === 'rate_limit_exceeded';
        if (!isRateLimit || attempt === maxRetries) return { resp, errData };
        const msg = errData?.error?.message || '';
        const m = msg.match(/try again in ([\d.]+)s/i);
        const waitMs = m ? Math.min(60000, Math.ceil(parseFloat(m[1]) * 1000) + 500) : 5000;
        console.warn(`[extract-concepts] Groq rate-limit, wacht ${waitMs}ms en probeer opnieuw…`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      return { resp: null, errData: { error: { message: 'Onbereikbaar' } } };
    }

    const { resp: llmResponse, errData: llmErrData } = await callGroq(1);

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
      console.error('[extract-concepts] JSON parse error:', parseErr, 'raw:', rawContent.slice(0, 200));
      return res.status(500).json({ error: 'Kon LLM-respons niet verwerken als JSON' });
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
        };
      })
    );

    const validConcepts = [];
    const rejectedConcepts = [];
    for (const r of verificationResults) {
      if (r.matchedCount >= minEvidence) {
        validConcepts.push(r.concept);
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

    // Niets te schrijven? Geef een duidelijke melding TERUG zonder de
    // bestaande begrippen weg te gooien. De gebruiker kan dan in
    // Beheer → RAG-instellingen → Extractie de drempels verlagen.
    if (validConcepts.length === 0) {
      const sampleNames = rejectedConcepts.slice(0, 6).map((r) => r.concept.name).join(', ');
      const msg = rawValidConcepts.length === 0
        ? 'De LLM vond geen begrippen in dit cursusmateriaal.'
        : `De LLM stelde ${rawValidConcepts.length} begrippen voor, maar geen enkele haalde de RAG-verificatiedrempel (similarity ≥ ${verifyThreshold.toFixed(2)}, ≥ ${minEvidence} chunks). Verlaag de drempels via Beheer → RAG-instellingen → Extractie en probeer opnieuw. Voorbeelden: ${sampleNames}.`;
      await writeRegenTimestamp().catch(() => {});
      return res.json({
        concepts: [],
        updated: 0,
        skipped: 0,
        verificationRejected: rejectedConcepts.length,
        candidatesFromLLM: rawValidConcepts.length,
        message: msg,
      });
    }

    // Volgorde: eerst inserten/updaten, daarna pas eventueel oude
    // RAG-begrippen wissen. Zo blijven bestaande begrippen behouden als
    // de schrijfactie zelf faalt (bv. transient DB-fout). In replace-modus
    // negeren we bestaande RAG-begrippen bij de duplicaat-check, want die
    // worden direct na de succesvolle insert weggegooid.
    const ragMarker = '[RAG-geëxtraheerd uit cursusmateriaal]';
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
        (existingForCourse || [])
          .filter((c) => !replace || !(c.key_points || []).includes(ragMarker))
          .map((c) => c.name.toLowerCase().trim())
      );

      const toInsert = [];
      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        if (alreadyByCourse.has(key)) { skipped++; continue; }
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
        const { data: ins, error: insertError } = await supabaseAdmin
          .from('concepts')
          .insert(toInsert)
          .select('id, name, category, definition');
        if (insertError) {
          console.error('[extract-concepts] Insert error (course_id path):', insertError);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
        }
        inserted = ins || [];
      }
    } else {
      const { data: allExisting } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points');

      const existingByName = new Map(
        (allExisting || []).map((c) => [c.name.toLowerCase().trim(), c])
      );

      const alreadyTaggedForCourse = new Set(
        (allExisting || [])
          .filter((c) => (c.key_points || []).includes(courseMarker))
          .filter((c) => !replace || !(c.key_points || []).includes(ragMarker))
          .map((c) => c.name.toLowerCase().trim())
      );

      const toInsert = [];
      const toUpdate = [];

      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        if (alreadyTaggedForCourse.has(key)) { skipped++; continue; }

        const existing = existingByName.get(key);
        // In replace-modus skipt de update-tak ook bestaande RAG-extracten;
        // die worden door runReplace() verwijderd, dus we voegen het begrip
        // gewoon opnieuw in.
        if (existing && !(replace && (existing.key_points || []).includes(ragMarker))) {
          const updatedKeyPoints = [...new Set([...(existing.key_points || []), courseMarker])];
          toUpdate.push({ id: existing.id, key_points: updatedKeyPoints });
        } else {
          toInsert.push({
            name: c.name.trim(),
            category: c.category,
            definition: c.definition.trim(),
            key_points: [courseMarker, ragMarker],
            examples: [],
          });
        }
      }

      for (const u of toUpdate) {
        const { error: updErr } = await supabaseAdmin
          .from('concepts')
          .update({ key_points: u.key_points })
          .eq('id', u.id);
        if (updErr) console.error('[extract-concepts] Update error:', updErr);
      }
      updatedCount = toUpdate.length;

      if (toInsert.length > 0) {
        const { data: ins, error: insertError } = await supabaseAdmin
          .from('concepts')
          .insert(toInsert)
          .select('id, name, category, definition');
        if (insertError) {
          console.error('[extract-concepts] Insert error (key_points path):', insertError);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
        }
        inserted = ins || [];
      }
    }

    // Schrijven gelukt — nu pas de oude RAG-begrippen wissen (replace-modus).
    // Als runReplace faalt, hebben we al een geslaagde insert; we loggen de
    // fout maar laten de nieuwe begrippen staan.
    try {
      await runReplace();
    } catch (replaceErr) {
      console.error('[extract-concepts] runReplace na insert mislukt:', replaceErr);
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
    return res.json(data || []);
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
    const isAdmin = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);

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
    const isAdmin = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);

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

    const { data, error } = await supabaseAdmin
      .from('student_explanations')
      .select('id, concept_id, version, created_at, concepts(id, name, category)')
      .eq('student_id', user.id)
      .order('created_at', { ascending: false });

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

app.post('/api/explain/archive', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { explanationId, generateSummary = true } = req.body;
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
      const apiKey = process.env.GROQ_API_KEY;
      const conceptName = row.concepts?.name || 'Onbekend begrip';
      const conceptDef = row.concepts?.definition || '';
      const keyPoints = Array.isArray(row.concepts?.key_points) ? row.concepts.key_points : [];
      const feedbackText = row.feedback?.content || (typeof row.feedback === 'string' ? row.feedback : '(geen feedback)');

      const summaryPrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft het begrip "${conceptName}" in eigen woorden uitgelegd en feedback ontvangen van de leerassistent. Schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

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

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`;

      if (apiKey) {
        try {
          const groqResp = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: summaryPrompt }],
              temperature: 0.5,
              max_tokens: 600,
            }),
          });

          if (groqResp.ok) {
            const groqData = await groqResp.json();
            const summaryContent = groqData.choices?.[0]?.message?.content;
            if (summaryContent) {
              const { data: entry, error: journalError } = await supabaseAdmin
                .from('learning_journal_entries')
                .insert({
                  user_id: user.id,
                  title: `Uitleg-reflectie: ${conceptName}`,
                  content: summaryContent,
                  activity_type: 'explanation_reflection',
                })
                .select('id')
                .single();

              if (journalError) {
                console.error('[explain/archive] Journal insert error:', journalError);
                summaryFailed = true;
              } else {
                journalEntryId = entry.id;
                console.log(`[explain/archive] Journal entry aangemaakt: ${journalEntryId}`);
              }
            } else {
              summaryFailed = true;
            }
          } else {
            console.error('[explain/archive] Groq fout:', groqResp.status, await groqResp.text());
            summaryFailed = true;
          }
        } catch (groqErr) {
          console.error('[explain/archive] Groq request mislukt:', groqErr.message);
          summaryFailed = true;
        }
      } else {
        console.warn('[explain/archive] GROQ_API_KEY niet beschikbaar — samenvatting overgeslagen');
        summaryFailed = true;
      }
    }

    // Verwijder de uitleg uit de actieve lijst
    const { error: delErr } = await supabaseAdmin
      .from('student_explanations')
      .delete()
      .eq('id', explanationId);

    if (delErr) {
      console.error('[explain/archive] kon uitleg niet verwijderen:', delErr);
      return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
    }

    return res.json({
      success: true,
      journalEntryId,
      summaryCreated: generateSummary && journalEntryId !== null,
      summaryFailed: generateSummary && summaryFailed,
    });
  } catch (err) {
    console.error('[explain/archive] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// ─── Gedeelde quiz-samenvattingsbouwer ──────────────────────────────────────
// Beide endpoints (/api/quiz/archive en /api/quiz/save-summary) gebruiken
// dezelfde notitie-stijl in het leerdagboek. De prompt schaalt mee in lengte
// en focus afhankelijk van het aantal vragen en het vraagtype: een korte
// 3-vragen meerkeuzequiz krijgt een compacte notitie van ~6 regels, een rijke
// 8-vragen open quiz krijgt een notitie tot ~18 regels met meer per-vraag-
// reflectie. De notitie spreekt de student altijd in de tweede persoon aan.
function buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage }) {
  const safeTopics = Array.isArray(topics) && topics.length > 0 ? topics : ['(geen onderwerp opgegeven)'];
  const topicsLabel = safeTopics.join(', ');
  const qType = questionType === 'open' || questionType === 'casus' ? questionType : 'mcq';
  const typeLabel = qType === 'mcq' ? 'meerkeuzevragen'
    : qType === 'open' ? 'open vragen'
    : 'casusvragen';
  const safeDifficulty = difficulty || 'gemiddeld';
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
      const sel = typeof a.selectedIndex === 'number' ? opts[a.selectedIndex] : '(niet beantwoord)';
      const correct = typeof q?.correctAnswer === 'number' ? opts[q.correctAnswer] : '(onbekend)';
      const status = a.isCorrect ? 'goed' : 'fout';
      return `Vraag ${i + 1}: ${qText}\n  - Jouw antwoord: ${sel} (${status})\n  - Correct: ${correct}`;
    }
    const ans = (a.text || '').trim() || '(geen antwoord)';
    const ev = a.evaluation || {};
    const fb = (ev.feedback || '').trim();
    const ff = (ev.feedforward || '').trim();
    const sc = ev.score != null ? `${ev.score}/100` : '(geen score)';
    const ctx = qType === 'casus' && q?.context ? `\n  - Casus: ${q.context}` : '';
    return `Vraag ${i + 1}: ${qText}${ctx}\n  - Jouw antwoord: ${ans}\n  - Score: ${sc}\n  - Feedback: ${fb}\n  - Feed forward: ${ff}`;
  }).join('\n\n');

  // Type-specifieke focusinstructie.
  const focusInstruction = qType === 'mcq'
    ? 'Focus op patronen: welke begrippen of denkstappen gingen goed, welke vroegen om correctie. Verwijs waar relevant naar specifieke vraagnummers.'
    : qType === 'open'
      ? 'Focus op de kwaliteit van je redenering: hoe expliciet maakte je je aannames, hoe nauwkeurig was je formulering, hoe goed onderbouw je conclusies? Wees concreet per vraag waar dat helpt.'
      : 'Focus op je klinisch-methodisch redeneren in de casus: hoe goed verbond je theorie met het scenario, welke methodische keuzes onderbouwde je, welke nuances liet je liggen? Wees concreet per casus waar dat helpt.';

  const summaryPrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft zojuist een AI-gegenereerde quiz afgerond. Schrijf een formatief reflectieverslag van ${minLines} tot ${maxLines} regels in het Nederlands, gericht aan de student zelf.

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

  return {
    summaryPrompt,
    topicsLabel,
    qType,
    typeLabel,
    minLines,
    maxLines,
  };
}

// Roept Groq aan met de gegeven prompt en schrijft de notitie weg in
// learning_journal_entries. Returnt {journalEntryId, summaryFailed, errorReason}.
async function generateAndSaveQuizSummary({ user, summaryPrompt, topicsLabel, qType, maxLines }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[quiz/summary] GROQ_API_KEY niet beschikbaar — samenvatting overgeslagen');
    return { journalEntryId: null, summaryFailed: true, errorReason: 'Geen taalmodel-toegang (GROQ_API_KEY ontbreekt).' };
  }
  // Token-budget evenredig aan maximale regels (≈ 50 tokens/regel marge).
  const maxTokens = Math.min(2000, Math.max(600, maxLines * 60));

  let summaryContent;
  try {
    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: summaryPrompt }],
        temperature: 0.5,
        max_tokens: maxTokens,
      }),
    });

    if (!groqResp.ok) {
      const txt = await groqResp.text();
      console.error('[quiz/summary] Groq fout:', groqResp.status, txt);
      return { journalEntryId: null, summaryFailed: true, errorReason: `Het taalmodel reageerde met status ${groqResp.status}.` };
    }
    const groqData = await groqResp.json();
    summaryContent = groqData.choices?.[0]?.message?.content;
    if (!summaryContent) {
      return { journalEntryId: null, summaryFailed: true, errorReason: 'Het taalmodel gaf een leeg antwoord.' };
    }
  } catch (groqErr) {
    console.error('[quiz/summary] Groq request mislukt:', groqErr.message);
    return { journalEntryId: null, summaryFailed: true, errorReason: groqErr.message };
  }

  const titleTopics = topicsLabel.length > 80 ? `${topicsLabel.slice(0, 77)}...` : topicsLabel;
  const typePrefix = qType === 'mcq' ? 'Meerkeuzequiz' : qType === 'open' ? 'Open quiz' : 'Casusquiz';
  const { data: entry, error: journalError } = await supabaseAdmin
    .from('learning_journal_entries')
    .insert({
      user_id: user.id,
      title: `${typePrefix}-reflectie: ${titleTopics}`,
      content: summaryContent,
      activity_type: 'quiz_reflection',
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

  const { topics, difficulty, questionType, questions, answers, scorePercentage } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions is vereist en mag niet leeg zijn' });
  }
  // Veiligheidsplafond op aantal vragen om abuse op een authenticated
  // Groq-genererend endpoint te beperken.
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

    const params = buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage });
    const result = await generateAndSaveQuizSummary({ user, ...params });

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

app.post('/api/quiz/archive', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  if (!quizAttemptsHasNewSchema) {
    return res.status(503).json({
      error: 'De quiz-database is nog niet bijgewerkt naar het nieuwe model. ' +
        'Pas migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql toe in Supabase en herstart de server.',
    });
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

  const { attemptId, generateSummary = true } = req.body;
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
      });
      const result = await generateAndSaveQuizSummary({ user, ...params });
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
      console.error('[quiz/archive] kon quizpoging niet verwijderen:', delErr);
      return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
    }

    return res.json({
      success: true,
      journalEntryId,
      summaryCreated: generateSummary && journalEntryId !== null,
      summaryFailed: generateSummary && summaryFailed,
    });
  } catch (err) {
    console.error('[quiz/archive] Onverwachte fout:', err);
    return res.status(500).json({ error: 'Interne fout' });
  }
});

// /api/projects/save-summary — vat een project (en de bijhorende sessie van
// de student) samen via Groq en bewaart het resultaat als een
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

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'De samenvatting kon niet worden opgesteld.',
        detail: 'Geen taalmodel-toegang (GROQ_API_KEY ontbreekt).',
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
    // leeg zijn, is er niets zinvols om te reflecteren en zou Groq de prompt
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
    // volloopt en we niet onnodig Groq-tokens verbruiken.
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
      const groqResp = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: summaryPrompt }],
          temperature: 0.5,
          max_tokens: 1000,
        }),
      });
      if (!groqResp.ok) {
        const txt = await groqResp.text();
        console.error('[projects/save-summary] Groq fout:', groqResp.status, txt);
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: `Het taalmodel reageerde met status ${groqResp.status}.`,
        });
      }
      const groqData = await groqResp.json();
      summaryContent = groqData.choices?.[0]?.message?.content;
      if (!summaryContent) {
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: 'Het taalmodel gaf een leeg antwoord.',
        });
      }
    } catch (groqErr) {
      console.error('[projects/save-summary] Groq request mislukt:', groqErr.message);
      return res.status(502).json({
        error: 'De samenvatting kon niet worden opgesteld.',
        detail: groqErr.message,
      });
    }

    const { data: entry, error: journalError } = await supabaseAdmin
      .from('learning_journal_entries')
      .insert({
        user_id: user.id,
        title: journalTitle,
        content: summaryContent,
        activity_type: 'project_reflection',
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
    if (!profile || !['admin', 'docent'].includes(profile.role)) {
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

app.get('/api/prompt/explain', async (req, res) => {
  if (!supabaseAdmin || !promptsHasSection) {
    return res.json({ content: DEFAULT_EXPLAIN_PROMPT });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('id, content')
      .eq('section', 'explain')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn('[/api/prompt/explain] Fout bij ophalen:', error.message);
      return res.json({ content: DEFAULT_EXPLAIN_PROMPT });
    }
    return res.json({ id: data?.id ?? null, content: data?.content ?? DEFAULT_EXPLAIN_PROMPT });
  } catch (err) {
    console.error('[/api/prompt/explain] Exception:', err.message);
    return res.json({ content: DEFAULT_EXPLAIN_PROMPT });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    groq: !!process.env.GROQ_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    github: !!process.env.GITHUB_TOKEN,
    supabase: !!process.env.SUPABASE_URL,
  });
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

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student in de gezondheidswetenschappen.`;

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

    await supabaseAdmin
      .from('chatbot_prompts')
      .update({ section: 'chat' })
      .not('name', 'like', '__rag_settings%')
      .not('section', 'in', '("explain","project")');

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

// Controleer of een gebruiker toegang heeft tot een specifieke cursus.
// Admins/superuser hebben altijd toegang; anderen moeten lid zijn via
// course_members. Geen cursus = geen toegang.
async function userHasCourseAccess(user, profile, courseId) {
  if (!courseId || !user) return false;
  const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
  if (isAdmin) return true;
  try {
    const { data: membership } = await supabaseAdmin
      .from('course_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('course_id', courseId)
      .maybeSingle();
    return !!membership;
  } catch {
    return false;
  }
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
    if (!profile || (!isSuperuser && !['admin', 'docent'].includes(profile.role))) {
      res.status(403).json({ error: 'Geen toegang' });
      return null;
    }
    return { user, profile, role: profile.role };
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
  try {
    const { data, error } = await supabaseAdmin
      .from('quiz_questions')
      .select('exsection_path, topic, subtopic, item_type')
      .eq('source', 'sharestats')
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
function normalizeMix(mix) {
  let r = Math.max(0, Math.min(100, parseInt(mix?.pct_rag, 10) || 0));
  let i = Math.max(0, Math.min(100, parseInt(mix?.pct_itembank, 10) || 0));
  let l = Math.max(0, Math.min(100, parseInt(mix?.pct_llm, 10) || 0));
  const sum = r + i + l;
  if (sum === 0) return { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };
  if (sum !== 100) {
    // Schaal naar 100 met afronding; corrigeer rest op de grootste.
    r = Math.round((r * 100) / sum);
    i = Math.round((i * 100) / sum);
    l = 100 - r - i;
  }
  return { pct_rag: r, pct_itembank: i, pct_llm: l };
}

app.get('/api/quiz-sources-mix/:courseId', async (req, res) => {
  // Lezen mag iedereen die toegang tot de cursus heeft (student of docent in
  // course_members, of admin/superuser).
  const auth = await requireAuthUser(req, res);
  if (!auth) return;
  const { courseId } = req.params;
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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
  if (!await userHasCourseAccess(auth.user, auth.profile, courseId)) {
    return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
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

    // Trek items met overlappende exsection_path. We halen kandidaten op met
    // het breedste segment (eerste segment) en filteren in JS op exact prefix-
    // match — dat is robuust ongeacht hoe de docent het pad heeft samengesteld.
    const firstSegments = [...new Set(sectionPaths.map(p => p[0]))];
    let candidatesQuery = supabaseAdmin
      .from('quiz_questions')
      .select('id, question_text, answer_options, correct_answer, explanation, sharestats_id, exsection_path, topic, subtopic, item_type, metadata')
      .eq('source', 'sharestats')
      .overlaps('exsection_path', firstSegments)
      .limit(500);
    // item_type-kolom is pas vanaf migratie 20260507130000 aanwezig.
    // Voor mcq: accepteer item_type='mcq' óf NULL (oude rijen zijn historisch
    // mchoice). Voor open: vereis expliciet item_type='open'.
    if (wantedItemType === 'mcq') {
      candidatesQuery = candidatesQuery.or('item_type.eq.mcq,item_type.is.null');
    } else {
      candidatesQuery = candidatesQuery.eq('item_type', 'open');
    }
    const { data: candidates, error: qErr } = await candidatesQuery;
    if (qErr) return res.status(500).json({ error: qErr.message });

    const matches = (candidates || []).filter(q => {
      const qPath = Array.isArray(q.exsection_path) ? q.exsection_path : [];
      return sectionPaths.some(target => {
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

    // Voor performance: één query met alle items waarvan eerste segment
    // overlapt, daarna in JS groeperen op concept.
    const allFirstSegments = [...new Set(
      (mapRows || [])
        .map(r => Array.isArray(r.exsection_path) && r.exsection_path.length > 0 ? r.exsection_path[0] : null)
        .filter(Boolean)
    )];
    let allItems = [];
    let itemsTruncated = false;
    const ITEM_HARD_LIMIT = 5000;
    if (allFirstSegments.length > 0) {
      const { data: items, count } = await supabaseAdmin
        .from('quiz_questions')
        .select('id, exsection_path, item_type', { count: 'exact' })
        .eq('source', 'sharestats')
        .overlaps('exsection_path', allFirstSegments)
        .limit(ITEM_HARD_LIMIT);
      allItems = items || [];
      if (typeof count === 'number' && count > ITEM_HARD_LIMIT) itemsTruncated = true;
    }

    const itembankCountByConcept = new Map();
    for (const cid of conceptIds) {
      const conceptMaps = (mapRows || []).filter(r => r.concept_id === cid);
      if (conceptMaps.length === 0) { itembankCountByConcept.set(cid, { total: 0, mcq: 0, open: 0 }); continue; }
      const targets = conceptMaps
        .map(m => Array.isArray(m.exsection_path) ? m.exsection_path : [])
        .filter(p => p.length > 0);
      let total = 0, mcq = 0, open = 0;
      for (const item of allItems) {
        const qPath = Array.isArray(item.exsection_path) ? item.exsection_path : [];
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY niet geconfigureerd');
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embeddings error: ${err}`);
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
  const { conceptName, conceptDefinition, topN = 3 } = req.body || {};
  if (!conceptName || typeof conceptName !== 'string') {
    return res.status(400).json({ error: 'conceptName is verplicht' });
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
      .eq('source', 'sharestats')
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

// Kopieert (idempotent) één course_persona naar project_personas. Geeft de
// resulterende project_persona-row terug, of null als de course-persona niet
// bestaat. Voorkomt dubbele kopieën door op (project_id, source_persona_id)
// te kijken.
async function ensureProjectPersonaFromCourse(projectId, coursePersonaId) {
  const { data: existing } = await supabaseAdmin
    .from('project_personas')
    .select('*')
    .eq('project_id', projectId)
    .eq('source_persona_id', coursePersonaId)
    .maybeSingle();
  if (existing) return existing;
  const { data: cp } = await supabaseAdmin
    .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
  if (!cp) return null;
  const { data: existingCount } = await supabaseAdmin
    .from('project_personas').select('id').eq('project_id', projectId);
  const sortOrder = (existingCount?.length || 0);
  const { data: inserted, error } = await supabaseAdmin
    .from('project_personas')
    .insert({
      project_id: projectId,
      source_persona_id: cp.id,
      name: cp.name,
      avatar_emoji: cp.avatar_emoji,
      system_prompt: cp.system_prompt,
      rag_enabled: cp.rag_enabled,
      rag_folder_ids: cp.rag_folder_ids,
      visible_from_phase: cp.visible_from_phase,
      sort_order: sortOrder,
    })
    .select('*').single();
  if (error) {
    // Mogelijk race-condition: probeer nogmaals te lezen.
    const { data: retry } = await supabaseAdmin
      .from('project_personas')
      .select('*')
      .eq('project_id', projectId)
      .eq('source_persona_id', coursePersonaId)
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
  const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const { data: projectDocs } = await supabaseAdmin
      .from('project_documents')
      .select('id, filename, byte_size, uploaded_by, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    return res.json({
      project, group, members, personas, checkpoints,
      projectDocuments: projectDocs || [],
      hasEvaluator: evaluatorCount > 0,
    });
  } catch (err) {
    console.error('[projects/:id/room]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/persona-chat — stuur een bericht naar een persona binnen
// een groep. Server zoekt/maakt thread, slaat user-bericht op, roept Groq aan
// (met optionele RAG via project.course_id en persona.rag_folder_ids), slaat
// assistant-antwoord op, en geeft beide terug.
app.post('/api/projects/persona-chat', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId, personaId, message } = req.body || {};
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

    // Thread ophalen of aanmaken (alleen voor echte persona's met uuid).
    let threadId = null;
    if (persona.id !== '__default__') {
      const { data: existingThread } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id').eq('group_id', groupId).eq('persona_id', persona.id).maybeSingle();
      if (existingThread) {
        threadId = existingThread.id;
      } else {
        const { data: newThread, error: tErr } = await supabaseAdmin
          .from('group_persona_threads')
          .insert({ group_id: groupId, persona_id: persona.id })
          .select('id').single();
        if (tErr) return res.status(500).json({ error: tErr.message });
        threadId = newThread.id;
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
        { enabled: cfg.query_expansion_enabled }
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
        .order('created_at', { ascending: true })
        .limit(10);
      if (pdocs && pdocs.length > 0) {
        projectDocContext = pdocs.map(d =>
          `[Projectdocument: ${d.filename}]\n${(d.content_text || '').slice(0, 6000)}`
        ).join('\n\n');
      }
    }

    const ragBlock = context ? `\n\nContext uit cursusmateriaal:\n${context}` : '';
    const docBlock = uploadedContext ? `\n\nGeüploade documenten van de groep:\n${uploadedContext}` : '';
    const projectDocBlock = projectDocContext ? `\n\nProjectmateriaal van de docent:\n${projectDocContext}` : '';
    const systemContent = `${persona.system_prompt}${ragBlock}${projectDocBlock}${docBlock}`;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GROQ_API_KEY niet beschikbaar' });
    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemContent },
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 700,
      }),
    });
    if (!groqResp.ok) {
      const txt = await groqResp.text();
      return res.status(502).json({ error: `Taalmodel-fout (${groqResp.status})`, detail: txt.slice(0, 500) });
    }
    const groqData = await groqResp.json();
    const reply = groqData.choices?.[0]?.message?.content || '(Geen antwoord)';

    if (threadId) {
      await supabaseAdmin.from('group_persona_messages').insert({
        thread_id: threadId,
        role: 'assistant',
        content: reply,
        rag_sources: ragSources,
      });
    }

    return res.json({ reply, ragSources, threadId });
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
    if (personaId === '__default__') return res.json({ messages: [] });
    const { data: thread } = await supabaseAdmin
      .from('group_persona_threads').select('id')
      .eq('group_id', groupId).eq('persona_id', personaId).maybeSingle();
    if (!thread) return res.json({ messages: [] });
    const { data: msgs } = await supabaseAdmin
      .from('group_persona_messages')
      .select('id, role, content, rag_sources, created_at, user_id')
      .eq('thread_id', thread.id).order('created_at', { ascending: true });
    return res.json({ messages: msgs || [] });
  } catch (err) {
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
  const { kind = 'checkpoint', reflection, requestId } = req.body || {};
  if (!['checkpoint', 'final'].includes(kind)) {
    return res.status(400).json({ error: "kind moet 'checkpoint' of 'final' zijn" });
  }
  if (!reflection || typeof reflection !== 'string' || reflection.trim().length < 20) {
    return res.status(400).json({ error: 'Reflectie van minimaal 20 tekens vereist' });
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

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GROQ_API_KEY niet beschikbaar' });

    const rubric = Array.isArray(project?.rubric_criteria) ? project.rubric_criteria : [];
    const rubricText = rubric.length > 0
      ? rubric.map((r, i) => typeof r === 'string' ? `${i + 1}. ${r}` : `${i + 1}. ${r.title || r.name || JSON.stringify(r)}`).join('\n')
      : '(geen rubriek beschikbaar)';

    let aiSummary = '';
    let rubricFeedback = null;

    if (kind === 'final') {
      const prompt = `Je bent een "critical friend" voor een groep VU-studenten epi/biostat. De groep heeft een onderzoeksproject afgerond en geeft hieronder een gezamenlijke eindreflectie. Beoordeel het werk per rubriekspunt — eerlijk, formatief en concreet. Spreek de groep aan met "jullie".

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

Geen tekst buiten de JSON.`;
      const groqResp = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4, max_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
      });
      if (!groqResp.ok) {
        const txt = await groqResp.text();
        return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
      }
      const data = await groqResp.json();
      const raw = data.choices?.[0]?.message?.content || '{}';
      try {
        rubricFeedback = JSON.parse(raw);
        aiSummary = rubricFeedback.samenvatting || '';
      } catch {
        aiSummary = raw;
      }
    } else {
      const prompt = `Je bent een "critical friend" voor een groep VU-studenten epi/biostat. Hieronder schrijft een groep een tussentijdse reflectie op hun project. Schrijf in 6-10 regels, in het Nederlands, gericht aan de groep ("jullie"), een formatief verslag: wat valt op aan jullie aanpak, waar zit nog twijfel of een gat, en welke concrete vervolgstap ligt voor de hand. Geen aanhef, geen afsluitende groet.

Project: ${project?.title || '(naamloos)'}
Reflectie:
${reflection}`;
      const groqResp = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5, max_tokens: 700,
        }),
      });
      if (!groqResp.ok) {
        const txt = await groqResp.text();
        return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
      }
      const data = await groqResp.json();
      aiSummary = data.choices?.[0]?.message?.content || '';
    }

    const insertRow = {
      group_id: groupId,
      kind,
      reflection,
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
      }));
      // Probeer met source_ref; bij ontbrekende kolom val terug zonder.
      const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert(rows);
      if (jErr && /source_ref/i.test(jErr.message || '')) {
        await supabaseAdmin.from('learning_journal_entries').insert(
          rows.map(({ source_ref, ...rest }) => rest)
        );
      }
    }

    // Per-persona-thread mini-samenvatting (4 regels), één journal-entry per
    // groepslid per thread met nieuwe berichten sinds vorige checkpoint van
    // dezelfde kind. Dedupe via source_ref = "group_thread_checkpoint:<cp.id>:<thread.id>".
    let threadSummariesAdded = 0;
    try {
      const apiKey2 = process.env.GROQ_API_KEY;
      const { data: prevCps } = await supabaseAdmin
        .from('group_checkpoints')
        .select('created_at')
        .eq('group_id', groupId)
        .lt('created_at', cp.created_at)
        .order('created_at', { ascending: false })
        .limit(1);
      const sinceTs = prevCps && prevCps[0] ? prevCps[0].created_at : '1970-01-01T00:00:00Z';

      const { data: threads } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id, persona_id')
        .eq('group_id', groupId);

      for (const t of (threads || [])) {
        const { data: newMsgs } = await supabaseAdmin
          .from('group_persona_messages')
          .select('role, content')
          .eq('thread_id', t.id)
          .gt('created_at', sinceTs)
          .order('created_at', { ascending: true });
        if (!newMsgs || newMsgs.length === 0) continue;

        const { data: persona } = await supabaseAdmin
          .from('project_personas').select('name, avatar_emoji')
          .eq('id', t.persona_id).maybeSingle();
        const personaName = persona?.name || 'Gesprek';
        const transcript = newMsgs.map(m =>
          `${m.role === 'user' ? 'Student' : personaName}: ${(m.content || '').slice(0, 1500)}`
        ).join('\n\n').slice(0, 12000);

        let summaryText = '';
        if (apiKey2) {
          try {
            const sumPrompt = `Vat het volgende gesprek met "${personaName}" samen in EXACT 4 korte regels. Spreek de student aan met "je"/"jij". Eerste regel: kernvraag. Tweede regel: belangrijkste inzicht. Derde regel: open punt of misvatting. Vierde regel: vervolgstap. Geen lijst-tekens, geen kop, alleen vier zinnen op aparte regels.\n\nGesprek:\n${transcript}`;
            const sr = await fetch(GROQ_API_URL, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey2}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: sumPrompt }],
                temperature: 0.3, max_tokens: 350,
              }),
            });
            if (sr.ok) {
              const sd = await sr.json();
              summaryText = (sd.choices?.[0]?.message?.content || '').trim();
            }
          } catch { /* val terug op eerste user-bericht */ }
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
        }));
        if (tRows.length > 0) {
          const { error: tjErr } = await supabaseAdmin.from('learning_journal_entries').insert(tRows);
          if (tjErr) {
            if (tjErr.code === '42703' || /column.*source_ref/i.test(tjErr.message || '')) {
              // Oude DB zonder source_ref-kolom: opnieuw zonder die kolom.
              await supabaseAdmin.from('learning_journal_entries').insert(
                tRows.map(({ source_ref: _ignored, ...rest }) => rest)
              );
              threadSummariesAdded += 1;
            } else if (tjErr.code === '23505') {
              // Reeds aanwezig — geen extra entry maar ook geen fout.
            } else {
              console.error('[checkpoint thread summary insert]', tjErr.message);
            }
          } else {
            threadSummariesAdded += 1;
          }
        }
      }
    } catch (e) {
      console.error('[checkpoint thread summaries]', e.message);
    }

    if (kind === 'final') {
      await supabaseAdmin.from('project_groups')
        .update({ status: 'finalized', finalized_at: new Date().toISOString() })
        .eq('id', groupId);
    }

    return res.json({ checkpoint: cp, threadSummariesAdded });
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
    const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
    if (!isStaff) return res.status(403).json({ error: 'Alleen docent/admin' });

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

    const rows = lib.map((p, i) => ({
      project_id: projectId,
      source_persona_id: p.id,
      name: p.name,
      avatar_emoji: p.avatar_emoji,
      system_prompt: p.system_prompt,
      rag_enabled: p.rag_enabled,
      rag_folder_ids: p.rag_folder_ids,
      visible_from_phase: p.visible_from_phase,
      sort_order: i,
    }));
    const { error: iErr } = await supabaseAdmin.from('project_personas').insert(rows);
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
  if (!profile || profile.role !== 'docent') {
    return { ok: false, status: 403, error: 'Alleen docent/admin' };
  }
  const { data: project } = await supabaseAdmin
    .from('projects').select('*').eq('id', projectId).maybeSingle();
  if (!project) return { ok: false, status: 404, error: 'Project niet gevonden' };
  if (!project.course_id) {
    return { ok: false, status: 403, error: 'Project zonder cursus is alleen door admin te beheren' };
  }
  if (!(await userHasCourseAccess(user, profile, project.course_id))) {
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
      'allow_self_signup', 'status'];
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
      // Voorkom dubbele kopie.
      const { data: dup } = await supabaseAdmin
        .from('project_personas').select('id')
        .eq('project_id', projectId).eq('source_persona_id', cp.id).maybeSingle();
      if (dup) return res.status(409).json({ error: 'Deze persona zit al in het project', personaId: dup.id });
      row = {
        project_id: projectId, source_persona_id: cp.id,
        name: cp.name, avatar_emoji: cp.avatar_emoji,
        system_prompt: cp.system_prompt, rag_enabled: cp.rag_enabled,
        rag_folder_ids: cp.rag_folder_ids, visible_from_phase: cp.visible_from_phase,
        sort_order: nextOrder,
        persona_type: cp.persona_type || 'conversational',
      };
    } else {
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is vereist' });
      const personaType = req.body?.persona_type === 'evaluator' ? 'evaluator' : 'conversational';
      row = {
        project_id: projectId, source_persona_id: null,
        name: String(name).trim(),
        avatar_emoji: avatar_emoji || '🤖',
        system_prompt: system_prompt || '',
        rag_enabled: rag_enabled !== false,
        rag_folder_ids: Array.isArray(rag_folder_ids) ? rag_folder_ids : [],
        sort_order: nextOrder,
        persona_type: personaType,
      };
    }
    const { data: inserted, error: iErr } = await supabaseAdmin
      .from('project_personas').insert(row).select('*').single();
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.json({ persona: inserted });
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

    const allowed = ['name', 'avatar_emoji', 'system_prompt', 'rag_enabled', 'rag_folder_ids', 'sort_order', 'persona_type'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.persona_type && !['conversational', 'evaluator'].includes(patch.persona_type)) {
      return res.status(400).json({ error: "persona_type moet 'conversational' of 'evaluator' zijn" });
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Geen wijzigingen' });
    const { data, error: e } = await supabaseAdmin
      .from('project_personas').update(patch)
      .eq('id', personaId).eq('project_id', projectId).select('*').single();
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
    let q = supabaseAdmin
      .from('project_persona_documents')
      .select('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric')
      .eq('project_id', projectId).eq('persona_id', personaId).eq('group_id', groupId);
    if (!isStaffViewer) q = q.eq('is_hidden_rubric', false);
    const { data, error: e } = await q.order('created_at', { ascending: false });
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
    const isStaffForProject = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const { data, error: e } = await supabaseAdmin
      .from('project_persona_documents').insert({
        project_id: projectId, persona_id: personaId, group_id: groupId,
        filename: String(filename).slice(0, 200),
        content_text: text, byte_size: req.file.size || Buffer.byteLength(text, 'utf8'),
        uploaded_by: auth.user.id,
        is_hidden_rubric: isHiddenRubric,
      }).select('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric').single();
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

// GET /api/projects/student-overview — lijst per cursus van projecten en
// laatste sessie-status. Wordt door /projects gebruikt voor de drie keuzes
// (start nieuw, vervolg laatste, herstart).
app.get('/api/projects/student-overview', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  try {
    // Cursussen waar de student lid van is.
    const { data: memberships } = await supabaseAdmin
      .from('course_members').select('course_id, courses(id, name)').eq('user_id', auth.user.id);
    const courseIds = (memberships || []).map(m => m.course_id).filter(Boolean);
    const courses = (memberships || []).map(m => m.courses).filter(Boolean);
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
    const { data: groupRows } = await supabaseAdmin
      .from('project_group_members')
      .select('group_id, project_groups!inner(id, project_id, name, status, invite_code)')
      .eq('user_id', auth.user.id);
    const groupsByProject = new Map();
    for (const g of (groupRows || [])) {
      const grp = g.project_groups;
      if (!grp) continue;
      const list = groupsByProject.get(grp.project_id) || [];
      list.push(grp);
      groupsByProject.set(grp.project_id, list);
    }

    const result = courses.map(c => {
      const cps = (projects || []).filter(p => p.course_id === c.id).map(p => {
        const pSessions = sessions.filter(s => s.project_id === p.id);
        const lastSession = pSessions[0] || null;
        const groups = groupsByProject.get(p.id) || [];
        const activeGroup = groups.find(g => g.status === 'active') || null;
        return { ...p, sessions: pSessions, lastSession, activeGroup };
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
    const isStaff = profile && (profile.role === 'admin' || profile.role === 'docent' || profile.email === SUPERUSER_EMAIL);
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
    const { data, error: e } = await supabaseAdmin
      .from('project_documents')
      .select('id, filename, byte_size, uploaded_by, created_at')
      .eq('project_id', projectId).order('created_at', { ascending: false });
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ documents: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/documents', docUpload.single('file'), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  let text;
  try { text = await extractTextFromUpload(req.file); }
  catch (e) { return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' }); }
  if (!text || text.length === 0) return res.status(400).json({ error: 'Geen leesbare tekst gevonden in dit bestand' });
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS) + `\n\n…[afgekapt op ${MAX_DOC_CHARS.toLocaleString('nl-NL')} tekens]`;
  }
  const filename = req.file.originalname || 'upload';
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
    const access = await requireProjectStaff(projectId, auth.user, profile);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { data, error: e } = await supabaseAdmin
      .from('project_documents').insert({
        project_id: projectId,
        filename: String(filename).slice(0, 200),
        content_text: text,
        byte_size: req.file.size || Buffer.byteLength(text, 'utf8'),
        uploaded_by: auth.user.id,
      }).select('id, filename, byte_size, uploaded_by, created_at').single();
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
    const { error: e } = await supabaseAdmin
      .from('project_documents').delete()
      .eq('id', docId).eq('project_id', projectId);
    if (e) return res.status(500).json({ error: e.message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Beoordeling opvragen — voor elke evaluator-persona van het project: rubric
// + alle persona-gesprekken van de groep + projectdocumenten naar Groq, en
// schrijf één journal-entry per groepslid per evaluator. Alleen leden of staff.
// =============================================================================

app.post('/api/projects/groups/:groupId/evaluate', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { groupId } = req.params;
  const requestId = req.body?.requestId || null;
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

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GROQ_API_KEY niet beschikbaar' });

    const results = [];
    for (const evalPersona of evaluators) {
      // Idempotency: als deze (groep, persona, requestId)-combinatie al een
      // journal-entry heeft, sla de Groq-call over — bespaart tokens en tijd
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
      const { data: rubricDocs } = await supabaseAdmin
        .from('project_persona_documents').select('filename, content_text')
        .eq('project_id', group.project_id).eq('persona_id', evalPersona.id);
      const rubricBlock = (rubricDocs || []).map(d =>
        `[Rubric/criteria: ${d.filename}]\n${(d.content_text || '').slice(0, 8000)}`
      ).join('\n\n').slice(0, 30000);

      const prompt = `${evalPersona.system_prompt || 'Je bent een formatieve beoordelaar voor een groep VU-studenten epi/biostat.'}

Je krijgt hieronder de leerdoelen/rubric (alléén voor jou — de studenten zien deze niet), het projectmateriaal, en alle gesprekken die de groep met de andere persona's heeft gevoerd. Geef een formatieve beoordeling per leerdoel/criterium. Spreek de studenten aan met "jullie".

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

Sluit af met een kort kopje "Vervolgstappen" met 2-3 suggesties. Noem GEEN exacte rubric-tekst letterlijk en spoiler de criteria niet.`;

      const gr = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4, max_tokens: 1800,
        }),
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
      const titleLabel = `${evalPersona.avatar_emoji || '🎓'} Beoordeling — ${evalPersona.name}`;
      const rows = (members || []).map(m => ({
        user_id: m.user_id,
        title: titleLabel,
        content: feedback,
        activity_type: 'project_reflection',
        source_ref: sourceRef,
      }));
      if (rows.length > 0) {
        const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert(rows);
        if (jErr) {
          // Kolom source_ref ontbreekt nog (oudere DB) → schrijf zonder die kolom.
          // We controleren expliciet op de Postgres-foutcode 42703 (undefined column).
          if (jErr.code === '42703' || /column.*source_ref/i.test(jErr.message || '')) {
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

    const { data: inserted, error: iErr } = await supabaseAdmin
      .from('course_personas').insert({
        course_id: project.course_id,
        name: pp.name,
        avatar_emoji: pp.avatar_emoji,
        system_prompt: pp.system_prompt,
        rag_enabled: pp.rag_enabled,
        rag_folder_ids: pp.rag_folder_ids,
        visible_from_phase: pp.visible_from_phase,
        is_default: false,
        persona_type: pp.persona_type || 'conversational',
        created_by: auth.user.id,
      }).select('*').single();
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.json({ persona: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API Server] Running on port ${PORT}`);
  detectConceptsCourseIdColumn();
  detectQuizAttemptsSchema();
  detectQuizSourcesSchema();
  initChatbotPromptSection();
  // Wacht kort tot promptsHasSection geinitialiseerd is alvorens quiz-prompts
  // aan te maken (initChatbotPromptSection draait async).
  setTimeout(() => { initQuizPromptDefaults(); }, 2000);
});
