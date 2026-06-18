import { useState, useEffect } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, FileText, Database, Users } from 'lucide-react';
import {
  FolderWithDocumentCount,
  BreadcrumbItem,
  getSubfolders,
  getBreadcrumbPath,
  createSubfolder,
  deleteFolder,
  updateFolder,
  canUserEditFolder
} from '../services/folder.service';
import { useAuth } from '../contexts/AuthContext';
import { NoticeBanner, ConfirmDialog, useNotice } from './Notice';
import { useLanguage } from '../i18n';

interface FolderTreeViewProps {
  rootFolder: FolderWithDocumentCount;
  onFolderSelect: (folderId: string, folderName: string) => void;
  selectedFolderId: string | null;
  onRefresh: () => void;
}

interface FolderNodeProps {
  folder: FolderWithDocumentCount;
  level: number;
  onSelect: (folderId: string, folderName: string) => void;
  selectedFolderId: string | null;
  onRefresh: () => void;
  lang: string;
}

function getFolderIcon(folderType: string | null, isOpen: boolean) {
  if (isOpen) return <FolderOpen className="w-5 h-5 text-blue-500" />;

  switch (folderType) {
    case 'rag_sources':
      return <FileText className="w-5 h-5 text-green-500" />;
    case 'data':
      return <Database className="w-5 h-5 text-purple-500" />;
    case 'roles':
      return <Users className="w-5 h-5 text-orange-500" />;
    case 'course':
      return <Folder className="w-5 h-5 text-yellow-500" />;
    default:
      return <Folder className="w-5 h-5 text-gray-500" />;
  }
}

