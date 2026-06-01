// RAG-documentverwerking (pptx + platte tekst), losgekoppeld van server/index.js
// zodat de fail-safe (status → 'failed' bij een fout) zonder draaiende Express-
// server getest kan worden. Alle externe afhankelijkheden komen via `deps` binnen
// (dependency injection): zo blijven de productie-aanroepen identiek terwijl tests
// een falende embeddings-call kunnen simuleren.

// Kernverwerking voor PowerPoint: download, extractie, semantische chunking,
// embeddings en persistentie. Zet bij elke fout de document-status op 'failed'.
export async function processPptxCore(doc, openaiKey, lang = 'nl', deps = {}) {
  const {
    supabaseAdmin,
    extractPptxStructured,
    semanticChunkDeck,
    splitLongSections,
    fallbackChunks,
    embedTextsServer,
    log = () => {},
  } = deps;

  const documentId = doc.id;
  const markFailed = async () => {
    try {
      await supabaseAdmin.from('documents').update({ processing_status: 'failed' }).eq('id', documentId);
    } catch { /* best effort */ }
  };

  try {
    if (!doc.file_path || !doc.bucket) {
      const e = new Error('Document heeft geen opgeslagen bestand om te verwerken');
      e.status = 400;
      throw e;
    }

    const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
    if (dlErr || !blob) {
      const e = new Error(`Kon bestand niet downloaden: ${dlErr?.message || 'onbekend'}`);
      e.status = 500;
      throw e;
    }
    const buffer = Buffer.from(await blob.arrayBuffer());

    let slides;
    try {
      slides = extractPptxStructured(buffer);
    } catch (err) {
      const e = new Error(`Kon PowerPoint niet uitlezen: ${err.message}`);
      e.status = 422;
      throw e;
    }
    slides = slides.filter((s) => s.title || s.body || s.notes);
    if (!slides.length) {
      const e = new Error('Geen tekst gevonden in deze PowerPoint');
      e.status = 422;
      throw e;
    }

    const { sections, mode } = await semanticChunkDeck(slides, openaiKey, lang);
    const finalSections = splitLongSections(sections.length ? sections : fallbackChunks(slides));
    if (!finalSections.length) {
      const e = new Error('Geen chunks geproduceerd');
      e.status = 422;
      throw e;
    }

    const embeddings = await embedTextsServer(finalSections.map((s) => s.content), openaiKey);
    await supabaseAdmin.from('document_chunks').delete().eq('document_id', documentId);

    const rows = finalSections.map((s, i) => ({
      document_id: documentId,
      content: s.content,
      embedding: embeddings[i],
      chunk_index: i,
      metadata: {
        slideStart: s.slideStart,
        slideEnd: s.slideEnd,
        sectionTitle: s.title || null,
        source: 'pptx',
        chunkingMode: mode,
      },
    }));

    const { error: insErr } = await supabaseAdmin.from('document_chunks').insert(rows);
    if (insErr) {
      const e = new Error(`Kon chunks niet opslaan: ${insErr.message}`);
      e.status = 500;
      throw e;
    }

    await supabaseAdmin.from('documents')
      .update({ processing_status: 'completed', total_chunks: rows.length })
      .eq('id', documentId);

    log(`[process-pptx] doc=${documentId} dia's=${slides.length} chunks=${rows.length} mode=${mode}`);
    return { totalChunks: rows.length, slideCount: slides.length, mode };
  } catch (err) {
    await markFailed();
    throw err;
  }
}

// Kernverwerking voor platte-tekstbronnen (.pdf/.docx/.txt/.xlsx/...): download,
// tekstextractie (officeparser voor kantoorformaten, utf8 voor tekst), chunking,
// embeddings en persistentie. Zet de document-status zelf.
export async function processPlainRagDocument(doc, openaiKey, deps = {}) {
  const {
    supabaseAdmin,
    parseOfficeAsync,
    chunkPlainText,
    embedTextsServer,
    log = () => {},
  } = deps;

  const documentId = doc.id;
  const markFailed = async () => {
    try {
      await supabaseAdmin.from('documents').update({ processing_status: 'failed' }).eq('id', documentId);
    } catch { /* best effort */ }
  };

  try {
    if (!doc.file_path || !doc.bucket) {
      const e = new Error('Document heeft geen opgeslagen bestand om te verwerken');
      e.status = 400;
      throw e;
    }

    const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
    if (dlErr || !blob) {
      const e = new Error(`Kon bestand niet downloaden: ${dlErr?.message || 'onbekend'}`);
      e.status = 500;
      throw e;
    }
    const buffer = Buffer.from(await blob.arrayBuffer());

    const ext = (doc.file_type || (doc.filename || '').split('.').pop() || '')
      .toLowerCase().replace(/^\./, '');
    let text = '';
    try {
      if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'tsv' || ext === 'json') {
        text = buffer.toString('utf8');
      } else if (['pdf', 'docx', 'xlsx', 'odt', 'ods', 'odp'].includes(ext)) {
        text = String(await parseOfficeAsync(buffer) || '').trim();
      } else {
        // Onbekend type: probeer als platte tekst te lezen.
        text = buffer.toString('utf8');
      }
    } catch (err) {
      const e = new Error(`Kon tekst niet uit bestand halen: ${err.message}`);
      e.status = 422;
      throw e;
    }

    if (!text || !text.trim()) {
      const e = new Error('Geen leesbare tekst gevonden in dit bestand');
      e.status = 422;
      throw e;
    }

    const chunks = chunkPlainText(text);
    if (!chunks.length) {
      const e = new Error('Geen chunks geproduceerd');
      e.status = 422;
      throw e;
    }

    const embeddings = await embedTextsServer(chunks, openaiKey);
    await supabaseAdmin.from('document_chunks').delete().eq('document_id', documentId);

    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      content,
      embedding: embeddings[i],
      chunk_index: i,
      metadata: { source: ext || 'text' },
    }));

    const { error: insErr } = await supabaseAdmin.from('document_chunks').insert(rows);
    if (insErr) {
      const e = new Error(`Kon chunks niet opslaan: ${insErr.message}`);
      e.status = 500;
      throw e;
    }

    await supabaseAdmin.from('documents')
      .update({ processing_status: 'completed', total_chunks: rows.length })
      .eq('id', documentId);

    log(`[process-rag] doc=${documentId} type=${ext} chunks=${rows.length}`);
    return { totalChunks: rows.length };
  } catch (err) {
    await markFailed();
    throw err;
  }
}
