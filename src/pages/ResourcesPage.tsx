import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n';
import { Download, Search, FileText, BookOpen, FolderOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { STORAGE_CONFIG } from '../config/storage.config';
import { formatFileSize, getFileIcon } from '../services/dataset.service';
import { useActiveCourse } from "../contexts/ActiveCourseContext";

interface Resource {
  id: string;
  name: string;
  description: string | null;
  file_path: string;
  file_size: number;
  file_type: string;
  bucket: string;
  folder_id: string | null;
  created_at: string;
  folder_name?: string;
}

function toResource(doc: any): Resource {
  return {
    id: doc.id,
    name: doc.title || doc.filename,
    description: doc.description,
    file_path: doc.file_path,
    file_size: doc.file_size,
    file_type: doc.file_type,
    bucket: doc.bucket,
    folder_id: doc.folder_id,
    created_at: doc.created_at,
    folder_name: doc.document_folders?.name,
  };
}

export function ResourcesPage() {
  const { t, lang } = useLanguage();
  const [otherDocs, setOtherDocs] = useState<Resource[]>([]);
  const [ragFiles, setRagFiles] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const { activeCourse, activeCourseRagFolderIds } = useActiveCourse();

  useEffect(() => {
    loadOtherDocs();
  }, []);

  useEffect(() => {
    loadRagFiles();
  }, [activeCourseRagFolderIds]);

  const fetchFromBucket = async (bucket: string): Promise<Resource[]> => {
    const { data, error } = await supabase
      .from('documents')
      .select('*, document_folders (name)')
      .eq('bucket', bucket)
      .eq('processing_status', 'completed')
      .order('created_at', { ascending: false });
    if (error) { console.error(`[Bronnen] fout bij ophalen ${bucket}:`, error.message); return []; }
    return (data || []).map(toResource);
  };

  const loadOtherDocs = async () => {
    setLoading(true);
    try {
      const [datasets, docs] = await Promise.all([
        fetchFromBucket(STORAGE_CONFIG.buckets.DATASETS),
        fetchFromBucket(STORAGE_CONFIG.buckets.DOCS_GENERAL),
      ]);
      setOtherDocs([...datasets, ...docs]);
    } finally {
      setLoading(false);
    }
  };

  const loadRagFiles = async () => {
    if (!activeCourseRagFolderIds || activeCourseRagFolderIds.length === 0) {
      setRagFiles([]);
      return;
    }
    const { data, error } = await supabase
      .from('documents')
      .select('*, document_folders (name)')
      .in('folder_id', activeCourseRagFolderIds)
      .eq('processing_status', 'completed')
      .order('created_at', { ascending: false });
    if (error) { console.error('[Bronnen] fout bij ophalen RAG-bestanden:', error.message); setRagFiles([]); return; }
    setRagFiles((data || []).map(toResource));
  };

  const handleDownload = async (resource: Resource) => {
    const { data, error } = await supabase.storage
      .from(resource.bucket)
      .download(resource.file_path);
    if (error) { alert(t('resources.downloadError', { message: error.message })); return; }
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = resource.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filter = (resources: Resource[]) => {
    if (!searchQuery.trim()) return resources;
    const q = searchQuery.toLowerCase();
    return resources.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.description?.toLowerCase().includes(q) ||
      r.folder_name?.toLowerCase().includes(q)
    );
  };

  const filteredRag = filter(ragFiles);
  const filteredOther = filter(otherDocs);

  const ResourceRow = ({ resource }: { resource: Resource }) => (
    <div
      className="flex items-center gap-3 p-3 border border-gray-100 rounded-lg hover:bg-gray-50 transition-colors"
      data-testid={`resource-row-${resource.id}`}
    >
      <span className="text-xl flex-shrink-0">{getFileIcon(resource.file_type)}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 text-sm truncate">{resource.name}</p>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
          {resource.folder_name && (
            <span className="flex items-center gap-1">
              <FolderOpen className="w-3 h-3" />
              {resource.folder_name}
            </span>
          )}
          {resource.file_size > 0 && <span>{formatFileSize(resource.file_size)}</span>}
          <span>{new Date(resource.created_at).toLocaleDateString(t('common.locale'))}</span>
        </div>
        {resource.description && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{resource.description}</p>
        )}
      </div>
      <button
        onClick={() => handleDownload(resource)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 transition-colors flex-shrink-0"
        data-testid={`download-btn-${resource.id}`}
      >
        <Download className="w-3.5 h-3.5" />
        {t('resources.download')}
      </button>
    </div>
  );

  const EmptyState = ({ search }: { search: boolean }) => (
    <p className="text-sm text-gray-400 text-center py-8">
      {search ? t('common.noResults') : t('resources.noFiles')}
    </p>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Paginaheader */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('resources.title')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('resources.availableFor', { name: activeCourse?.name ?? t('resources.thisCourse') })}
          </p>
        </div>
        <div className="relative w-60">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('common.search') + '...'}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            data-testid="resources-search"
          />
        </div>
      </div>

      {/* Sectie 1: Cursusmateriaal (RAG) */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <BookOpen className="w-5 h-5 text-blue-600 flex-shrink-0" />
          <h2 className="text-base font-semibold text-gray-900">{t('resources.courseFiles')}</h2>
          <span className="ml-auto text-xs text-gray-400 font-medium">
            {filteredRag.length === 1 ? t('resources.fileCountSingular', { count: '1' }) : t('resources.fileCountPlural', { count: String(filteredRag.length) })}
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-4 ml-7">
          {t('resources.courseFilesDesc')}
        </p>
        {filteredRag.length === 0
          ? <EmptyState search={!!searchQuery} />
          : <div className="space-y-2">{filteredRag.map(r => <ResourceRow key={r.id} resource={r} />)}</div>
        }
      </section>

      {/* Sectie 2: Overige documenten */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <FileText className="w-5 h-5 text-purple-600 flex-shrink-0" />
          <h2 className="text-base font-semibold text-gray-900">{t('resources.otherFiles')}</h2>
          <span className="ml-auto text-xs text-gray-400 font-medium">
            {filteredOther.length === 1 ? t('resources.fileCountSingular', { count: '1' }) : t('resources.fileCountPlural', { count: String(filteredOther.length) })}
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-4 ml-7">
          {t('resources.otherFilesDesc')}
        </p>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-purple-600" />
          </div>
        ) : filteredOther.length === 0 ? (
          <EmptyState search={!!searchQuery} />
        ) : (
          <div className="space-y-2">{filteredOther.map(r => <ResourceRow key={r.id} resource={r} />)}</div>
        )}
      </section>
    </div>
  );
}
