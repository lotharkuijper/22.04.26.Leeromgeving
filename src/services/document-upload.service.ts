import { supabase } from '../lib/supabase';
import { processDocument } from './document-processor.service';
import { generateEmbeddings } from './llm.service';
import { STORAGE_CONFIG, getBucketForType, type BucketType } from '../config/storage.config';

export interface UploadProgress {
  stage: 'uploading' | 'processing' | 'generating' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  currentChunk?: number;
  totalChunks?: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

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

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(chunk => chunk.text);

      const embeddings = await generateEmbeddings(texts);

      const chunkRecords = batch.map((chunk, idx) => ({
        document_id: docData.id,
        content: chunk.text,
        embedding: embeddings[idx],
        chunk_index: i + idx,
        metadata: chunk.metadata,
      }));

      const { error: chunkError } = await supabase
        .from('document_chunks')
        .insert(chunkRecords);

      if (chunkError) {
        throw new Error(`Failed to save chunks: ${chunkError.message}`);
      }

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

    onProgress?.({
      stage: 'saving',
      progress: 95,
      message: 'Document voltooien...',
    });

    const { error: updateError } = await supabase
      .from('documents')
      .update({
        processing_status: 'completed',
        total_chunks: chunks.length,
      })
      .eq('id', docData.id);

    if (updateError) {
      console.error('Failed to update document status:', updateError);
    }

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: 'Document succesvol verwerkt!',
    });

    return { documentId: docData.id };
  } catch (error) {
    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });

    throw error;
  }
}

export async function retryFailedDocument(documentId: string, onProgress?: ProgressCallback): Promise<void> {
  try {
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      throw new Error('Document not found');
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
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

    await supabase
      .from('document_chunks')
      .delete()
      .eq('document_id', documentId);

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

    const batchSize = 5;
    const chunks = processedDoc.chunks;
    let processedChunks = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(chunk => chunk.text);

      const embeddings = await generateEmbeddings(texts);

      const chunkRecords = batch.map((chunk, idx) => ({
        document_id: documentId,
        content: chunk.text,
        embedding: embeddings[idx],
        chunk_index: i + idx,
        metadata: chunk.metadata,
      }));

      await supabase
        .from('document_chunks')
        .insert(chunkRecords);

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

    await supabase
      .from('documents')
      .update({
        processing_status: 'completed',
        total_chunks: chunks.length,
      })
      .eq('id', documentId);

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: 'Document succesvol verwerkt!',
    });
  } catch (error) {
    await supabase
      .from('documents')
      .update({
        processing_status: 'failed',
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
    const { data: folder } = await supabase
      .from('document_folders')
      .select('folder_type')
      .eq('id', folderId)
      .single();

    if (folder) {
      const folderType = folder.folder_type;
      if (folderType === 'rag_sources') {
        bucketType = 'rag_sources';
        skipEmbeddings = false;
      } else if (folderType === 'data') {
        bucketType = 'datasets';
        skipEmbeddings = true;
      } else {
        bucketType = 'general';
        skipEmbeddings = true;
      }
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
