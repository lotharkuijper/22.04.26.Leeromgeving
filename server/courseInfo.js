// ───────────────────────────────────────────────────────────────────────────
// Cursus-info (Task #202) — één informatieblok per cursus: opgemaakte tekst
// (markdown) + gekoppelde, downloadbare bestanden. Getoond bovenaan het
// Dashboard van de actieve cursus. Beheer biedt het tabblad "Cursus-info".
// Lezen mag elk cursuslid; bewerken alleen staff van die cursus.
//
// De routes en hun helpers zijn hierheen verplaatst uit server/index.js zodat
// de toegangsregels (Task #203) geautomatiseerd getest kunnen worden via
// dependency-injectie. `registerCourseInfoRoutes(app, deps)` mount de 7
// endpoints op een Express-app; alle externe afhankelijkheden (Supabase, pg,
// auth-helpers, multer-middleware) komen via `deps` binnen.
// ───────────────────────────────────────────────────────────────────────────

export function registerCourseInfoRoutes(app, deps) {
  const {
    supabaseAdmin,
    pgPool,
    getFileMimeType,
    requireAuthUser,
    userHasCourseAccess,
    isStaffForCourse,
    docUpload,
  } = deps;

  // Serialiseer de gekoppelde documenten van een cursus in dashboard-vorm.
  async function loadCourseInfoDocuments(courseId) {
    const { data: links } = await supabaseAdmin
      .from('course_info_documents')
      .select('document_id, sort_order, created_at, documents(id, title, filename, file_type, file_size)')
      .eq('course_id', courseId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    return (links || [])
      .filter((l) => l.documents)
      .map((l) => ({
        id: l.documents.id,
        title: l.documents.title,
        filename: l.documents.filename,
        file_type: l.documents.file_type,
        file_size: l.documents.file_size,
      }));
  }

  // Verzamel alle folder-id's die bij een cursus horen: de via
  // course_folder_assignments gekoppelde mappen plus al hun submappen.
  async function getCourseFolderIds(courseId) {
    const { data: assigns } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id')
      .eq('course_id', courseId);
    const rootIds = (assigns || []).map((a) => a.folder_id).filter(Boolean);
    if (!rootIds.length) return [];
    const { data: allFolders } = await supabaseAdmin
      .from('document_folders')
      .select('id, parent_folder_id');
    const childMap = {};
    for (const f of allFolders || []) {
      if (f.parent_folder_id) (childMap[f.parent_folder_id] ||= []).push(f.id);
    }
    const result = new Set();
    const stack = [...rootIds];
    while (stack.length) {
      const id = stack.pop();
      if (result.has(id)) continue;
      result.add(id);
      for (const c of childMap[id] || []) stack.push(c);
    }
    return [...result];
  }

  // Zoek of maak de submap "Cursus-info" onder de cursusmap (niet-RAG bucket).
  // Geüploade cursus-info-bestanden belanden hier; ze worden NIET geïndexeerd.
  async function ensureCourseInfoFolder(courseId, userId) {
    const { data: assigns } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id, document_folders(id, folder_type)')
      .eq('course_id', courseId);
    const folders = (assigns || []);
    const courseFolder = folders
      .map((a) => a.document_folders)
      .filter(Boolean)
      .find((f) => f.folder_type === 'course');
    const parentId = courseFolder?.id || folders[0]?.folder_id || null;
    if (!parentId) return null;
    const { data: existing } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .eq('parent_folder_id', parentId)
      .eq('name', 'Cursus-info')
      .maybeSingle();
    if (existing) return existing.id;
    const { data: created, error } = await supabaseAdmin
      .from('document_folders')
      .insert({
        name: 'Cursus-info',
        parent_folder_id: parentId,
        folder_type: 'general',
        bucket_type: 'docs_general',
        is_root: false,
        created_by: userId,
      })
      .select('id')
      .single();
    if (error || !created) return null;
    await supabaseAdmin
      .from('course_folder_assignments')
      .insert({ course_id: courseId, folder_id: created.id });
    return created.id;
  }

  // Volgende sort_order voor een nieuwe koppeling (achteraan).
  async function nextCourseInfoSortOrder(courseId) {
    const { data } = await supabaseAdmin
      .from('course_info_documents')
      .select('sort_order')
      .eq('course_id', courseId)
      .order('sort_order', { ascending: false })
      .limit(1);
    return data?.[0]?.sort_order != null ? data[0].sort_order + 1 : 0;
  }

  // GET /api/courses/:courseId/info — tekst + gekoppelde bestanden voor leden.
  app.get('/api/courses/:courseId/info', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus.' });
    }
    try {
      const { data: info } = await supabaseAdmin
        .from('course_info')
        .select('body, updated_at')
        .eq('course_id', courseId)
        .maybeSingle();
      const documents = await loadCourseInfoDocuments(courseId);
      const canEdit = await isStaffForCourse(auth.user, auth.profile, courseId);
      return res.json({
        body: info?.body || '',
        updatedAt: info?.updated_at || null,
        documents,
        canEdit,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/courses/:courseId/info — sla de tekst op (alleen staff van cursus).
  app.put('/api/courses/:courseId/info', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus kunnen de cursus-info bewerken.' });
    }
    const body = typeof req.body?.body === 'string' ? req.body.body : '';
    if (body.length > 20000) {
      return res.status(400).json({ error: 'Tekst is te lang (max. 20.000 tekens).' });
    }
    try {
      const { error } = await supabaseAdmin
        .from('course_info')
        .upsert(
          { course_id: courseId, body, updated_by: auth.user.id, updated_at: new Date().toISOString() },
          { onConflict: 'course_id' }
        );
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/courses/:courseId/info/available-files — cursusmap-bestanden die
  // nog niet gekoppeld zijn (alleen staff), om uit te kiezen.
  app.get('/api/courses/:courseId/info/available-files', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus.' });
    }
    try {
      const folderIds = await getCourseFolderIds(courseId);
      if (!folderIds.length) return res.json({ files: [] });
      const { data: docs } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_type, file_size, folder_id, document_folders(name)')
        .in('folder_id', folderIds)
        .order('created_at', { ascending: false });
      const { data: linked } = await supabaseAdmin
        .from('course_info_documents')
        .select('document_id')
        .eq('course_id', courseId);
      const linkedSet = new Set((linked || []).map((l) => l.document_id));
      const files = (docs || [])
        .filter((d) => !linkedSet.has(d.id))
        .map((d) => ({
          id: d.id,
          title: d.title,
          filename: d.filename,
          file_type: d.file_type,
          file_size: d.file_size,
          folderName: d.document_folders?.name || null,
        }));
      return res.json({ files });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/courses/:courseId/info/documents — koppel bestaande cursusbestanden.
  app.post('/api/courses/:courseId/info/documents', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus.' });
    }
    const ids = Array.isArray(req.body?.documentIds)
      ? req.body.documentIds.filter((x) => typeof x === 'string')
      : [];
    if (!ids.length) return res.status(400).json({ error: 'Geen bestanden geselecteerd.' });
    try {
      // Beveiliging: alleen documenten die in de cursusmappen zitten mogen
      // gekoppeld worden — voorkomt koppelen van vreemde document-id's.
      const folderIds = new Set(await getCourseFolderIds(courseId));
      const { data: validDocs } = await supabaseAdmin
        .from('documents')
        .select('id, folder_id')
        .in('id', ids);
      const valid = (validDocs || [])
        .filter((d) => d.folder_id && folderIds.has(d.folder_id))
        .map((d) => d.id);
      if (!valid.length) {
        return res.status(400).json({ error: 'Geen geldige cursusbestanden geselecteerd.' });
      }
      let next = await nextCourseInfoSortOrder(courseId);
      const rows = valid.map((id) => ({ course_id: courseId, document_id: id, sort_order: next++ }));
      const { error } = await supabaseAdmin
        .from('course_info_documents')
        .upsert(rows, { onConflict: 'course_id,document_id', ignoreDuplicates: true });
      if (error) return res.status(500).json({ error: error.message });
      const documents = await loadCourseInfoDocuments(courseId);
      return res.json({ ok: true, documents });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/courses/:courseId/info/documents/order — herschik de gekoppelde
  // cursus-info-bestanden. Body: { documentIds: [...] } in de gewenste volgorde.
  // Alleen staff van de cursus. Bestanden die niet in de lijst staan behouden
  // hun relatieve volgorde en komen achteraan.
  app.put('/api/courses/:courseId/info/documents/order', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus.' });
    }
    const orderedIds = Array.isArray(req.body?.documentIds)
      ? req.body.documentIds.filter((x) => typeof x === 'string')
      : [];
    if (!orderedIds.length) return res.status(400).json({ error: 'Geen volgorde opgegeven.' });
    try {
      const { data: links } = await supabaseAdmin
        .from('course_info_documents')
        .select('document_id, sort_order, created_at')
        .eq('course_id', courseId);
      const existing = links || [];
      const existingIds = new Set(existing.map((l) => l.document_id));
      // Eerst de doorgegeven volgorde (alleen geldige, gekoppelde id's), daarna
      // de overige gekoppelde bestanden in hun huidige volgorde.
      const seen = new Set();
      const finalOrder = [];
      for (const id of orderedIds) {
        if (existingIds.has(id) && !seen.has(id)) {
          seen.add(id);
          finalOrder.push(id);
        }
      }
      const remaining = existing
        .filter((l) => !seen.has(l.document_id))
        .sort((a, b) => {
          const sa = a.sort_order ?? 0;
          const sb = b.sort_order ?? 0;
          if (sa !== sb) return sa - sb;
          return String(a.created_at).localeCompare(String(b.created_at));
        });
      for (const l of remaining) finalOrder.push(l.document_id);
      for (let i = 0; i < finalOrder.length; i++) {
        const { error } = await supabaseAdmin
          .from('course_info_documents')
          .update({ sort_order: i })
          .eq('course_id', courseId)
          .eq('document_id', finalOrder[i]);
        if (error) return res.status(500).json({ error: error.message });
      }
      const documents = await loadCourseInfoDocuments(courseId);
      return res.json({ ok: true, documents });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/courses/:courseId/info/documents/upload — upload een lokaal bestand
  // naar de submap "Cursus-info" (niet-RAG bucket, geen embeddings) en koppel.
  app.post('/api/courses/:courseId/info/documents/upload', docUpload.single('file'), async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen.' });
    try {
      const folderId = await ensureCourseInfoFolder(courseId, auth.user.id);
      if (!folderId) {
        return res.status(500).json({ error: 'Kon de map "Cursus-info" niet bepalen. Controleer of de cursus een gekoppelde documentmap heeft.' });
      }
      const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
      const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filePath = `${courseId}/${Date.now()}_${sanitized}`;
      const mime = req.file.mimetype || getFileMimeType(ext);
      const { error: upErr } = await supabaseAdmin.storage
        .from('docs_general')
        .upload(filePath, req.file.buffer, { contentType: mime });
      if (upErr) return res.status(500).json({ error: 'Upload mislukt: ' + upErr.message });
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : req.file.originalname;
      const { data: doc, error: docErr } = await supabaseAdmin
        .from('documents')
        .insert({
          title,
          filename: req.file.originalname,
          file_path: filePath,
          file_type: ext || 'unknown',
          file_size: req.file.size,
          folder_id: folderId,
          bucket: 'docs_general',
          mime_type: mime,
          processing_status: 'completed',
          uploaded_by: auth.user.id,
        })
        .select('id')
        .single();
      if (docErr || !doc) {
        await supabaseAdmin.storage.from('docs_general').remove([filePath]);
        return res.status(500).json({ error: 'Document record aanmaken mislukt: ' + (docErr?.message || '') });
      }
      const sort = await nextCourseInfoSortOrder(courseId);
      await supabaseAdmin
        .from('course_info_documents')
        .insert({ course_id: courseId, document_id: doc.id, sort_order: sort });
      const documents = await loadCourseInfoDocuments(courseId);
      return res.json({ ok: true, documents });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/courses/:courseId/info/documents/:documentId — ontkoppel een
  // bestand van de cursus-info (verwijdert het document zelf niet).
  app.delete('/api/courses/:courseId/info/documents/:documentId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, documentId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten van deze cursus.' });
    }
    try {
      const { error } = await supabaseAdmin
        .from('course_info_documents')
        .delete()
        .eq('course_id', courseId)
        .eq('document_id', documentId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/courses/:courseId/info/documents/:documentId/download — cursuslid-
  // geautoriseerde download van een gekoppeld cursus-info-bestand (signed URL of
  // binaire bytes), analoog aan de RAG-download maar via de koppeling i.p.v.
  // folder_permissions.
  app.get('/api/courses/:courseId/info/documents/:documentId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, documentId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus.' });
    }
    try {
      const { data: link } = await supabaseAdmin
        .from('course_info_documents')
        .select('document_id')
        .eq('course_id', courseId)
        .eq('document_id', documentId)
        .maybeSingle();
      if (!link) return res.status(404).json({ error: 'Dit bestand is niet gekoppeld aan deze cursus.' });
      const { data: doc } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type')
        .eq('id', documentId)
        .maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden.' });
      const filename = String(doc.filename || doc.title || 'download').replace(/[\r\n"]/g, '_');
      const mimeType = doc.mime_type || getFileMimeType((doc.file_type || '').toLowerCase());
      if (!doc.file_path && pgPool) {
        const result = await pgPool.query('SELECT file_bytes, mime_type FROM documents WHERE id = $1', [documentId]);
        const row = result.rows[0];
        if (row?.file_bytes) {
          res.setHeader('Content-Type', row.mime_type || mimeType);
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
        return res.json({ url: signed.signedUrl, filename });
      }
      return res.status(404).json({ error: 'Dit document heeft geen downloadbaar bestand.' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
