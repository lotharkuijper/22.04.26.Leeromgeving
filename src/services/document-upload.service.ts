import { supabase } from '../lib/supabase';
import { processDocument } from './document-processor.service';
import { generateEmbeddings } from './llm.service';
import { STORAGE_CONFIG, getBucketForType, type BucketType } from '../config/storage.config';
import { sanitizeText, sanitizeMetadata } from '../lib/sanitizeText';

export interface UploadProgress {
  stage: 'uploading' | 'processing' | 'generating' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  currentChunk?: number;
  totalChunks?: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

function isPptx(fileName: string): boolean {
  return fileName.split('.').pop()?.toLowerCase() === 'pptx';
}

// Pagineerbare Word-bronnen worden server-side verwerkt (Task #377): LibreOffice
// converteert .docx → PDF en per-pagina tekstextractie koppelt elke chunk aan
// zijn paginanummer(s), net zoals bij PDF's.
const DOCX_PAGED_EXT = new Set(['docx', 'doc', 'odt']);
function isDocx(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return DOCX_PAGED_EXT.has(ext);
}

// PowerPoint wordt server-side verwerkt: dia's + sprekersnotities worden
// uitgelezen en semantisch gechunkt (LLM) op de server. De server haalt het
// bestand zelf uit storage op basis van het document-id.
async function processPptxOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Niet geauthenticeerd');

  const res = await fetch('/api/admin/process-pptx', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `PowerPoint-verwerking mislukt (${res.status})`);
  }
  return data.totalChunks ?? 0;
}

interface ChunkRecord {
  document_id: string;
  content: string;
  embedding: number[];
  chunk_index: number;
  metadata: unknown;
}

// Postgres/PostgREST weigert tekst met onopslaanbare tekens (NUL, ongepaarde
// surrogaten) met meldingen als "unsupported Unicode escape sequence". De content
// wordt al bij het bouwen van de rijen gesaneerd (zie sanitizeText), maar als er
// tóch nog zo'n fout optreedt vangen we hem hier op: we proberen de batch dan
// fragment-voor-fragment en slaan een enkel onopslaanbaar fragment over in plaats
// van het hele document te laten mislukken. Geeft het aantal opgeslagen +
// overgeslagen fragmenten terug.
const UNSTORABLE_TEXT_ERROR_RE = /unicode|escape|surrogate|\\u0000|invalid byte|untranslatable/i;

async function insertChunkBatch(records: ChunkRecord[]): Promise<{ stored: number; skipped: number }> {
  if (records.length === 0) return { stored: 0, skipped: 0 };

  const { error } = await supabase.from('document_chunks').insert(records);
  if (!error) return { stored: records.length, skipped: 0 };

  // Niet-teken-gerelateerde fout (netwerk, RLS, ...): meteen doorgooien.
  if (!UNSTORABLE_TEXT_ERROR_RE.test(error.message || '')) {
    throw new Error(`Fragmenten opslaan mislukt: ${error.message}`);
  }

  // Een multi-row insert is atomisch: bij een fout is er niets opgeslagen, dus we
  // kunnen veilig fragment-voor-fragment opnieuw proberen en alleen het rotte
  // fragment overslaan.
  let stored = 0;
  let skipped = 0;
  for (const rec of records) {
    const { error: oneErr } = await supabase.from('document_chunks').insert(rec);
    if (oneErr) {
      // Alleen écht onopslaanbare-teken-fouten overslaan; andere fouten (netwerk,
      // RLS, vector, ...) niet stilzwijgend negeren maar doorgooien, anders raken
      // we ongemerkt fragmenten kwijt.
      if (!UNSTORABLE_TEXT_ERROR_RE.test(oneErr.message || '')) {
        throw new Error(`Fragmenten opslaan mislukt: ${oneErr.message}`);
      }
      skipped += 1;
      console.warn(
        `[document-upload] Fragment ${rec.chunk_index} overgeslagen (onopslaanbare tekens): ${oneErr.message}`,
      );
    } else {
      stored += 1;
    }
  }
  return { stored, skipped };
}

