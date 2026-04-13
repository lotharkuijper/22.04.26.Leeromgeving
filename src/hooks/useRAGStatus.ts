import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

export interface RAGStatus {
  isAvailable: boolean;
  documentCount: number;
  chunkCount: number;
  loading: boolean;
  noCourse: boolean;
  noRagFolders: boolean;
}

const DEBOUNCE_MS = 1500;

export function useRAGStatus(): RAGStatus {
  const { activeCourseId, activeCourseRagFolderIds, loading: courseLoading } = useActiveCourse();

  const [status, setStatus] = useState<RAGStatus>({
    isAvailable: false,
    documentCount: 0,
    chunkCount: 0,
    loading: true,
    noCourse: false,
    noRagFolders: false,
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (courseLoading) return;

    let mounted = true;

    const checkStatusIfMounted = async () => {
      if (mounted) {
        await checkRAGStatus();
      }
    };

    const debouncedCheck = () => {
      if (!mounted) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(checkStatusIfMounted, DEBOUNCE_MS);
    };

    checkStatusIfMounted();

    const channel = supabase
      .channel('rag-status-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'documents' },
        debouncedCheck
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'document_chunks' },
        debouncedCheck
      )
      .subscribe();

    return () => {
      mounted = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      supabase.removeChannel(channel);
    };
  }, [activeCourseId, activeCourseRagFolderIds.join(','), courseLoading]);

  async function checkRAGStatus() {
    if (!activeCourseId) {
      setStatus({
        isAvailable: false,
        documentCount: 0,
        chunkCount: 0,
        loading: false,
        noCourse: true,
        noRagFolders: false,
      });
      return;
    }

    if (activeCourseRagFolderIds.length === 0) {
      setStatus({
        isAvailable: false,
        documentCount: 0,
        chunkCount: 0,
        loading: false,
        noCourse: false,
        noRagFolders: true,
      });
      return;
    }

    try {
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('id')
        .in('folder_id', activeCourseRagFolderIds)
        .eq('processing_status', 'completed');

      if (docsError || !documents || documents.length === 0) {
        setStatus({
          isAvailable: false,
          documentCount: 0,
          chunkCount: 0,
          loading: false,
          noCourse: false,
          noRagFolders: false,
        });
        return;
      }

      const documentIds = documents.map((d) => d.id);

      const { count: chunkCount, error: chunksError } = await supabase
        .from('document_chunks')
        .select('*', { count: 'exact', head: true })
        .in('document_id', documentIds);

      if (chunksError) {
        console.error('[RAG STATUS] Error counting chunks:', chunksError);
      }

      setStatus({
        isAvailable: (chunkCount || 0) > 0,
        documentCount: documents.length,
        chunkCount: chunkCount || 0,
        loading: false,
        noCourse: false,
        noRagFolders: false,
      });
    } catch (error) {
      console.error('[RAG STATUS] Error checking RAG status:', error);
      setStatus({
        isAvailable: false,
        documentCount: 0,
        chunkCount: 0,
        loading: false,
        noCourse: false,
        noRagFolders: false,
      });
    }
  }

  return status;
}
