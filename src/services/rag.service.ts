import { supabase } from '../lib/supabase';
import { getAccessibleFolders } from './permissions.service';
import { generateEmbeddings } from './llm.service';
import { STORAGE_CONFIG } from '../config/storage.config';

export interface DocumentChunk {
  id: string;
  content: string;
  documentTitle: string;
  similarity: number;
  metadata: unknown;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const embeddings = await generateEmbeddings([text]);
    return embeddings[0] || null;
  } catch (error) {
    console.warn('No embedding generated, RAG functionality will be limited:', error);
    return null;
  }
}

export async function getRAGEnabledFolders(
  moduleType?: 'general' | 'explain' | 'project' | 'quiz',
  courseId?: string | null
): Promise<string[]> {
  if (courseId === null) {
    return [];
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      console.warn('[RAG] No session token — cannot fetch RAG folders');
      return [];
    }

    const params = new URLSearchParams();
    if (courseId !== undefined) params.set('courseId', courseId);
    if (moduleType) params.set('moduleType', moduleType);

    const response = await fetch(`/api/rag-enabled-folders?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.error('[RAG] rag-enabled-folders error:', response.status);
      return [];
    }

    const data = await response.json();
    return data.folderIds ?? [];
  } catch (error) {
    console.error('[RAG] Error fetching RAG-enabled folders:', error);
    return [];
  }
}

export async function searchRelevantChunks(
  query: string,
  matchThreshold: number = 0.7,
  matchCount: number = 5,
  moduleType?: 'general' | 'explain' | 'project' | 'quiz',
  userRole: 'student' | 'docent' | 'admin' = 'admin',
  courseId?: string | null
): Promise<DocumentChunk[]> {
  if (courseId === null) {
    console.log('[RAG] No active course — skipping RAG search');
    return [];
  }

  const embedding = await generateEmbedding(query);

  if (!embedding) {
    console.warn('[RAG] No embedding generated, RAG not available');
    return [];
  }

  try {
    const { count: docCount } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('bucket', STORAGE_CONFIG.buckets.RAG_SOURCES);

    if (!docCount || docCount === 0) {
      console.warn('[RAG] No RAG documents in database, operating without RAG context');
      return [];
    }

    console.log(`[RAG] Found ${docCount} RAG documents in database`);

    const ragEnabledFolders = await getRAGEnabledFolders(moduleType, courseId);

    if (courseId !== undefined && ragEnabledFolders.length === 0) {
      console.log('[RAG] Active course has no RAG folders for this module — skipping RAG');
      return [];
    }

    const accessibleFolderIds = await getAccessibleFolders(userRole);

    const allowedFolderIds = userRole === 'admin'
      ? ragEnabledFolders
      : ragEnabledFolders.filter((id) => accessibleFolderIds.includes(id));

    console.log(`[RAG] Allowed folder IDs: ${allowedFolderIds.length}`);

    const { data: allChunks, error } = await supabase.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: matchThreshold,
      match_count: matchCount * 3,
    });

    if (error) {
      console.error('[RAG] Error searching chunks:', error);
      return [];
    }

    if (!allChunks || allChunks.length === 0) {
      console.warn('[RAG] No matching chunks found for query');
      return [];
    }

    console.log(`[RAG] Found ${allChunks.length} matching chunks`);

    const { data: documents } = await supabase
      .from('documents')
      .select('id, folder_id, bucket')
      .in('id', allChunks.map((c: { document_id: string }) => c.document_id))
      .eq('bucket', STORAGE_CONFIG.buckets.RAG_SOURCES);

    const allowedDocIds = new Set(
      documents
        ?.filter((doc) => {
          if (!doc.folder_id) return allowedFolderIds.length === 0;
          return allowedFolderIds.includes(doc.folder_id);
        })
        .map((doc) => doc.id) || []
    );

    const filteredChunks = (allChunks as Array<{ id: string; document_id: string; content: string; document_title: string; similarity: number; metadata: unknown }>)
      .filter((chunk) => allowedDocIds.has(chunk.document_id))
      .slice(0, matchCount);

    console.log(`[RAG] Returning ${filteredChunks.length} filtered chunks`);

    return filteredChunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      documentTitle: chunk.document_title,
      similarity: chunk.similarity,
      metadata: chunk.metadata,
    }));
  } catch (error) {
    console.error('[RAG] Unexpected error in searchRelevantChunks:', error);
    return [];
  }
}

export async function checkRAGAvailability(): Promise<{
  documentsAvailable: boolean;
  chunksAvailable: boolean;
  embeddingsConfigured: boolean;
  documentCount: number;
  chunkCount: number;
  ragFoldersCount: number;
}> {
  try {
    const { count: docCount } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('bucket', STORAGE_CONFIG.buckets.RAG_SOURCES);

    const { count: chunkCount } = await supabase
      .from('document_chunks')
      .select('*', { count: 'exact', head: true });

    const { count: ragFoldersCount } = await supabase
      .from('document_folders')
      .select('*', { count: 'exact', head: true })
      .eq('bucket_type', 'rag_sources');

    let embeddingsConfigured = false;
    try {
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        const health = await healthRes.json() as { openai?: boolean };
        embeddingsConfigured = !!health.openai;
      }
    } catch {
      embeddingsConfigured = false;
    }

    return {
      documentsAvailable: (docCount || 0) > 0,
      chunksAvailable: (chunkCount || 0) > 0,
      embeddingsConfigured,
      documentCount: docCount || 0,
      chunkCount: chunkCount || 0,
      ragFoldersCount: ragFoldersCount || 0,
    };
  } catch (error) {
    console.error('[RAG] Error checking RAG availability:', error);
    return {
      documentsAvailable: false,
      chunksAvailable: false,
      embeddingsConfigured: false,
      documentCount: 0,
      chunkCount: 0,
      ragFoldersCount: 0,
    };
  }
}

export function formatContextFromChunks(chunks: DocumentChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }

  const contextParts = chunks.map((chunk, index) =>
    `[Bron ${index + 1}: ${chunk.documentTitle}]\n${chunk.content}`
  );

  return contextParts.join('\n\n---\n\n');
}

export async function validateQuizQuestion(
  questionText: string,
  threshold: number = 0.65
): Promise<{ validated: boolean; score: number }> {
  const chunks = await searchRelevantChunks(questionText, threshold, 3);

  if (chunks.length === 0) {
    return { validated: false, score: 0 };
  }

  const avgScore = chunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / chunks.length;

  return {
    validated: avgScore >= threshold,
    score: avgScore,
  };
}
