import { useState, useEffect } from 'react';
import { CheckCircle, AlertTriangle, Loader2, RefreshCw, FileText, Info, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { retryFailedDocument, UploadProgress, SESSION_EXPIRED_MSG } from '../services/document-upload.service';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../i18n';

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
  hasPageData: boolean;
}

type FilterMode = 'all' | 'failed';

function isPdf(filename: string): boolean {
  return /\.pdf$/i.test(filename || '');
}

// Een voltooide PDF met chunks maar zónder paginanummers in de metadata: doelwit
// voor de bulk-actie. Mislukte/lege PDF's vallen al onder docNeedsAttention.
function docMissingPageData(d: DocumentWithChunkCount): boolean {
  return (
    d.processing_status === 'completed' &&
    d.chunkCount > 0 &&
    isPdf(d.filename) &&
    !d.hasPageData
  );
}

// Een document "vereist aandacht" als het niet bruikbaar is voor RAG: mislukt,
// nog in verwerking, in de wachtrij (pending) of voltooid zonder chunks.
function docNeedsAttention(d: { processing_status: string; chunkCount: number }): boolean {
  return (
    d.processing_status === 'failed' ||
    d.processing_status === 'processing' ||
    d.processing_status === 'pending' ||
    (d.processing_status === 'completed' && d.chunkCount === 0)
  );
}

