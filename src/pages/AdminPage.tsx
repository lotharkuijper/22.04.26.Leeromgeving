import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Users, FileUp, BookOpen, Settings, Search, Upload, File, Trash2, RefreshCw, CheckCircle, XCircle, Loader2, FolderTree, ClipboardCheck, Eye, Tag, Download, MessageSquareText, CreditCard as Edit2, Home, Plus, Globe, GraduationCap } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Database } from '../lib/database.types';
import { DocumentUploadModal } from '../components/DocumentUploadModal';
import { retryFailedDocument, UploadProgress } from '../services/document-upload.service';
import { QuizValidationPanel } from '../components/QuizValidationPanel';
import { RAGSetupPanel } from '../components/RAGSetupPanel';
import { ShareStatsImportPanel } from '../components/ShareStatsImportPanel';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

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

type TabType = 'users' | 'documents' | 'rag_beheer' | 'concepts' | 'quiz_validation' | 'sharestats_import' | 'prompts' | 'settings';

type ConceptCategory = 'epidemiologie' | 'biostatistiek';
type UserRole = 'student' | 'docent' | 'admin';

interface ConceptCardProps {
  concept: Concept;
  sourceLabel: string;
  sourceBg: string;
  deleteConfirmId: string | null;
  deletingConceptId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
}

function ConceptCard({ concept, sourceLabel, sourceBg, deleteConfirmId, deletingConceptId, onDeleteRequest, onDeleteConfirm, onDeleteCancel }: ConceptCardProps) {
  return (
    <div className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50" data-testid={`card-concept-${concept.id}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-gray-900">{concept.name}</h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">
            {concept.category}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sourceBg}`}>
            {sourceLabel}
          </span>
        </div>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          {deleteConfirmId === concept.id ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-red-600">Verwijderen?</span>
              <button
                onClick={() => onDeleteConfirm(concept.id)}
                disabled={deletingConceptId === concept.id}
                className="px-2 py-0.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                data-testid={`button-confirm-delete-${concept.id}`}
              >
                {deletingConceptId === concept.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Ja'}
              </button>
              <button
                onClick={onDeleteCancel}
                className="px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
              >
                Nee
              </button>
            </div>
          ) : (
            <button
              onClick={() => onDeleteRequest(concept.id)}
              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Verwijderen"
              data-testid={`button-delete-${concept.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {concept.definition && (
        <p className="text-sm text-gray-600 line-clamp-2">{concept.definition}</p>
      )}
    </div>
  );
}

