import { describe, it, expect } from 'vitest';
import { processPptxCore, processPlainRagDocument, processDocxCore } from '../ragProcessing.js';
import { assignPdfPages } from '../pdfPages.js';

// Mini-mock van supabaseAdmin: legt elke documents-status-update vast zodat we
// kunnen verifiëren dat de fail-safe het document op 'failed' zet.
function makeMockSupabase({ blobText = 'Dit is wat leesbare tekst.', failUpdate = false } = {}) {
  const statusUpdates = [];
  const insertedRows = [];
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
      insert: async (rows) => {
        if (table === 'document_chunks') {
          for (const r of [].concat(rows)) insertedRows.push(r);
        }
        return { error: null };
      },
    }),
  };
  return { supabaseAdmin, statusUpdates, insertedRows };
}

// Mini-mock van pgPool: legt elke uitgevoerde query vast en kan een query die
// matcht met `failOn` (regex op de SQL) laten falen, zodat we het ROLLBACK-pad
// van de atomic-transactie kunnen verifiëren.
function makeMockPgPool({ failOn = null } = {}) {
  const queries = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (failOn && new RegExp(failOn, 'i').test(sql)) {
        throw new Error('query kapot');
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const pgPool = { connect: async () => client };
  return { pgPool, queries, wasReleased: () => released };
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

const PDF_DOC = { id: 'doc-pdf', file_path: 'folder/reader.pdf', bucket: 'rag_sources', file_type: 'pdf' };

describe('processPlainRagDocument — betrouwbare PDF-extractie (Task #397)', () => {
  it('gebruikt pdf.js (niet officeparser) voor PDF-tekst en koppelt paginanummers', async () => {
    const { supabaseAdmin, insertedRows, statusUpdates } = makeMockSupabase();
    const pageTexts = ['Hoofdstuk een over alpha beta gamma.', 'Hoofdstuk twee over delta epsilon zeta.'];
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      // officeparser zou hier ruis geven; pdf.js moet voorrang krijgen.
      parseOfficeAsync: async () => 'JUNK officeparser-tekst die niet gebruikt mag worden',
      extractPdfPageTexts: async () => pageTexts,
      assignPdfPages,
      chunkPlainText: () => pageTexts.slice(),
    };

    const res = await processPlainRagDocument(PDF_DOC, 'sk-test', deps);

    expect(res.totalChunks).toBe(2);
    expect(res.paged).toBe(true);
    expect(res.pagesAssigned).toBe(2);
    expect(insertedRows.map((r) => r.content)).toEqual(pageTexts);
    expect(insertedRows[0].metadata).toMatchObject({ source: 'pdf', pageStart: 1, pageNumber: 1 });
    expect(insertedRows[1].metadata).toMatchObject({ source: 'pdf', pageStart: 2, pageNumber: 2 });
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
  });

  it('valt terug op officeparser als pdf.js leeg blijft', async () => {
    const { supabaseAdmin, insertedRows, statusUpdates } = makeMockSupabase();
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      parseOfficeAsync: async () => 'Dit is de officeparser-terugval met genoeg leesbare tekst.',
      extractPdfPageTexts: async () => ['', ''],
      assignPdfPages,
      chunkPlainText: (t) => [t],
    };

    const res = await processPlainRagDocument(PDF_DOC, 'sk-test', deps);

    expect(res.paged).toBe(false);
    expect(res.pagesAssigned).toBe(0);
    expect(insertedRows[0].metadata.pageStart).toBeUndefined();
    expect(insertedRows[0].metadata.source).toBe('pdf');
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
  });

  it('markeert "failed" als zowel pdf.js als officeparser vrijwel niets opleveren', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      parseOfficeAsync: async () => 'x y z', // < MIN_BINARY_TEXT_CHARS
      extractPdfPageTexts: async () => ['', ''],
      assignPdfPages,
      chunkPlainText: (t) => [t],
    };

    await expect(processPlainRagDocument(PDF_DOC, 'sk-test', deps)).rejects.toThrow(/leesbare tekst/i);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(false);
  });
});

