import { supabase } from '../lib/supabase';
import { getAccessibleFolders } from './permissions.service';
import { generateEmbeddings } from './llm.service';
import { STORAGE_CONFIG } from '../config/storage.config';
import { expandQuery, type QueryExpansionOptions } from './queryExpansion';

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

// Haal de primaire RAG-folders op die docenten aan een set begrippen hebben
// gekoppeld. Wordt door searchRelevantChunks gebruikt om eerst binnen die
// folders te zoeken voordat het terugvalt op de bredere cursus-mappen.
async function fetchPrimaryRagFolders(
  courseId: string,
  conceptIds: string[],
): Promise<string[]> {
  if (!conceptIds || conceptIds.length === 0) return [];
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch('/api/quiz/primary-rag-folders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ courseId, conceptIds }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.folderIds) ? data.folderIds : [];
  } catch (err) {
    console.warn('[RAG] Primaire folders ophalen mislukt:', err);
    return [];
  }
}

export async function searchRelevantChunks(
  query: string,
  matchThreshold: number = 0.7,
  matchCount: number = 5,
  moduleType?: 'general' | 'explain' | 'project' | 'quiz',
  userRole: 'student' | 'docent' | 'admin' = 'admin',
  courseId?: string | null,
  expansion?: QueryExpansionOptions & { enabled?: boolean },
  conceptIds?: string[],
): Promise<DocumentChunk[]> {
  if (courseId === null) {
    console.log('[RAG] No active course — skipping RAG search');
    return [];
  }

  // Verrijk de zoekterm wanneer expansion expliciet aanstaat. Voor korte
  // Nederlandse vaktermen (bv. "cohort") geeft text-embedding-3-small zonder
  // verrijking lage similarity-scores; door synoniemen + de definition mee te
  // geven scoren we meetbaar hoger zonder de drempel te verlagen.
  const embedQuery = expansion?.enabled
    ? expandQuery(query, { definition: expansion.definition, keyPoints: expansion.keyPoints })
    : query;
  if (expansion?.enabled && embedQuery !== query) {
    console.log(`[RAG] Query expanded for embedding: "${query}" -> "${embedQuery.slice(0, 120)}${embedQuery.length > 120 ? '…' : ''}"`);
  }

  const embedding = await generateEmbedding(embedQuery);

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

    // Primaire RAG-folders per begrip (Task #57). Wanneer concepten gekoppeld
    // zijn aan een specifieke folder, geven we die voorrang. Pas als daar geen
    // bruikbare hits zijn, vallen we terug op de bredere allowedFolderIds.
    const primaryFolderIds = (conceptIds && conceptIds.length > 0 && courseId)
      ? (await fetchPrimaryRagFolders(courseId, conceptIds)).filter((id) => allowedFolderIds.includes(id))
      : [];

    console.log(`[RAG] Allowed folder IDs: ${allowedFolderIds.length}, primary folders: ${primaryFolderIds.length}`);

    // Vraag de top kandidaten op zonder drempel zodat we altijd de hoogste
    // beschikbare similarity-score kunnen rapporteren bij geen match.
    const { data: allChunks, error } = await supabase.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: 0,
      match_count: Math.max(matchCount * 3, 15),
    });

    if (error) {
      console.error('[RAG] Error searching chunks:', error);
      return [];
    }

    if (!allChunks || allChunks.length === 0) {
      console.warn('[RAG] match_document_chunks returned no rows at all');
      return [];
    }

    console.log(`[RAG] RPC returned ${allChunks.length} candidate chunks (top score: ${(allChunks[0]?.similarity ?? 0).toFixed(3)})`);

    const { data: documents } = await supabase
      .from('documents')
      .select('id, folder_id, bucket')
      .in('id', allChunks.map((c: { document_id: string }) => c.document_id))
      .eq('bucket', STORAGE_CONFIG.buckets.RAG_SOURCES);

    const docFolderById = new Map((documents || []).map((d) => [d.id, d.folder_id]));

    const allowedDocIds = new Set(
      documents
        ?.filter((doc) => {
          if (!doc.folder_id) return allowedFolderIds.length === 0;
          return allowedFolderIds.includes(doc.folder_id);
        })
        .map((doc) => doc.id) || []
    );

    const inAllowedFolders = (allChunks as Array<{ id: string; document_id: string; content: string; document_title: string; similarity: number; metadata: unknown }>)
      .filter((chunk) => allowedDocIds.has(chunk.document_id));

    // Voorrang aan chunks uit primaire folders zodra die voldoende hits opleveren.
    let workingSet = inAllowedFolders;
    if (primaryFolderIds.length > 0) {
      const primarySet = new Set(primaryFolderIds);
      const primaryChunks = inAllowedFolders.filter((c) => {
        const f = docFolderById.get(c.document_id);
        return f && primarySet.has(f);
      });
      const primaryAboveThreshold = primaryChunks.filter((c) => c.similarity >= matchThreshold);
      if (primaryAboveThreshold.length >= Math.min(matchCount, 2)) {
        workingSet = primaryChunks;
        console.log(`[RAG] Primaire folder-set gebruikt (${primaryChunks.length} kandidaten, ${primaryAboveThreshold.length} ≥ drempel)`);
      } else {
        console.log(`[RAG] Primaire folder-set onvoldoende (${primaryAboveThreshold.length} hits) — fallback naar brede set.`);
      }
    }

    const aboveThreshold = workingSet.filter((c) => c.similarity >= matchThreshold);

    if (aboveThreshold.length === 0) {
      const maxAllowed = workingSet.length > 0
        ? Math.max(...workingSet.map((c) => c.similarity))
        : 0;
      console.warn(
        `[RAG] Geen chunks boven drempel ${matchThreshold.toFixed(2)} ` +
        `(beste score in toegestane mappen: ${maxAllowed.toFixed(3)}, kandidaten: ${inAllowedFolders.length}). ` +
        `Overweeg de drempel te verlagen.`
      );
      return [];
    }

    const filteredChunks = aboveThreshold.slice(0, matchCount);

    console.log(`[RAG] Returning ${filteredChunks.length} chunks (scores: ${filteredChunks.map((c) => c.similarity.toFixed(3)).join(', ')})`);

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

