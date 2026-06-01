import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { processPptxCore } from '../ragProcessing.js';
import { extractPptxStructured, splitLongSections, fallbackChunks } from '../pptxExtract.js';

// Aanvullende end-to-end-dekking voor de PowerPoint-verwerkingsflow
// (processPptxCore uit ragProcessing.js). ragProcessing.test.js dekt de
// fail-safe (failed/completed); hier verifiëren we de chunking-modus die in
// de chunk-metadata terechtkomt, het lege-deck-pad (422), en de expliciete
// HTTP-statuscodes op de download-/insert-foutpaden. We gebruiken de échte
// extractPptxStructured + splitLongSections + fallbackChunks en injecteren
// alleen de LLM-chunker (semanticChunkDeck) en de embeddings.

// --- Helpers -------------------------------------------------------------

// Bouwt een minimale .pptx-buffer met de gegeven dia's. Met `empty: true`
// produceren we een deck zónder tekst zodat de flow het lege-deck-pad raakt.
function buildPptxBuffer(slides, { empty = false } = {}) {
  const files = {};
  slides.forEach((s, idx) => {
    const n = idx + 1;
    const body = empty
      ? '<p:sp><p:txBody></p:txBody></p:sp>'
      : `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:txBody><a:p><a:t>${s.title}</a:t></a:p></p:txBody></p:sp>` +
        `<p:sp><p:txBody><a:p><a:t>${s.body}</a:t></a:p></p:txBody></p:sp>`;
    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
    );
  });
  return Buffer.from(zipSync(files));
}

function blobFromBuffer(buffer) {
  return { arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

// Supabase-admin-mock die inserts en documents-status-updates vastlegt.
function makeSupabase(cfg = {}) {
  const updates = [];
  const inserted = [];
  const deletes = [];
  const supabaseAdmin = {
    storage: {
      from: () => ({
        download: async () => cfg.downloadResult ?? { data: null, error: { message: 'geen bestand' } },
      }),
    },
    from: (table) => ({
      update: (payload) => ({
        eq: async () => {
          if (table === 'documents') updates.push(payload);
          return { error: null };
        },
      }),
      delete: () => ({ eq: async () => { deletes.push({ table }); return { error: null }; } }),
      insert: async (rows) => {
        inserted.push({ table, rows });
        return { error: cfg.insertError ?? null };
      },
    }),
  };
  return { supabaseAdmin, updates, inserted, deletes };
}

const okEmbeddings = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);
const PPTX_DOC = { id: 'doc-1', file_path: 'folder/deck.pptx', bucket: 'rag_sources', file_type: 'pptx' };

function pptxDeps(sb, over = {}) {
  return {
    supabaseAdmin: sb.supabaseAdmin,
    extractPptxStructured: over.extractPptxStructured ?? extractPptxStructured,
    semanticChunkDeck: over.semanticChunkDeck ?? (async () => ({
      sections: [{ title: 'Samenvatting', slideStart: 1, slideEnd: 2, content: 'Lopende studietekst over het college.' }],
      mode: 'llm',
    })),
    splitLongSections: over.splitLongSections ?? splitLongSections,
    fallbackChunks: over.fallbackChunks ?? fallbackChunks,
    embedTextsServer: over.embedTextsServer ?? okEmbeddings,
    log: () => {},
  };
}

// --- Tests ---------------------------------------------------------------

describe('processPptxCore — chunking-modus en flow', () => {
  it('succes: LLM-modus → chunks met mode "llm" + embeddings + status completed', async () => {
    const buffer = buildPptxBuffer([
      { title: 'Inleiding', body: 'Eerste punt' },
      { title: 'Kern', body: 'Tweede punt' },
    ]);
    const sb = makeSupabase({ downloadResult: { data: blobFromBuffer(buffer), error: null } });

    const res = await processPptxCore(PPTX_DOC, 'sk-test', 'nl', pptxDeps(sb));

    expect(res.mode).toBe('llm');
    expect(res.slideCount).toBe(2);
    expect(res.totalChunks).toBe(1);
    expect(sb.inserted).toHaveLength(1);
    expect(sb.inserted[0].table).toBe('document_chunks');
    expect(sb.inserted[0].rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(sb.inserted[0].rows[0].metadata.chunkingMode).toBe('llm');
    expect(sb.inserted[0].rows[0].metadata.source).toBe('pptx');
    // Oude chunks opgeruimd vóór insert.
    expect(sb.deletes.some((d) => d.table === 'document_chunks')).toBe(true);
    expect(sb.updates.at(-1).processing_status).toBe('completed');
    expect(sb.updates.at(-1).total_chunks).toBe(1);
  });

  it('LLM-falen → deterministisch vangnet: mode "fallback" in metadata, status completed', async () => {
    const buffer = buildPptxBuffer([
      { title: 'Inleiding', body: 'Eerste punt' },
      { title: 'Kern', body: 'Tweede punt' },
    ]);
    const sb = makeSupabase({ downloadResult: { data: blobFromBuffer(buffer), error: null } });
    // Simuleer dat elk venster terugviel op het deterministische vangnet.
    const deps = pptxDeps(sb, {
      semanticChunkDeck: async (slides) => ({ sections: fallbackChunks(slides), mode: 'fallback' }),
    });

    const res = await processPptxCore(PPTX_DOC, 'sk-test', 'nl', deps);

    expect(res.mode).toBe('fallback');
    expect(sb.inserted[0].rows[0].metadata.chunkingMode).toBe('fallback');
    expect(sb.updates.at(-1).processing_status).toBe('completed');
  });

  it('lege deck → fout met status 422 + document op failed', async () => {
    const buffer = buildPptxBuffer([{ title: '', body: '' }], { empty: true });
    const sb = makeSupabase({ downloadResult: { data: blobFromBuffer(buffer), error: null } });

    let caught;
    try {
      await processPptxCore(PPTX_DOC, 'sk-test', 'nl', pptxDeps(sb));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(422);
    expect(caught.message).toMatch(/geen tekst/i);
    expect(sb.inserted).toHaveLength(0);
    expect(sb.updates.at(-1).processing_status).toBe('failed');
  });

  it('download-fout → fout met status 500 + document op failed', async () => {
    const sb = makeSupabase({ downloadResult: { data: null, error: { message: 'storage stuk' } } });

    let caught;
    try {
      await processPptxCore(PPTX_DOC, 'sk-test', 'nl', pptxDeps(sb));
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(500);
    expect(caught.message).toMatch(/downloaden/i);
    expect(sb.updates.at(-1).processing_status).toBe('failed');
  });

  it('insert-fout → fout met status 500 + document op failed', async () => {
    const buffer = buildPptxBuffer([{ title: 'A', body: 'B' }]);
    const sb = makeSupabase({
      downloadResult: { data: blobFromBuffer(buffer), error: null },
      insertError: { message: 'constraint' },
    });

    let caught;
    try {
      await processPptxCore(PPTX_DOC, 'sk-test', 'nl', pptxDeps(sb));
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(500);
    expect(caught.message).toMatch(/chunks niet opslaan/i);
    expect(sb.updates.at(-1).processing_status).toBe('failed');
  });
});
