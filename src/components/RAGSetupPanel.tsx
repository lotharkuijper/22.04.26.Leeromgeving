import { useState, useEffect, useRef, useCallback } from 'react';
import {
  FolderPlus, Upload, Download, CheckCircle2, AlertTriangle,
  Loader2, FileText, RefreshCw, X, FolderOpen, Info, Database, Sparkles,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { uploadDocument, UploadProgress } from '../services/document-upload.service';
import { RAGDocumentStatusPanel } from './RAGDocumentStatusPanel';
import { useLanguage } from '../i18n';

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.txt'];

interface ProcessedDocument {
  id: string;
  filename: string;
}

interface StorageFile {
  name: string;
  storagePath: string;
  displayPath: string;
  size: number;
  extension: string;
  alreadyImported: boolean;
}

interface FileUploadItem {
  id: string;
  file: File;
  progress: UploadProgress | null;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

type ActiveSection = 'upload' | 'import';

async function listStorageFilesRecursively(
  bucketName: string,
  path: string,
  basePath: string = path
): Promise<StorageFile[]> {
  const { data, error } = await supabase.storage.from(bucketName).list(path, { limit: 200 });
  if (error || !data) return [];

  const files: StorageFile[] = [];
  for (const item of data) {
    if (item.name.startsWith('.')) continue;
    const fullPath = path ? `${path}/${item.name}` : item.name;
    const ext = '.' + item.name.split('.').pop()?.toLowerCase();

    if (item.metadata === null || item.metadata === undefined) {
      const subFiles = await listStorageFilesRecursively(bucketName, fullPath, basePath);
      files.push(...subFiles);
    } else if (SUPPORTED_EXTENSIONS.includes(ext)) {
      const relPath = fullPath.startsWith(basePath + '/')
        ? fullPath.slice(basePath.length + 1)
        : fullPath;
      files.push({
        name: item.name,
        storagePath: fullPath,
        displayPath: relPath,
        size: item.metadata?.size || 0,
        extension: ext,
        alreadyImported: false,
      });
    }
  }
  return files;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RAGSetupPanel() {
  const { profile, session } = useAuth();
  const { lang, t } = useLanguage();
  const { activeCourseId, activeCourse, activeCourseRagFolderIds, refreshActiveCourse, loading: courseLoading } = useActiveCourse();

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>('upload');
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<{
    count: number;
    skipped: number;
    message: string;
    candidatesFromLLM?: number;
    verificationRejected?: number;
    verificationThreshold?: number;
    minEvidenceChunks?: number;
    rejected?: { name: string; maxScore: number }[];
    concepts?: { id: string; name: string; category: string; definition: string }[];
  } | null>(null);
  const [conceptLanguage, setConceptLanguage] = useState<'nl' | 'en' | 'auto'>('auto');
  const [loweringThreshold, setLoweringThreshold] = useState(false);
  const [lowerThresholdNote, setLowerThresholdNote] = useState<string | null>(null);
  const [processedDocs, setProcessedDocs] = useState<ProcessedDocument[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [existingConceptCount, setExistingConceptCount] = useState(0);
  const [replaceMode, setReplaceMode] = useState(false);

  const [loadingProcessedDocs, setLoadingProcessedDocs] = useState(false);

  const loadProcessedDocs = useCallback(async () => {
    if (activeCourseRagFolderIds.length === 0) {
      setProcessedDocs([]);
      setSelectedDocIds(new Set());
      return;
    }
    setLoadingProcessedDocs(true);
    try {
      const { data } = await supabase
        .from('documents')
        .select('id, filename')
        .in('folder_id', activeCourseRagFolderIds)
        .eq('processing_status', 'completed');
      const docs: ProcessedDocument[] = (data || []).map(d => ({ id: d.id, filename: d.filename }));
      setProcessedDocs(docs);
      setSelectedDocIds(new Set(docs.map(d => d.id)));
    } finally {
      setLoadingProcessedDocs(false);
    }
  }, [activeCourseRagFolderIds]);

  useEffect(() => {
    loadProcessedDocs();
  }, [loadProcessedDocs]);

  useEffect(() => {
    if (!activeCourseId || !session?.access_token) {
      setExistingConceptCount(0);
      return;
    }
    fetch(`/api/concepts?courseId=${activeCourseId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => r.ok ? r.json() : { concepts: [], source: 'empty' })
      .then(data => {
        const count = data.source === 'course' ? (data.concepts?.length ?? 0) : 0;
        setExistingConceptCount(count);
      })
      .catch(() => setExistingConceptCount(0));
  }, [activeCourseId, session?.access_token, extractResult]);

  const ragFolderId = activeCourseRagFolderIds[0] ?? null;

  if (courseLoading) {
    return (
      <div className="flex items-center gap-3 py-10 justify-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>{t('admin.ragSetup.loadingCourse')}</span>
      </div>
    );
  }

  if (!activeCourseId || !activeCourse) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Info className="w-12 h-12 mx-auto mb-3 text-gray-300" />
        <p className="font-medium">{t('admin.ragSetup.noActiveCourse')}</p>
        <p className="text-sm mt-1">{t('admin.ragSetup.noActiveCourseHint')}</p>
      </div>
    );
  }

  const handleCreateRagFolder = async () => {
    if (!activeCourseId || !session?.access_token) return;
    setCreatingFolder(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/admin/create-rag-folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          courseId: activeCourseId,
          courseName: activeCourse.name,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Server error ${response.status}`);
      }

      await refreshActiveCourse();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleExtractConcepts = async () => {
    if (!activeCourseId || !session?.access_token) return;
    setExtracting(true);
    setExtractResult(null);
    setLowerThresholdNote(null);
    try {
      const response = await fetch('/api/admin/extract-concepts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          courseId: activeCourseId,
          replace: replaceMode,
          language: conceptLanguage,
          documentIds: selectedDocIds.size < processedDocs.length ? Array.from(selectedDocIds) : [],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Server error ${response.status}`);
      }
      setExtractResult({
        count: (data.concepts?.length ?? 0) + (data.updated ?? 0),
        skipped: data.skipped ?? 0,
        message: data.message || '',
        candidatesFromLLM: data.candidatesFromLLM,
        verificationRejected: data.verificationRejected,
        verificationThreshold: data.verificationThreshold,
        minEvidenceChunks: data.minEvidenceChunks,
        rejected: Array.isArray(data.rejected) ? data.rejected : [],
        concepts: Array.isArray(data.concepts) ? data.concepts : [],
      });
    } catch (err) {
      setExtractResult({
        count: 0,
        skipped: 0,
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    } finally {
      setExtracting(false);
    }
  };

  // Verlaag de extractie-drempel (-0.1, min 0.10) en draai de extractie
  // direct opnieuw. Geeft de docent een 1-klik-uitweg wanneer alle kandidaten
  // net onder de verificatiedrempel bleven steken.
  const handleLowerThresholdAndRetry = async () => {
    if (!activeCourseId || !session?.access_token) return;
    const current = extractResult?.verificationThreshold ?? 0.55;
    // Verlaag met 0.1 maar nooit onder 0.10 — en nooit hoger dan de huidige
    // waarde (anders zou een toch al lage drempel per ongeluk omhoog gaan).
    const next = Math.min(current, Math.max(0.10, Math.round((current - 0.1) * 100) / 100));
    setLoweringThreshold(true);
    setLowerThresholdNote(null);
    try {
      const resp = await fetch('/api/rag-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          courseId: activeCourseId,
          settings: { extraction: { similarity_threshold: next } },
        }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || `Server error ${resp.status}`);
      }
      setLowerThresholdNote(t('admin.ragSetup.extract.thresholdLowered', { value: next.toFixed(2) }));
    } catch (err) {
      setLowerThresholdNote(err instanceof Error ? err.message : t('common.unknownError'));
      setLoweringThreshold(false);
      return;
    }
    setLoweringThreshold(false);
    await handleExtractConcepts();
  };

  if (activeCourseRagFolderIds.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex gap-4">
          <FolderPlus className="w-8 h-8 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-2">
              {t('admin.ragSetup.noConfig.headingPre')} <strong>{activeCourse.name}</strong> {t('admin.ragSetup.noConfig.headingPost')}
            </h3>
            <p className="text-sm text-gray-700 mb-2">{t('admin.ragSetup.noConfig.note')}</p>
            <p className="text-sm text-gray-700 mb-4">{t('admin.ragSetup.noConfig.hint')}</p>
            {createError && (
              <div className="mb-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{createError}</span>
              </div>
            )}
            <button
              onClick={handleCreateRagFolder}
              disabled={creatingFolder}
              data-testid="button-create-rag-folder"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {creatingFolder ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> {t('admin.ragSetup.noConfig.creating')}</>
              ) : (
                <><Database className="w-4 h-4" /> {t('admin.ragSetup.noConfig.createBtn', { name: activeCourse.name })}</>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
        <div className="text-sm text-emerald-800">
          {t('admin.ragSetup.active', { name: activeCourse.name })}
        </div>
      </div>

      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveSection('upload')}
            data-testid="tab-upload"
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeSection === 'upload'
                ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Upload className="w-4 h-4" />
            {t('admin.ragSetup.upload.tab')}
          </button>
          <button
            onClick={() => setActiveSection('import')}
            data-testid="tab-import"
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeSection === 'import'
                ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Download className="w-4 h-4" />
            {t('admin.ragSetup.import.tab')}
          </button>
        </div>

        <div className="p-4">
          {activeSection === 'upload' && ragFolderId && (
            <UploadSection folderId={ragFolderId} userId={profile?.id ?? ''} courseId={activeCourseId ?? undefined} accessToken={session?.access_token ?? undefined} />
          )}
          {activeSection === 'import' && ragFolderId && (
            <ImportSection
              folderId={ragFolderId}
              userId={profile?.id ?? ''}
              courseName={activeCourse.name}
            />
          )}
        </div>
      </div>

      <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-purple-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-gray-900 text-sm">{t('admin.ragSetup.extract.title')}</h3>
              <button
                type="button"
                onClick={loadProcessedDocs}
                disabled={loadingProcessedDocs}
                data-testid="button-refresh-extract-docs"
                className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${loadingProcessedDocs ? 'animate-spin' : ''}`} /> {t('admin.ragSetup.extract.refresh')}
              </button>
            </div>
            <p className="text-xs text-gray-600 mt-0.5 mb-1">{t('admin.ragSetup.extract.desc')}</p>
            <div className="flex flex-wrap gap-3 text-xs text-gray-500 mb-3">
              <span>{t('admin.ragSetup.extract.docCount', { count: String(processedDocs.length), s: processedDocs.length !== 1 ? (lang === 'en' ? 's' : 'en') : '' })}</span>
              <span>·</span>
              <span>{t('admin.ragSetup.extract.conceptCount', { count: String(existingConceptCount) })}</span>
            </div>

            {processedDocs.length > 0 && (
              <div className="mb-3 border border-gray-200 rounded-lg overflow-hidden bg-white">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-medium text-gray-700">{t('admin.ragSetup.extract.selectDocs')}</span>
                  {processedDocs.length > 3 && (
                    <button
                      onClick={() => {
                        if (selectedDocIds.size === processedDocs.length) {
                          setSelectedDocIds(new Set());
                        } else {
                          setSelectedDocIds(new Set(processedDocs.map(d => d.id)));
                        }
                      }}
                      className="text-xs text-blue-600 hover:underline"
                      data-testid="button-toggle-all-docs"
                    >
                      {selectedDocIds.size === processedDocs.length ? t('admin.ragSetup.extract.deselectAll') : t('admin.ragSetup.extract.selectAll')}
                    </button>
                  )}
                </div>
                <div className="divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {processedDocs.map(doc => {
                    const ext = doc.filename.split('.').pop()?.toUpperCase() ?? '';
                    return (
                      <label
                        key={doc.id}
                        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors"
                        data-testid={`label-doc-${doc.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDocIds.has(doc.id)}
                          onChange={e => {
                            setSelectedDocIds(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(doc.id);
                              else next.delete(doc.id);
                              return next;
                            });
                          }}
                          className="w-4 h-4 rounded accent-purple-600 flex-shrink-0"
                          data-testid={`checkbox-doc-${doc.id}`}
                        />
                        <span className="text-xs text-gray-700 truncate flex-1">{doc.filename}</span>
                        {ext && (
                          <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-mono flex-shrink-0">{ext}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {extractResult && (
              <div
                className={`mb-3 text-sm px-3 py-2.5 rounded-lg space-y-2 ${
                  extractResult.count > 0
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                    : 'bg-gray-100 border border-gray-200 text-gray-700'
                }`}
                data-testid="text-extract-result"
              >
                <div>
                  {extractResult.message}
                  {extractResult.skipped > 0 && (
                    <span className="ml-1 text-gray-500">({extractResult.skipped} {t('admin.ragSetup.extract.alreadyPresent')})</span>
                  )}
                </div>

                {typeof extractResult.candidatesFromLLM === 'number' && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                    <span data-testid="text-extract-candidates">{t('admin.ragSetup.extract.statsCandidates', { count: String(extractResult.candidatesFromLLM) })}</span>
                    <span>·</span>
                    <span className="text-emerald-700" data-testid="text-extract-accepted">{t('admin.ragSetup.extract.statsAccepted', { count: String(extractResult.count) })}</span>
                    {typeof extractResult.verificationRejected === 'number' && extractResult.verificationRejected > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-amber-700" data-testid="text-extract-rejected">{t('admin.ragSetup.extract.statsRejected', { count: String(extractResult.verificationRejected) })}</span>
                      </>
                    )}
                    {typeof extractResult.verificationThreshold === 'number' && (
                      <>
                        <span>·</span>
                        <span>{t('admin.ragSetup.extract.statsThreshold', { value: extractResult.verificationThreshold.toFixed(2), min: String(extractResult.minEvidenceChunks ?? 1) })}</span>
                      </>
                    )}
                  </div>
                )}

                {extractResult.concepts && extractResult.concepts.length > 0 && (
                  <div className="pt-1">
                    <p className="text-xs font-medium text-emerald-800 mb-1">{t('admin.ragSetup.extract.savedPreviewTitle')}</p>
                    <div className="flex flex-wrap gap-1.5" data-testid="list-saved-concepts">
                      {extractResult.concepts.slice(0, 24).map((c) => (
                        <span
                          key={c.id}
                          title={c.definition}
                          className="inline-flex items-center px-2 py-0.5 bg-white text-emerald-800 text-xs rounded-full border border-emerald-200"
                          data-testid={`chip-saved-concept-${c.id}`}
                        >
                          {c.name}
                        </span>
                      ))}
                      {extractResult.concepts.length > 24 && (
                        <span className="text-xs text-emerald-700">{t('admin.ragSetup.extract.savedPreviewMore', { count: String(extractResult.concepts.length - 24) })}</span>
                      )}
                    </div>
                    <p className="text-xs text-emerald-700 mt-1.5">{t('admin.ragSetup.extract.appearsOnExplain')}</p>
                  </div>
                )}

                {extractResult.count === 0 && extractResult.rejected && extractResult.rejected.length > 0 && (
                  <div className="pt-1">
                    <p className="text-xs font-medium text-amber-800 mb-1">{t('admin.ragSetup.extract.rejectedPreviewTitle')}</p>
                    <div className="flex flex-wrap gap-1.5" data-testid="list-rejected-concepts">
                      {extractResult.rejected.slice(0, 12).map((r, i) => (
                        <span
                          key={`${r.name}-${i}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-white text-amber-800 text-xs rounded-full border border-amber-200"
                          data-testid={`chip-rejected-concept-${i}`}
                        >
                          {r.name}
                          <span className="text-amber-500 font-mono">{r.maxScore.toFixed(2)}</span>
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={handleLowerThresholdAndRetry}
                      disabled={loweringThreshold || extracting}
                      data-testid="button-lower-threshold-retry"
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 disabled:opacity-60 transition-colors"
                    >
                      {loweringThreshold || extracting ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('admin.ragSetup.extract.lowerThresholdBusy')}</>
                      ) : (
                        <><RefreshCw className="w-3.5 h-3.5" /> {t('admin.ragSetup.extract.lowerThresholdRetry')}</>
                      )}
                    </button>
                  </div>
                )}

                {lowerThresholdNote && (
                  <p className="text-xs text-gray-600" data-testid="text-lower-threshold-note">{lowerThresholdNote}</p>
                )}
              </div>
            )}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="select-concept-language" className="text-sm font-medium text-gray-700">{t('admin.ragSetup.extract.languageLabel')}</label>
                <select
                  id="select-concept-language"
                  value={conceptLanguage}
                  onChange={e => setConceptLanguage(e.target.value as 'nl' | 'en' | 'auto')}
                  data-testid="select-concept-language"
                  className="w-full sm:max-w-xs rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="auto">{t('admin.ragSetup.extract.languageAuto')}</option>
                  <option value="nl">{t('admin.ragSetup.extract.languageNl')}</option>
                  <option value="en">{t('admin.ragSetup.extract.languageEn')}</option>
                </select>
                <p className="text-xs text-gray-500">{t('admin.ragSetup.extract.languageHint')}</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={replaceMode}
                  onChange={e => setReplaceMode(e.target.checked)}
                  data-testid="checkbox-replace-concepts"
                  className="w-4 h-4 rounded accent-purple-600"
                />
                {t('admin.ragSetup.extract.replace')}
              </label>
              <button
                onClick={handleExtractConcepts}
                disabled={extracting || processedDocs.length === 0}
                data-testid="button-extract-concepts"
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors self-start"
              >
                {extracting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {t('admin.ragSetup.extract.extracting')}</>
                ) : selectedDocIds.size > 0 && selectedDocIds.size < processedDocs.length ? (
                  <><Sparkles className="w-4 h-4" /> {t('admin.ragSetup.extract.extractSelected', { count: String(selectedDocIds.size), s: selectedDocIds.size !== 1 ? (lang === 'en' ? 's' : 'en') : '' })}</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> {t('admin.ragSetup.extract.extractAll', { count: String(processedDocs.length), s: processedDocs.length !== 1 ? (lang === 'en' ? 's' : 'en') : '' })}</>
                )}
              </button>
              {selectedDocIds.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(selectedDocIds).map(id => {
                    const doc = processedDocs.find(d => d.id === id);
                    if (!doc) return null;
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-100 text-purple-800 text-xs rounded-full border border-purple-200"
                        data-testid={`chip-doc-${id}`}
                      >
                        <span className="max-w-[140px] truncate">{doc.filename}</span>
                        <button
                          onClick={() => setSelectedDocIds(prev => {
                            const next = new Set(prev);
                            next.delete(id);
                            return next;
                          })}
                          className="ml-0.5 text-purple-600 hover:text-purple-900 flex-shrink-0"
                          data-testid={`chip-remove-doc-${id}`}
                          aria-label={t('admin.ragSetup.extract.deselectFile', { name: doc.filename })}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-gray-800 mb-3">{t('admin.ragSetup.docStatus')}</h3>
        <RAGDocumentStatusPanel />
      </div>
    </div>
  );
}

function UploadSection({ folderId, userId, courseId, accessToken }: { folderId: string; userId: string; courseId?: string; accessToken?: string }) {
  const { t, lang } = useLanguage();
  const [items, setItems] = useState<FileUploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    const valid = arr.filter(f => {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase();
      return SUPPORTED_EXTENSIONS.includes(ext);
    });
    setItems(prev => [
      ...prev,
      ...valid.map(f => ({
        id: `${Date.now()}-${f.name}`,
        file: f,
        progress: null,
        status: 'pending' as const,
      })),
    ]);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };

  const removeItem = (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const uploadAll = async () => {
    const pending = items.filter(i => i.status === 'pending');
    for (const item of pending) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'uploading' } : i));
      try {
        await uploadDocument(
          item.file,
          item.file.name.replace(/\.[^/.]+$/, ''),
          '',
          userId,
          folderId,
          'rag_sources',
          false,
          (progress) => {
            setItems(prev => prev.map(i => i.id === item.id ? { ...i, progress } : i));
          }
        );
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done' } : i));
        if (courseId && accessToken) {
          fetch('/api/admin/record-doc-mutation', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ courseId }),
          }).catch(err => console.warn('[record-doc-mutation] upload tracking failed:', err));
        }
      } catch (err) {
        setItems(prev => prev.map(i =>
          i.id === item.id
            ? { ...i, status: 'error', error: err instanceof Error ? err.message : 'Error' }
            : i
        ));
      }
    }
  };

  const pendingCount = items.filter(i => i.status === 'pending').length;
  const uploadingCount = items.filter(i => i.status === 'uploading').length;
  const isProcessing = uploadingCount > 0;

  return (
    <div className="space-y-4">
      <div
        onDragEnter={() => setDragging(true)}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        data-testid="dropzone-upload"
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        }`}
      >
        <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-700">{t('admin.ragSetup.upload.dropzone')}</p>
        <p className="text-xs text-gray-500 mt-1">{t('admin.ragSetup.upload.hint')}</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.txt"
          className="hidden"
          onChange={e => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map(item => (
            <div
              key={item.id}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
                item.status === 'done' ? 'bg-emerald-50 border-emerald-200' :
                item.status === 'error' ? 'bg-red-50 border-red-200' :
                item.status === 'uploading' ? 'bg-blue-50 border-blue-200' :
                'bg-white border-gray-200'
              }`}
            >
              <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
                {item.status === 'uploading' && item.progress && (
                  <div className="mt-1">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{item.progress.message}</span>
                      <span>{item.progress.progress}%</span>
                    </div>
                    <div className="w-full bg-blue-200 rounded-full h-1.5">
                      <div
                        className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                        style={{ width: `${item.progress.progress}%` }}
                      />
                    </div>
                    {item.progress.currentChunk !== undefined && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Chunk {item.progress.currentChunk} / {item.progress.totalChunks}
                      </p>
                    )}
                  </div>
                )}
                {item.status === 'done' && (
                  <p className="text-xs text-emerald-700 mt-0.5">{t('admin.ragSetup.upload.done')}</p>
                )}
                {item.status === 'error' && (
                  <p className="text-xs text-red-600 mt-0.5">{item.error}</p>
                )}
                {item.status === 'pending' && (
                  <p className="text-xs text-gray-500 mt-0.5">{formatBytes(item.file.size)}</p>
                )}
              </div>
              <div className="flex-shrink-0">
                {item.status === 'done' && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                {item.status === 'uploading' && <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />}
                {item.status === 'error' && <AlertTriangle className="w-5 h-5 text-red-600" />}
                {item.status === 'pending' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                    className="p-1 text-gray-400 hover:text-gray-600 rounded"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <p className="text-sm text-gray-600">
              {pendingCount > 0 && t('admin.ragSetup.upload.readyCount', { count: String(pendingCount) })}
              {isProcessing && t('admin.ragSetup.upload.uploadingCount', { count: String(uploadingCount) })}
            </p>
            <button
              onClick={uploadAll}
              disabled={pendingCount === 0 || isProcessing}
              data-testid="button-upload-all"
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isProcessing ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('admin.ragSetup.upload.uploadingBtn')}</span>
              ) : (
                t('admin.ragSetup.upload.uploadBtn', { count: String(pendingCount), s: pendingCount !== 1 ? (lang === 'en' ? 's' : 'en') : '' })
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportSection({
  folderId,
  userId,
  courseName,
}: {
  folderId: string;
  userId: string;
  courseName: string;
}) {
  const { t } = useLanguage();
  const [storageFiles, setStorageFiles] = useState<StorageFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [importingPaths, setImportingPaths] = useState<Set<string>>(new Set());
  const [importedPaths, setImportedPaths] = useState<Set<string>>(new Set());
  const [importFileErrors, setImportFileErrors] = useState<Record<string, string>>({});
  const [bulkImporting, setBulkImporting] = useState(false);
  const [importResults, setImportResults] = useState<{ ok: string[]; fail: { path: string; error: string }[] } | null>(null);
  const [confirmBulkImport, setConfirmBulkImport] = useState(false);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    setImportResults(null);
    try {
      const files = await listStorageFilesRecursively('resources', courseName, courseName);

      const { data: existingDocs } = await supabase
        .from('documents')
        .select('filename')
        .in('folder_id', [folderId]);

      const importedNames = new Set((existingDocs || []).map(d => d.filename));

      setStorageFiles(files.map(f => ({
        ...f,
        alreadyImported: importedNames.has(f.name),
      })));
    } catch (err) {
      console.error('[IMPORT] Error listing files:', err);
    } finally {
      setLoadingFiles(false);
    }
  }, [courseName, folderId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const importFile = async (sf: StorageFile) => {
    setImportingPaths(prev => new Set(prev).add(sf.storagePath));
    try {
      const { data: fileData, error: dlError } = await supabase.storage
        .from('resources')
        .download(sf.storagePath);

      if (dlError || !fileData) throw new Error(`Download failed: ${dlError?.message}`);

      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain',
      };

      const file = new File([fileData], sf.name, { type: mimeMap[sf.extension] || '' });

      await uploadDocument(
        file,
        sf.name.replace(/\.[^/.]+$/, ''),
        `Imported from ${sf.displayPath}`,
        userId,
        folderId,
        'rag_sources',
        false,
      );

      setImportedPaths(prev => new Set(prev).add(sf.storagePath));
      setStorageFiles(prev => prev.map(f =>
        f.storagePath === sf.storagePath ? { ...f, alreadyImported: true } : f
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setImportFileErrors(prev => ({ ...prev, [sf.storagePath]: msg }));
    } finally {
      setImportingPaths(prev => {
        const next = new Set(prev);
        next.delete(sf.storagePath);
        return next;
      });
    }
  };

  const importAll = async () => {
    const toImport = storageFiles.filter(f => !f.alreadyImported && !importedPaths.has(f.storagePath));
    if (toImport.length === 0) return;

    if (!confirmBulkImport) {
      setConfirmBulkImport(true);
      return;
    }
    setConfirmBulkImport(false);
    setBulkImporting(true);
    const ok: string[] = [];
    const fail: { path: string; error: string }[] = [];

    for (const sf of toImport) {
      try {
        await importFile(sf);
        ok.push(sf.name);
      } catch {
        fail.push({ path: sf.name, error: 'Import failed' });
      }
      await new Promise(r => setTimeout(r, 500));
    }

    setImportResults({ ok, fail });
    setBulkImporting(false);
  };

  const notImported = storageFiles.filter(f => !f.alreadyImported && !importedPaths.has(f.storagePath));

  if (loadingFiles) {
    return (
      <div className="flex items-center gap-3 py-8 justify-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">{t('admin.ragSetup.import.loading', { name: courseName })}</span>
      </div>
    );
  }

  if (storageFiles.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2" data-testid="text-import-note">
          {t('admin.ragSetup.import.note')}
        </p>
        <div className="text-center py-8 text-gray-500">
          <FolderOpen className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-700">{t('admin.ragSetup.import.noFiles')}</p>
          <p className="text-sm mt-1 text-gray-500">{t('admin.ragSetup.import.noFilesHint', { name: courseName })}</p>
          <button
            onClick={loadFiles}
            className="mt-3 text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> {t('admin.ragSetup.import.reload')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2" data-testid="text-import-note">
        {t('admin.ragSetup.import.note')}
      </p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-700">
            {t('admin.ragSetup.import.filesFound', { count: String(storageFiles.length), name: courseName })}
          </p>
          {notImported.length > 0 && (
            <p className="text-xs text-amber-700 mt-0.5">
              {t('admin.ragSetup.import.notImported', { count: String(notImported.length) })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadFiles}
            disabled={loadingFiles}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            title={t('admin.ragSetup.import.refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${loadingFiles ? 'animate-spin' : ''}`} />
          </button>
          {notImported.length > 0 && !confirmBulkImport && (
            <button
              onClick={importAll}
              disabled={bulkImporting || importingPaths.size > 0}
              data-testid="button-import-all"
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {bulkImporting ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> {t('admin.ragSetup.import.importing')}</>
              ) : (
                <><Download className="w-3 h-3" /> {t('admin.ragSetup.import.importAll', { count: String(notImported.length) })}</>
              )}
            </button>
          )}
          {confirmBulkImport && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-sm">
              <span className="text-amber-800">{t('admin.ragSetup.import.confirmQuestion', { count: String(notImported.length) })}</span>
              <button
                onClick={importAll}
                className="px-2 py-0.5 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 text-xs"
                data-testid="button-confirm-import-all"
              >
                {t('admin.ragSetup.import.confirmYes')}
              </button>
              <button
                onClick={() => setConfirmBulkImport(false)}
                className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded font-medium hover:bg-gray-300 text-xs"
              >
                {t('admin.ragSetup.import.confirmCancel')}
              </button>
            </div>
          )}
        </div>
      </div>

      {importResults && (
        <div className={`rounded-lg p-3 text-sm ${importResults.fail.length === 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
          {importResults.ok.length > 0 && <p>✓ {t('admin.ragSetup.import.resultOk', { count: String(importResults.ok.length) })}</p>}
          {importResults.fail.length > 0 && <p>✗ {t('admin.ragSetup.import.resultFail', { count: String(importResults.fail.length) })}</p>}
        </div>
      )}

      <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
        {storageFiles.map(sf => {
          const isImporting = importingPaths.has(sf.storagePath);
          const isImported = sf.alreadyImported || importedPaths.has(sf.storagePath);

          return (
            <div
              key={sf.storagePath}
              data-testid={`row-storage-file-${sf.name}`}
              className={`flex items-center gap-3 px-4 py-3 ${isImported ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50'} transition-colors`}
            >
              <FileText className={`w-4 h-4 flex-shrink-0 ${isImported ? 'text-emerald-500' : 'text-gray-400'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{sf.name}</p>
                <p className="text-xs text-gray-500">
                  {sf.displayPath !== sf.name ? `${sf.displayPath} • ` : ''}{formatBytes(sf.size)}
                </p>
              </div>
              <div className="flex-shrink-0 flex flex-col items-end gap-1">
                {importFileErrors[sf.storagePath] && (
                  <span className="text-xs text-red-600 max-w-xs text-right">{importFileErrors[sf.storagePath]}</span>
                )}
                {isImported ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="w-3 h-3" /> {t('admin.ragSetup.import.imported')}
                  </span>
                ) : isImporting ? (
                  <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
                    <Loader2 className="w-3 h-3 animate-spin" /> {t('admin.ragSetup.import.importingFile')}
                  </span>
                ) : (
                  <button
                    onClick={() => { setImportFileErrors(prev => { const n = {...prev}; delete n[sf.storagePath]; return n; }); importFile(sf); }}
                    disabled={bulkImporting || importingPaths.size > 0}
                    data-testid={`button-import-${sf.name}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                  >
                    <Download className="w-3 h-3" /> {t('admin.ragSetup.import.importBtn')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
