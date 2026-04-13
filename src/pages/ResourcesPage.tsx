import { useState, useEffect } from 'react';
import { Download, Search, FolderOpen, FileText } from 'lucide-react';
import { Layout } from '../components/Layout';
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

export function ResourcesPage() {
  const [datasets, setDatasets] = useState<Resource[]>([]);
  const [documents, setDocuments] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'datasets' | 'docs'>('datasets');
  const [searchQuery, setSearchQuery] = useState('');
  const [ragFiles, setRagFiles] = useState([]);
  const { activeCourse } = useActiveCourse();


  useEffect(() => {
    loadResources();
  }, []);
  
    useEffect(() => {
    loadRagFiles();
  }, [activeCourse]);


  const loadResources = async () => {
    setLoading(true);
    try {
      const [datasetsData, docsData] = await Promise.all([
        fetchResources(STORAGE_CONFIG.buckets.DATASETS),
        fetchResources(STORAGE_CONFIG.buckets.DOCS_GENERAL),
      ]);

      setDatasets(datasetsData);
      setDocuments(docsData);
    } catch (error) {
      console.error('Error loading resources:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchResources = async (bucket: string): Promise<Resource[]> => {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select(`
          *,
          document_folders (
            name
          )
        `)
        .eq('bucket', bucket)
        .eq('processing_status', 'completed')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return (data || []).map(doc => ({
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
      }));
    } catch (error) {
      console.error(`Error fetching resources from ${bucket}:`, error);
      return [];
    }
  };

  const handleDownload = async (resource: Resource) => {
    try {
      const { data, error } = await supabase.storage
        .from(resource.bucket)
        .download(resource.file_path);

      if (error) {
        alert(`Fout bij downloaden: ${error.message}`);
        return;
      }

      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = resource.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(`Fout bij downloaden: ${error.message}`);
    }
  };

    const loadRagFiles = async () => {
    if (!activeCourse?.rag_folder_id) {
      setRagFiles([]);
      return;
    }

    const { data, error } = await supabase
      .from("documents")
      .select(`
        *,
        document_folders (
          name
        )
      `)
      .eq("folder_id", activeCourse.rag_folder_id)
      .eq("processing_status", "completed")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading RAG files:", error);
      setRagFiles([]);
      return;
    }

    setRagFiles(data || []);
  };


  const filterResources = (resources: Resource[]) => {
    if (!searchQuery.trim()) return resources;

    const query = searchQuery.toLowerCase();
    return resources.filter(
      r =>
        r.name.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query) ||
        r.folder_name?.toLowerCase().includes(query)
    );
  };

  const currentResources = activeTab === 'datasets' ? datasets : documents;
  const filteredResources = filterResources(currentResources);

  return (
      <div className="max-w-6xl mx-auto space-y-6">

                {/* 🟦 SECTIE: CURSUSINHOUD */}
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-xl font-semibold mb-3">Cursusinhoud</h2>

          {ragFiles.length === 0 ? (
            <p className="text-gray-500">Geen bestanden gevonden in de cursusinhoud.</p>
          ) : (
            <div className="space-y-2">
              {ragFiles.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center justify-between p-2 border rounded"
                >
                  <span>{file.name}</span>
<button
  onClick={() => handleDownload(file)}
  className="text-blue-600 hover:underline"
>
  Download
</button>

                </div>
              ))}
            </div>
          )}
        </section>

        <div>
          <h1 className="text-3xl font-bold text-gray-900">Bronnen & Datasets</h1>
          <p className="text-gray-600 mt-2">
            Download datasets en cursusmateriaal
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('datasets')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'datasets'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              📊 Datasets ({datasets.length})
            </button>
            <button
              onClick={() => setActiveTab('docs')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'docs'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              📄 Documenten ({documents.length})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Zoeken..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Laden...</p>
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="bg-gray-50 rounded-lg p-12 text-center">
            <FileText className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">
              {searchQuery ? 'Geen resultaten gevonden' : `Geen ${activeTab === 'datasets' ? 'datasets' : 'documenten'} beschikbaar`}
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredResources.map(resource => (
              <div
                key={resource.id}
                className="bg-white border border-gray-200 rounded-lg p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4 flex-1">
                    <span className="text-4xl">{getFileIcon(resource.file_type)}</span>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900">{resource.name}</h3>
                      {resource.description && (
                        <p className="text-sm text-gray-600 mt-1">{resource.description}</p>
                      )}
                      <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
                        {resource.folder_name && (
                          <span className="flex items-center gap-1">
                            <FolderOpen className="w-4 h-4" />
                            {resource.folder_name}
                          </span>
                        )}
                        <span>{formatFileSize(resource.file_size)}</span>
                        <span>{new Date(resource.created_at).toLocaleDateString('nl-NL')}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDownload(resource)}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
  );
}
