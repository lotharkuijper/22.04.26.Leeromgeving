import { useState, useEffect } from 'react';
import { CheckCircle, AlertTriangle, Loader2, RefreshCw, FileText, Info } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { retryFailedDocument, UploadProgress } from '../services/document-upload.service';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

interface DocumentWithChunkCount {
  id: string;
  title: string;
  filename: string;
  file_size: number;
  processing_status: string;
  total_chunks: number | null;
  folder_id: string | null;
  bucket: string;
  chunkCount: number;
}

type FilterMode = 'all' | 'failed';

export function RAGDocumentStatusPanel() {
  const { activeCourseId, activeCourseRagFolderIds, activeCourse } = useActiveCourse();
  const [documents, setDocuments] = useState<DocumentWithChunkCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [retryProgress, setRetryProgress] = useState<UploadProgress | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  useEffect(() => {
    if (activeCourseRagFolderIds.length > 0) {
      loadDocuments();
    } else {
      setDocuments([]);
    }
  }, [activeCourseRagFolderIds]);

  const loadDocuments = async () => {
    if (activeCourseRagFolderIds.length === 0) return;

    setLoading(true);
    try {
      const { data: docs, error } = await supabase
        .from('documents')
        .select('id, title, filename, file_size, processing_status, total_chunks, folder_id, bucket')
        .in('folder_id', activeCourseRagFolderIds)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[RAG PANEL] Error loading documents:', error);
        setLoading(false);
        return;
      }

      if (!docs || docs.length === 0) {
        setDocuments([]);
        setLoading(false);
        return;
      }

      const completedDocIds = docs
        .filter((d) => d.processing_status === 'completed')
        .map((d) => d.id);

      let chunkCountMap: Record<string, number> = {};

      if (completedDocIds.length > 0) {
        const { data: chunks } = await supabase
          .from('document_chunks')
          .select('document_id')
          .in('document_id', completedDocIds);

        for (const chunk of chunks || []) {
          chunkCountMap[chunk.document_id] = (chunkCountMap[chunk.document_id] || 0) + 1;
        }
      }

      setDocuments(
        docs.map((d) => ({
          id: d.id,
          title: d.title,
          filename: d.filename,
          file_size: d.file_size,
          processing_status: d.processing_status,
          total_chunks: d.total_chunks,
          folder_id: d.folder_id,
          bucket: d.bucket,
          chunkCount: chunkCountMap[d.id] || 0,
        }))
      );
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (documentId: string) => {
    setRetryingDocId(documentId);
    setRetryProgress(null);

    try {
      await retryFailedDocument(documentId, setRetryProgress);
      await loadDocuments();
    } catch (error) {
      console.error('[RAG PANEL] Retry failed:', error);
      alert(
        'Fout bij opnieuw verwerken: ' +
          (error instanceof Error ? error.message : 'Onbekende fout')
      );
    } finally {
      setRetryingDocId(null);
      setRetryProgress(null);
    }
  };

  const handleRetryAll = async () => {
    const failedDocs = documents.filter(
      (d) =>
        d.processing_status === 'failed' ||
        d.processing_status === 'processing' ||
        (d.processing_status === 'completed' && d.chunkCount === 0)
    );
    if (failedDocs.length === 0) return;

    if (
      !confirm(
        `${failedDocs.length} document(en) opnieuw verwerken? Dit kan enkele minuten duren.`
      )
    ) {
      return;
    }

    for (const doc of failedDocs) {
      try {
        await handleRetry(doc.id);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        // Continue with next document
      }
    }
  };

  const filteredDocuments =
    filterMode === 'failed'
      ? documents.filter(
          (d) =>
            d.processing_status === 'failed' ||
            d.processing_status === 'processing' ||
            (d.processing_status === 'completed' && d.chunkCount === 0)
        )
      : documents;

  const failedCount = documents.filter(
    (d) =>
      d.processing_status === 'failed' ||
      d.processing_status === 'processing' ||
      (d.processing_status === 'completed' && d.chunkCount === 0)
  ).length;

  if (!activeCourseId) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Info className="w-12 h-12 mx-auto mb-3 text-gray-400" />
        <p>Kies een actieve cursus om RAG-documenten te bekijken</p>
      </div>
    );
  }

  if (activeCourseRagFolderIds.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Info className="w-12 h-12 mx-auto mb-3 text-gray-400" />
        <p>
          Cursus <strong>{activeCourse?.name}</strong> heeft geen RAG-mappen
        </p>
        <p className="text-sm mt-1">
          Wijs een RAG-map toe aan de cursus via Cursussen beheren
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-900">
            RAG-documenten: {activeCourse?.name}
          </h3>
          <p className="text-sm text-gray-600">
            {documents.length} document(en) in {activeCourseRagFolderIds.length} RAG-map(pen)
            {failedCount > 0 && (
              <span className="ml-2 text-amber-700 font-medium">
                • {failedCount} vereisen aandacht
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilterMode(filterMode === 'all' ? 'failed' : 'all')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              filterMode === 'failed'
                ? 'bg-amber-100 text-amber-800 font-medium'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {filterMode === 'failed' ? 'Toon alle' : `Toon problemen (${failedCount})`}
          </button>
          <button
            onClick={loadDocuments}
            disabled={loading}
            className="p-1.5 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
            title="Vernieuwen"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {failedCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-gray-900 text-sm">
              {failedCount} document(en) zonder chunks
            </p>
            <p className="text-sm text-gray-700 mt-0.5">
              Documenten die zijn mislukt of geen chunks hebben kunnen niet worden gebruikt voor RAG.
              Verwerk ze opnieuw zodat de inhoudsindex up-to-date is.
            </p>
          </div>
          <button
            onClick={handleRetryAll}
            disabled={retryingDocId !== null}
            className="flex-shrink-0 px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            Verwerk opnieuw
          </button>
        </div>
      )}

      {retryProgress && retryingDocId && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-700">{retryProgress.message}</span>
            <span className="font-medium">{retryProgress.progress}%</span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${retryProgress.progress}%` }}
            />
          </div>
          {retryProgress.currentChunk !== undefined && retryProgress.totalChunks !== undefined && (
            <p className="text-xs text-gray-600 mt-2">
              Chunk {retryProgress.currentChunk} / {retryProgress.totalChunks}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          <p className="text-sm">Documenten laden...</p>
        </div>
      ) : filteredDocuments.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <CheckCircle className="w-10 h-10 mx-auto mb-3 text-emerald-500" />
          <p className="font-medium text-gray-700">
            {filterMode === 'failed' ? 'Geen problemen gevonden' : 'Geen documenten'}
          </p>
          <p className="text-sm mt-1">
            {filterMode === 'failed'
              ? 'Alle documenten zijn correct verwerkt'
              : 'Upload documenten via de Bestanden-tab of het admin beheerpaneel'}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {filteredDocuments.map((doc) => {
            const needsAttention =
              doc.processing_status === 'failed' ||
              doc.processing_status === 'processing' ||
              (doc.processing_status === 'completed' && doc.chunkCount === 0);

            return (
              <div
                key={doc.id}
                className={`flex items-center gap-4 px-4 py-3 ${
                  needsAttention ? 'bg-amber-50' : 'bg-white hover:bg-gray-50'
                } transition-colors`}
              >
                <FileText
                  className={`w-5 h-5 flex-shrink-0 ${
                    needsAttention ? 'text-amber-600' : 'text-gray-400'
                  }`}
                />

                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{doc.title}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {doc.filename} • {(doc.file_size / 1024).toFixed(0)} KB
                  </p>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  <StatusBadge status={doc.processing_status} chunkCount={doc.chunkCount} />

                  {doc.processing_status === 'completed' && doc.chunkCount > 0 && (
                    <span className="text-xs text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                      {doc.chunkCount} chunks
                    </span>
                  )}

                  {needsAttention && (
                    <button
                      onClick={() => handleRetry(doc.id)}
                      disabled={retryingDocId !== null}
                      className="p-2 text-blue-700 bg-blue-100 rounded-lg hover:bg-blue-200 transition-colors disabled:opacity-50"
                      title="Opnieuw verwerken"
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${retryingDocId === doc.id ? 'animate-spin' : ''}`}
                      />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  chunkCount,
}: {
  status: string;
  chunkCount: number;
}) {
  if (status === 'completed' && chunkCount > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
        <CheckCircle className="w-3 h-3" />
        Voltooid
      </span>
    );
  }

  if (status === 'completed' && chunkCount === 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
        <AlertTriangle className="w-3 h-3" />
        Geen chunks
      </span>
    );
  }

  if (status === 'processing') {
    return (
      <span className="flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
        <Loader2 className="w-3 h-3 animate-spin" />
        Bezig...
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
        <AlertTriangle className="w-3 h-3" />
        Mislukt
      </span>
    );
  }

  return (
    <span className="text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">
      {status}
    </span>
  );
}
