import { useState, useEffect } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { retryFailedDocument, UploadProgress } from '../services/document-upload.service';

export function DocumentRetryPanel() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [retryProgress, setRetryProgress] = useState<UploadProgress | null>(null);

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('documents')
      .select('*')
      .in('processing_status', ['processing', 'failed'])
      .order('created_at', { ascending: false });

    setDocuments(data || []);
    setLoading(false);
  };

  const handleRetry = async (documentId: string) => {
    setRetryingDocId(documentId);
    setRetryProgress(null);

    try {
      await retryFailedDocument(documentId, setRetryProgress);
      await loadDocuments();
      alert('Document succesvol verwerkt!');
    } catch (error) {
      console.error('Retry failed:', error);
      alert('Fout bij opnieuw verwerken: ' + (error instanceof Error ? error.message : 'Onbekende fout'));
    } finally {
      setRetryingDocId(null);
      setRetryProgress(null);
    }
  };

  const handleRetryAll = async () => {
    if (!confirm(`${documents.length} documenten opnieuw verwerken? Dit kan lang duren.`)) {
      return;
    }

    for (const doc of documents) {
      try {
        await handleRetry(doc.id);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Failed to retry ${doc.title}:`, error);
      }
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-600">Documenten laden...</div>;
  }

  if (documents.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-600" />
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Alle documenten verwerkt</h3>
        <p className="text-gray-600">Er zijn geen documenten die opnieuw verwerkt moeten worden</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">
              {documents.length} Document{documents.length !== 1 ? 'en' : ''} Vastgelopen
            </h3>
            <p className="text-sm text-gray-700">
              Deze documenten zijn niet volledig verwerkt. Dit kan gebeuren als het verwerkingsproces
              werd onderbroken of als er een fout optrad bij het genereren van embeddings.
            </p>
          </div>
        </div>
      </div>

      <button
        onClick={handleRetryAll}
        disabled={retryingDocId !== null}
        className="w-full px-4 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        <RefreshCw className={`w-5 h-5 ${retryingDocId ? 'animate-spin' : ''}`} />
        Verwerk Alle Documenten Opnieuw
      </button>

      {retryProgress && retryingDocId && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-700">{retryProgress.message}</span>
            <span className="font-medium">{retryProgress.progress}%</span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${retryProgress.progress}%` }}
            />
          </div>
          {retryProgress.currentChunk !== undefined && retryProgress.totalChunks !== undefined && (
            <p className="text-sm text-gray-600 mt-2">
              Chunk {retryProgress.currentChunk} van {retryProgress.totalChunks}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <div className="flex-1">
              <h4 className="font-medium text-gray-900">{doc.title}</h4>
              <p className="text-sm text-gray-600">
                {doc.filename} • {(doc.file_size / 1024).toFixed(0)} KB
              </p>
              <div className="flex items-center gap-2 mt-1">
                <span
                  className={`text-xs px-2 py-1 rounded-full ${
                    doc.processing_status === 'failed'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  {doc.processing_status === 'failed' ? 'Mislukt' : 'Bezig...'}
                </span>
                <span className="text-xs text-gray-500">
                  {doc.total_chunks || 0} chunks
                </span>
              </div>
            </div>

            <button
              onClick={() => handleRetry(doc.id)}
              disabled={retryingDocId !== null}
              className="p-3 text-blue-700 bg-blue-100 rounded-lg hover:bg-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Opnieuw verwerken"
            >
              <RefreshCw
                className={`w-5 h-5 ${retryingDocId === doc.id ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