export function AdminPage() {
  const { profile, isAdmin, isDocent, session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>(isAdmin ? 'users' : 'documents');
  const [users, setUsers] = useState<Profile[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [courseConcepts, setCourseConcepts] = useState<Concept[]>([]);
  const [globalConcepts, setGlobalConcepts] = useState<Concept[]>([]);
  const [prompts, setPrompts] = useState<ChatbotPrompt[]>([]);
  const [deletingConceptId, setDeletingConceptId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addConceptForm, setAddConceptForm] = useState(false);
  const [addConceptName, setAddConceptName] = useState('');
  const [addConceptCategory, setAddConceptCategory] = useState<ConceptCategory>('epidemiologie');
  const [addConceptDefinition, setAddConceptDefinition] = useState('');
  const [addConceptLoading, setAddConceptLoading] = useState(false);
  const [addConceptError, setAddConceptError] = useState<string | null>(null);
  const [addConceptSuccess, setAddConceptSuccess] = useState(false);
  const [roleMsg, setRoleMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<{ userId: string; newRole: UserRole } | null>(null);
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const [promptMsg, setPromptMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
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
    if (!session?.access_token) return;
    try {
      const res = await fetch('/api/concepts', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        console.error('Error loading concepts:', await res.text());
        return;
      }
      const data = await res.json();
      const all: Concept[] = data.concepts || [];
      const isGlobalSeed = (c: Concept) =>
        !c.course_id && !(c.key_points || []).some(kp => kp.startsWith('course_id:'));
      if (activeCourseId) {
        const courseMarker = `course_id:${activeCourseId}`;
        const course = all.filter(
          c => c.course_id === activeCourseId || (c.key_points || []).includes(courseMarker)
        );
        const global = all.filter(isGlobalSeed);
        setCourseConcepts(course);
        setGlobalConcepts(global);
      } else {
        setCourseConcepts([]);
        setGlobalConcepts(all.filter(isGlobalSeed));
      }
    } catch (err) {
      console.error('Error loading concepts:', err);
    }
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

  const handleChangeUserRole = async (userId: string, newRole: UserRole) => {
    if (!isAdmin) return;
    setRoleConfirm({ userId, newRole });
  };

  const confirmRoleChange = async () => {
    if (!roleConfirm) return;
    const { userId, newRole } = roleConfirm;
    setRoleConfirm(null);
    setRoleMsg(null);
    setLoading(true);
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);

    if (error) {
      console.error('Error updating role:', error);
      setRoleMsg({ type: 'error', text: 'Fout bij wijzigen van rol: ' + error.message });
    } else {
      setRoleMsg({ type: 'success', text: 'Rol succesvol gewijzigd.' });
      loadUsers();
    }
    setLoading(false);
  };

  const handleDeleteDocument = async (documentId: string, filePath: string) => {
    setLoading(true);
    setDocMsg(null);

    try {
      const { data: doc, error: fetchError } = await supabase
        .from('documents')
        .select('bucket')
        .eq('id', documentId)
        .maybeSingle();

      if (fetchError) {
        console.error('Error fetching document:', fetchError);
        setDocMsg('Fout bij ophalen document gegevens: ' + fetchError.message);
        return;
      }

      const { error: chunksError } = await supabase
        .from('document_chunks')
        .delete()
        .eq('document_id', documentId);

      if (chunksError) {
        console.error('Error deleting chunks:', chunksError);
        setDocMsg('Fout bij verwijderen document chunks: ' + chunksError.message);
        return;
      }

      const { error: docError } = await supabase
        .from('documents')
        .delete()
        .eq('id', documentId);

      if (docError) {
        console.error('Error deleting document:', docError);
        setDocMsg('Fout bij verwijderen document record: ' + docError.message);
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
      setDocMsg('Fout bij verwijderen: ' + (error as Error).message);
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
    if (!addConceptName.trim()) {
      setAddConceptError('Naam is verplicht');
      return;
    }
    setAddConceptLoading(true);
    setAddConceptError(null);
    setAddConceptSuccess(false);

    type ConceptInsert = Database['public']['Tables']['concepts']['Insert'];
    const insertData: ConceptInsert = {
      name: addConceptName.trim(),
      category: addConceptCategory,
      definition: addConceptDefinition.trim() || null,
      key_points: activeCourseId ? [`course_id:${activeCourseId}`] : [],
    };

    const { error } = await supabase
      .from('concepts')
      .insert(insertData);

    if (error) {
      console.error('Error adding concept:', error);
      setAddConceptError('Fout bij toevoegen: ' + error.message);
    } else {
      setAddConceptSuccess(true);
      setAddConceptName('');
      setAddConceptDefinition('');
      setAddConceptCategory('epidemiologie');
      await loadConcepts();
      setTimeout(() => setAddConceptSuccess(false), 3000);
    }
    setAddConceptLoading(false);
  };

  const handleDeleteConcept = async (conceptId: string) => {
    if (!session?.access_token) return;
    setDeletingConceptId(conceptId);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/concepts/${conceptId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Fout ${res.status}`);
      }
      setDeleteConfirmId(null);
      await loadConcepts();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Onbekende fout');
    } finally {
      setDeletingConceptId(null);
    }
  };

  const handleSavePrompt = async () => {
    if (!editingPrompt || !profile) return;
    setLoading(true);
    setPromptMsg(null);

    const { error } = await supabase
      .from('chatbot_prompts')
      .update({
        content: promptContent,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingPrompt.id);

    if (error) {
      console.error('Error updating prompt:', error);
      setPromptMsg({ type: 'error', text: 'Fout bij opslaan: ' + error.message });
    } else {
      setPromptMsg({ type: 'success', text: 'Prompt succesvol bijgewerkt.' });
      setEditingPrompt(null);
      setPromptContent('');
      loadPrompts();
    }
    setLoading(false);
  };

  const handleActivatePrompt = async (promptId: string) => {
    setLoading(true);
    setPromptMsg(null);

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
      setPromptMsg({ type: 'error', text: 'Fout bij activeren: ' + error.message });
    } else {
      setPromptMsg({ type: 'success', text: 'Prompt geactiveerd.' });
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
              {roleMsg && (
                <div className={`rounded-lg px-4 py-2 text-sm ${roleMsg.type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
                  {roleMsg.text}
                </div>
              )}
              {roleConfirm && (
                <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm">
                  <span className="text-amber-800">Rol wijzigen naar <strong>{roleConfirm.newRole}</strong>?</span>
                  <button onClick={confirmRoleChange} className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs font-medium">Bevestigen</button>
                  <button onClick={() => setRoleConfirm(null)} className="px-3 py-1 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-xs font-medium">Annuleren</button>
                </div>
              )}
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
                <div>
                  <p className="text-gray-600">Beheer begrippen voor de "Ik Leg Uit" module</p>
                  {activeCourse && (
                    <p className="text-sm text-blue-600 mt-1 flex items-center gap-1">
                      <GraduationCap className="w-4 h-4" />
                      Actieve cursus: <strong>{activeCourse.name}</strong>
                      {courseConcepts.length === 0 && <span className="text-amber-600 ml-1">(nog geen cursus-begrippen)</span>}
                    </p>
                  )}
                  {!activeCourse && (
                    <p className="text-sm text-gray-500 mt-1 flex items-center gap-1">
                      <Globe className="w-4 h-4" />
                      Alle begrippen (geen actieve cursus)
                    </p>
                  )}
                </div>
                <button
                  onClick={() => { setAddConceptForm(v => !v); setAddConceptError(null); setAddConceptSuccess(false); }}
                  className="px-4 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg flex items-center gap-2"
                  data-testid="button-toggle-add-concept"
                >
                  <Plus className="w-4 h-4" />
                  Begrip toevoegen
                </button>
              </div>

              {addConceptForm && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
                  <h3 className="font-semibold text-gray-900">Nieuw begrip toevoegen</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Naam *</label>
                      <input
                        type="text"
                        value={addConceptName}
                        onChange={e => setAddConceptName(e.target.value)}
                        placeholder="Bijv. Relatief risico"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        data-testid="input-concept-name"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Categorie</label>
                      <select
                        value={addConceptCategory}
                        onChange={e => setAddConceptCategory(e.target.value as 'epidemiologie' | 'biostatistiek')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        data-testid="select-concept-category"
                      >
                        <option value="epidemiologie">Epidemiologie</option>
                        <option value="biostatistiek">Biostatistiek</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Definitie (optioneel)</label>
                    <textarea
                      value={addConceptDefinition}
                      onChange={e => setAddConceptDefinition(e.target.value)}
                      placeholder="Korte definitie van het begrip..."
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                      data-testid="input-concept-definition"
                    />
                  </div>
                  {addConceptError && (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{addConceptError}</p>
                  )}
                  {addConceptSuccess && (
                    <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">Begrip succesvol toegevoegd.</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddConcept}
                      disabled={addConceptLoading}
                      className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-all disabled:opacity-50 text-sm"
                      data-testid="button-save-concept"
                    >
                      {addConceptLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Opslaan'}
                    </button>
                    <button
                      onClick={() => { setAddConceptForm(false); setAddConceptError(null); }}
                      className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all text-sm"
                    >
                      Annuleren
                    </button>
                  </div>
                </div>
              )}

              {deleteError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{deleteError}</p>
              )}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-gray-700">
                  <strong>Tip:</strong> Gebruik de "RAG Beheer" tab om begrippen automatisch te extracteren uit cursusmateriaal.
                </p>
              </div>

              {activeCourse && (
                <div>
                  <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <GraduationCap className="w-4 h-4 text-purple-600" />
                    Cursus: {activeCourse.name}
                    <span className="text-sm font-normal text-gray-500">({courseConcepts.length})</span>
                  </h3>
                  {courseConcepts.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 border border-dashed border-gray-200 rounded-lg">
                      <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                      <p className="text-sm">Geen cursus-begrippen — gebruik RAG Beheer om te extracteren.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {courseConcepts.map(concept => {
                        const isRagExtracted = (concept.key_points || []).includes('[RAG-geëxtraheerd uit cursusmateriaal]');
                        const sourceLabel = isRagExtracted ? 'Cursus — AI' : 'Cursus';
                        const sourceBg = isRagExtracted ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700';
                        return (
                          <ConceptCard
                            key={concept.id}
                            concept={concept}
                            sourceLabel={sourceLabel}
                            sourceBg={sourceBg}
                            deleteConfirmId={deleteConfirmId}
                            deletingConceptId={deletingConceptId}
                            onDeleteRequest={(id) => { setDeleteConfirmId(id); setDeleteError(null); }}
                            onDeleteConfirm={handleDeleteConcept}
                            onDeleteCancel={() => setDeleteConfirmId(null)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div>
                <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <Globe className="w-4 h-4 text-gray-500" />
                  Globale seeds
                  <span className="text-sm font-normal text-gray-500">({globalConcepts.length})</span>
                </h3>
                {globalConcepts.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 border border-dashed border-gray-200 rounded-lg">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">Nog geen globale begrippen toegevoegd.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {globalConcepts.map(concept => (
                      <ConceptCard
                        key={concept.id}
                        concept={concept}
                        sourceLabel="Globaal"
                        sourceBg="bg-gray-100 text-gray-600"
                        deleteConfirmId={deleteConfirmId}
                        deletingConceptId={deletingConceptId}
                        onDeleteRequest={(id) => { setDeleteConfirmId(id); setDeleteError(null); }}
                        onDeleteConfirm={handleDeleteConcept}
                        onDeleteCancel={() => setDeleteConfirmId(null)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'quiz_validation' && <QuizValidationPanel />}

          {activeTab === 'sharestats_import' && <ShareStatsImportPanel />}

          {activeTab === 'prompts' && (
            <div className="space-y-4">
              <p className="text-gray-600">Beheer de systeem prompts voor de chatbot</p>

              {promptMsg && (
                <div className={`rounded-lg px-4 py-2 text-sm ${promptMsg.type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
                  {promptMsg.text}
                </div>
              )}

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
