import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Users, FileUp, BookOpen, Settings, Search, Upload, File, Trash2, RefreshCw, CheckCircle, XCircle, Loader2, FolderTree, ClipboardCheck, Eye, Tag, Download, MessageSquareText, CreditCard as Edit2, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Database } from '../lib/database.types';
import { DocumentUploadModal } from '../components/DocumentUploadModal';
import { retryFailedDocument, UploadProgress } from '../services/document-upload.service';
import { ConceptReviewPanel } from '../components/ConceptReviewPanel';
import { QuizValidationPanel } from '../components/QuizValidationPanel';
import { RAGSetupPanel } from '../components/RAGSetupPanel';
import { ShareStatsImportPanel } from '../components/ShareStatsImportPanel';

import FileManager from '../pages/FileManager';

type Profile = Database['public']['Tables']['profiles']['Row'];
type Document = Database['public']['Tables']['documents']['Row'];
type Concept = Database['public']['Tables']['concepts']['Row'];

interface ChatbotPrompt {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

type TabType = 'users' | 'documents' | 'rag_beheer' | 'concepts' | 'concept_review' | 'quiz_validation' | 'sharestats_import' | 'prompts' | 'settings';

export function AdminPage() {
  const { profile, isAdmin, isDocent } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>(isAdmin ? 'users' : 'documents');
  const [users, setUsers] = useState<Profile[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [prompts, setPrompts] = useState<ChatbotPrompt[]>([]);
  const [editingPrompt, setEditingPrompt] = useState<ChatbotPrompt | null>(null);
  const [promptContent, setPromptContent] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFolderId, setUploadFolderId] = useState<string | null>(null);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [retryProgress, setRetryProgress] = useState<UploadProgress | null>(null);

  useEffect(() => {
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'documents') loadDocuments();
    if (activeTab === 'concepts') loadConcepts();
    if (activeTab === 'prompts') loadPrompts();
  }, [activeTab]);