export function RAGDocumentStatusPanel() {
  const { activeCourseId, activeCourseRagFolderIds, activeCourse } = useActiveCourse();
  const { session } = useAuth();
  const { t } = useLanguage();
  const [documents, setDocuments] = useState<DocumentWithChunkCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [retryProgress, setRetryProgress] = useState<UploadProgress | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [bulkPageProgress, setBulkPageProgress] = useState<{
    current: number;
    total: number;
    title: string;
  } | null>(null);

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
      const docsWithPageData = new Set<string>();

      if (completedDocIds.length > 0) {
        const { data: chunks } = await supabase
          .from('document_chunks')
          .select('document_id')
          .in('document_id', completedDocIds);

        for (const chunk of chunks || []) {
          chunkCountMap[chunk.document_id] = (chunkCountMap[chunk.document_id] || 0) + 1;
        }

        // Welke voltooide docs hebben al paginanummers (metadata.pageStart)? Eén
        // rij per chunk-met-paginanummer; we dedupen client-side naar een set.
        const { data: pageChunks } = await supabase
          .from('document_chunks')
          .select('document_id')
          .in('document_id', completedDocIds)
          .not('metadata->>pageStart', 'is', null);

        for (const chunk of pageChunks || []) {
          docsWithPageData.add(chunk.document_id);
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
          hasPageData: docsWithPageData.has(d.id),
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
        t('rag.docStatus.reprocessErrorPrefix') +
          (error instanceof Error ? error.message : t('common.unknownError'))
      );
    } finally {
      setRetryingDocId(null);
      setRetryProgress(null);
    }
  };

  // Een reeds voltooid PDF-document opnieuw verwerken zodat de chunks paginanummers
  // krijgen (de pagina-detectie zit alleen in de ingestie). Bewust achter een
  // bevestiging: retryFailedDocument vervangt de bestaande fragmenten en bedt ze
  // opnieuw in (kost embeddings).
  const handleReprocessCompleted = async (doc: { id: string; title: string }) => {
    if (!confirm(t('rag.docStatus.reprocessCompletedConfirm', { title: doc.title }))) return;
    await handleRetry(doc.id);
  };

  // Bulk: alle voltooide PDF's zónder paginanummers opnieuw verwerken zodat hun
  // chunks pageStart/pageEnd krijgen. Reuse retryFailedDocument (via handleRetry);
  // throttle 2s tussen docs om embeddings-kosten te spreiden; sla docs over die al
  // paginadata hebben (gefilterd op docMissingPageData).
  const handleReprocessAllMissingPages = async () => {
    const targets = documents.filter(docMissingPageData);
    if (targets.length === 0) return;

    if (
      !confirm(
        t('rag.docStatus.reprocessMissingPagesConfirm', { n: String(targets.length) })
      )
    ) {
      return;
    }

    for (let i = 0; i < targets.length; i++) {
      setBulkPageProgress({ current: i + 1, total: targets.length, title: targets[i].title });
      try {
        await handleRetry(targets[i].id);
      } catch {
        // Ga door met het volgende document
      }
      if (i < targets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    setBulkPageProgress(null);
  };

  const handleRetryAll = async () => {
    const failedDocs = documents.filter(docNeedsAttention);
    if (failedDocs.length === 0) return;

    if (
      !confirm(t('rag.docStatus.reprocessConfirm', { n: String(failedDocs.length) }))
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

  const handleDeleteDocument = async (doc: DocumentWithChunkCount) => {
    if (!activeCourseId || !session?.access_token) return;
    setDeletingDocId(doc.id);
    try {
      // Verwijderen loopt via het service-role server-endpoint i.p.v. client-side
      // deletes onder de gebruikers-JWT. De server verwijdert de documents-rij,
      // de fragmenten (FK cascade) én het storage-object op het JUISTE file_path
      // (de oude client-code wiste op doc.filename → verweesde bestanden in de
      // bucket). Zo hangt verwijderen niet meer af van RLS of een verse sessie.
      const res = await fetch(`/api/admin/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? SESSION_EXPIRED_MSG : (body.error || `HTTP ${res.status}`));
      }

      fetch('/api/admin/record-doc-mutation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ courseId: activeCourseId }),
      }).catch(err => console.warn('[record-doc-mutation] deletion tracking failed:', err));

      await loadDocuments();
    } catch (err) {
      console.error('[RAG PANEL] Delete failed:', err);
      alert('Fout bij verwijderen: ' + (err instanceof Error ? err.message : 'Onbekende fout'));
    } finally {
      setDeletingDocId(null);
      setDeleteConfirmId(null);
    }
  };

  const filteredDocuments =
    filterMode === 'failed' ? documents.filter(docNeedsAttention) : documents;

  const failedCount = documents.filter(docNeedsAttention).length;
  const missingPagesCount = documents.filter(docMissingPageData).length;
  const busy = retryingDocId !== null || bulkPageProgress !== null;

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
              {t('rag.docStatus.docsWithoutChunks', { n: String(failedCount) })}
            </p>
            <p className="text-sm text-gray-700 mt-0.5">
              {t('rag.docStatus.failedNoChunksDesc')}
            </p>
          </div>
          <button
            onClick={handleRetryAll}
            disabled={retryingDocId !== null}
            className="flex-shrink-0 px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            {t('rag.docStatus.reprocess')}
          </button>
        </div>
      )}

      {missingPagesCount > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-indigo-700 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-gray-900 text-sm">
              {t('rag.docStatus.missingPagesTitle', { n: String(missingPagesCount) })}
            </p>
            <p className="text-sm text-gray-700 mt-0.5">
              {t('rag.docStatus.missingPagesDesc')}
            </p>
          </div>
          <button
            onClick={handleReprocessAllMissingPages}
            disabled={busy}
            className="flex-shrink-0 px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
            data-testid="button-reprocess-missing-pages"
          >
            {t('rag.docStatus.reprocessMissingPages')}
          </button>
        </div>
      )}

      {bulkPageProgress && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4" data-testid="status-bulk-page-progress">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-700">
              {t('rag.docStatus.reprocessMissingPagesProgress', {
                current: String(bulkPageProgress.current),
                total: String(bulkPageProgress.total),
                title: bulkPageProgress.title,
              })}
            </span>
          </div>
          <div className="w-full bg-indigo-200 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
              style={{
                width: `${Math.round((bulkPageProgress.current / bulkPageProgress.total) * 100)}%`,
              }}
            />
          </div>
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
            const needsAttention = docNeedsAttention(doc);

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

                  {doc.processing_status === 'completed' && /\.pdf$/i.test(doc.filename) && (
                    <button
                      onClick={() => handleReprocessCompleted(doc)}
                      disabled={retryingDocId !== null}
                      className="p-2 text-gray-500 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                      title={t('rag.docStatus.reprocessPageTitle')}
                      data-testid={`button-reprocess-doc-${doc.id}`}
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${retryingDocId === doc.id ? 'animate-spin' : ''}`}
                      />
                    </button>
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

                  {deleteConfirmId === doc.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDeleteDocument(doc)}
                        disabled={deletingDocId === doc.id}
                        className="px-2 py-1 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                        data-testid={`button-confirm-delete-doc-${doc.id}`}
                      >
                        {deletingDocId === doc.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Ja'}
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(null)}
                        className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                        data-testid={`button-cancel-delete-doc-${doc.id}`}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirmId(doc.id)}
                      disabled={deletingDocId !== null || retryingDocId !== null}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      title={t('rag.docStatus.deleteTitle')}
                      data-testid={`button-delete-doc-${doc.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
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

  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
        <AlertTriangle className="w-3 h-3" />
        In wachtrij
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
