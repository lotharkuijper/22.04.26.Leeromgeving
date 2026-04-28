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
  explain: { similarity_threshold: 0.70, match_count: 5,  rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5,  rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7,  rag_strict_mode: false },
};

const RAG_STRICT_INSTRUCTION = `\n\nSTRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven uit het cursusmateriaal. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."`;

async function loadRagSettings(courseId) {
  if (!supabaseAdmin) return { ...RAG_MODULE_DEFAULTS };
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
        return merged;
      } catch { /* fall through to next key */ }
    }
  }
  return { ...RAG_MODULE_DEFAULTS };
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
          .map(m => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`)
          .join('\n\n');

        const sourcesText = ragSources.size > 0
          ? `\n\nGebruikte cursusbronnen in dit gesprek: ${[...ragSources].join(', ')}`
          : '';

        const summaryPrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Analyseer het volgende studiegesprek en schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat de student heeft laten zien en geleerd
2. Concrete sterke punten én verbeterpunten (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping, bij voorkeur met verwijzing naar beschikbare cursusbronnen${sourcesText}

Gesprekstitel: "${conversation.title}"

Gesprek:
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
    return res.json({ ...RAG_MODULE_DEFAULTS });
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
          m.similarity_threshold = Math.max(0.50, Math.min(0.95, parsed));
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

    const settingsKey = courseId ? `__rag_settings_${courseId}__` : '__rag_settings_global__';

    // Haal bestaande settings op en voeg samen om gedeeltelijke updates te steunen
    const { data: existingRow } = await supabaseAdmin
      .from('chatbot_prompts').select('id, content').eq('name', settingsKey).maybeSingle();

    let mergedSettings = { ...RAG_MODULE_DEFAULTS };
    if (existingRow?.content) {
      try {
        const prev = JSON.parse(existingRow.content);
        for (const mod of Object.keys(RAG_MODULE_DEFAULTS)) {
          if (prev[mod]) mergedSettings[mod] = { ...RAG_MODULE_DEFAULTS[mod], ...prev[mod] };
        }
      } catch { /* negeer parse-fouten, gebruik defaults */ }
    }
    // Schrijf de inkomende modules over de bestaande settings heen
    for (const mod of MODULES) {
      if (settings[mod]) mergedSettings[mod] = { ...mergedSettings[mod], ...settings[mod] };
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

    return res.json({
      ragCount: ragConcepts.length,
      manualCount: manualConcepts.length,
      lastExtraction,
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
      return res.json({ concepts: [], message: 'Geen RAG-mappen gevonden voor deze cursus' });
    }

    const assignedFolderIds = assignments.map((a) => a.folder_id);

    const { data: ragFolders } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', assignedFolderIds)
      .eq('folder_type', 'rag_sources');

    if (!ragFolders || ragFolders.length === 0) {
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
      return res.json({ concepts: [], message: 'Geen verwerkte documenten gevonden in RAG-mappen' });
    }

    let docIds = docs.map((d) => d.id);
    if (filterDocIds) {
      const allowed = new Set(filterDocIds);
      docIds = docIds.filter((id) => allowed.has(id));
      if (docIds.length === 0) {
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
      return res.json({ concepts: [], message: 'Geen begrippen gevonden in LLM-respons' });
    }

    const validCategories = ['epidemiologie', 'biostatistiek'];
    const validConcepts = extractedConcepts.filter(
      (c) => c.name && c.category && validCategories.includes(c.category) && c.definition
    );

    let inserted = [];
    let updatedCount = 0;
    let skipped = 0;

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

    console.log(`[extract-concepts] Done for course ${courseId}: ${inserted.length} new, ${updatedCount} updated, ${skipped} already tagged`);

    return res.json({
      concepts: inserted,
      updated: updatedCount,
      skipped,
      message: `${totalAdded} begrippen toegevoegd/bijgewerkt voor deze cursus`,
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

const DEFAULT_EXPLAIN_PROMPT = `Je bent een kritische en constructieve tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback.

Geef je feedback in vier onderdelen:
1. Wat de student goed heeft gedaan (noem specifieke sterke punten)
2. Wat ontbreekt of onduidelijk is (wees concreet)
3. Eventuele misconcepties die gecorrigeerd moeten worden
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