describe('atomic persistentie via pgPool (Task #397)', () => {
  it('schrijft chunks weg in één transactie (BEGIN → DELETE → INSERT → COMMIT)', async () => {
    const { supabaseAdmin } = makeMockSupabase();
    const { pgPool, queries, wasReleased } = makeMockPgPool();
    const deps = { supabaseAdmin, pgPool, embedTextsServer: okEmbeddings, ...plainDeps() };

    const res = await processPlainRagDocument(TXT_DOC, 'sk-test', deps);

    expect(res.totalChunks).toBe(1);
    const sqls = queries.map((q) => q.sql);
    expect(sqls.some((s) => /^\s*BEGIN/i.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM document_chunks/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO document_chunks/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE documents SET processing_status = 'completed'/i.test(s))).toBe(true);
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(true);
    expect(sqls.some((s) => /ROLLBACK/i.test(s))).toBe(false);
    expect(wasReleased()).toBe(true);
  });

  it('rolt terug (ROLLBACK, geen COMMIT) en markeert "failed" als de atomic insert faalt', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const { pgPool, queries, wasReleased } = makeMockPgPool({ failOn: 'INSERT INTO document_chunks' });
    const deps = { supabaseAdmin, pgPool, embedTextsServer: okEmbeddings, ...plainDeps() };

    await expect(processPlainRagDocument(TXT_DOC, 'sk-test', deps)).rejects.toThrow(/atomisch/i);

    const sqls = queries.map((q) => q.sql);
    expect(sqls.some((s) => /ROLLBACK/i.test(s))).toBe(true);
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(false);
    // De 'completed'-status zit binnen de transactie en mag dus nooit persisteren.
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(false);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
    expect(wasReleased()).toBe(true);
  });
});

const DOCX_DOC = { id: 'doc-docx', file_path: 'folder/essay.docx', bucket: 'rag_sources', file_type: 'docx' };

// De pagina-bewuste route: converteer naar PDF (mock), per-pagina tekst (mock),
// chunk op pagina-grenzen en koppel paginanummers via de echte assignPdfPages.
function docxPagedDeps(extra = {}) {
  const pageTexts = ['Pagina een alpha beta.', 'Pagina twee gamma delta.'];
  return {
    convertToPdf: async () => Buffer.from('%PDF-fake'),
    extractPdfPageTexts: async () => pageTexts,
    chunkPlainText: () => ['Pagina een alpha beta.', 'Pagina twee gamma delta.'],
    assignPdfPages,
    parseOfficeAsync: async () => 'platte tekst',
    ...extra,
  };
}

describe('processDocxCore — pagina-bewuste verwerking (Task #377)', () => {
  it('koppelt elke chunk aan zijn paginanummer en zet status op "completed"', async () => {
    const { supabaseAdmin, statusUpdates, insertedRows } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: okEmbeddings, ...docxPagedDeps() };

    const res = await processDocxCore(DOCX_DOC, 'sk-test', deps);

    expect(res.totalChunks).toBe(2);
    expect(res.paged).toBe(true);
    expect(res.pagesAssigned).toBe(2);
    expect(insertedRows[0].metadata).toMatchObject({ source: 'docx', pageStart: 1, pageEnd: 1, pageNumber: 1 });
    expect(insertedRows[1].metadata).toMatchObject({ source: 'docx', pageStart: 2, pageEnd: 2, pageNumber: 2 });
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(false);
  });

  it('valt terug op platte tekst (zonder paginavelden) als de PDF-conversie faalt', async () => {
    const { supabaseAdmin, statusUpdates, insertedRows } = makeMockSupabase();
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      ...docxPagedDeps({
        convertToPdf: async () => { throw new Error('soffice niet beschikbaar'); },
        chunkPlainText: (t) => [t],
      }),
    };

    const res = await processDocxCore(DOCX_DOC, 'sk-test', deps);

    expect(res.paged).toBe(false);
    expect(res.pagesAssigned).toBe(0);
    expect(insertedRows[0].metadata.pageStart).toBeUndefined();
    expect(insertedRows[0].metadata.source).toBe('docx');
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(true);
  });

  it('zet processing_status op "failed" als de embeddings-call faalt', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = { supabaseAdmin, embedTextsServer: failingEmbeddings, ...docxPagedDeps() };

    await expect(processDocxCore(DOCX_DOC, 'sk-test', deps)).rejects.toThrow(/embeddings/i);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
    expect(statusUpdates.some((u) => u.processing_status === 'completed')).toBe(false);
  });

  it('markeert als "failed" als er geen leesbare tekst is (lege PDF + lege platte tekst)', async () => {
    const { supabaseAdmin, statusUpdates } = makeMockSupabase();
    const deps = {
      supabaseAdmin,
      embedTextsServer: okEmbeddings,
      ...docxPagedDeps({
        extractPdfPageTexts: async () => ['', ''],
        parseOfficeAsync: async () => '   ',
      }),
    };

    await expect(processDocxCore(DOCX_DOC, 'sk-test', deps)).rejects.toThrow(/leesbare tekst/i);
    expect(statusUpdates.some((u) => u.processing_status === 'failed')).toBe(true);
  });
});