// Eén embed-batch ophalen met begrensde terugval bij de Azure-snelheidslimiet (429).
// De server probeert al meerdere keren; raakt hij tóch uitgeput, dan wacht de client
// nog kort en probeert opnieuw, zodat een TIJDELIJKE limiet de verwerking niet meteen
// afbreekt. Andere fouten (netwerk, RLS, onopslaanbare tekens) gaan meteen door.
const EMBED_RATE_LIMIT_WAIT_MS = 30000;
const EMBED_RATE_LIMIT_RETRIES = 2;

async function embedBatchWithClientRetry(
  texts: string[],
  onRateLimitWait?: (attempt: number, waitMs: number) => void,
): Promise<number[][]> {
  let attempt = 0;
  for (;;) {
    try {
      return await generateEmbeddings(texts);
    } catch (err) {
      const isRateLimit =
        (err as { isRateLimit?: boolean })?.isRateLimit === true ||
        /snelheidslimiet|rate.?limit|\b429\b/i.test(
          err instanceof Error ? err.message : String(err),
        );
      if (!isRateLimit || attempt >= EMBED_RATE_LIMIT_RETRIES) {
        throw err;
      }
      attempt += 1;
      onRateLimitWait?.(attempt, EMBED_RATE_LIMIT_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, EMBED_RATE_LIMIT_WAIT_MS));
    }
  }
}

