import { sanitizeText, sanitizeMetadata } from './sanitizeText.js';
import { buildEmbedInput } from './chunking.js';

// RAG-documentverwerking (pptx + platte tekst), losgekoppeld van server/index.js
// zodat de fail-safe (status → 'failed' bij een fout) zonder draaiende Express-
// server getest kan worden. Alle externe afhankelijkheden komen via `deps` binnen
// (dependency injection): zo blijven de productie-aanroepen identiek terwijl tests
// een falende embeddings-call kunnen simuleren.

// Een handvol tekens uit een PDF van enkele MB's betekent vrijwel zeker een
// mislukte extractie (corrupte/gescande PDF zonder OCR, parser-bug). pdf.js is de
// primaire route; valt die terug op officeparser en levert óók die bijna niets
// op, dan liever fail-closed dan de bestaande, goede chunks overschrijven met
// ruis. Alleen voor PDF: andere formaten kunnen legitiem kort zijn.
const MIN_PDF_TEXT_CHARS = 20;

// Maximale rij-batch per INSERT in de atomic-transactie (houdt het aantal
// query-parameters ruim onder de Postgres-limiet, ook bij grote documenten).
const INSERT_BATCH = 100;

// Schrijf de nieuwe chunks weg zónder ooit een document met nul chunks achter te
// laten. Met een `pgPool` gebeurt delete-oud → insert-nieuw → status 'completed'
// in ÉÉN transactie: faalt de insert halverwege, dan rolt ook de delete terug en
// blijven de oude chunks staan (status wordt door de aanroeper op 'failed' gezet).
// Zonder `pgPool` (testomgeving) valt de functie terug op het oude supabase-pad,
// maar zet de status pas op 'completed' nádat de insert is geslaagd.
async function persistChunksAtomic({ documentId, rows, deps }) {
  const { supabaseAdmin, pgPool } = deps;

  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
      for (let start = 0; start < rows.length; start += INSERT_BATCH) {
        const batch = rows.slice(start, start + INSERT_BATCH);
        const valuesSql = [];
        const params = [];
        batch.forEach((r, i) => {
          const b = i * 5;
          valuesSql.push(`($${b + 1}, $${b + 2}, $${b + 3}::vector, $${b + 4}, $${b + 5}::jsonb)`);
          params.push(
            r.document_id,
            r.content,
            Array.isArray(r.embedding) ? `[${r.embedding.join(',')}]` : r.embedding,
            r.chunk_index,
            JSON.stringify(r.metadata ?? {}),
          );
        });
        await client.query(
          `INSERT INTO document_chunks (document_id, content, embedding, chunk_index, metadata) VALUES ${valuesSql.join(', ')}`,
          params,
        );
      }
      await client.query(
        "UPDATE documents SET processing_status = 'completed', total_chunks = $2 WHERE id = $1",
        [documentId, rows.length],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* best effort */ }
      const e = new Error(`Kon chunks niet atomisch opslaan: ${err.message}`);
      e.status = 500;
      throw e;
    } finally {
      client.release();
    }
    return rows.length;
  }

  // Terugvalpad zonder pgPool (bv. tests): oude volgorde, status pas na insert.
  await supabaseAdmin.from('document_chunks').delete().eq('document_id', documentId);
  const { error: insErr } = await supabaseAdmin.from('document_chunks').insert(rows);
  if (insErr) {
    const e = new Error(`Kon chunks niet opslaan: ${insErr.message}`);
    e.status = 500;
    throw e;
  }
  await supabaseAdmin.from('documents')
    .update({ processing_status: 'completed', total_chunks: rows.length })
    .eq('id', documentId);
  return rows.length;
}

