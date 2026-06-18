import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Eye, FileText, Loader2 } from 'lucide-react';
import { useLanguage } from '../i18n';
import { intlLocale } from '../i18n/languages';
import {
  getExtractedConceptsForReview,
  approveExtractedConcept,
  rejectExtractedConcept,
  extractConceptsFromDocument,
  extractConceptsFromAllDocuments,
  ExtractionProgress,
} from '../services/concept-extraction.service';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { NoticeBanner, ConfirmDialog, useNotice } from './Notice';

export function ConceptReviewPanel() {
  const { profile } = useAuth();
  const { t, lang } = useLanguage();
  const [concepts, setConcepts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState<ExtractionProgress | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [confirmExtractAll, setConfirmExtractAll] = useState(false);
  const { notice, setNotice, clearNotice } = useNotice();

  useEffect(() => {
    loadConcepts();
    loadDocuments();
  }, []);

  const loadConcepts = async () => {
    setLoading(true);
    try {
      const data = await getExtractedConceptsForReview();
      setConcepts(data);
    } catch (error) {
      console.error('Error loading concepts:', error);
    }
    setLoading(false);
  };

  const loadDocuments = async () => {
    const { data } = await supabase
      .from('documents')
      .select('id, title, processing_status, total_chunks')
      .eq('processing_status', 'completed')
      .order('created_at', { ascending: false });

    setDocuments(data || []);
  };

  const handleApprove = async (conceptId: string) => {
    if (!profile?.id) return;
    try {
      await approveExtractedConcept(conceptId, profile.id);
      loadConcepts();
    } catch (error) {
      console.error('Error approving concept:', error);
      setNotice({ kind: 'error', message: t('concepts.approveFailed') });
    }
  };

  const handleReject = async (conceptId: string) => {
    if (!profile?.id) return;
    try {
      await rejectExtractedConcept(conceptId, profile.id);
      loadConcepts();
    } catch (error) {
      console.error('Error rejecting concept:', error);
      setNotice({ kind: 'error', message: t('concepts.rejectFailed') });
    }
  };

  const handleExtractFromDocument = async () => {
    if (!selectedDocument || !profile?.id) return;
    setExtracting(true);
    try {
      await extractConceptsFromDocument(selectedDocument, profile.id, setExtractionProgress);
      loadConcepts();
      setSelectedDocument(null);
      setNotice({ kind: 'success', message: t('concepts.extractDocSuccess') });
    } catch (error) {
      console.error('Error extracting concepts:', error);
      setNotice({ kind: 'error', message: t('concepts.extractFailed') });
    }
    setExtracting(false);
    setExtractionProgress(null);
  };

  const runExtractFromAll = async () => {
    if (!profile?.id) return;
    setConfirmExtractAll(false);
    setExtracting(true);
    try {
      const result = await extractConceptsFromAllDocuments(profile.id, (_docId, progress) => {
        setExtractionProgress(progress);
      });
      setNotice({
        kind: 'success',
        message: t('concepts.extractAllSuccess', {
          concepts: String(result.totalConcepts),
          documents: String(result.processedDocuments),
        }),
      });
      loadConcepts();
    } catch (error) {
      console.error('Error extracting concepts:', error);
      setNotice({ kind: 'error', message: t('concepts.extractFailed') });
    }
    setExtracting(false);
    setExtractionProgress(null);
  };

  return (
    <div className="space-y-6">
      <NoticeBanner notice={notice} onDismiss={clearNotice} />

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-3">{t('concepts.extractionTitle')}</h3>

        <div className="space-y-3">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('concepts.selectDocument')}
              </label>
              <select
                value={selectedDocument || ''}
                onChange={(e) => setSelectedDocument(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={extracting}
                data-testid="select-extract-document"
              >
                <option value="">{t('concepts.chooseDocument')}</option>
                {documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.title} ({doc.total_chunks} chunks)
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleExtractFromDocument}
              disabled={!selectedDocument || extracting}
              className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              data-testid="button-extract-document"
            >
              <FileText className="w-4 h-4" />
              {t('concepts.extractBtn')}
            </button>
          </div>

          <button
            onClick={() => setConfirmExtractAll(true)}
            disabled={extracting}
            className="w-full px-4 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-extract-all"
          >
            {t('concepts.extractAllBtn')}
          </button>
        </div>

        {extractionProgress && (
          <div className="mt-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-700">{extractionProgress.message}</span>
              <span className="font-medium">{extractionProgress.progress}%</span>
            </div>
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${extractionProgress.progress}%` }}
              />
            </div>
            {extractionProgress.conceptsFound !== undefined && (
              <p className="text-sm text-gray-600 mt-2">
                {t('concepts.conceptsFound', { count: String(extractionProgress.conceptsFound) })}
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('concepts.toReviewCount', { count: String(concepts.length) })}
        </h3>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        )}

        {!loading && concepts.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Eye className="w-12 h-12 mx-auto mb-3 text-gray-400" />
            <p>{t('concepts.noConceptsToReview')}</p>
          </div>
        )}

        <div className="space-y-4">
          {concepts.map((concept) => (
            <div
              key={concept.id}
              className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-gray-900">{concept.name}</h4>
                    <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-semibold">
                      {concept.category}
                    </span>
                    {concept.source_document && (
                      <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
                        {concept.source_document.title}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 mb-2">{concept.definition}</p>

                  {concept.key_points && concept.key_points.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-gray-700 mb-1">{t('concepts.keyPointsLabel')}</p>
                      <ul className="list-disc list-inside space-y-1">
                        {concept.key_points.map((point: string, idx: number) => (
                          <li key={idx} className="text-xs text-gray-600">{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {concept.examples && concept.examples.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-gray-700 mb-1">{t('concepts.examplesLabel')}</p>
                      <ul className="list-disc list-inside space-y-1">
                        {concept.examples.map((example: string, idx: number) => (
                          <li key={idx} className="text-xs text-gray-600">{example}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="text-xs text-gray-500 mt-2">
                    {t('concepts.extractedLabel')}: {new Date(concept.extracted_at).toLocaleString(intlLocale(lang))}
                  </p>
                </div>

                <div className="flex gap-2 ml-4">
                  <button
                    onClick={() => handleApprove(concept.id)}
                    className="p-2 text-green-700 bg-green-100 rounded-lg hover:bg-green-200 transition-colors"
                    title={t('concepts.approve')}
                    data-testid={`button-approve-concept-${concept.id}`}
                  >
                    <CheckCircle className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => handleReject(concept.id)}
                    className="p-2 text-red-700 bg-red-100 rounded-lg hover:bg-red-200 transition-colors"
                    title={t('concepts.reject')}
                    data-testid={`button-reject-concept-${concept.id}`}
                  >
                    <XCircle className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmExtractAll}
        title={t('concepts.extractAllConfirmTitle')}
        description={t('concepts.extractAllConfirmDesc')}
        confirmLabel={t('chooseCourse.continue')}
        onConfirm={() => { void runExtractFromAll(); }}
        onCancel={() => setConfirmExtractAll(false)}
      />
    </div>
  );
}