// Word-document (.docx/.doc/.odt) server-side verwerken met paginanummers. De
// server haalt het bestand zelf uit storage op basis van het document-id.
async function processDocxOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Niet geauthenticeerd');

  const res = await fetch('/api/admin/process-docx', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Word-verwerking mislukt (${res.status})`);
  }
  return data.totalChunks ?? 0;
}

export async function uploadDocument(
  file: File,
  title: string,
  description: string,
  userId: string,
  folderId: string | null = null,
  bucketType: BucketType = 'rag_sources',
  skipEmbeddings: boolean = false,
  onProgress?: ProgressCallback
): Promise<{ documentId: string }> {
  // Onthoud het aangemaakte document-id op functie-niveau zodat de buitenste catch een
  // halverwege gestrand document (bijv. embeddings die op de snelheidslimiet stuklopen)
  // niet eindeloos op 'processing' laat staan, maar netjes als 'failed' markeert.
  let createdDocId: string | null = null;
  try {
    const bucket = getBucketForType(bucketType);
    const shouldGenerateEmbeddings = !skipEmbeddings && STORAGE_CONFIG.ragEnabled[bucketType];

    onProgress?.({
      stage: 'uploading',
      progress: 10,
      message: 'Bestand uploaden naar opslag...',
    });

    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = folderId
      ? `${folderId}/${timestamp}_${sanitizedName}`
      : `${userId}/${timestamp}_${sanitizedName}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, file);

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    onProgress?.({
      stage: 'uploading',
      progress: 20,
      message: 'Document record aanmaken...',
    });

    const { data: docData, error: docError } = await supabase
      .from('documents')
      .insert({
        title,
        description,
        filename: file.name,
        file_path: filePath,
        file_type: file.name.split('.').pop()?.toLowerCase() || 'unknown',
        file_size: file.size,
        folder_id: folderId,
        bucket: bucket,
        processing_status: shouldGenerateEmbeddings ? 'processing' : 'completed',
        uploaded_by: userId,
      })
      .select()
      .single();

    if (docError || !docData) {
      await supabase.storage.from(bucket).remove([filePath]);
      throw new Error(`Failed to create document record: ${docError?.message}`);
    }

    createdDocId = docData.id;

    if (!shouldGenerateEmbeddings) {
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Bestand succesvol geüpload!',
      });

      return { documentId: docData.id };
    }

    onProgress?.({
      stage: 'processing',
      progress: 30,
      message: 'Tekst extracten uit document...',
    });

    // PowerPoint volledig server-side verwerken (dia's + sprekersnotities,
    // semantische chunking). De server schrijft chunks en zet de status zelf.
    if (isPptx(file.name)) {
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: 'PowerPoint verwerken op de server (dia\'s + notities)...',
      });
      try {
        const totalChunks = await processPptxOnServer(docData.id);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: 'PowerPoint succesvol verwerkt!',
          totalChunks,
        });
        return { documentId: docData.id };
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', docData.id);
        throw err;
      }
    }

    // Word-bronnen server-side verwerken zodat chunks paginanummers krijgen
    // (LibreOffice→PDF + per-pagina tekst). De server schrijft chunks + status.
    if (isDocx(file.name)) {
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: 'Word-document verwerken op de server (paginanummers)...',
      });
      try {
        const totalChunks = await processDocxOnServer(docData.id);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: 'Word-document succesvol verwerkt!',
          totalChunks,
        });
        return { documentId: docData.id };
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', docData.id);
        throw err;
      }
    }

    const processedDoc = await processDocument(file);

    onProgress?.({
      stage: 'generating',
      progress: 40,
      message: 'Embeddings genereren...',
      currentChunk: 0,
      totalChunks: processedDoc.chunks.length,
    });

    const batchSize = 5;
    const chunks = processedDoc.chunks;
    let processedChunks = 0;
    let storedChunks = 0;
    let skippedChunks = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      // Saneer vóór embedding én opslag, zodat de embedding bij de opgeslagen
      // tekst past en de insert nooit op onopslaanbare tekens stukloopt.
      const texts = batch.map(chunk => sanitizeText(chunk.text));

      const embeddings = await embedBatchWithClientRetry(texts, (attempt, waitMs) => {
        onProgress?.({
          stage: 'generating',
          progress: 40 + Math.floor((processedChunks / chunks.length) * 50),
          message: `Snelheidslimiet bereikt — even wachten (${Math.round(waitMs / 1000)}s, poging ${attempt}/${EMBED_RATE_LIMIT_RETRIES})...`,
          currentChunk: processedChunks,
          totalChunks: chunks.length,
        });
      });

      const chunkRecords: ChunkRecord[] = batch.map((chunk, idx) => ({
        document_id: docData.id,
        content: texts[idx],
        embedding: embeddings[idx],
        chunk_index: i + idx,
        metadata: sanitizeMetadata(chunk.metadata),
      }));

      const { stored, skipped } = await insertChunkBatch(chunkRecords);
      storedChunks += stored;
      skippedChunks += skipped;

      processedChunks += batch.length;
      const progressPercent = 40 + Math.floor((processedChunks / chunks.length) * 50);

      onProgress?.({
        stage: 'generating',
        progress: progressPercent,
        message: 'Embeddings genereren...',
        currentChunk: processedChunks,
        totalChunks: chunks.length,
      });

      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (chunks.length > 0 && storedChunks === 0) {
      await supabase
        .from('documents')
        .update({ processing_status: 'failed' })
        .eq('id', docData.id);
      throw new Error(
        'Geen enkel tekstfragment uit dit document kon worden opgeslagen. Het bestand bevat mogelijk ongeldige tekens of geen leesbare tekst.',
      );
    }

    onProgress?.({
      stage: 'saving',
      progress: 95,
      message: 'Document voltooien...',
    });

    const { error: updateError } = await supabase
      .from('documents')
      .update({
        processing_status: 'completed',
        total_chunks: storedChunks,
      })
      .eq('id', docData.id);

    if (updateError) {
      console.error('Failed to update document status:', updateError);
    }

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message:
        skippedChunks > 0
          ? `Document verwerkt — ${skippedChunks} fragment(en) met ongeldige tekens overgeslagen.`
          : 'Document succesvol verwerkt!',
    });

    return { documentId: docData.id };
  } catch (error) {
    // Markeer een halverwege gestrand nieuw document als 'failed' (bijv. embeddings die
    // op de snelheidslimiet stuklopen of een mislukte insert), zodat het niet eindeloos
    // op 'processing' blijft hangen. Dit is veilig: het document is zojuist aangemaakt en
    // had nog geen bruikbare set fragmenten.
    if (createdDocId) {
      await supabase
        .from('documents')
        .update({ processing_status: 'failed' })
        .eq('id', createdDocId);
    }

    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });

    throw error;
  }
}