// Kernverwerking voor PowerPoint: download, extractie, semantische chunking,
// embeddings en persistentie. Zet bij elke fout de document-status op 'failed'.
export async function processPptxCore(doc, openaiKey, lang = 'nl', deps = {}) {
  const {
    supabaseAdmin,
    pgPool,
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

    const embeddings = await embedTextsServer(finalSections.map((s) => buildEmbedInput(doc.title, s.content)), openaiKey);

    const rows = finalSections.map((s, i) => ({
      document_id: documentId,
      content: sanitizeText(s.content),
      embedding: embeddings[i],
      chunk_index: i,
      metadata: sanitizeMetadata({
        slideStart: s.slideStart,
        slideEnd: s.slideEnd,
        sectionTitle: s.title || null,
        source: 'pptx',
        chunkingMode: mode,
      }),
    }));

    await persistChunksAtomic({ documentId, rows, deps: { supabaseAdmin, pgPool } });

    log(`[process-pptx] doc=${documentId} dia's=${slides.length} chunks=${rows.length} mode=${mode}`);
    return { totalChunks: rows.length, slideCount: slides.length, mode };
  } catch (err) {
    await markFailed();
    throw err;
  }
}

// Kernverwerking voor pagineerbare Word-bronnen (.docx/.doc/.odt): download,
// LibreOffice→PDF-conversie, per-pagina tekstextractie, chunking, koppeling van
// elke chunk aan zijn paginanummer(s) (assignPdfPages) en persistentie. Zo tonen
// DOCX-bronkaarten dezelfde "p. 12"-labels en #page-sprong als PDF's (Task #377).
// Valt bij een conversie-/extractiefout terug op platte-tekstverwerking zodat het
// document nog steeds (zonder paginalabels) wordt geïngesteerd.
export async function processDocxCore(doc, openaiKey, deps = {}) {
  const {
    supabaseAdmin,
    pgPool,
    convertToPdf,
    extractPdfPageTexts,
    chunkPlainText,
    assignPdfPages,
    embedTextsServer,
    parseOfficeAsync,
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

    // Probeer de pagina-bewuste route: DOCX → PDF → per-pagina tekst. Lukt dat
    // niet, dan vallen we terug op platte tekst (officeparser) zonder pagina's.
    let pageTexts = null;
    try {
      const pdfBuffer = await convertToPdf(buffer, ext);
      pageTexts = await extractPdfPageTexts(pdfBuffer);
      if (!Array.isArray(pageTexts) || pageTexts.join('').trim().length === 0) {
        pageTexts = null;
      }
    } catch (err) {
      log(`[process-docx] doc=${documentId} pagina-extractie mislukt, terugval op platte tekst: ${err.message}`);
      pageTexts = null;
    }

    let text;
    let paged = false;
    if (pageTexts) {
      text = pageTexts.join('\n\n');
      paged = true;
    } else {
      try {
        text = String(await parseOfficeAsync(buffer) || '').trim();
      } catch (err) {
        const e = new Error(`Kon tekst niet uit bestand halen: ${err.message}`);
        e.status = 422;
        throw e;
      }
    }

    if (!text || !text.trim()) {
      const e = new Error('Geen leesbare tekst gevonden in dit bestand');
      e.status = 422;
      throw e;
    }

    const chunkTexts = chunkPlainText(text);
    if (!chunkTexts.length) {
      const e = new Error('Geen chunks geproduceerd');
      e.status = 422;
      throw e;
    }

    // Koppel chunks aan paginanummer(s) op basis van de geconverteerde PDF.
    const chunkObjs = chunkTexts.map((t) => ({ text: t, metadata: {} }));
    if (paged) {
      try {
        assignPdfPages(pageTexts, chunkObjs);
      } catch (err) {
        log(`[process-docx] doc=${documentId} pagina-toewijzing mislukt: ${err.message}`);
      }
    }

    const embeddings = await embedTextsServer(chunkTexts.map((t) => buildEmbedInput(doc.title, t)), openaiKey);

    let pagesAssigned = 0;
    const rows = chunkObjs.map((c, i) => {
      const metadata = { source: ext || 'docx' };
      if (c.metadata.pageStart != null) {
        metadata.pageStart = c.metadata.pageStart;
        metadata.pageEnd = c.metadata.pageEnd ?? c.metadata.pageStart;
        metadata.pageNumber = c.metadata.pageStart;
        pagesAssigned += 1;
      }
      return {
        document_id: documentId,
        content: c.text,
        embedding: embeddings[i],
        chunk_index: i,
        metadata,
      };
    });

    await persistChunksAtomic({ documentId, rows, deps: { supabaseAdmin, pgPool } });

    log(`[process-docx] doc=${documentId} type=${ext} chunks=${rows.length} paged=${paged} pages=${pagesAssigned}`);
    return { totalChunks: rows.length, paged, pagesAssigned };
  } catch (err) {
    await markFailed();
    throw err;
  }
}

