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

  const { courseId } = req.body;
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
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin role required' });
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

    const docIds = docs.map((d) => d.id);

    const { data: chunks, error: chunksError } = await supabaseAdmin
      .from('document_chunks')
      .select('content, document_id')
      .in('document_id', docIds)
      .limit(60);

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
      .slice(0, 12000);

    const extractionPrompt = `Je bent een expert in epidemiologie en biostatistiek aan de VU Amsterdam.

Analyseer de volgende tekst uit cursusmateriaal en extraheer maximaal 20 sleutelbegrippen die studenten moeten kennen. Elk begrip krijgt:
- name: de exacte naam van het begrip (in het Nederlands)
- category: precies "epidemiologie" of "biostatistiek"
- definition: een korte definitie van 1-2 zinnen in het Nederlands

Geef ALLEEN een JSON-array terug, geen extra tekst:
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
        temperature: 0.3,
        max_tokens: 3000,
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

    const { data: existingConcepts } = await supabaseAdmin
      .from('concepts')
      .select('name');

    const existingNames = new Set((existingConcepts || []).map((c) => c.name.toLowerCase().trim()));

    const newConcepts = validConcepts.filter(
      (c) => !existingNames.has(c.name.toLowerCase().trim())
    );

    if (newConcepts.length === 0) {
      return res.json({
        concepts: [],
        skipped: validConcepts.length,
        message: 'Alle geëxtraheerde begrippen bestaan al in de database',
      });
    }

    const toInsert = newConcepts.map((c) => ({
      name: c.name.trim(),
      category: c.category,
      definition: c.definition.trim(),
      key_points: ['[RAG-geëxtraheerd uit cursusmateriaal]'],
      examples: [],
    }));

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('concepts')
      .insert(toInsert)
      .select('id, name, category, definition');

    if (insertError) {
      console.error('[extract-concepts] Insert error:', insertError);
      return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
    }

    console.log(`[extract-concepts] Inserted ${inserted?.length ?? 0} new concepts for course ${courseId}`);

    return res.json({
      concepts: inserted || [],
      skipped: validConcepts.length - (inserted?.length ?? 0),
      message: `${inserted?.length ?? 0} nieuwe begrippen toegevoegd`,
    });
  } catch (err) {
    console.error('[extract-concepts] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API Server] Running on port ${PORT}`);
});