export async function retryFailedDocument(documentId: string, onProgress?: ProgressCallback): Promise<void> {
  // Bijhouden of we al iets onomkeerbaars (chunks verwijderen) hebben gedaan, plus de
  // status van vóór deze poging, zodat we bij een vroege fout de oude staat herstellen
  // i.p.v. een nog-intact document onterecht op 'failed' te zetten.
  let destructiveStarted = false;
  let originalStatusForRestore: string | null = null;
  try {
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      throw new Error('Document not found');
    }

    originalStatusForRestore = doc.processing_status || 'completed';

    // PowerPoint server-side opnieuw verwerken (server ruimt oude chunks op,
    // leest dia's + notities en zet de status zelf).
    if ((doc.file_type || '').toLowerCase() === 'pptx' || isPptx(doc.file_path || '')) {
      await supabase
        .from('documents')
        .update({ processing_status: 'processing' })
        .eq('id', documentId);
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: 'PowerPoint verwerken op de server (dia\'s + notities)...',
      });
      try {
        const totalChunks = await processPptxOnServer(documentId);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: 'PowerPoint succesvol verwerkt!',
          totalChunks,
        });
        return;
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', documentId);
        onProgress?.({
          stage: 'error',
          progress: 0,
          message: err instanceof Error ? err.message : 'Unknown error occurred',
        });
        throw err;
      }
    }

    // Word server-side opnieuw verwerken (server ruimt oude chunks op, converteert
    // naar PDF voor paginanummers en zet de status zelf).
    if (DOCX_PAGED_EXT.has((doc.file_type || '').toLowerCase()) || isDocx(doc.file_path || '')) {
      await supabase
        .from('documents')
        .update({ processing_status: 'processing' })
        .eq('id', documentId);
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: 'Word-document verwerken op de server (paginanummers)...',
      });
      try {
        const totalChunks = await processDocxOnServer(documentId);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: 'Word-document succesvol verwerkt!',
          totalChunks,
        });
        return;
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', documentId);
        onProgress?.({
          stage: 'error',
          progress: 0,
          message: err instanceof Error ? err.message : 'Unknown error occurred',
        });
        throw err;
      }
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from(doc.bucket || 'rag_sources')
      .download(doc.file_path);

    if (downloadError || !fileData) {
      throw new Error('Failed to download document');
    }

    const file = new File([fileData], doc.file_path.split('/').pop() || 'document', {
      type: doc.file_type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    await supabase
      .from('documents')
      .update({ processing_status: 'processing' })
      .eq('id', documentId);

    onProgress?.({
      stage: 'processing',
      progress: 20,
      message: 'Tekst extracten uit document...',
    });

    const processedDoc = await processDocument(file);

    onProgress?.({
      stage: 'generating',
      progress: 30,
      message: 'Embeddings genereren...',
      currentChunk: 0,
      totalChunks: processedDoc.chunks.length,
    });

    // CRASHBESTENDIG: genereer eerst ALLE embeddings (de faalgevoelige stap die op de
    // Azure-snelheidslimiet kan stuklopen) en verwijder nog NIETS. Pas als alle
    // embeddings binnen zijn, wisselen we oude→nieuwe chunks om. Faalt het embedden,
    // dan blijven de bestaande chunks intact en herstellen we de oude status — zo
    // raakt een document nooit zijn fragmenten kwijt door een tijdelijke limiet.
    const batchSize = 5;
    const chunks = processedDoc.chunks;
    const pendingRecords: ChunkRecord[] = [];
    let processedChunks = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      // Saneer vóór embedding én opslag (zie uploadDocument).
      const texts = batch.map(chunk => sanitizeText(chunk.text));

      const embeddings = await embedBatchWithClientRetry(texts, (attempt, waitMs) => {
        onProgress?.({
          stage: 'generating',
          progress: 30 + Math.floor((processedChunks / chunks.length) * 60),
          message: `Snelheidslimiet bereikt — even wachten (${Math.round(waitMs / 1000)}s, poging ${attempt}/${EMBED_RATE_LIMIT_RETRIES})...`,
          currentChunk: processedChunks,
          totalChunks: chunks.length,
        });
      });

      batch.forEach((chunk, idx) => {
        pendingRecords.push({
          document_id: documentId,
          content: texts[idx],
          embedding: embeddings[idx],
          chunk_index: i + idx,
          metadata: sanitizeMetadata(chunk.metadata),
        });
      });

      processedChunks += batch.length;
      const progressPercent = 30 + Math.floor((processedChunks / chunks.length) * 60);

      onProgress?.({
        stage: 'generating',
        progress: progressPercent,
        message: 'Embeddings genereren...',
        currentChunk: processedChunks,
        totalChunks: chunks.length,
      });

      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Alle embeddings staan klaar → nu pas de oude fragmenten vervangen. Dit venster
    // bevat geen embedding-calls meer, dus de snelheidslimiet raakt ons hier niet.
    onProgress?.({
      stage: 'saving',
      progress: 92,
      message: 'Fragmenten vervangen...',
    });

    // Pas NA een geslaagde delete de vlag zetten: mislukt de delete zelf (de oude
    // fragmenten staan er dan nog), dan willen we de oorspronkelijke status herstellen
    // i.p.v. het document onterecht als 'failed' te markeren.
    const { error: deleteError } = await supabase
      .from('document_chunks')
      .delete()
      .eq('document_id', documentId);
    if (deleteError) {
      throw new Error(
        `Oude fragmenten konden niet worden verwijderd: ${deleteError.message}`,
      );
    }
    destructiveStarted = true;

    let storedChunks = 0;
    let skippedChunks = 0;
    const insertBatchSize = 50;
    for (let i = 0; i < pendingRecords.length; i += insertBatchSize) {
      const { stored, skipped } = await insertChunkBatch(
        pendingRecords.slice(i, i + insertBatchSize),
      );
      storedChunks += stored;
      skippedChunks += skipped;
    }

    if (chunks.length > 0 && storedChunks === 0) {
      throw new Error(
        'Geen enkel tekstfragment uit dit document kon worden opgeslagen. Het bestand bevat mogelijk ongeldige tekens of geen leesbare tekst.',
      );
    }

    await supabase
      .from('documents')
      .update({
        processing_status: 'completed',
        total_chunks: storedChunks,
      })
      .eq('id', documentId);

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message:
        skippedChunks > 0
          ? `Document verwerkt — ${skippedChunks} fragment(en) met ongeldige tekens overgeslagen.`
          : 'Document succesvol verwerkt!',
    });
  } catch (error) {
    // Hadden we nog niets verwijderd (de oude chunks staan er nog)? Herstel dan de
    // oorspronkelijke status, zodat een eerder voltooid document niet onterecht als
    // 'failed' wordt gemarkeerd terwijl het zijn fragmenten gewoon behoudt. Alleen
    // wanneer de vervang-stap al begonnen was, is 'failed' terecht.
    const restoreStatus =
      !destructiveStarted && originalStatusForRestore
        ? originalStatusForRestore
        : 'failed';
    await supabase
      .from('documents')
      .update({
        processing_status: restoreStatus,
      })
      .eq('id', documentId);

    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });

    throw error;
  }
}