// Veiligheidsgrenzen voor de prompt naar het taalmodel: boven deze waarden
// loopt llama-3.3-70b-versatile (Groq) snel tegen context-limieten of TPM-quota
// aan. De cap geldt naast de gebruiker-instelbare match_count.
export const RAG_CONTEXT_MAX_CHUNKS = 10;
export const RAG_CONTEXT_MAX_CHARS = 18000;

export interface FormattedContext {
  context: string;
  usedChunks: number;
  totalChunks: number;
  /** True wanneer er chunks zijn weggelaten of wanneer chunk-inhoud is ingekort. */
  truncated: boolean;
  /** True wanneer minstens één chunk-inhoud is afgekapt door de char-cap. */
  charTrimmed: boolean;
}

export function formatContextFromChunks(chunks: DocumentChunk[]): string {
  return buildContextWithCap(chunks).context;
}

// Reduceer een (mogelijk lange) lijst chunk-niveau bronnen tot maximaal `topN`
// unieke documenten. Per documentnaam wordt de hoogste similarity behouden,
// resterende worden verwijderd. Sortering: hoogste similarity eerst.
export function dedupeSourcesByDocument<T extends { title: string; similarity: number }>(
  sources: T[],
  topN: number = 3
): T[] {
  if (sources.length === 0 || topN <= 0) return [];
  const bestPerDoc = new Map<string, T>();
  for (const src of sources) {
    const existing = bestPerDoc.get(src.title);
    if (!existing || src.similarity > existing.similarity) {
      bestPerDoc.set(src.title, src);
    }
  }
  return Array.from(bestPerDoc.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}

export function buildContextWithCap(
  chunks: DocumentChunk[],
  maxChunks: number = RAG_CONTEXT_MAX_CHUNKS,
  maxChars: number = RAG_CONTEXT_MAX_CHARS
): FormattedContext {
  const total = chunks.length;
  if (total === 0) {
    return { context: '', usedChunks: 0, totalChunks: 0, truncated: false, charTrimmed: false };
  }

  // Aannemen dat searchRelevantChunks al op similarity gesorteerd is (hoogst eerst).
  const limitN = Math.min(maxChunks, total);
  const SEP = '\n\n---\n\n';
  const parts: string[] = [];
  let runningChars = 0;
  let used = 0;
  let charTrimmed = false;
  for (let i = 0; i < limitN; i++) {
    const chunk = chunks[i];
    const header = `[Bron ${i + 1}: ${chunk.documentTitle}]\n`;
    const sepLen = parts.length === 0 ? 0 : SEP.length;
    const headroom = maxChars - runningChars - sepLen - header.length;
    if (headroom <= 0) {
      // Geen ruimte meer voor de header van deze chunk — stoppen.
      break;
    }
    // Trim chunk-inhoud zo nodig zodat we ook de eerste (mogelijk grote) chunk
    // strikt onder maxChars houden.
    let content = chunk.content;
    if (chunk.content.length > headroom) {
      content = chunk.content.slice(0, Math.max(0, headroom - 20)) + '…[ingekort]';
      charTrimmed = true;
    }
    const part = header + content;
    parts.push(part);
    runningChars += part.length + sepLen;
    used += 1;
  }

  return {
    context: parts.join(SEP),
    usedChunks: used,
    totalChunks: total,
    truncated: used < total || charTrimmed,
    charTrimmed,
  };
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
