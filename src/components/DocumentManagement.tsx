import { useState, useEffect } from 'react';
import {
  Folder,
  File,
  Upload,
  FolderPlus,
  ChevronRight,
  FolderOpen,
  Download,
  Inbox,
} from 'lucide-react';
import {
  getSubfolders,
  getDocumentsInFolder,
  FolderWithDocumentCount,
  getBreadcrumbPath,
  BreadcrumbItem,
  getRootFolder,
  getFolderById,
  createSubfolder,
  deleteFolder,
  updateFolder,
} from '../services/folder.service';
import { useAuth } from '../contexts/AuthContext';
import { NoticeBanner, ConfirmDialog, useNotice } from './Notice';

interface SubmissionItem {
  id: string;
  project_id: string;
  project_title: string | null;
  group_id: string;
  group_name: string | null;
  uploaded_by_name: string | null;
  uploaded_by_email: string | null;
  filename: string;
  byte_size: number | null;
  created_at: string;
}

interface DocumentItem {
  id: string;
  title: string;
  filename: string;
  file_path: string;
  created_at: string;
  processing_status: string;
}

interface SelectedItem {
  type: 'folder' | 'document';
  id: string;
  name: string;
}

export default function DocumentManagement({
  onUploadClick,
  onDeleteDocument,
}: {
  onUploadClick: (folderId: string | null) => void;
  onDeleteDocument: (documentId: string, filePath: string, fileName: string) => void;
}) {
  const { user, session } = useAuth();
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [currentFolderType, setCurrentFolderType] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderWithDocumentCount[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionItem[]>([]);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<{ id: string; name: string } | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const { notice, setNotice, clearNotice } = useNotice();

  useEffect(() => {
    initializeRoot();
  }, []);

  useEffect(() => {
    if (currentFolderId !== null) {
      loadCurrentFolder();
    }
  }, [currentFolderId]);

  async function initializeRoot() {
    try {
      setLoading(true);
      const root = await getRootFolder();
      if (root) {
        setCurrentFolderId(root.id);
      }
    } catch (error) {
      console.error('Error initializing root:', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadCurrentFolder() {
    if (!currentFolderId) return;

    try {
      setLoading(true);
      setSubmissionsError(null);
      const [subfolders, docs, path, meta] = await Promise.all([
        getSubfolders(currentFolderId),
        getDocumentsInFolder(currentFolderId),
        getBreadcrumbPath(currentFolderId),
        getFolderById(currentFolderId),
      ]);

      setFolders(subfolders);
      setDocuments(docs as DocumentItem[]);
      setBreadcrumbs(path);
      const ftype = meta?.folder_type || null;
      setCurrentFolderType(ftype);

      if (ftype === 'uploads' && session?.access_token) {
        try {
          const r = await fetch(`/api/admin/uploads-folder/${currentFolderId}/submissions`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (r.ok) {
            const d = await r.json();
            setSubmissions(d.submissions || []);
          } else {
            const j = await r.json().catch(() => ({}));
            setSubmissionsError(j.error || 'Kon inleveringen niet laden');
            setSubmissions([]);
          }
        } catch (e: any) {
          setSubmissionsError(e.message);
          setSubmissions([]);
        }
      } else {
        setSubmissions([]);
      }
    } catch (error) {
      console.error('Error loading folder:', error);
    } finally {
      setLoading(false);
    }
  }

  async function downloadSubmission(s: SubmissionItem) {
    if (!session?.access_token) return;
    try {
      const r = await fetch(`/api/projects/${s.project_id}/submissions/${s.id}/download`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!r.ok) { setSubmissionsError('Download mislukt'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = s.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setSubmissionsError(e.message);
    }
  }

  function handleFolderDoubleClick(folderId: string) {
    setCurrentFolderId(folderId);
    setSelectedItem(null);
  }

  function handleBreadcrumbClick(folderId: string) {
    setCurrentFolderId(folderId);
    setSelectedItem(null);
  }

  function handleItemClick(item: SelectedItem) {
    setSelectedItem(item);
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim() || !currentFolderId || !user) return;

    try {
      await createSubfolder(
        newFolderName,
        newFolderDescription || null,
        currentFolderId,
        'general',
        user.id
      );
      setShowNewFolderModal(false);
      setNewFolderName('');
      setNewFolderDescription('');
      await loadCurrentFolder();
    } catch (error) {
      console.error('Error creating folder:', error);
      setNotice({
        kind: 'error',
        message: 'Map aanmaken mislukt. Mogelijk bestaat er al een map met deze naam.',
      });
    }
  }

  async function handleRenameFolder() {
    if (!newFolderName.trim() || !selectedItem || selectedItem.type !== 'folder') return;

    try {
      await updateFolder(selectedItem.id, { name: newFolderName });
      setShowRenameModal(false);
      setNewFolderName('');
      setSelectedItem(null);
      await loadCurrentFolder();
    } catch (error) {
      console.error('Error renaming folder:', error);
      setNotice({ kind: 'error', message: 'Hernoemen van map mislukt.' });
    }
  }

  function handleDeleteFolder() {
    if (!selectedItem || selectedItem.type !== 'folder') return;
    setConfirmDeleteFolder({ id: selectedItem.id, name: selectedItem.name });
  }

  async function confirmDeleteFolderAction() {
    if (!confirmDeleteFolder) return;
    setDeletingFolder(true);
    try {
      await deleteFolder(confirmDeleteFolder.id);
      setSelectedItem(null);
      setConfirmDeleteFolder(null);
      await loadCurrentFolder();
    } catch (error: any) {
      console.error('Error deleting folder:', error);
      setNotice({ kind: 'error', message: error.message || 'Verwijderen van map mislukt.' });
    } finally {
      setDeletingFolder(false);
    }
  }

  async function handleDeleteDocument() {
    if (!selectedItem || selectedItem.type !== 'document') return;

    const doc = documents.find(d => d.id === selectedItem.id);
    if (!doc) return;

    onDeleteDocument(doc.id, doc.file_path, doc.filename);
    setSelectedItem(null);
  }

  function handleOpenSelected() {
    if (!selectedItem) return;

    if (selectedItem.type === 'folder') {
      handleFolderDoubleClick(selectedItem.id);
    }
  }

  function handleRenameSelected() {
    if (!selectedItem || selectedItem.type !== 'folder') return;
    setNewFolderName(selectedItem.name);
    setShowRenameModal(true);
  }

  if (loading && currentFolderId === null) {
    return <div className="text-center py-12 text-gray-500">Laden...</div>;
  }

  return (
    <div className="space-y-4">
      <NoticeBanner notice={notice} onDismiss={clearNotice} />
      <div className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 text-sm flex-1">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.id} className="flex items-center gap-2">
              {index > 0 && <ChevronRight className="w-4 h-4 text-gray-400" />}
              <button
                onClick={() => handleBreadcrumbClick(crumb.id)}
                className="hover:text-blue-600 transition-colors font-medium"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewFolderModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <FolderPlus className="w-4 h-4" />
            Nieuwe Map
          </button>
          <button
            onClick={() => onUploadClick(currentFolderId)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload Bestand(en)
          </button>
        </div>
      </div>

      {selectedItem && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {selectedItem.type === 'folder' ? (
              <Folder className="w-4 h-4 text-blue-600" />
            ) : (
              <File className="w-4 h-4 text-blue-600" />
            )}
            <span className="font-medium text-blue-900">{selectedItem.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenSelected}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Openen
            </button>
            {selectedItem.type === 'folder' && (
              <button
                onClick={handleRenameSelected}
                className="px-3 py-1 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
              >
                Hernoemen
              </button>
            )}
            <button
              onClick={selectedItem.type === 'folder' ? handleDeleteFolder : handleDeleteDocument}
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
            >
              Verwijderen
            </button>
            <button
              onClick={() => setSelectedItem(null)}
              className="px-3 py-1 text-sm text-gray-600 hover:text-gray-900"
            >
              Annuleren
            </button>
          </div>
        </div>
      )}

      {currentFolderType === 'uploads' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2 text-sm text-amber-900" data-testid="banner-uploads-info">
          <Inbox className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">Inleveringen van studenten</div>
            <div className="text-xs text-amber-800">
              In deze map staan de ingeleverde projectproducten per groep. Eén bestand per groep — een nieuwe upload vervangt de vorige.
              {submissionsError && <span className="block text-red-700 mt-1">{submissionsError}</span>}
            </div>
          </div>
        </div>
      )}

      {currentFolderType === 'uploads' && !loading && submissions.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden" data-testid="list-uploads-submissions">
          {submissions.map(s => (
            <div key={s.id} className="flex items-center justify-between p-4 border-b border-gray-100 hover:bg-gray-50" data-testid={`uploads-submission-row-${s.id}`}>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <File className="w-5 h-5 text-gray-500 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium truncate">{s.filename}</div>
                  <div className="text-xs text-gray-500">
                    {s.project_title || s.project_id.slice(0, 8)} · {s.group_name || s.group_id.slice(0, 8)}
                    {s.uploaded_by_name || s.uploaded_by_email ? ` · door ${s.uploaded_by_name || s.uploaded_by_email}` : ''}
                    {' · '}{new Date(s.created_at).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {s.byte_size ? ` · ${Math.round(s.byte_size / 1024)} KB` : ''}
                  </div>
                </div>
              </div>
              <button
                onClick={() => downloadSubmission(s)}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1.5"
                data-testid={`button-download-uploads-submission-${s.id}`}
              >
                <Download className="w-4 h-4" /> Download
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Laden...</div>
        ) : folders.length === 0 && documents.length === 0 && !(currentFolderType === 'uploads' && submissions.length > 0) ? (
          <div className="text-center py-12 text-gray-500">
            <FolderOpen className="w-12 h-12 mx-auto mb-3 text-gray-400" />
            <p>Deze map is leeg</p>
            <p className="text-sm mt-1">Maak een nieuwe map aan of upload bestanden</p>
          </div>
        ) : (
          <div>
            {folders.map((folder) => (
              <div
                key={folder.id}
                className={`flex items-center justify-between p-4 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors ${
                  selectedItem?.id === folder.id ? 'bg-blue-50' : ''
                }`}
                onClick={() => handleItemClick({ type: 'folder', id: folder.id, name: folder.name })}
                onDoubleClick={() => handleFolderDoubleClick(folder.id)}
              >
                <div className="flex items-center gap-3 flex-1">
                  <Folder className="w-5 h-5 text-blue-500 flex-shrink-0" />
                  <div>
                    <div className="font-medium">{folder.name}</div>
                    {folder.description && (
                      <div className="text-xs text-gray-500">{folder.description}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{folder.document_count} items</span>
                </div>
              </div>
            ))}

            {documents.map((doc) => (
              <div
                key={doc.id}
                className={`flex items-center justify-between p-4 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors ${
                  selectedItem?.id === doc.id ? 'bg-blue-50' : ''
                }`}
                onClick={() => handleItemClick({ type: 'document', id: doc.id, name: doc.title })}
              >
                <div className="flex items-center gap-3 flex-1">
                  <File className="w-5 h-5 text-gray-500 flex-shrink-0" />
                  <div>
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-gray-500">{doc.filename}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`px-3 py-1 text-xs font-medium rounded-full ${
                      doc.processing_status === 'completed'
                        ? 'bg-green-100 text-green-800'
                        : doc.processing_status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {doc.processing_status === 'completed'
                      ? 'Klaar'
                      : doc.processing_status === 'failed'
                      ? 'Mislukt'
                      : 'Verwerken...'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showNewFolderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Nieuwe Map Aanmaken</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mapnaam
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Voer mapnaam in"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Beschrijving (optioneel)
                </label>
                <textarea
                  value={newFolderDescription}
                  onChange={(e) => setNewFolderDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Voer beschrijving in"
                  rows={3}
                />
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowNewFolderModal(false);
                    setNewFolderName('');
                    setNewFolderDescription('');
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Annuleren
                </button>
                <button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Aanmaken
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteFolder !== null}
        title="Map verwijderen?"
        description={
          confirmDeleteFolder
            ? `Weet je zeker dat je de map "${confirmDeleteFolder.name}" wilt verwijderen? Deze actie kan niet ongedaan worden gemaakt.`
            : ''
        }
        confirmLabel="Verwijderen"
        variant="danger"
        busy={deletingFolder}
        onConfirm={() => { void confirmDeleteFolderAction(); }}
        onCancel={() => setConfirmDeleteFolder(null)}
      />

      {showRenameModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Map Hernoemen</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nieuwe naam
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Voer nieuwe naam in"
                  autoFocus
                />
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowRenameModal(false);
                    setNewFolderName('');
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Annuleren
                </button>
                <button
                  onClick={handleRenameFolder}
                  disabled={!newFolderName.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Hernoemen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
