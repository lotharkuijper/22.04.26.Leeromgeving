import { useState, useEffect } from 'react';
import { Upload, Download, Trash2, FolderOpen, X } from 'lucide-react';
import {
  getDatasets,
  uploadDataset,
  downloadDataset,
  deleteDataset,
  formatFileSize,
  getFileIcon,
  type Dataset,
} from '../services/dataset.service';
import { getFolders, type Folder } from '../services/folder.service';
import { NoticeBanner, ConfirmDialog, useNotice } from './Notice';

export function DatasetManagement() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Dataset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { notice, setNotice, clearNotice } = useNotice();

  const [uploadForm, setUploadForm] = useState({
    file: null as File | null,
    name: '',
    description: '',
    folderId: null as string | null,
  });

  useEffect(() => {
    loadData();
  }, [selectedFolder]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [datasetsData, foldersData] = await Promise.all([
        getDatasets(selectedFolder || undefined),
        getFolders(),
      ]);
      setDatasets(datasetsData);
      setFolders(foldersData.filter(f => f.bucket_type === 'datasets'));
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadForm({
        ...uploadForm,
        file,
        name: file.name.replace(/\.[^/.]+$/, ''),
      });
    }
  };

  const handleUpload = async () => {
    if (!uploadForm.file) return;

    setUploading(true);
    try {
      const result = await uploadDataset(
        uploadForm.file,
        uploadForm.name,
        uploadForm.description || null,
        uploadForm.folderId
      );

      if (result.success) {
        setNotice({ kind: 'success', message: 'Dataset succesvol geüpload!' });
        setShowUploadModal(false);
        setUploadForm({ file: null, name: '', description: '', folderId: null });
        loadData();
      } else {
        setNotice({ kind: 'error', message: `Fout bij uploaden: ${result.error}` });
      }
    } catch (error: any) {
      setNotice({ kind: 'error', message: `Fout bij uploaden: ${error.message}` });
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (dataset: Dataset) => {
    try {
      const result = await downloadDataset(dataset);

      if (result.success && result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = dataset.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        setNotice({ kind: 'error', message: `Fout bij downloaden: ${result.error}` });
      }
    } catch (error: any) {
      setNotice({ kind: 'error', message: `Fout bij downloaden: ${error.message}` });
    }
  };

  const confirmDeleteDataset = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteDataset(deleteTarget.id, deleteTarget.file_path);
      if (result.success) {
        setNotice({ kind: 'success', message: 'Dataset verwijderd.' });
        loadData();
      } else {
        setNotice({ kind: 'error', message: `Fout bij verwijderen: ${result.error}` });
      }
    } catch (error: any) {
      setNotice({ kind: 'error', message: `Fout bij verwijderen: ${error.message}` });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const datasetFolders = folders.filter(f => f.bucket_type === 'datasets');

  return (
    <div className="space-y-6">
      <NoticeBanner notice={notice} onDismiss={clearNotice} />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Dataset Beheer</h2>
          <p className="text-gray-600 mt-1">
            Upload datasets (XLSX, CSV, OMV) voor studenten om te downloaden
          </p>
        </div>
        <button
          onClick={() => setShowUploadModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          data-testid="button-open-upload-dataset"
        >
          <Upload className="w-4 h-4" />
          Upload Dataset
        </button>
      </div>

      <div className="flex gap-4">
        <button
          onClick={() => setSelectedFolder(null)}
          className={`px-4 py-2 rounded-lg transition-colors ${
            selectedFolder === null
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Alle Datasets
        </button>
        {datasetFolders.map(folder => (
          <button
            key={folder.id}
            onClick={() => setSelectedFolder(folder.id)}
            className={`px-4 py-2 rounded-lg transition-colors ${
              selectedFolder === folder.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FolderOpen className="w-4 h-4 inline mr-2" />
            {folder.name}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Laden...</p>
        </div>
      ) : datasets.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-12 text-center">
          <p className="text-gray-600">Geen datasets gevonden</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {datasets.map(dataset => (
            <div key={dataset.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 flex-1">
                  <span className="text-3xl">{getFileIcon(dataset.file_type)}</span>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900">{dataset.name}</h3>
                    {dataset.description && (
                      <p className="text-sm text-gray-600 mt-1">{dataset.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                      <span>{formatFileSize(dataset.file_size)}</span>
                      <span>Geüpload door: {dataset.uploader_name || 'Onbekend'}</span>
                      <span>{new Date(dataset.created_at).toLocaleDateString('nl-NL')}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDownload(dataset)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title="Download"
                    data-testid={`button-download-dataset-${dataset.id}`}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(dataset)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Verwijder"
                    data-testid={`button-delete-dataset-${dataset.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showUploadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
              <h3 className="text-xl font-bold text-gray-900">Upload Dataset</h3>
              <button
                onClick={() => setShowUploadModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Bestand *
                </label>
                <input
                  type="file"
                  accept=".xlsx,.csv,.omv"
                  onChange={handleFileSelect}
                  className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Toegestaan: XLSX, CSV, OMV (max 50MB)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Naam *
                </label>
                <input
                  type="text"
                  value={uploadForm.name}
                  onChange={(e) => setUploadForm({ ...uploadForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Dataset naam"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Beschrijving
                </label>
                <textarea
                  value={uploadForm.description}
                  onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Optionele beschrijving"
                  rows={3}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Folder (optioneel)
                </label>
                <select
                  value={uploadForm.folderId || ''}
                  onChange={(e) => setUploadForm({ ...uploadForm, folderId: e.target.value || null })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Geen folder</option>
                  {datasetFolders.map(folder => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowUploadModal(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Annuleer
                </button>
                <button
                  onClick={handleUpload}
                  disabled={!uploadForm.file || !uploadForm.name || uploading}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {uploading ? 'Uploaden...' : 'Upload'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Dataset verwijderen?"
        description={
          deleteTarget
            ? `Weet je zeker dat je "${deleteTarget.name}" wilt verwijderen? Deze actie kan niet ongedaan worden gemaakt.`
            : ''
        }
        confirmLabel="Verwijderen"
        variant="danger"
        busy={deleting}
        onConfirm={() => { void confirmDeleteDataset(); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