export interface MultiFileProgress {
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  progress: UploadProgress;
}

export type MultiFileProgressCallback = (progress: MultiFileProgress) => void;

export interface MultiFileResult {
  successful: { fileName: string; documentId: string }[];
  failed: { fileName: string; error: string }[];
}

export async function uploadMultipleDocuments(
  files: File[],
  titles: string[],
  descriptions: string[],
  userId: string,
  folderId: string | null = null,
  onProgress?: MultiFileProgressCallback
): Promise<MultiFileResult> {
  const results: MultiFileResult = {
    successful: [],
    failed: [],
  };

  let bucketType: BucketType = 'rag_sources';
  let skipEmbeddings = false;

  if (folderId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        const res = await fetch(`/api/folder-type?folderId=${encodeURIComponent(folderId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const { folderType } = await res.json();
          if (folderType === 'data') {
            bucketType = 'datasets';
            skipEmbeddings = true;
          } else if (folderType !== 'rag_sources') {
            bucketType = 'general';
            skipEmbeddings = true;
          }
        }
      }
    } catch {
    }
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const title = titles[i] || file.name;
    const description = descriptions[i] || '';

    try {
      const { documentId } = await uploadDocument(
        file,
        title,
        description,
        userId,
        folderId,
        bucketType,
        skipEmbeddings,
        (progress) => {
          onProgress?.({
            fileName: file.name,
            fileIndex: i,
            totalFiles: files.length,
            progress,
          });
        }
      );

      results.successful.push({
        fileName: file.name,
        documentId,
      });
    } catch (error) {
      results.failed.push({
        fileName: file.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
