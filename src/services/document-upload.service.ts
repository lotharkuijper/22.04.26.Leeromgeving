import { supabase } from '../lib/supabase';
import { STORAGE_CONFIG, getBucketForType, type BucketType } from '../config/storage.config';

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

// Algemene RAG-bron (pdf/txt e.d.) server-side verwerken op document-id. De server
// haalt het bestand zelf uit storage, extraheert tekst (PDF per pagina via pdf.js →
// paginanummers), chunkt, embeddt en vervangt de fragmenten ATOMISCH (delete+insert+
// status in één transactie). Zo raakt een document nooit zijn fragmenten kwijt door
// een crash of snelheidslimiet halverwege — identiek aan het Word/PowerPoint-pad.
async function processRagDocOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Niet geauthenticeerd');

  const res = await fetch('/api/admin/process-rag-document', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Documentverwerking mislukt (${res.status})`);
  }
  return data.totalChunks ?? 0;
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

    // PDF/txt en overige RAG-bronnen server-side verwerken: de server extraheert
    // tekst (PDF per pagina → paginanummers), chunkt, embeddt en persisteert de
    // fragmenten ATOMISCH. Zo is er geen niet-atomisch client-side venster meer en
    // gedraagt een PDF zich net als Word/PowerPoint.
    onProgress?.({
      stage: 'generating',
      progress: 50,
      message: 'Document verwerken op de server...',
    });
    try {
      const totalChunks = await processRagDocOnServer(docData.id);
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Document succesvol verwerkt!',
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
  // De status van vóór deze poging onthouden zodat we bij een fout de oude staat
  // herstellen i.p.v. een nog-intact document onterecht op 'failed' te zetten. Alle
  // verwerking loopt nu server-side en ATOMISCH (de bestaande fragmenten blijven
  // staan als het faalt), dus een mislukte herverwerking is nooit destructief.
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

    // PDF/txt en overige RAG-bronnen server-side opnieuw verwerken. De server
    // extraheert tekst (PDF per pagina → paginanummers), chunkt, embeddt en vervangt
    // de fragmenten ATOMISCH (delete+insert+status in één transactie). Faalt het
    // embedden of de snelheidslimiet, dan blijven de bestaande fragmenten staan —
    // er is geen niet-atomisch venster meer waarin het document leeg kan raken.
    await supabase
      .from('documents')
      .update({ processing_status: 'processing' })
      .eq('id', documentId);

    onProgress?.({
      stage: 'generating',
      progress: 50,
      message: 'Document verwerken op de server...',
    });

    try {
      const totalChunks = await processRagDocOnServer(documentId);
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Document succesvol verwerkt!',
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
  } catch (error) {
    // Alle verwerking loopt nu server-side en ATOMISCH: bij een fout blijven de
    // bestaande fragmenten staan. Herstel daarom de oorspronkelijke status, zodat een
    // eerder voltooid document niet onterecht als 'failed' blijft staan terwijl het
    // zijn fragmenten gewoon behoudt. Was er geen oude status, dan is 'failed' terecht.
    const restoreStatus = originalStatusForRestore || 'failed';
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