// Kernverwerking voor platte-tekstbronnen (.pdf/.txt/.xlsx/...): download,
// tekstextractie (pdf.js voor PDF, officeparser voor overige kantoorformaten,
// utf8 voor tekst), chunking, embeddings en atomic-persistentie. Zet de
// document-status zelf en laat bij een fout het document op 'failed'.
export async function processPlainRagDocument(doc, openaiKey, deps = {}) {
  const {
    supabaseAdmin,
    pgPool,
    parseOfficeAsync,
    extractPdfPageTexts,
    assignPdfPages,
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
    let pageTexts = null;
    let paged = false;
    try {
      if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'tsv' || ext === 'json') {
        text = buffer.toString('utf8');
      } else if (ext === 'pdf') {
        // PDF betrouwbaar via pdf.js (per pagina). officeparser leverde op
        // sommige PDF's stil bijna niets op; pdf.js geeft echte tekst én laat
        // ons paginanummers koppelen. Bij een leeg/mislukt pdf.js-resultaat
        // vallen we terug op officeparser zodat oudere paden blijven werken.
        if (typeof extractPdfPageTexts === 'function') {
          try {
            const pages = await extractPdfPageTexts(buffer);
            if (Array.isArray(pages) && pages.join('').trim().length > 0) {
              pageTexts = pages;
              text = pages.join('\n\n');
              paged = true;
            }
          } catch (err) {
            log(`[process-rag] doc=${documentId} pdf.js-extractie mislukt, terugval op officeparser: ${err.message}`);
          }
        }
        if (!paged) {
          text = String(await parseOfficeAsync(buffer) || '').trim();
        }
      } else if (['docx', 'xlsx', 'odt', 'ods', 'odp'].includes(ext)) {
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
    if (ext === 'pdf' && text.trim().length < MIN_PDF_TEXT_CHARS) {
      const e = new Error('Geen leesbare tekst gevonden in dit bestand (extractie leverde vrijwel niets op)');
      e.status = 422;
      throw e;
    }

    const chunkTexts = chunkPlainText(text);
    if (!chunkTexts.length) {
      const e = new Error('Geen chunks geproduceerd');
      e.status = 422;
      throw e;
    }

    // Koppel chunks aan paginanummer(s) als we per-pagina PDF-tekst hebben.
    const chunkObjs = chunkTexts.map((t) => ({ text: t, metadata: {} }));
    if (paged && typeof assignPdfPages === 'function') {
      try {
        assignPdfPages(pageTexts, chunkObjs);
      } catch (err) {
        log(`[process-rag] doc=${documentId} pagina-toewijzing mislukt: ${err.message}`);
      }
    }

    const embeddings = await embedTextsServer(chunkTexts.map((t) => buildEmbedInput(doc.title, t)), openaiKey);

    let pagesAssigned = 0;
    const rows = chunkObjs.map((c, i) => {
      const metadata = { source: ext || 'text' };
      if (c.metadata.pageStart != null) {
        metadata.pageStart = c.metadata.pageStart;
        metadata.pageEnd = c.metadata.pageEnd ?? c.metadata.pageStart;
        metadata.pageNumber = c.metadata.pageStart;
        pagesAssigned += 1;
      }
      return {
        document_id: documentId,
        content: sanitizeText(c.text),
        embedding: embeddings[i],
        chunk_index: i,
        metadata: sanitizeMetadata(metadata),
      };
    });

    await persistChunksAtomic({ documentId, rows, deps: { supabaseAdmin, pgPool } });

    log(`[process-rag] doc=${documentId} type=${ext} chunks=${rows.length} paged=${paged} pages=${pagesAssigned}`);
    return { totalChunks: rows.length, paged, pagesAssigned };
  } catch (err) {
    await markFailed();
    throw err;
  }
}
