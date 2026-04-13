import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

interface RAGStatus {
  isAvailable: boolean;
  documentCount: number;
  chunkCount: number;
  loading: boolean;
}

const DEBOUNCE_MS = 1500;

export function useRAGStatus() {
  const [status, setStatus] = useState<RAGStatus>({
    isAvailable: false,
    documentCount: 0,
    chunkCount: 0,
    loading: true,
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
  }, []);

  async function checkRAGStatus() {
    try {
      const { data: ragFolder } = await supabase
        .from('document_folders')
        .select('id')
        .eq('name', 'RAG')
        .is('parent_folder_id', null)
        .maybeSingle();

      if (!ragFolder) {
        setStatus({
          isAvailable: false,
          documentCount: 0,
          chunkCount: 0,
          loading: false,
        });
        return;
      }

      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('id')
        .eq('folder_id', ragFolder.id)
        .eq('processing_status', 'completed');

      if (docsError || !documents || documents.length === 0) {
        setStatus({
          isAvailable: false,
          documentCount: 0,
          chunkCount: 0,
          loading: false,
        });
        return;
      }

      const documentIds = documents.map(d => d.id);

      const { count: chunkCount, error: chunksError } = await supabase
        .from('document_chunks')
        .select('*', { count: 'exact', head: true })
        .in('document_id', documentIds);

      if (chunksError) {
        console.error('Error counting chunks:', chunksError);
      }

      setStatus({
        isAvailable: (chunkCount || 0) > 0,
        documentCount: documents.length,
        chunkCount: chunkCount || 0,
        loading: false,
      });
    } catch (error) {
      console.error('Error checking RAG status:', error);
      setStatus({
        isAvailable: false,
        documentCount: 0,
        chunkCount: 0,
        loading: false,
      });
    }
  }

  return status;
}
