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
const HUGGINGFACE_EMBEDDINGS_URL = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'GROQ_API_KEY not configured on server' });
  }

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
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

app.post('/api/embeddings', async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  const hfKey = process.env.HUGGINGFACE_API_KEY;

  if (!openaiKey && !hfKey) {
    return res.status(503).json({ error: 'No embedding API key configured on server' });
  }

  const { texts, provider } = req.body;
  if (!texts || !Array.isArray(texts)) {
    return res.status(400).json({ error: 'texts array required' });
  }

  if (hfKey && provider !== 'openai') {
    try {
      const results = [];
      for (const text of texts) {
        const response = await fetch(HUGGINGFACE_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: text }),
        });

        if (!response.ok) {
          throw new Error(`HuggingFace error: ${response.status}`);
        }

        const embedding = await response.json();
        results.push(Array.isArray(embedding[0]) ? embedding[0] : embedding);
      }
      console.log(`[/api/embeddings] Generated ${results.length} embeddings via HuggingFace (dim=${results[0]?.length})`);
      return res.json({ embeddings: results, provider: 'huggingface' });
    } catch (hfErr) {
      console.warn('[/api/embeddings] HuggingFace failed, trying OpenAI:', hfErr.message);
      if (!openaiKey) {
        return res.status(503).json({ error: hfErr.message });
      }
    }
  }

  if (openaiKey) {
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
          dimensions: 384,
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
  }

  return res.status(503).json({ error: 'No embedding provider available' });
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

app.post('/api/admin/create-rag-folder', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, courseName, userId } = req.body;
  if (!courseId || !courseName || !userId) {
    return res.status(400).json({ error: 'courseId, courseName, and userId are required' });
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
          created_by: userId,
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    groq: !!process.env.GROQ_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    huggingface: !!process.env.HUGGINGFACE_API_KEY,
    github: !!process.env.GITHUB_TOKEN,
    supabase: !!process.env.SUPABASE_URL,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API Server] Running on port ${PORT}`);
});