function FolderNode({ folder, level, onSelect, selectedFolderId, onRefresh, lang }: FolderNodeProps) {
  const { t } = useLanguage();
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FolderWithDocumentCount[]>([]);
  const [isLoadingChildren, setIsLoadingChildren] = useState(false);
  const isSelected = selectedFolderId === folder.id;
  const hasChildren = folder.children && folder.children.length > 0;

  const loadChildren = async () => {
    if (children.length > 0) return;

    setIsLoadingChildren(true);
    try {
      const subfolders = await getSubfolders(folder.id);
      setChildren(subfolders);
    } catch (error) {
      console.error('Error loading subfolders:', error);
    } finally {
      setIsLoadingChildren(false);
    }
  };

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isExpanded) {
      await loadChildren();
    }
    setIsExpanded(!isExpanded);
  };

  const handleSelect = () => {
    onSelect(folder.id, folder.name);
  };

  return (
    <div>
      <div
        className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${
          isSelected ? 'bg-blue-50 border-l-4 border-blue-500' : ''
        }`}
        style={{ paddingLeft: `${level * 20 + 12}px` }}
        onClick={handleSelect}
      >
        {(hasChildren || folder.folder_type === 'course' || folder.folder_type === 'root') && (
          <button
            onClick={handleToggle}
            className="p-0.5 hover:bg-gray-200 rounded transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        )}
        {!(hasChildren || folder.folder_type === 'course' || folder.folder_type === 'root') && (
          <div className="w-5" />
        )}
        {getFolderIcon(folder.folder_type, isExpanded && isSelected)}
        <span className={`flex-1 ${isSelected ? 'font-semibold' : ''}`}>
          {folder.name}
        </span>
        {folder.document_count > 0 && (
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
            {folder.document_count}
          </span>
        )}
      </div>

      {isExpanded && isLoadingChildren && (
        <div className="text-sm text-gray-500 py-2" style={{ paddingLeft: `${(level + 1) * 20 + 12}px` }}>
          {t('common.loading')}
        </div>
      )}

      {isExpanded && children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          level={level + 1}
          onSelect={onSelect}
          selectedFolderId={selectedFolderId}
          onRefresh={onRefresh}
          lang={lang}
        />
      ))}
    </div>
  );
}

export function FolderTreeView({ rootFolder, onFolderSelect, selectedFolderId, onRefresh }: FolderTreeViewProps) {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showRenameFolderModal, setShowRenameFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { notice, setNotice, clearNotice } = useNotice();

const openNewFolderForSelected = () => {
  if (!selectedFolderId) {
    setNotice({ kind: 'warning', message: t('folderTree.selectFolderFirst') });
    return;
  }

  setShowNewFolderModal(true);
  setNewFolderName('');
  setNewFolderDescription('');
};

  useEffect(() => {
    if (selectedFolderId) {
      loadBreadcrumbs();
      checkEditPermission();
    } else {
      setBreadcrumbs([]);
    }
  }, [selectedFolderId]);

  const loadBreadcrumbs = async () => {
    if (!selectedFolderId) return;
    try {
      const path = await getBreadcrumbPath(selectedFolderId);
      setBreadcrumbs(path);
    } catch (error) {
      console.error('Error loading breadcrumbs:', error);
    }
  };

  const checkEditPermission = async () => {
    if (!selectedFolderId || !user) {
      setCanEdit(false);
      return;
    }
    try {
      const hasPermission = await canUserEditFolder(selectedFolderId, user.id);
      setCanEdit(hasPermission);
    } catch (error) {
      console.error('Error checking permissions:', error);
      setCanEdit(false);
    }
  };

const handleCreateFolder = async () => {
  const parentId = selectedFolderId;

  if (!parentId || !user || !newFolderName.trim()) {
    setNotice({ kind: 'warning', message: t('folderTree.selectFolderFirst') });
    return;
  }

  try {
    const isRoot = rootFolder.id === parentId;

    const newFolder = await createSubfolder(
      newFolderName,
      newFolderDescription || null,
      parentId,
      isRoot ? 'course' : 'general',
      user.id
    );

    if (isRoot) {
      await createSubfolder(
        'RAG',
        'RAG-documenten voor deze cursus',
        newFolder.id,
        'rag_sources',
        user.id
      );
    }

    setShowNewFolderModal(false);
    setNewFolderName('');
    setNewFolderDescription('');

    onRefresh();

  } catch (error) {
    console.error('Error creating folder:', error);
    setNotice({ kind: 'error', message: t('folderTree.createFailed') });
  }
};

const handleRenameFolder = async () => {
  if (!selectedFolderId || !newFolderName.trim()) return;

  try {
    await updateFolder(selectedFolderId, { name: newFolderName.trim() });
    setShowRenameFolderModal(false);
    setNewFolderName('');
    onRefresh();
  } catch (error) {
    console.error('Error renaming folder:', error);
    setNotice({
      kind: 'error',
      message: t('folderTree.renameFailed'),
    });
  }
};

const askDeleteFolder = () => {
  if (!selectedFolderId) {
    setNotice({ kind: 'warning', message: t('folderTree.selectFolderFirst') });
    return;
  }
  const folderName =
    selectedFolderId === rootFolder.id
      ? rootFolder.name
      : breadcrumbs[breadcrumbs.length - 1]?.name || t('folderTree.thisFolder');
  setConfirmDelete({ id: selectedFolderId, name: folderName });
};

const runDeleteFolder = async () => {
  if (!confirmDelete) return;
  setDeleting(true);
  try {
    await deleteFolder(confirmDelete.id);
    setConfirmDelete(null);
    onRefresh();
  } catch (error: any) {
    console.error('Error deleting folder:', error);
    setNotice({ kind: 'error', message: error.message || t('folderTree.deleteFailed') });
  } finally {
    setDeleting(false);
  }
};

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {notice && (
        <div className="p-4 pb-0">
          <NoticeBanner notice={notice} onDismiss={clearNotice} />
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('folderTree.deleteTitle')}
        description={
          confirmDelete
            ? t('folderTree.deleteConfirm', { name: confirmDelete.name })
            : ''
        }
        confirmLabel={t('folderTree.delete')}
        variant="danger"
        busy={deleting}
        onConfirm={() => { void runDeleteFolder(); }}
        onCancel={() => setConfirmDelete(null)}
      />
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{t('folderTree.fileEnvironment')}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={openNewFolderForSelected}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              data-testid="button-new-folder"
            >
              {t('folderTree.newFolder')}
            </button>
            {selectedFolderId && selectedFolderId !== rootFolder.id && canEdit && (
              <button
                onClick={askDeleteFolder}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                data-testid="button-delete-folder"
              >
                {t('folderTree.deleteFolderBtn')}
              </button>
            )}
          </div>
        </div>

        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-2 mt-2 text-sm text-gray-600">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.id}>
                {index > 0 && <span className="mx-1">/</span>}
                <button
                  onClick={() => onFolderSelect(crumb.id, crumb.name)}
                  className="hover:text-blue-600 transition-colors"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-y-auto max-h-96">
        <FolderNode
          folder={rootFolder}
          level={0}
          onSelect={onFolderSelect}
          selectedFolderId={selectedFolderId}
          onRefresh={onRefresh}
          lang={lang}
        />
      </div>
      {showNewFolderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">{t('folderTree.createNewFolderTitle')}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('folderTree.folderName')}
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder={t('folderTree.folderNamePlaceholder')}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('folderTree.descriptionOptional')}
                </label>
                <textarea
                  value={newFolderDescription}
                  onChange={(e) => setNewFolderDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder={t('folderTree.descriptionPlaceholder')}
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
                  {t('folderTree.cancel')}
                </button>
                <button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('folderTree.create')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRenameFolderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">{t('folderTree.renameFolderTitle')}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('folderTree.newName')}
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder={t('folderTree.newNamePlaceholder')}
                  autoFocus
                />
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowRenameFolderModal(false);
                    setNewFolderName('');
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  {t('folderTree.cancel')}
                </button>
                <button
                  onClick={handleRenameFolder}
                  disabled={!newFolderName.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('folderTree.rename')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