  const loadUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading users:', error);
      return;
    }

    setUsers(data || []);
  };

  const loadDocuments = async () => {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading documents:', error);
      return;
    }

    setDocuments(data || []);
  };

  const loadConcepts = async () => {
    const { data, error } = await supabase
      .from('concepts')
      .select('*')
      .order('name');

    if (error) {
      console.error('Error loading concepts:', error);
      return;
    }

    setConcepts(data || []);
  };

  const loadPrompts = async () => {
    const { data, error } = await supabase
      .from('chatbot_prompts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading prompts:', error);
      return;
    }

    setPrompts(data || []);
  };

  const handleChangeUserRole = async (userId: string, newRole: 'student' | 'docent' | 'admin') => {
    if (!isAdmin) {
      alert('Alleen administrators kunnen rollen wijzigen');
      return;
    }

    const confirmChange = window.confirm(`Weet je zeker dat je de rol wilt wijzigen naar "${newRole}"?`);
    if (!confirmChange) return;

    setLoading(true);
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);

    if (error) {
      console.error('Error updating role:', error);
      alert('Er is een fout opgetreden bij het wijzigen van de rol');
    } else {
      alert('Rol succesvol gewijzigd');
      loadUsers();
    }

    setLoading(false);
  };

  const handleDeleteDocument = async (documentId: string, filePath: string) => {
    setLoading(true);

    try {
      const { data: doc, error: fetchError } = await supabase
        .from('documents')
        .select('bucket')
        .eq('id', documentId)
        .maybeSingle();

      if (fetchError) {
        console.error('Error fetching document:', fetchError);
        alert('Fout bij ophalen document gegevens.');
        return;
      }

      const { error: chunksError } = await supabase
        .from('document_chunks')
        .delete()
        .eq('document_id', documentId);

      if (chunksError) {
        console.error('Error deleting chunks:', chunksError);
        alert('Fout bij verwijderen document chunks.');
        return;
      }

      const { error: docError } = await supabase
        .from('documents')
        .delete()
        .eq('id', documentId);

      if (docError) {
        console.error('Error deleting document:', docError);
        alert('Fout bij verwijderen document record.');
        return;
      }

      const bucket = (doc?.bucket as string) || 'rag_sources';
      const { error: storageError } = await supabase.storage
        .from(bucket)
        .remove([filePath]);

      if (storageError) {
        console.error('Error deleting file:', storageError);
      }

      loadDocuments();
    } catch (error) {
      console.error('Delete error:', error);
      alert('Fout bij verwijderen: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleRetryDocument = async (documentId: string) => {
    setRetryingDocId(documentId);
    setRetryProgress(null);

    try {
      await retryFailedDocument(documentId, setRetryProgress);
      loadDocuments();
    } catch (error) {
      console.error('Retry failed:', error);
    } finally {
      setRetryingDocId(null);
      setRetryProgress(null);
    }
  };

  const handleAddConcept = async () => {
    const name = prompt('Naam van het begrip:');
    if (!name) return;

    const category = confirm('Is dit begrip uit epidemiologie? (Cancel voor biostatistiek)')
      ? 'epidemiologie'
      : 'biostatistiek';

    const definition = prompt('Definitie (optioneel):');

    const { error } = await supabase
      .from('concepts')
      .insert({ name, category, definition });

    if (error) {
      console.error('Error adding concept:', error);
      alert('Er is een fout opgetreden');
    } else {
      alert('Begrip toegevoegd');
      loadConcepts();
    }
  };

  const handleSavePrompt = async () => {
    if (!editingPrompt || !profile) return;

    setLoading(true);

    const { error } = await supabase
      .from('chatbot_prompts')
      .update({
        content: promptContent,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingPrompt.id);

    if (error) {
      console.error('Error updating prompt:', error);
      alert('Er is een fout opgetreden bij het opslaan');
    } else {
      alert('Prompt succesvol bijgewerkt');
      setEditingPrompt(null);
      setPromptContent('');
      loadPrompts();
    }

    setLoading(false);
  };

  const handleActivatePrompt = async (promptId: string) => {
    setLoading(true);

    await supabase
      .from('chatbot_prompts')
      .update({ is_active: false })
      .neq('id', promptId);

    const { error } = await supabase
      .from('chatbot_prompts')
      .update({ is_active: true })
      .eq('id', promptId);

    if (error) {
      console.error('Error activating prompt:', error);
      alert('Er is een fout opgetreden');
    } else {
      alert('Prompt geactiveerd');
      loadPrompts();
    }

    setLoading(false);
  };

  const filteredUsers = users.filter(user =>
    user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (user.full_name?.toLowerCase() || '').includes(searchTerm.toLowerCase())
  );

const tabs = [
  { id: 'users' as TabType, label: 'Gebruikers', icon: Users, show: isAdmin },
  { id: 'documents' as TabType, label: 'Documenten', icon: FolderTree, show: true },
  { id: 'rag_beheer' as TabType, label: 'RAG Beheer', icon: RefreshCw, show: true },
  { id: 'concepts' as TabType, label: 'Begrippen', icon: BookOpen, show: true },
  { id: 'concept_review' as TabType, label: 'Begrippen Review', icon: Eye, show: true },
  { id: 'quiz_validation' as TabType, label: 'Quiz Validatie', icon: ClipboardCheck, show: true },
  { id: 'sharestats_import' as TabType, label: 'ShareStats Import', icon: Download, show: true },
  { id: 'prompts' as TabType, label: 'Chatbot Prompts', icon: MessageSquareText, show: isAdmin },
  { id: 'settings' as TabType, label: 'Instellingen', icon: Settings, show: isAdmin },
].filter(tab => tab.show);


  if (!isDocent && !isAdmin) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <Settings className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Geen Toegang</h1>
          <p className="text-gray-600">
            Je hebt geen toegang tot het beheerderspaneel. Neem contact op met de administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Beheer Dashboard</h1>
          <p className="text-gray-600">
            {isAdmin ? 'Beheer gebruikers, documenten en systeeminstellingen' : 'Beheer documenten en cursusmateriaal'}
          </p>
          <div className="mt-4">
  <Link
    to="/admin/courses"
    className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
  >
    Cursussen beheren
  </Link>
</div>

        </div>
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Home className="w-5 h-5" />
          <span>Terug naar Dashboard</span>
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-visible">
        <div className="border-b border-gray-200">
          <div className="flex overflow-x-auto">
            {tabs.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-6 py-4 font-medium transition-all whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-6">
          {activeTab === 'users' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Zoek gebruikers op naam of email..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Naam</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Email</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Rol</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Acties</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map(user => (
                      <tr key={user.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-3 px-4">{user.full_name || '-'}</td>
                        <td className="py-3 px-4">{user.email}</td>
                        <td className="py-3 px-4">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                            user.role === 'admin'
                              ? 'bg-red-100 text-red-700'
                              : user.role === 'docent'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {isAdmin && user.id !== profile?.id && (
                            <div className="flex gap-2">
                              {user.role !== 'docent' && (
                                <button
                                  onClick={() => handleChangeUserRole(user.id, 'docent')}
                                  disabled={loading}
                                  className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-100 rounded-lg hover:bg-blue-200 transition-colors disabled:opacity-50"
                                >
                                  → Docent
                                </button>
                              )}
                              {user.role !== 'student' && (
                                <button
                                  onClick={() => handleChangeUserRole(user.id, 'student')}
                                  disabled={loading}
                                  className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded-lg hover:bg-green-200 transition-colors disabled:opacity-50"
                                >
                                  → Student
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

{activeTab === 'documents' && (
  <div>
    <FileManager />
  </div>
)}

{activeTab === 'rag_beheer' && (
  <div className="space-y-4">
    <RAGSetupPanel />
  </div>
)}


          {activeTab === 'concepts' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-gray-600">Beheer begrippen voor de "Ik Leg Uit" module</p>
                <button
                  onClick={handleAddConcept}
                  className="px-4 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg flex items-center gap-2"
                >
                  <BookOpen className="w-4 h-4" />
                  Handmatig Begrip Toevoegen
                </button>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <p className="text-sm text-gray-700">
                  💡 <strong>Tip:</strong> Ga naar de "Begrippen Review" tab om begrippen automatisch te extracteren uit geüploade documenten.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {concepts.length === 0 && (
                  <div className="col-span-2 text-center py-12 text-gray-500">
                    <BookOpen className="w-12 h-12 mx-auto mb-3 text-gray-400" />
                    <p>Nog geen begrippen toegevoegd</p>
                  </div>
                )}
                {concepts.map(concept => (
                  <div key={concept.id} className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-gray-900">{concept.name}</h3>
                      <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-semibold">
                        {concept.category}
                      </span>
                    </div>
                    {concept.definition && (
                      <p className="text-sm text-gray-600 line-clamp-2">{concept.definition}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'concept_review' && <ConceptReviewPanel />}

          {activeTab === 'quiz_validation' && <QuizValidationPanel />}

          {activeTab === 'sharestats_import' && <ShareStatsImportPanel />}

          {activeTab === 'prompts' && (
            <div className="space-y-4">
              <p className="text-gray-600">Beheer de systeem prompts voor de chatbot</p>

              {editingPrompt ? (
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-bold text-gray-900 mb-4">
                    Bewerk Prompt: {editingPrompt.name}
                  </h3>
                  <textarea
                    value={promptContent}
                    onChange={(e) => setPromptContent(e.target.value)}
                    rows={12}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none font-mono text-sm"
                    placeholder="Voer de systeem prompt in..."
                  />
                  <div className="flex gap-3 mt-4">
                    <button
                      onClick={handleSavePrompt}
                      disabled={loading}
                      className="px-6 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg disabled:opacity-50"
                    >
                      {loading ? 'Opslaan...' : 'Opslaan'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingPrompt(null);
                        setPromptContent('');
                      }}
                      className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all"
                    >
                      Annuleren
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {prompts.map((prompt) => (
                    <div
                      key={prompt.id}
                      className={`p-4 border rounded-lg ${
                        prompt.is_active
                          ? 'border-green-300 bg-green-50'
                          : 'border-gray-200 bg-white hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-semibold text-gray-900">{prompt.name}</h3>
                            {prompt.is_active && (
                              <span className="px-2 py-1 text-xs font-semibold bg-green-600 text-white rounded-full">
                                Actief
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-600 line-clamp-2">{prompt.content}</p>
                        </div>
                        <div className="flex gap-2 ml-4">
                          <button
                            onClick={() => {
                              setEditingPrompt(prompt);
                              setPromptContent(prompt.content);
                            }}
                            className="p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Bewerken"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {!prompt.is_active && (
                            <button
                              onClick={() => handleActivatePrompt(prompt.id)}
                              disabled={loading}
                              className="p-2 text-gray-600 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
                              title="Activeren"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-4">
              <p className="text-gray-600">Systeeminstellingen en configuratie</p>
              <div className="space-y-4">
                <div className="p-4 border border-gray-200 rounded-lg">
                  <h3 className="font-semibold text-gray-900 mb-2">API Configuratie</h3>
                  <p className="text-sm text-gray-600">
                    Voeg je API keys toe als Replit Secrets:<br />
                    - GROQ_API_KEY voor LLM functionaliteit<br />
                    - OPENAI_API_KEY voor embeddings/RAG<br />
                    - HUGGINGFACE_API_KEY voor alternatieve embeddings<br />
                    - GITHUB_TOKEN voor hogere GitHub API limieten
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showUploadModal && (
        <DocumentUploadModal
          onClose={() => {
            setShowUploadModal(false);
            setUploadFolderId(null);
          }}
          onSuccess={() => {
            loadDocuments();
            setShowUploadModal(false);
            setUploadFolderId(null);
          }}
          folderId={uploadFolderId}
        />
      )}
    </div>
  );
}
