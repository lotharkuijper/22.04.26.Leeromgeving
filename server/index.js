import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

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
  chat:    { similarity_threshold: 0.70, match_count: 5,  rag_strict_mode: false },
  explain: { similarity_threshold: 0.50, match_count: 5,  rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5,  rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7,  rag_strict_mode: false },
};

const RAG_EXTRACTION_DEFAULTS = {
  similarity_threshold: 0.55,
  min_evidence_chunks: 1,
};

// allowedFolderIds semantiek:
//   null / undefined  → geen folderfilter (alle chunks)
//   []                → expliciet geen toegang (geen resultaten)
//   [id, id, ...]     → alleen chunks uit deze folders
async function searchChunksServerSide(queryText, threshold, matchCount, allowedFolderIds) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || !supabaseAdmin) return { matched: [], maxScore: 0, candidatesInAllowed: 0 };

  // Expliciet lege toegestane mappen → geen toegang
  if (Array.isArray(allowedFolderIds) && allowedFolderIds.length === 0) {
    return { matched: [], maxScore: 0, candidatesInAllowed: 0 };
  }

  try {
    const embRes = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: [queryText] }),
    });
    if (!embRes.ok) return { matched: [], maxScore: 0, candidatesInAllowed: 0 };
    const embData = await embRes.json();
    const embedding = embData.data?.[0]?.embedding;
    if (!embedding) return { matched: [], maxScore: 0, candidatesInAllowed: 0 };

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
    };
  } catch (err) {
    console.error('[searchChunksServerSide] Error:', err.message);
    return { matched: [], maxScore: 0, candidatesInAllowed: 0 };
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

  const { courseId, query } = req.body;
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

    // Haal top-N kandidaten op zonder drempel
    const result = await searchChunksServerSide(query.trim(), 0, 10, allowedFolderIds);

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
  const path = req.params.path;
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

    let query = supabaseAdmin
      .from('concepts')
      .select('id, key_points, extraction_method, extracted_at, created_at')
      .or(`course_id.eq.${courseId},key_points.cs.{"course_id:${courseId}"}`);

    const { data: concepts, error: conceptsError } = await query;

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

    if (replace) {
      if (conceptsHasCourseId) {
        const { error: delErr } = await supabaseAdmin
          .from('concepts')
          .delete()
          .eq('course_id', courseId)
          .contains('key_points', ['[RAG-geëxtraheerd uit cursusmateriaal]']);
        if (delErr) {
          console.error('[extract-concepts] Delete (replace) error:', delErr);
          return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
        }
        console.log(`[extract-concepts] Deleted extracted concepts for course ${courseId} (replace mode, course_id)`);
      } else {
        const { data: taggedConcepts, error: taggedErr } = await supabaseAdmin
          .from('concepts')
          .select('id, key_points')
          .contains('key_points', [courseMarker]);

        if (taggedErr) {
          console.error('[extract-concepts] Tagged concepts query error on replace:', taggedErr);
          return res.status(500).json({ error: `Ophalen mislukt: ${taggedErr.message}` });
        }

        const ragMarker = '[RAG-geëxtraheerd uit cursusmateriaal]';
        const toDeleteIds = [];
        const toUntag = [];

        for (const concept of taggedConcepts || []) {
          const isRagExtracted = (concept.key_points || []).includes(ragMarker);
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

    const llmResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.2,
        max_tokens: 6000,
      }),
    });

    if (!llmResponse.ok) {
      const errData = await llmResponse.json().catch(() => ({}));
      console.error('[extract-concepts] LLM error:', errData);
      return res.status(500).json({ error: 'LLM extractie mislukt', details: errData });
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

    let inserted = [];
    let updatedCount = 0;
    let skipped = 0;
    const verificationRejected = rejectedConcepts.length;

    if (conceptsHasCourseId) {
      const { data: existingForCourse } = await supabaseAdmin
        .from('concepts')
        .select('id, name')
        .eq('course_id', courseId);

      const alreadyByCourse = new Set(
        (existingForCourse || []).map((c) => c.name.toLowerCase().trim())
      );

      const toInsert = [];
      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        if (alreadyByCourse.has(key)) { skipped++; continue; }
        toInsert.push({
          name: c.name.trim(),
          category: c.category,
          definition: c.definition.trim(),
          key_points: ['[RAG-geëxtraheerd uit cursusmateriaal]'],
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
          .map((c) => c.name.toLowerCase().trim())
      );

      const toInsert = [];
      const toUpdate = [];

      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        if (alreadyTaggedForCourse.has(key)) { skipped++; continue; }

        const existing = existingByName.get(key);
        if (existing) {
          const updatedKeyPoints = [...new Set([...(existing.key_points || []), courseMarker])];
          toUpdate.push({ id: existing.id, key_points: updatedKeyPoints });
        } else {
          toInsert.push({
            name: c.name.trim(),
            category: c.category,
            definition: c.definition.trim(),
            key_points: [courseMarker, '[RAG-geëxtraheerd uit cursusmateriaal]'],
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API Server] Running on port ${PORT}`);
  detectConceptsCourseIdColumn();
  initChatbotPromptSection();
});
