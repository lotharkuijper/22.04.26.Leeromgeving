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
  const { activeCourseId, activeCourse, activeCourseRagFolderIds, refreshActiveCourse, loading: courseLoading } = useActiveCourse();

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>('upload');
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<{ count: number; skipped: number; message: string } | null>(null);
  const [processedDocs, setProcessedDocs] = useState<ProcessedDocument[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [existingConceptCount, setExistingConceptCount] = useState(0);
  const [replaceMode, setReplaceMode] = useState(false);

  useEffect(() => {
    if (activeCourseRagFolderIds.length === 0) {
      setProcessedDocs([]);
      setSelectedDocIds(new Set());
      return;
    }
    supabase
      .from('documents')
      .select('id, filename')
      .in('folder_id', activeCourseRagFolderIds)
      .eq('processing_status', 'completed')
      .then(({ data }) => {
        const docs: ProcessedDocument[] = (data || []).map(d => ({ id: d.id, filename: d.filename }));
        setProcessedDocs(docs);
        setSelectedDocIds(new Set(docs.map(d => d.id)));
      });
  }, [activeCourseRagFolderIds]);

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
        <span>Cursusgegevens laden...</span>
      </div>
    );
  }

  if (!activeCourseId || !activeCourse) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Info className="w-12 h-12 mx-auto mb-3 text-gray-300" />
        <p className="font-medium">Geen actieve cursus</p>
        <p className="text-sm mt-1">Kies een cursus via de cursusbalk bovenaan.</p>
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
      setCreateError(err instanceof Error ? err.message : 'Onbekende fout');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleExtractConcepts = async () => {
    if (!activeCourseId || !session?.access_token) return;
    setExtracting(true);
    setExtractResult(null);
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
      });
    } catch (err) {
      setExtractResult({
        count: 0,
        skipped: 0,
        message: err instanceof Error ? err.message : 'Onbekende fout',
      });
    } finally {
      setExtracting(false);
    }
  };

  if (activeCourseRagFolderIds.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex gap-4">
          <FolderPlus className="w-8 h-8 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-2">
              Cursus <strong>{activeCourse.name}</strong> heeft nog geen RAG-configuratie
            </h3>
            <p className="text-sm text-gray-700 mb-2">
              Let op: dit gaat <em>niet</em> over een map in het bestandsbeheer. In het bestandsbeheer
              kunnen al bestanden staan (bijv. <code className="bg-amber-100 px-1 rounded text-xs">{activeCourse.name}/RAG/</code>),
              maar die zijn nog <strong>niet</strong> doorzoekbaar voor de chatbot.
            </p>
            <p className="text-sm text-gray-700 mb-4">
              Met de knop hieronder wordt een <strong>database-configuratie</strong> aangemaakt die de chatbot
              vertelt welke documenten hij mag gebruiken. Daarna kun je via de <em>Importeren</em>-tab bestaande
              bestanden uit het bestandsbeheer inladen, of via <em>Uploaden</em> nieuwe bestanden toevoegen.
            </p>
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
                <><Loader2 className="w-4 h-4 animate-spin" /> Aanmaken...</>
              ) : (
                <><Database className="w-4 h-4" /> RAG-configuratie instellen voor {activeCourse.name}</>
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
          <strong>RAG-map actief</strong> voor cursus <strong>{activeCourse.name}</strong> —
          upload hieronder nieuwe documenten of importeer bestaande bestanden.
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
            Nieuwe bestanden uploaden
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
            Importeren uit bestandsbeheer
          </button>
        </div>

        <div className="p-4">
          {activeSection === 'upload' && ragFolderId && (
            <UploadSection folderId={ragFolderId} userId={profile?.id ?? ''} />
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
            <h3 className="font-semibold text-gray-900 text-sm">Onderwerpen extraheren uit cursusmateriaal</h3>
            <p className="text-xs text-gray-600 mt-0.5 mb-1">
              Laat de AI automatisch vaktermen identificeren uit de geïmporteerde documenten — ook als ze impliciet in de tekst voorkomen — en voeg ze toe aan de lijst in &quot;Ik leg uit&quot;.
            </p>
            <div className="flex flex-wrap gap-3 text-xs text-gray-500 mb-3">
              <span>{processedDocs.length} verwerkt document{processedDocs.length !== 1 ? 'en' : ''}</span>
              <span>·</span>
              <span>{existingConceptCount} bestaande begrippen voor deze cursus</span>
            </div>

            {processedDocs.length > 0 && (
              <div className="mb-3 border border-gray-200 rounded-lg overflow-hidden bg-white">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-medium text-gray-700">Selecteer documenten voor extractie</span>
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
                      {selectedDocIds.size === processedDocs.length ? 'Niets selecteren' : 'Alles selecteren'}
                    </button>
                  )}
                </div>
                <div className="divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {processedDocs.map(doc => (
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
                      <span className="text-xs text-gray-700 truncate">{doc.filename}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {selectedDocIds.size > 0 && selectedDocIds.size < processedDocs.length && (
              <div className="flex flex-wrap gap-1.5 mb-3">
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
                        aria-label={`${doc.filename} deselecteren`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {extractResult && (
              <div className={`mb-3 text-sm px-3 py-2 rounded-lg ${
                extractResult.count > 0
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                  : 'bg-gray-100 border border-gray-200 text-gray-700'
              }`}>
                {extractResult.message}
                {extractResult.skipped > 0 && (
                  <span className="ml-1 text-gray-500">({extractResult.skipped} al aanwezig)</span>
                )}
              </div>
            )}
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={replaceMode}
                  onChange={e => setReplaceMode(e.target.checked)}
                  data-testid="checkbox-replace-concepts"
                  className="w-4 h-4 rounded accent-purple-600"
                />
                Bestaande begrippen vervangen (verwijdert huidige cursuslijst voor opnieuw extraheren)
              </label>
              <button
                onClick={handleExtractConcepts}
                disabled={extracting || processedDocs.length === 0 || selectedDocIds.size === 0}
                data-testid="button-extract-concepts"
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors self-start"
              >
                {extracting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Extraheren...</>
                ) : selectedDocIds.size < processedDocs.length ? (
                  <><Sparkles className="w-4 h-4" /> Extraheren uit {selectedDocIds.size} geselecteerde document{selectedDocIds.size !== 1 ? 'en' : ''}</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> {existingConceptCount > 0 && replaceMode ? 'Opnieuw extraheren' : `Extraheren uit alle ${processedDocs.length} document${processedDocs.length !== 1 ? 'en' : ''}`}</>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-gray-800 mb-3">Verwerkingsstatus documenten</h3>
        <RAGDocumentStatusPanel />
      </div>
    </div>
  );
}

function UploadSection({ folderId, userId }: { folderId: string; userId: string }) {
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
      } catch (err) {
        setItems(prev => prev.map(i =>
          i.id === item.id
            ? { ...i, status: 'error', error: err instanceof Error ? err.message : 'Fout' }
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
        <p className="text-sm font-medium text-gray-700">Sleep bestanden hierheen of klik om te kiezen</p>
        <p className="text-xs text-gray-500 mt-1">PDF, DOCX, PPTX, TXT — max 20 MB per bestand</p>
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
                  <p className="text-xs text-emerald-700 mt-0.5">Succesvol verwerkt</p>
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
              {pendingCount > 0 && `${pendingCount} klaar om te uploaden`}
              {isProcessing && `${uploadingCount} bezig...`}
            </p>
            <button
              onClick={uploadAll}
              disabled={pendingCount === 0 || isProcessing}
              data-testid="button-upload-all"
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isProcessing ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Bezig...</span>
              ) : (
                `${pendingCount} bestand${pendingCount !== 1 ? 'en' : ''} uploaden`
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

      if (dlError || !fileData) throw new Error(`Download mislukt: ${dlError?.message}`);

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
        `Geïmporteerd vanuit ${sf.displayPath}`,
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
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
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
        fail.push({ path: sf.name, error: 'Importeren mislukt' });
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
        <span className="text-sm">Bestanden zoeken in {courseName}...</span>
      </div>
    );
  }

  if (storageFiles.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <FolderOpen className="w-10 h-10 mx-auto mb-3 text-gray-300" />
        <p className="font-medium text-gray-700">Geen compatibele bestanden gevonden</p>
        <p className="text-sm mt-1 text-gray-500">
          Geen PDF, DOCX, PPTX of TXT-bestanden gevonden in de map <strong>{courseName}</strong> van het bestandsbeheer.
        </p>
        <button
          onClick={loadFiles}
          className="mt-3 text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" /> Opnieuw laden
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-700">
            <strong>{storageFiles.length}</strong> bestand(en) gevonden in het bestandsbeheer van <strong>{courseName}</strong>
          </p>
          {notImported.length > 0 && (
            <p className="text-xs text-amber-700 mt-0.5">
              {notImported.length} nog niet geïmporteerd in de RAG-pipeline
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadFiles}
            disabled={loadingFiles}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            title="Vernieuwen"
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
                <><Loader2 className="w-3 h-3 animate-spin" /> Importeren...</>
              ) : (
                <><Download className="w-3 h-3" /> Alles importeren ({notImported.length})</>
              )}
            </button>
          )}
          {confirmBulkImport && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-sm">
              <span className="text-amber-800">{notImported.length} bestand(en) importeren?</span>
              <button
                onClick={importAll}
                className="px-2 py-0.5 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 text-xs"
                data-testid="button-confirm-import-all"
              >
                Ja
              </button>
              <button
                onClick={() => setConfirmBulkImport(false)}
                className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded font-medium hover:bg-gray-300 text-xs"
              >
                Annuleren
              </button>
            </div>
          )}
        </div>
      </div>

      {importResults && (
        <div className={`rounded-lg p-3 text-sm ${importResults.fail.length === 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
          {importResults.ok.length > 0 && <p>✓ {importResults.ok.length} bestand(en) succesvol geïmporteerd</p>}
          {importResults.fail.length > 0 && <p>✗ {importResults.fail.length} bestand(en) mislukt</p>}
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
                    <CheckCircle2 className="w-3 h-3" /> Geïmporteerd
                  </span>
                ) : isImporting ? (
                  <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
                    <Loader2 className="w-3 h-3 animate-spin" /> Bezig...
                  </span>
                ) : (
                  <button
                    onClick={() => { setImportFileErrors(prev => { const n = {...prev}; delete n[sf.storagePath]; return n; }); importFile(sf); }}
                    disabled={bulkImporting || importingPaths.size > 0}
                    data-testid={`button-import-${sf.name}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                  >
                    <Download className="w-3 h-3" /> Importeren
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
