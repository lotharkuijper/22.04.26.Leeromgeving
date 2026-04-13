import { useState, useEffect, useRef, useCallback } from 'react';
import {
  FolderPlus, Upload, Download, CheckCircle2, AlertTriangle,
  Loader2, FileText, RefreshCw, X, FolderOpen, Info,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { uploadDocument, UploadProgress } from '../services/document-upload.service';
import { RAGDocumentStatusPanel } from './RAGDocumentStatusPanel';

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.txt'];

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
  const { profile } = useAuth();
  const { activeCourseId, activeCourse, activeCourseRagFolderIds, refreshActiveCourse, loading: courseLoading } = useActiveCourse();

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [activeSection, setActiveSection] = useState<ActiveSection>('upload');

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
    if (!activeCourseId || !profile?.id) return;
    setCreatingFolder(true);
    try {
      const { data: existingFolder } = await supabase
        .from('document_folders')
        .select('id')
        .eq('name', `RAG - ${activeCourse.name}`)
        .maybeSingle();

      let folderId: string;

      if (existingFolder) {
        folderId = existingFolder.id;
      } else {
        const { data: newFolder, error: folderError } = await supabase
          .from('document_folders')
          .insert({
            name: `RAG - ${activeCourse.name}`,
            description: `RAG-bronnen voor cursus ${activeCourse.name}`,
            parent_folder_id: null,
            created_by: profile.id,
            folder_type: 'rag_sources',
            is_root: false,
          } as any)
          .select()
          .single();

        if (folderError || !newFolder) {
          throw new Error(`Kon RAG-map niet aanmaken: ${folderError?.message}`);
        }
        folderId = newFolder.id;

        await supabase.from('folder_permissions').insert([
          { folder_id: folderId, role: 'admin', can_view: true, can_edit: true },
          { folder_id: folderId, role: 'docent', can_view: true, can_edit: true },
          { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
        ]);
      }

      const { data: existingAssignment } = await supabase
        .from('course_folder_assignments')
        .select('id')
        .eq('course_id', activeCourseId)
        .eq('folder_id', folderId)
        .maybeSingle();

      if (!existingAssignment) {
        const { error: assignError } = await supabase
          .from('course_folder_assignments')
          .insert({ course_id: activeCourseId, folder_id: folderId });

        if (assignError) {
          throw new Error(`Kon RAG-map niet koppelen aan cursus: ${assignError.message}`);
        }
      }

      await refreshActiveCourse();
    } catch (err) {
      alert('Fout: ' + (err instanceof Error ? err.message : 'Onbekende fout'));
    } finally {
      setCreatingFolder(false);
    }
  };

  if (activeCourseRagFolderIds.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex gap-4">
          <FolderPlus className="w-8 h-8 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">
              Cursus <strong>{activeCourse.name}</strong> heeft nog geen RAG-map
            </h3>
            <p className="text-sm text-gray-700 mb-4">
              Om documenten doorzoekbaar te maken voor de chatbot, moet er eerst een RAG-map worden
              aangemaakt en gekoppeld aan deze cursus. Dit is een eenmalige instelling.
            </p>
            <button
              onClick={handleCreateRagFolder}
              disabled={creatingFolder}
              data-testid="button-create-rag-folder"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {creatingFolder ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Aanmaken...</>
              ) : (
                <><FolderPlus className="w-4 h-4" /> RAG-map aanmaken voor {activeCourse.name}</>
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
  const [bulkImporting, setBulkImporting] = useState(false);
  const [importResults, setImportResults] = useState<{ ok: string[]; fail: { path: string; error: string }[] } | null>(null);

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
      alert(`Fout bij importeren van ${sf.name}: ${err instanceof Error ? err.message : 'Onbekende fout'}`);
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

    if (!confirm(`${toImport.length} bestand(en) importeren en verwerken? Dit kan enkele minuten duren.`)) return;

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
          {notImported.length > 0 && (
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
              <div className="flex-shrink-0">
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
                    onClick={() => importFile(sf)}
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
