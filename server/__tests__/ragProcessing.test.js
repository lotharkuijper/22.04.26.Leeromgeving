import { describe, it, expect } from 'vitest';
import { processPptxCore, processPlainRagDocument } from '../ragProcessing.js';

// Mini-mock van supabaseAdmin: legt elke documents-status-update vast zodat we
// kunnen verifiëren dat de fail-safe het document op 'failed' zet.
function makeMockSupabase({ blobText = 'Dit is wat leesbare tekst.', failUpdate = false } = {}) {
  const statusUpdates = [];
  const blob = { arrayBuffer: async () => Buffer.from(blobText, 'utf8') };
  const supabaseAdmin = {
    storage: {
      from: () => ({
        download: async () => ({ data: blob, error: null }),
      }),
    },
    from: (table) => ({
      update: (payload) => ({
        eq: async () => {
          if (table === 'documents') {
            statusUpdates.push(payload);
            if (failUpdate) return { error: { message: 'update faalde' } };
          }
          return { error: null };
        },
      }),
      delete: () => ({ eq: async () => ({ error: null }) }),
      insert: async () => ({ error: null }),
    }),
  };
  return { supabaseAdmin, statusUpdates };
}

const failingEmbeddings = async () => { throw new Error('embeddings API onbereikbaar'); };
const okEmbeddings = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);

function pptxDeps(extra = {}) {
  return {
    extractPptxStructured: () => [{ title: 'Titel', body: 'Inhoud', notes: '' }],
    semanticChunkDeck: async () => ({
      sections: [{ content: 'sectie-inhoud', slideStart: 1, slideEnd: 1, title: 'Titel' }],
      mode: 'semantic',
    }),
    splitLongSections: (s) => s,
    fallbackChunks: () => [],
    ...extra,
  };
}

function plainDeps(extra = {}) {
  return {
    parseOfficeAsync: async () => 'office tekst',
    chunkPlainText: (text) => [text],
    ...extra,
  };
}

const PPTX_DOC = { id: 'doc-pptx', file_path: 'folder/deck.pptx', bucket: 'rag_sources', file_type: 'pptx' };
const TXT_DOC = { id: 'doc-txt', file_path: 'folder/notes.txt', bucket: 'rag_sources', file_type: 'txt' };

describe('processPptxCore fail-safe', () => {
  it('zet processing_status op "failed" als de embeddings-call faalt', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: failingEmbeddings, ...pptxDeps() };

    await expect(processPptxCore(PPTX_DOC, 'sk-test', 'nl', deps)).rejects.toThrow(/embeddings/i);

    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(false);
  });

  it('markeert ook als "failed" bij een fout vroeg in de pijplijn (uitlezen pptx)', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      ...pptxDeps({
        extractPptxStructured: () => { throw new Error('corrupt bestand'); },
      }),
    };

    await expect(processPptxCore(PPTX_DOC, 'sk-test', 'nl', deps)).rejects.toThrow(/PowerPoint/i);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
  });

  it('zet status op "completed" bij succes (geen "failed")', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: okEmbeddings, ...pptxDeps() };

    const res = await processPptxCore(PPTX_DOC, 'sk-test', 'nl', deps);

    expect(res.totalChunks).toBe(1);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(false);
  });
});

describe('processPlainRagDocument fail-safe', () => {
  it('zet processing_status op "failed" als de embeddings-call faalt', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: failingEmbeddings, ...plainDeps() };

    await expect(processPlainRagDocument(TXT_DOC, 'sk-test', deps)).rejects.toThrow(/embeddings/i);

    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(false);
  });

  it('markeert ook als "failed" als er geen leesbare tekst is', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase({ blobText: '   ' });
    const deps = { supabaseAdmin, embedTextsServer: okEmbeddings, ...plainDeps() };

    await expect(processPlainRagDocument(TXT_DOC, 'sk-test', deps)).rejects.toThrow(/leesbare tekst/i);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
  });

  it('zet status op "completed" bij succes (geen "failed")', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: okEmbeddings, ...plainDeps() };

    const res = await processPlainRagDocument(TXT_DOC, 'sk-test', deps);

    expect(res.totalChunks).toBe(1);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(false);
  });
});
