import { useState, useRef } from 'react';
import { X, Upload, FileText, Loader2, Trash2 } from 'lucide-react';
import { validateDocumentFile } from '../services/document-processor.service';
import { uploadMultipleDocuments, MultiFileProgress } from '../services/document-upload.service';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../i18n';

interface DocumentUploadModalProps {
  onClose: () => void;
  onSuccess: () => void;
  folderId?: string | null;
}

export function DocumentUploadModal({ onClose, onSuccess, folderId = null }: DocumentUploadModalProps) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [currentFileProgress, setCurrentFileProgress] = useState<MultiFileProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    handleFilesSelect(droppedFiles);
  };

  const handleFilesSelect = (selectedFiles: File[]) => {
    const validFiles: File[] = [];
    const errors: string[] = [];

    selectedFiles.forEach(file => {
      const validation = validateDocumentFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        errors.push(`${file.name}: ${validation.error}`);
      }
    });

    if (errors.length > 0) {
      setError(errors.join('\n'));
    } else {
      setError('');
    }

    setFiles(prev => [...prev, ...validFiles]);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files ? Array.from(e.target.files) : [];
    if (selectedFiles.length > 0) {
      handleFilesSelect(selectedFiles);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (files.length === 0 || !user) {
      setError(t('docUpload.errSelectFile'));
      return;
    }

    if (!folderId) {
      setError(t('docUpload.errNoFolder'));
      return;
    }

    setIsUploading(true);
    setError('');

    try {
      const titles = files.map(f => f.name.replace(/\.[^/.]+$/, ''));
      const descriptions = files.map(() => '');

      const results = await uploadMultipleDocuments(
        files,
        titles,
        descriptions,
        user.id,
        folderId,
        (progress) => {
          setCurrentFileProgress(progress);
        }
      );

      if (results.failed.length > 0) {
        setError(t('docUpload.partialResult', { success: String(results.successful.length), failed: String(results.failed.length) }));
        setIsUploading(false);
      } else {
        onSuccess();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('docUpload.uploadFailed'));
      setIsUploading(false);
    }
  };

  if (isUploading && currentFileProgress) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 className="text-xl font-semibold mb-4">{t('docUpload.processingTitle')}</h2>

          <div className="space-y-4">
            <div>
              <div className="text-sm text-gray-600 mb-2">
                {t('docUpload.fileProgress', { current: String(currentFileProgress.fileIndex + 1), total: String(currentFileProgress.totalFiles) })}
              </div>
              <div className="font-medium mb-1">{currentFileProgress.fileName}</div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">{currentFileProgress.progress.message}</span>
                <span className="font-medium">{currentFileProgress.progress.progress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${currentFileProgress.progress.progress}%` }}
                />
              </div>
            </div>

            {currentFileProgress.progress.totalChunks && (
              <div className="text-sm text-gray-600">
                {t('docUpload.chunksProcessed', { current: String(currentFileProgress.progress.currentChunk), total: String(currentFileProgress.progress.totalChunks) })}
              </div>
            )}

            {currentFileProgress.progress.stage === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800">
                {currentFileProgress.progress.message}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b sticky top-0 bg-white">
          <h2 className="text-xl font-semibold">{t('docUpload.title')}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx"
              multiple
              onChange={handleFileInputChange}
              className="hidden"
            />

            <div className="space-y-2">
              <Upload className="w-12 h-12 text-gray-400 mx-auto" />
              <p className="text-gray-600">
                {t('docUpload.dragHint')}
              </p>
              <p className="text-sm text-gray-500">{t('docUpload.fileTypeHint')}</p>
              <p className="text-sm font-medium text-blue-600">{t('docUpload.multipleAllowed')}</p>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800 whitespace-pre-line">
              {error}
            </div>
          )}

          {files.length > 0 && (
            <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
              {files.map((file, index) => (
                <div key={index} className="flex items-center justify-between p-3">
                  <div className="flex items-center space-x-3 flex-1">
                    <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900 truncate">{file.name}</p>
                      <p className="text-sm text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    className="ml-2 p-1 hover:bg-red-50 rounded"
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              {t('docUpload.cancel')}
            </button>
            <button
              type="submit"
              disabled={files.length === 0 || isUploading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {isUploading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Upload {files.length > 0 && `(${files.length})`}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
