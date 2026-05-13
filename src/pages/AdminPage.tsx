import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Users, FileUp, BookOpen, Settings, Search, Upload, File, Trash2, RefreshCw, CheckCircle, XCircle, Loader2, FolderTree, ClipboardCheck, Eye, Tag, Download, MessageSquareText, CreditCard as Edit2, Home, Plus, Globe, GraduationCap, SlidersHorizontal, Save, ChevronDown, Sparkles, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Database } from '../lib/database.types';
import { DocumentUploadModal } from '../components/DocumentUploadModal';
import { retryFailedDocument, UploadProgress } from '../services/document-upload.service';
import { QuizValidationPanel } from '../components/QuizValidationPanel';
import { RAGSetupPanel } from '../components/RAGSetupPanel';
import { ShareStatsImportPanel } from '../components/ShareStatsImportPanel';
import { QuizSourcesAdminPanel } from '../components/QuizSourcesAdminPanel';
import { PersonaLibraryTab } from './admin/PersonaLibraryTab';
import { ProjectsAdminTab } from './admin/ProjectsAdminTab';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

import DocumentsPage from '../pages/DocumentsPage';

type Profile = Database['public']['Tables']['profiles']['Row'];
type Document = Database['public']['Tables']['documents']['Row'];
type Concept = Database['public']['Tables']['concepts']['Row'];

interface ChatbotPrompt {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  section?: 'chat' | 'explain' | 'project';
  created_at: string;
  updated_at: string;
}

type TabType = 'users' | 'documents' | 'rag_beheer' | 'concepts' | 'quiz_validation' | 'sharestats_import' | 'quiz_sources' | 'prompts' | 'rag_settings' | 'settings' | 'personas' | 'projects_admin';

interface RagModuleSettings {
  similarity_threshold: number;
  match_count: number;
  rag_strict_mode: boolean;
  query_expansion_enabled: boolean;
}

interface RagExtractionSettings {
  similarity_threshold: number;
  min_evidence_chunks: number;
}

interface RagSettingsConfig {
  chat: RagModuleSettings;
  explain: RagModuleSettings;
  quiz: RagModuleSettings;
  project: RagModuleSettings;
  extraction: RagExtractionSettings;
}

const RAG_ADMIN_DEFAULTS: RagSettingsConfig = {
  chat:    { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: false, query_expansion_enabled: false },
  explain: { similarity_threshold: 0.50, match_count: 5, rag_strict_mode: true,  query_expansion_enabled: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true,  query_expansion_enabled: false },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false, query_expansion_enabled: false },
  extraction: { similarity_threshold: 0.55, min_evidence_chunks: 1 },
};

interface RagDiagnosticChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  similarity: number;
  contentPreview: string;
}

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
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  lang: string;
}

function ConceptCard({ concept, sourceLabel, sourceBg, deleteConfirmId, deletingConceptId, onDeleteRequest, onDeleteConfirm, onDeleteCancel, isSelected, onToggleSelect, lang }: ConceptCardProps) {
  return (
    <div
      className={`p-4 border rounded-lg transition-colors ${isSelected ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}
      data-testid={`card-concept-${concept.id}`}
    >
      <div className="flex items-start gap-3">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!isSelected}
            onChange={() => onToggleSelect(concept.id)}
            className="mt-1 w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer flex-shrink-0 accent-blue-600"
            data-testid={`checkbox-concept-${concept.id}`}
          />
        )}
        <div className="flex-1 min-w-0">
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
                  <span className="text-xs text-red-600">{lang === 'en' ? 'Delete?' : 'Verwijderen?'}</span>
                  <button
                    onClick={() => onDeleteConfirm(concept.id)}
                    disabled={deletingConceptId === concept.id}
                    className="px-2 py-0.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                    data-testid={`button-confirm-delete-${concept.id}`}
                  >
                    {deletingConceptId === concept.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : (lang === 'en' ? 'Yes' : 'Ja')}
                  </button>
                  <button
                    onClick={onDeleteCancel}
                    className="px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                  >
                    {lang === 'en' ? 'No' : 'Nee'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onDeleteRequest(concept.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title={lang === 'en' ? 'Delete' : 'Verwijderen'}
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
      </div>
    </div>
  );
}

export function AdminPage() {
  const { t, lang } = useLanguage();
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
  const [regeneratingConcepts, setRegeneratingConcepts] = useState(false);
  const [regenerateResult, setRegenerateResult] = useState<{ count: number; skipped: number; message: string } | null>(null);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [selectedConceptIds, setSelectedConceptIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [conceptsMeta, setConceptsMeta] = useState<{ ragCount: number; manualCount: number; lastExtraction: string | null; lastDocumentChange: string | null; lastSuccessfulRegeneration: string | null } | null>(null);
  const [roleMsg, setRoleMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<{ userId: string; newRole: UserRole } | null>(null);
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const [promptMsg, setPromptMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<ChatbotPrompt | null>(null);
  const [promptContent, setPromptContent] = useState('');
  const [editingPromptName, setEditingPromptName] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectContent, setNewProjectContent] = useState('');
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);
  const [confirmDeletePromptId, setConfirmDeletePromptId] = useState<string | null>(null);
  const [promptsMigration, setPromptsMigration] = useState<{ hasSection: boolean; sqlToRun: string | null } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFolderId, setUploadFolderId] = useState<string | null>(null);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [retryProgress, setRetryProgress] = useState<UploadProgress | null>(null);
  const [ragSettingsState, setRagSettingsState] = useState<RagSettingsConfig>(RAG_ADMIN_DEFAULTS);
  const [ragSettingsSaving, setRagSettingsSaving] = useState(false);
  const [ragSettingsMsg, setRagSettingsMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [ragSelectedCourseId, setRagSelectedCourseId] = useState<string | null>(null);
  const [allCourses, setAllCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [coursesWithOverrides, setCoursesWithOverrides] = useState<Set<string>>(new Set());
  const [ragDeletingOverride, setRagDeletingOverride] = useState(false);
  const [diagnosticQuery, setDiagnosticQuery] = useState('');
  const [diagnosticExpand, setDiagnosticExpand] = useState(false);
  const [diagnosticDefinition, setDiagnosticDefinition] = useState('');
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<{
    query: string;
    embedQuery?: string;
    expanded?: boolean;
    chunks: RagDiagnosticChunk[];
    maxScore: number;
    candidatesInAllowedFolders?: number;
  } | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [autoBackfillStatus, setAutoBackfillStatus] = useState<{
    ok: boolean;
    total?: number;
    linked?: number;
    skipped?: number;
    failed?: number;
    errors?: string[];
    error?: string;
    ranAt?: string;
    trigger?: string;
  } | null>(null);
  const BACKFILL_DISMISS_KEY = 'backfill_banner_dismissed_ranAt';
  const [autoBackfillBannerDismissed, setAutoBackfillBannerDismissed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const { data: { session: s } } = await supabase.auth.getSession();
        if (!s?.access_token) return;
        const r = await fetch('/api/admin/backfill-project-doc-folder-links/status', {
          headers: { Authorization: `Bearer ${s.access_token}` },
        });
        if (r.ok) {
          const d = await r.json();
          const status = d.status;
          setAutoBackfillStatus(status);
          if ((status?.failed ?? 0) === 0) {
            localStorage.removeItem(BACKFILL_DISMISS_KEY);
            setAutoBackfillBannerDismissed(false);
          } else {
            const storedRanAt = localStorage.getItem(BACKFILL_DISMISS_KEY);
            if (storedRanAt && storedRanAt === status?.ranAt) {
              setAutoBackfillBannerDismissed(true);
            } else {
              setAutoBackfillBannerDismissed(false);
            }
          }
        }
      } catch {}
    })();
  }, [isAdmin]);

  useEffect(() => {
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'documents') loadDocuments();
    if (activeTab === 'concepts') { loadConcepts(); loadConceptsMeta(); }
    if (activeTab === 'rag_beheer') { loadConceptsMeta(); }
    if (activeTab === 'prompts') {
      loadPrompts();
      (async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session?.access_token) return;
          const r = await fetch('/api/admin/prompts-migration-status', {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (r.ok) {
            const data = await r.json();
            setPromptsMigration(data);
          }
        } catch {}
      })();
    }
  }, [activeTab, activeCourseId]);

  useEffect(() => {
    if (activeTab === 'rag_settings') {
      loadAllCourses();
      loadCoursesWithOverrides();
      loadRagSettingsAdmin();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'rag_settings') loadRagSettingsAdmin();
  }, [ragSelectedCourseId]);

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

  const loadConceptsMeta = async () => {
    if (!session?.access_token || !activeCourseId) {
      setConceptsMeta(null);
      return;
    }
    try {
      const res = await fetch(`/api/admin/concepts-meta?courseId=${activeCourseId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        console.error('Error loading concepts meta:', await res.text());
        setConceptsMeta(null);
        return;
      }
      const data = await res.json();
      setConceptsMeta(data);
    } catch (err) {
      console.error('Error loading concepts meta:', err);
      setConceptsMeta(null);
    }
  };

  const loadPrompts = async () => {
    const { data, error } = await supabase
      .from('chatbot_prompts')
      .select('*')
      .not('name', 'like', '__rag_settings%')
      .not('name', 'like', '__doc_mutation_%')
      .not('name', 'like', '__concepts_regen_%')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading prompts:', error);
      return;
    }

    setPrompts(data || []);
  };

  const loadAllCourses = async () => {
    try {
      const { data } = await supabase.from('courses').select('id, name').order('name');
      setAllCourses(data || []);
    } catch (err) {
      console.warn('[admin] Cursussen laden mislukt');
    }
  };

  const loadCoursesWithOverrides = async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch('/api/rag-settings/overrides', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCoursesWithOverrides(new Set(data.courseIds || []));
      }
    } catch (err) {
      console.warn('[admin] RAG overrides laden mislukt');
    }
  };

  const loadRagSettingsAdmin = async () => {
    try {
      const url = ragSelectedCourseId ? `/api/rag-settings?courseId=${ragSelectedCourseId}` : '/api/rag-settings';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setRagSettingsState(data);
      }
    } catch (err) {
      console.warn('[admin] RAG settings laden mislukt');
    }
  };

  const saveRagSettingsAdmin = async () => {
    if (!session?.access_token) return;
    setRagSettingsSaving(true);
    setRagSettingsMsg(null);
    try {
      const res = await fetch('/api/rag-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ courseId: ragSelectedCourseId || undefined, settings: ragSettingsState }),
      });
      const data = await res.json();
      if (res.ok) {
        setRagSettingsMsg({ type: 'success', text: 'RAG instellingen opgeslagen.' });
        if (ragSelectedCourseId) {
          setCoursesWithOverrides(prev => new Set([...prev, ragSelectedCourseId]));
        }
      } else {
        setRagSettingsMsg({ type: 'error', text: data.error || (lang === 'en' ? 'Save failed.' : 'Opslaan mislukt.') });
      }
    } catch (err: any) {
      setRagSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setRagSettingsSaving(false);
    }
  };

  const deleteRagOverride = async (courseId: string) => {
    if (!session?.access_token) return;
    setRagDeletingOverride(true);
    setRagSettingsMsg(null);
    try {
      const res = await fetch(`/api/rag-settings/${encodeURIComponent(courseId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (res.ok) {
        setCoursesWithOverrides(prev => { const next = new Set(prev); next.delete(courseId); return next; });
        setRagSettingsMsg({ type: 'success', text: 'Cursus-override verwijderd. Globale standaard wordt nu gebruikt.' });
        loadRagSettingsAdmin();
      } else {
        setRagSettingsMsg({ type: 'error', text: data.error || (lang === 'en' ? 'Delete failed.' : 'Verwijderen mislukt.') });
      }
    } catch (err: any) {
      setRagSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setRagDeletingOverride(false);
    }
  };

  const updateRagModule = (mod: 'chat' | 'explain' | 'quiz' | 'project', field: keyof RagModuleSettings, value: number | boolean) => {
    setRagSettingsState(prev => ({
      ...prev,
      [mod]: { ...prev[mod], [field]: value },
    }));
  };

  const updateRagExtraction = (field: keyof RagExtractionSettings, value: number) => {
    setRagSettingsState(prev => ({
      ...prev,
      extraction: { ...prev.extraction, [field]: value },
    }));
  };

  const runDiagnostic = async () => {
    if (!session?.access_token || !diagnosticQuery.trim()) return;
    setDiagnosticLoading(true);
    setDiagnosticError(null);
    setDiagnosticResult(null);
    try {
      const res = await fetch('/api/admin/test-rag-similarity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          courseId: ragSelectedCourseId || undefined,
          query: diagnosticQuery.trim(),
          expand: diagnosticExpand,
          definition: diagnosticExpand && diagnosticDefinition.trim() ? diagnosticDefinition.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDiagnosticError(data.error || `Serverfout ${res.status}`);
      } else {
        setDiagnosticResult(data);
      }
    } catch (err: any) {
      setDiagnosticError(err.message || (lang === 'en' ? 'Unknown error' : 'Onbekende fout'));
    } finally {
      setDiagnosticLoading(false);
    }
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
      setRoleMsg({ type: 'error', text: (lang === 'en' ? 'Error changing role: ' : 'Fout bij wijzigen van rol: ') + error.message });
    } else {
      setRoleMsg({ type: 'success', text: 'Rol succesvol gewijzigd.' });
      loadUsers();
    }
    setLoading(false);
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
      setAddConceptError((lang === 'en' ? 'Error adding: ' : 'Fout bij toevoegen: ') + error.message);
    } else {
      setAddConceptSuccess(true);
      setAddConceptName('');
      setAddConceptDefinition('');
      setAddConceptCategory('epidemiologie');
      await loadConcepts();
      await loadConceptsMeta();
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
        throw new Error(data.error || (lang === 'en' ? `Error ${res.status}` : `Fout ${res.status}`));
      }
      setDeleteConfirmId(null);
      await loadConcepts();
      await loadConceptsMeta();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : (lang === 'en' ? 'Unknown error' : 'Onbekende fout'));
    } finally {
      setDeletingConceptId(null);
    }
  };

  const handleRegenerateConcepts = async () => {
    if (!activeCourseId || !session?.access_token) return;
    setRegeneratingConcepts(true);
    setRegenerateResult(null);
    setRegenerateError(null);
    try {
      const response = await fetch('/api/admin/extract-concepts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ courseId: activeCourseId, replace: true }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Serverfout ${response.status}`);
      }
      setRegenerateResult({
        count: (data.concepts?.length ?? 0) + (data.updated ?? 0),
        skipped: data.skipped ?? 0,
        message: data.message || '',
      });
      await loadConcepts();
      await loadConceptsMeta();
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : (lang === 'en' ? 'Unknown error' : 'Onbekende fout'));
    } finally {
      setRegeneratingConcepts(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!bulkDeleteConfirm) {
      setBulkDeleteConfirm(true);
      return;
    }
    if (!session?.access_token || selectedConceptIds.size === 0) return;
    setBulkDeleting(true);
    setBulkDeleteError(null);
    setBulkDeleteConfirm(false);
    const ids = Array.from(selectedConceptIds);
    const results = await Promise.allSettled(
      ids.map(id =>
        fetch(`/api/admin/concepts/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
      )
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      setBulkDeleteError(`${failed} van de ${ids.length} begrippen konden niet worden verwijderd.`);
    }
    setSelectedConceptIds(new Set());
    setBulkDeleting(false);
    await loadConcepts();
    await loadConceptsMeta();
  };

  const handleSavePrompt = async () => {
    if (!editingPrompt || !profile) return;
    setLoading(true);
    setPromptMsg(null);

    const updateFields: Record<string, string> = {
      content: promptContent,
      updated_at: new Date().toISOString(),
    };
    if (editingPrompt.section === 'project' && editingPromptName.trim()) {
      updateFields.name = editingPromptName.trim();
    }

    const { error } = await supabase
      .from('chatbot_prompts')
      .update(updateFields)
      .eq('id', editingPrompt.id);

    if (error) {
      console.error('Error updating prompt:', error);
      setPromptMsg({ type: 'error', text: (lang === 'en' ? 'Error saving: ' : 'Fout bij opslaan: ') + error.message });
    } else {
      setPromptMsg({ type: 'success', text: 'Prompt succesvol bijgewerkt.' });
      setEditingPrompt(null);
      setPromptContent('');
      setEditingPromptName('');
      loadPrompts();
    }
    setLoading(false);
  };

  const handleCreateProjectPrompt = async () => {
    if (!newProjectName.trim()) return;
    setLoading(true);
    setPromptMsg(null);
    const { error } = await supabase
      .from('chatbot_prompts')
      .insert({
        name: newProjectName.trim(),
        content: newProjectContent.trim() || 'Beschrijf hier de rol van deze agent...',
        is_active: false,
        section: 'project',
      });
    if (error) {
      setPromptMsg({ type: 'error', text: (lang === 'en' ? 'Error creating: ' : 'Fout bij aanmaken: ') + error.message });
    } else {
      setPromptMsg({ type: 'success', text: 'Agent prompt aangemaakt.' });
      setNewProjectName('');
      setNewProjectContent('');
      setShowNewProjectForm(false);
      loadPrompts();
    }
    setLoading(false);
  };

  const handleDeleteProjectPrompt = async (promptId: string) => {
    setDeletingPromptId(promptId);
    const { error } = await supabase
      .from('chatbot_prompts')
      .delete()
      .eq('id', promptId);
    if (error) {
      setPromptMsg({ type: 'error', text: (lang === 'en' ? 'Error deleting: ' : 'Fout bij verwijderen: ') + error.message });
    } else {
      setPromptMsg({ type: 'success', text: 'Prompt verwijderd.' });
      setConfirmDeletePromptId(null);
      loadPrompts();
    }
    setDeletingPromptId(null);
  };

  const handleActivatePromptInSection = async (promptId: string, section: 'chat' | 'explain' | 'project') => {
    setLoading(true);
    setPromptMsg(null);

    await supabase
      .from('chatbot_prompts')
      .update({ is_active: false })
      .eq('section', section)
      .neq('id', promptId);

    const { error } = await supabase
      .from('chatbot_prompts')
      .update({ is_active: true })
      .eq('id', promptId);

    if (error) {
      console.error('Error activating prompt:', error);
      setPromptMsg({ type: 'error', text: (lang === 'en' ? 'Error activating: ' : 'Fout bij activeren: ') + error.message });
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
  { id: 'users' as TabType, label: lang === 'en' ? 'Users' : 'Gebruikers', icon: Users, show: isAdmin },
  { id: 'documents' as TabType, label: lang === 'en' ? 'Documents' : 'Documenten', icon: FolderTree, show: true },
  { id: 'rag_beheer' as TabType, label: lang === 'en' ? 'RAG Management' : 'RAG Beheer', icon: RefreshCw, show: true },
  { id: 'concepts' as TabType, label: lang === 'en' ? 'Concepts' : 'Begrippen', icon: BookOpen, show: true },
  { id: 'quiz_validation' as TabType, label: lang === 'en' ? 'Quiz Validation' : 'Quiz Validatie', icon: ClipboardCheck, show: true },
  { id: 'sharestats_import' as TabType, label: 'ShareStats Import', icon: Download, show: true },
  { id: 'quiz_sources' as TabType, label: lang === 'en' ? 'Quiz Sources' : 'Quiz-bronnen', icon: SlidersHorizontal, show: isAdmin || isDocent },
  { id: 'prompts' as TabType, label: lang === 'en' ? 'Chatbot Prompts' : 'Chatbot Prompts', icon: MessageSquareText, show: isAdmin || isDocent },
  { id: 'rag_settings' as TabType, label: lang === 'en' ? 'RAG Settings' : 'RAG Instellingen', icon: SlidersHorizontal, show: isAdmin || isDocent },
  { id: 'projects_admin' as TabType, label: lang === 'en' ? 'Projects' : 'Projecten', icon: FolderTree, show: isAdmin || isDocent },
  { id: 'personas' as TabType, label: lang === 'en' ? "Personas" : "Persona's", icon: MessageSquareText, show: isAdmin || isDocent },
  { id: 'settings' as TabType, label: lang === 'en' ? 'Settings' : 'Instellingen', icon: Settings, show: isAdmin },
].filter(tab => tab.show);

const tabGroups = [
  { label: lang === 'en' ? 'Course content' : 'Cursusinhoud', ids: ['documents', 'rag_beheer', 'rag_settings', 'concepts'] },
  { label: lang === 'en' ? 'Learning environment' : 'Leeromgeving', ids: ['prompts', 'quiz_validation', 'quiz_sources', 'projects_admin', 'personas'] },
  { label: lang === 'en' ? 'System' : 'Systeem', ids: ['users', 'sharestats_import', 'settings'] },
].map(g => ({ label: g.label, items: tabs.filter(t => g.ids.includes(t.id)) }))
 .filter(g => g.items.length > 0);


  if (!isDocent && !isAdmin) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <Settings className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">{lang === 'en' ? 'No Access' : 'Geen Toegang'}</h1>
          <p className="text-gray-600">
            {lang === 'en' ? 'You do not have access to the admin panel. Please contact the administrator.' : 'Je hebt geen toegang tot het beheerderspaneel. Neem contact op met de administrator.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">{lang === 'en' ? 'Admin Dashboard' : 'Beheer Dashboard'}</h1>
          <p className="text-gray-600">
            {lang === 'en'
              ? (isAdmin ? 'Manage users, documents and system settings' : 'Manage documents and course material')
              : (isAdmin ? 'Beheer gebruikers, documenten en systeeminstellingen' : 'Beheer documenten en cursusmateriaal')}
          </p>
          <div className="mt-4">
  <Link
    to="/admin/courses"
    className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
  >
    {lang === 'en' ? 'Manage courses' : 'Cursussen beheren'}
  </Link>
</div>

        </div>
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Home className="w-5 h-5" />
          <span>{lang === 'en' ? 'Back to Dashboard' : 'Terug naar Dashboard'}</span>
        </button>
      </div>

      {isAdmin && autoBackfillStatus && !autoBackfillBannerDismissed && (autoBackfillStatus.failed ?? 0) > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3" data-testid="banner-backfill-errors">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800">
              {lang === 'en'
                ? `Automatic folder mapping could not link ${autoBackfillStatus.failed} row${(autoBackfillStatus.failed ?? 0) !== 1 ? 's' : ''}`
                : `Automatische mapkoppeling heeft ${autoBackfillStatus.failed} rij${(autoBackfillStatus.failed ?? 0) !== 1 ? 'en' : ''} niet kunnen koppelen`}
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              {lang === 'en'
                ? `Total: ${autoBackfillStatus.total ?? '?'} · Linked: ${autoBackfillStatus.linked ?? 0} · Skipped: ${autoBackfillStatus.skipped ?? 0} · Failed: ${autoBackfillStatus.failed}`
                : `Totaal: ${autoBackfillStatus.total ?? '?'} · Gekoppeld: ${autoBackfillStatus.linked ?? 0} · Overgeslagen: ${autoBackfillStatus.skipped ?? 0} · Mislukt: ${autoBackfillStatus.failed}`}
              {autoBackfillStatus.ranAt && <> · {lang === 'en' ? 'Run at' : 'Uitgevoerd om'} {new Date(autoBackfillStatus.ranAt).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'nl-NL', { hour: '2-digit', minute: '2-digit' })}</>}
            </p>
            {(autoBackfillStatus.errors ?? []).length > 0 && (
              <ul className="mt-1.5 text-xs text-amber-700 list-disc list-inside space-y-0.5">
                {autoBackfillStatus.errors!.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            <p className="text-xs text-amber-600 mt-1.5">
              {lang === 'en'
                ? <>Go to <button className="underline font-medium" onClick={() => setActiveTab('projects_admin')} data-testid="link-backfill-projects-tab">Projects → Management</button> to fix the folder mapping manually.</>
                : <>Ga naar <button className="underline font-medium" onClick={() => setActiveTab('projects_admin')} data-testid="link-backfill-projects-tab">Projecten → Beheer</button> om de mapkoppeling handmatig te herstellen.</>}
            </p>
          </div>
          <button
            onClick={() => {
              if (autoBackfillStatus?.ranAt) {
                localStorage.setItem(BACKFILL_DISMISS_KEY, autoBackfillStatus.ranAt);
              }
              setAutoBackfillBannerDismissed(true);
            }}
            className="text-amber-500 hover:text-amber-700 transition-colors flex-shrink-0"
            title={lang === 'en' ? 'Close' : 'Sluiten'}
            data-testid="button-dismiss-backfill-banner"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-start">

        {/* Mobiel: dropdown */}
        <div className="md:hidden w-full">
          <select
            value={activeTab}
            onChange={e => setActiveTab(e.target.value as TabType)}
            className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 shadow-sm"
            data-testid="select-admin-tab-mobile"
          >
            {tabs.map(tab => (
              <option key={tab.id} value={tab.id}>{tab.label}</option>
            ))}
          </select>
        </div>

        {/* Desktop: verticale zijbalk */}
        <nav className="hidden md:block w-52 flex-shrink-0 bg-white rounded-2xl border border-gray-200 overflow-hidden self-start sticky top-4">
          {tabGroups.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'border-t border-gray-100' : ''}>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 pt-4 pb-1">
                {group.label}
              </p>
              {group.items.map(tab => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    data-testid={`nav-${tab.id}`}
                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium transition-all text-left ${
                      activeTab === tab.id
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {tab.label}
                  </button>
                );
              })}
              {gi === tabGroups.length - 1 && <div className="pb-2" />}
            </div>
          ))}
        </nav>

        {/* Inhoudspaneel */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200 min-w-0">
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
                  <span className="text-amber-800">{lang === 'en' ? <>Change role to <strong>{roleConfirm.newRole}</strong>?</> : <>Rol wijzigen naar <strong>{roleConfirm.newRole}</strong>?</>}</span>
                  <button onClick={confirmRoleChange} className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs font-medium">{lang === 'en' ? 'Confirm' : 'Bevestigen'}</button>
                  <button onClick={() => setRoleConfirm(null)} className="px-3 py-1 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-xs font-medium">{lang === 'en' ? 'Cancel' : 'Annuleren'}</button>
                </div>
              )}
              <div className="flex items-center gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    placeholder={lang === 'en' ? 'Search users by name or email...' : 'Zoek gebruikers op naam of email...'}
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
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">{lang === 'en' ? 'Name' : 'Naam'}</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Email</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">{lang === 'en' ? 'Role' : 'Rol'}</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">{lang === 'en' ? 'Actions' : 'Acties'}</th>
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
                                  {lang === 'en' ? '→ Lecturer' : '→ Docent'}
                                </button>
                              )}
                              {user.role !== 'student' && (
                                <button
                                  onClick={() => handleChangeUserRole(user.id, 'student')}
                                  disabled={loading}
                                  className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded-lg hover:bg-green-200 transition-colors disabled:opacity-50"
                                >
                                  {lang === 'en' ? '→ Student' : '→ Student'}
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
    <DocumentsPage />
  </div>
)}

{activeTab === 'rag_beheer' && (
  <div className="space-y-4">
    {activeCourse && conceptsMeta && conceptsMeta.lastDocumentChange && (() => {
      const effectiveRegen = [conceptsMeta.lastSuccessfulRegeneration, conceptsMeta.lastExtraction]
        .filter(Boolean).sort().reverse()[0] ?? null;
      return !effectiveRegen || conceptsMeta.lastDocumentChange > effectiveRegen;
    })() && (
      <div className="flex items-start justify-between gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3" data-testid="banner-docs-changed-rag">
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
          <span>
            <strong>{lang === 'en' ? 'Documents changed' : 'Documenten gewijzigd'}</strong> — {lang === 'en' ? 'consider regenerating the concept list.' : 'overweeg de begrippenlijst te hergenereren.'}{' '}
            {conceptsMeta.lastDocumentChange && (
              <span className="text-amber-700">
                {lang === 'en' ? 'Last document change:' : 'Laatste documentwijziging:'}{' '}
                {new Date(conceptsMeta.lastDocumentChange).toLocaleString(lang === 'en' ? 'en-GB' : 'nl-NL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </span>
        </div>
        <button
          onClick={handleRegenerateConcepts}
          disabled={regeneratingConcepts}
          className="flex-shrink-0 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
          data-testid="button-regenerate-now-rag"
        >
          {regeneratingConcepts ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {lang === 'en' ? 'Working…' : 'Bezig…'}
            </>
          ) : (
            <>
              <RefreshCw className="w-3.5 h-3.5" />
              {lang === 'en' ? 'Regenerate now' : 'Hergenereer nu'}
            </>
          )}
        </button>
      </div>
    )}
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
                  {activeCourse && conceptsMeta && (
                    <div className="flex flex-wrap items-center gap-2 mt-2" data-testid="text-concepts-meta">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium" data-testid="badge-rag-count">
                        {conceptsMeta.ragCount} {lang === 'en' ? 'AI-extracted' : 'AI-geëxtraheerd'}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium" data-testid="badge-manual-count">
                        {conceptsMeta.manualCount} {lang === 'en' ? 'manual' : 'handmatig'}
                      </span>
                      <span className="text-xs text-gray-500" data-testid="text-last-extraction">
                        {conceptsMeta.lastExtraction
                          ? `${lang === 'en' ? 'Last extraction:' : 'Laatste extractie:'} ${new Date(conceptsMeta.lastExtraction).toLocaleString(lang === 'en' ? 'en-GB' : 'nl-NL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                          : (lang === 'en' ? 'Never regenerated' : 'Nog nooit hergegenereerd')}
                      </span>
                    </div>
                  )}
                  {activeCourse && !conceptsMeta && (
                    <p className="text-xs text-gray-400 mt-2" data-testid="text-last-extraction">{lang === 'en' ? 'Never regenerated' : 'Nog nooit hergegenereerd'}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeCourseId && (
                    <button
                      onClick={handleRegenerateConcepts}
                      disabled={regeneratingConcepts}
                      className="px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 text-white font-semibold rounded-lg hover:from-amber-600 hover:to-amber-700 transition-all shadow-lg flex items-center gap-2 disabled:opacity-50"
                      data-testid="button-regenerate-concepts"
                    >
                      {regeneratingConcepts ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {lang === 'en' ? 'Working…' : 'Bezig…'}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4" />
                          {lang === 'en' ? 'Regenerate concept list' : 'Hergenereer begrippenlijst'}
                        </>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => { setAddConceptForm(v => !v); setAddConceptError(null); setAddConceptSuccess(false); }}
                    className="px-4 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg flex items-center gap-2"
                    data-testid="button-toggle-add-concept"
                  >
                    <Plus className="w-4 h-4" />
                    {lang === 'en' ? 'Add concept' : 'Begrip toevoegen'}
                  </button>
                </div>
              </div>

              {activeCourse && conceptsMeta && conceptsMeta.lastDocumentChange && (() => {
                const effectiveRegen = [conceptsMeta.lastSuccessfulRegeneration, conceptsMeta.lastExtraction]
                  .filter(Boolean).sort().reverse()[0] ?? null;
                return !effectiveRegen || conceptsMeta.lastDocumentChange > effectiveRegen;
              })() && (
                <div className="flex items-start justify-between gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3" data-testid="banner-docs-changed">
                  <div className="flex items-start gap-2 text-sm text-amber-800">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
                    <span>
                      <strong>{lang === 'en' ? 'Documents changed' : 'Documenten gewijzigd'}</strong> — {lang === 'en' ? 'consider regenerating the concept list.' : 'overweeg de begrippenlijst te hergenereren.'}{' '}
                      {conceptsMeta.lastDocumentChange && (
                        <span className="text-amber-700">
                          {lang === 'en' ? 'Last document change:' : 'Laatste documentwijziging:'}{' '}
                          {new Date(conceptsMeta.lastDocumentChange).toLocaleString(lang === 'en' ? 'en-GB' : 'nl-NL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    onClick={handleRegenerateConcepts}
                    disabled={regeneratingConcepts}
                    className="flex-shrink-0 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    data-testid="button-regenerate-now"
                  >
                    {regeneratingConcepts ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {lang === 'en' ? 'Working…' : 'Bezig…'}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        {lang === 'en' ? 'Regenerate now' : 'Hergenereer nu'}
                      </>
                    )}
                  </button>
                </div>
              )}

              {regenerateResult && (
                <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800" data-testid="text-regenerate-result">
                  <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-600" />
                  <span>
                    <strong>{regenerateResult.count}</strong> {lang === 'en' ? 'concepts generated' : 'begrippen gegenereerd'}
                    {regenerateResult.skipped > 0 && <>, <strong>{regenerateResult.skipped}</strong> {lang === 'en' ? 'skipped' : 'overgeslagen'}</>}.
                    {regenerateResult.message && <> {regenerateResult.message}</>}
                  </span>
                </div>
              )}
              {regenerateError && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3" data-testid="text-regenerate-error">
                  {regenerateError}
                </p>
              )}

              {addConceptForm && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
                  <h3 className="font-semibold text-gray-900">{lang === 'en' ? 'Add new concept' : 'Nieuw begrip toevoegen'}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Name *' : 'Naam *'}</label>
                      <input
                        type="text"
                        value={addConceptName}
                        onChange={e => setAddConceptName(e.target.value)}
                        placeholder={lang === 'en' ? 'E.g. Relative risk' : 'Bijv. Relatief risico'}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        data-testid="input-concept-name"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Category' : 'Categorie'}</label>
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Definition (optional)' : 'Definitie (optioneel)'}</label>
                    <textarea
                      value={addConceptDefinition}
                      onChange={e => setAddConceptDefinition(e.target.value)}
                      placeholder={lang === 'en' ? 'Brief definition of the concept...' : 'Korte definitie van het begrip...'}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                      data-testid="input-concept-definition"
                    />
                  </div>
                  {addConceptError && (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{addConceptError}</p>
                  )}
                  {addConceptSuccess && (
                    <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{lang === 'en' ? 'Concept added successfully.' : 'Begrip succesvol toegevoegd.'}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddConcept}
                      disabled={addConceptLoading}
                      className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-all disabled:opacity-50 text-sm"
                      data-testid="button-save-concept"
                    >
                      {addConceptLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : (lang === 'en' ? 'Save' : 'Opslaan')}
                    </button>
                    <button
                      onClick={() => { setAddConceptForm(false); setAddConceptError(null); }}
                      className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all text-sm"
                    >
                      {lang === 'en' ? 'Cancel' : 'Annuleren'}
                    </button>
                  </div>
                </div>
              )}

              {deleteError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{deleteError}</p>
              )}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-gray-700">
                  <strong>Tip:</strong> {lang === 'en' ? 'Use the "RAG Management" tab to automatically extract concepts from course material.' : 'Gebruik de "RAG Beheer" tab om begrippen automatisch te extracteren uit cursusmateriaal.'}
                </p>
              </div>

              {/* ── Selectie-toolbar ── */}
              {(courseConcepts.length > 0 || globalConcepts.length > 0) && (() => {
                const allIds = [...courseConcepts, ...globalConcepts].map(c => c.id);
                const allSelected = allIds.length > 0 && allIds.every(id => selectedConceptIds.has(id));
                const noneSelected = selectedConceptIds.size === 0;
                return (
                  <div className="flex flex-wrap items-center gap-3 py-2 border-t border-gray-100 pt-3">
                    <button
                      onClick={() => {
                        setBulkDeleteConfirm(false);
                        setSelectedConceptIds(allSelected ? new Set() : new Set(allIds));
                      }}
                      className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
                      data-testid="button-toggle-select-all"
                    >
                      <input
                        type="checkbox"
                        readOnly
                        checked={allSelected}
                        className="w-4 h-4 rounded border-gray-300 accent-blue-600 pointer-events-none"
                      />
                      {allSelected ? (lang === 'en' ? 'Deselect all' : 'Niets selecteren') : (lang === 'en' ? 'Select all' : 'Alles selecteren')}
                    </button>

                    {!noneSelected && (
                      <span className="text-sm text-gray-500">{selectedConceptIds.size} {lang === 'en' ? 'selected' : 'geselecteerd'}</span>
                    )}

                    {!noneSelected && (
                      bulkDeleteConfirm ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-red-700 font-medium">
                            {lang === 'en'
                              ? `Permanently delete ${selectedConceptIds.size} concept${selectedConceptIds.size !== 1 ? 's' : ''}?`
                              : `${selectedConceptIds.size} begrip${selectedConceptIds.size !== 1 ? 'pen' : ''} definitief verwijderen?`}
                          </span>
                          <button
                            onClick={handleBulkDelete}
                            disabled={bulkDeleting}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                            data-testid="button-confirm-bulk-delete"
                          >
                            {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            {lang === 'en' ? 'Yes, delete' : 'Ja, verwijder'}
                          </button>
                          <button
                            onClick={() => setBulkDeleteConfirm(false)}
                            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                          >
                            {lang === 'en' ? 'Cancel' : 'Annuleren'}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={handleBulkDelete}
                          disabled={bulkDeleting}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors"
                          data-testid="button-bulk-delete"
                        >
                          <Trash2 className="w-3 h-3" />
                          {lang === 'en' ? `Delete selected (${selectedConceptIds.size})` : `Verwijder geselecteerde (${selectedConceptIds.size})`}
                        </button>
                      )
                    )}

                    {bulkDeleteError && (
                      <span className="text-sm text-red-600">{bulkDeleteError}</span>
                    )}
                  </div>
                );
              })()}

              {activeCourse && (
                <div>
                  <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <GraduationCap className="w-4 h-4 text-purple-600" />
                    {lang === 'en' ? 'Course:' : 'Cursus:'} {activeCourse.name}
                    <span className="text-sm font-normal text-gray-500">({courseConcepts.length})</span>
                  </h3>
                  {courseConcepts.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 border border-dashed border-gray-200 rounded-lg">
                      <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                      <p className="text-sm">{lang === 'en' ? 'No course concepts — use RAG Management to extract them.' : 'Geen cursus-begrippen — gebruik RAG Beheer om te extracteren.'}</p>
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
                            isSelected={selectedConceptIds.has(concept.id)}
                            onToggleSelect={(id) => setSelectedConceptIds(prev => {
                              const next = new Set(prev);
                              next.has(id) ? next.delete(id) : next.add(id);
                              return next;
                            })}
                            lang={lang}
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
                  {lang === 'en' ? 'Global seeds' : 'Globale seeds'}
                  <span className="text-sm font-normal text-gray-500">({globalConcepts.length})</span>
                </h3>
                {globalConcepts.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 border border-dashed border-gray-200 rounded-lg">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">{lang === 'en' ? 'No global concepts added yet.' : 'Nog geen globale begrippen toegevoegd.'}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {globalConcepts.map(concept => (
                      <ConceptCard
                        key={concept.id}
                        concept={concept}
                        sourceLabel={lang === 'en' ? 'Global' : 'Globaal'}
                        sourceBg="bg-gray-100 text-gray-600"
                        deleteConfirmId={deleteConfirmId}
                        deletingConceptId={deletingConceptId}
                        onDeleteRequest={(id) => { setDeleteConfirmId(id); setDeleteError(null); }}
                        onDeleteConfirm={handleDeleteConcept}
                        onDeleteCancel={() => setDeleteConfirmId(null)}
                        isSelected={selectedConceptIds.has(concept.id)}
                        onToggleSelect={(id) => setSelectedConceptIds(prev => {
                          const next = new Set(prev);
                          next.has(id) ? next.delete(id) : next.add(id);
                          return next;
                        })}
                        lang={lang}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'quiz_validation' && <QuizValidationPanel />}

          {activeTab === 'sharestats_import' && <ShareStatsImportPanel />}

          {activeTab === 'quiz_sources' && <QuizSourcesAdminPanel />}

          {activeTab === 'prompts' && (
            <div className="space-y-6">
              <p className="text-gray-600">{lang === 'en' ? 'Manage system prompts per section of the learning environment.' : 'Beheer de systeem prompts per sectie van de leeromgeving.'}</p>

              {promptsMigration && !promptsMigration.hasSection && (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl space-y-2">
                  <p className="text-sm font-semibold text-yellow-900">{lang === 'en' ? 'One-time database migration required' : 'Eenmalige database-migratie vereist'}</p>
                  <p className="text-sm text-yellow-800">
                    {lang === 'en' ? 'To enable section management, run this SQL once in the Supabase dashboard (SQL Editor):' : 'Om sectie-beheer in te schakelen, voer je dit SQL eenmalig uit in het Supabase dashboard (SQL Editor):'}
                  </p>
                  <code className="block bg-yellow-100 border border-yellow-300 rounded-lg px-3 py-2 text-xs font-mono text-yellow-900 select-all whitespace-pre-wrap">
                    {promptsMigration.sqlToRun}
                  </code>
                  <p className="text-xs text-yellow-700">{lang === 'en' ? 'After running the SQL: restart the server. The explanation prompt will be created automatically and section management will be activated.' : 'Na het uitvoeren van de SQL: herstart de server. De uitleg-prompt wordt dan automatisch aangemaakt en de sectie-indeling wordt geactiveerd.'}</p>
                </div>
              )}

              {promptMsg && (
                <div className={`rounded-lg px-4 py-2 text-sm ${promptMsg.type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
                  {promptMsg.text}
                </div>
              )}

              {editingPrompt ? (
                <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
                  <h3 className="text-lg font-bold text-gray-900 mb-1">
                    {editingPrompt.section === 'project'
                      ? (lang === 'en' ? 'Edit Agent Prompt' : 'Bewerk Agent Prompt')
                      : editingPrompt.section === 'explain'
                        ? (lang === 'en' ? 'Edit Explanation Prompt' : 'Bewerk Uitleg Prompt')
                        : (lang === 'en' ? 'Edit Chat Prompt' : 'Bewerk Chat Prompt')}
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">{editingPrompt.name}</p>

                  {editingPrompt.section === 'project' && (
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Agent name' : 'Naam van de agent'}</label>
                      <input
                        type="text"
                        value={editingPromptName}
                        onChange={e => setEditingPromptName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
                        placeholder={lang === 'en' ? 'Agent prompt name...' : 'Naam van de agent prompt...'}
                        data-testid="input-prompt-name"
                      />
                    </div>
                  )}

                  <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Content' : 'Inhoud'}</label>
                  <textarea
                    value={promptContent}
                    onChange={(e) => setPromptContent(e.target.value)}
                    rows={14}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none font-mono text-sm"
                    placeholder={lang === 'en' ? 'Enter the system prompt...' : 'Voer de systeem prompt in...'}
                    data-testid="textarea-prompt-content"
                  />
                  <div className="flex gap-3 mt-4">
                    <button
                      onClick={handleSavePrompt}
                      disabled={loading}
                      className="px-6 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all shadow-sm disabled:opacity-50"
                      data-testid="button-save-prompt"
                    >
                      {loading ? (lang === 'en' ? 'Saving...' : 'Opslaan...') : (lang === 'en' ? 'Save' : 'Opslaan')}
                    </button>
                    <button
                      onClick={() => { setEditingPrompt(null); setPromptContent(''); setEditingPromptName(''); }}
                      className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all"
                      data-testid="button-cancel-prompt"
                    >
                      {lang === 'en' ? 'Cancel' : 'Annuleren'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  {/* ── Chat ── */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <MessageSquareText className="w-5 h-5 text-blue-600" />
                      <h3 className="text-base font-bold text-gray-900">Chat</h3>
                      <span className="text-xs text-gray-400">— {lang === 'en' ? 'one system prompt for the chatbot' : 'één systeem-prompt voor de chatbot'}</span>
                    </div>
                    <div className="space-y-2">
                      {(() => {
                        const chatPool = prompts.filter(p => (p.section ?? 'chat') === 'chat');
                        const activeChatPrompt = chatPool.find(p => p.is_active) || chatPool[0] || null;
                        return activeChatPrompt ? (
                          <div key={activeChatPrompt.id} className="flex items-start justify-between p-4 border border-blue-100 bg-blue-50 rounded-xl">
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-gray-900 text-sm">{activeChatPrompt.name}</p>
                              <p className="text-xs text-gray-500 mt-1 line-clamp-2 font-mono">{activeChatPrompt.content}</p>
                            </div>
                            <button
                              onClick={() => { setEditingPrompt(activeChatPrompt); setPromptContent(activeChatPrompt.content); setEditingPromptName(activeChatPrompt.name); }}
                              className="ml-4 p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-100 rounded-lg transition-colors flex-shrink-0"
                              title={lang === 'en' ? 'Edit' : 'Bewerken'}
                              data-testid={`button-edit-chat-${activeChatPrompt.id}`}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400 italic">{lang === 'en' ? 'No chat prompt found. Restart the server to create the default prompt.' : 'Geen chat-prompt gevonden. Herstart de server om de standaard-prompt aan te maken.'}</p>
                        );
                      })()}
                    </div>
                  </div>

                  {/* ── Ik Leg Uit ── */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="w-5 h-5 text-purple-600" />
                      <h3 className="text-base font-bold text-gray-900">Ik Leg Uit</h3>
                      <span className="text-xs text-gray-400">— evaluatietoon en -structuur voor studentuitleg</span>
                    </div>
                    <div className="space-y-2">
                      {(() => {
                        const explainPool = prompts.filter(p => p.section === 'explain');
                        const activeExplainPrompt = explainPool.find(p => p.is_active) || explainPool[0] || null;
                        return activeExplainPrompt ? (
                          <div key={activeExplainPrompt.id} className="flex items-start justify-between p-4 border border-purple-100 bg-purple-50 rounded-xl">
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-gray-900 text-sm">{activeExplainPrompt.name}</p>
                              <p className="text-xs text-gray-500 mt-1 line-clamp-2 font-mono">{activeExplainPrompt.content}</p>
                            </div>
                            <button
                              onClick={() => { setEditingPrompt(activeExplainPrompt); setPromptContent(activeExplainPrompt.content); setEditingPromptName(activeExplainPrompt.name); }}
                              className="ml-4 p-2 text-gray-500 hover:text-purple-600 hover:bg-purple-100 rounded-lg transition-colors flex-shrink-0"
                              title={lang === 'en' ? 'Edit' : 'Bewerken'}
                              data-testid={`button-edit-explain-${activeExplainPrompt.id}`}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400 italic">{lang === 'en' ? 'No explanation prompt found. Run the migration SQL and restart the server to create the default prompt.' : 'Geen uitleg-prompt gevonden. Voer de migratie-SQL uit en herstart de server om de standaard-prompt aan te maken.'}</p>
                        );
                      })()}
                    </div>
                  </div>

                  {/* ── Projecten ── */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <GraduationCap className="w-5 h-5 text-green-600" />
                        <h3 className="text-base font-bold text-gray-900">{lang === 'en' ? 'Projects' : 'Projecten'}</h3>
                        <span className="text-xs text-gray-400">— {lang === 'en' ? 'one prompt per agent, freely customisable' : 'één prompt per agent, vrij aanpasbaar'}</span>
                      </div>
                      {promptsMigration?.hasSection !== false && (
                        <button
                          onClick={() => setShowNewProjectForm(v => !v)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                          data-testid="button-add-project-prompt"
                        >
                          <Plus className="w-4 h-4" />
                          {lang === 'en' ? 'New agent prompt' : 'Nieuwe agent prompt'}
                        </button>
                      )}
                    </div>
                    {promptsMigration?.hasSection === false && (
                      <p className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 mb-3">
                        {lang === 'en' ? 'Creating agent prompts is available after the database migration above has been run.' : 'Agent prompts aanmaken is beschikbaar nadat de database-migratie hierboven is uitgevoerd.'}
                      </p>
                    )}

                    {showNewProjectForm && (
                      <div className="mb-4 p-4 border border-green-200 bg-green-50 rounded-xl space-y-3">
                        <p className="text-sm font-medium text-green-900">{lang === 'en' ? 'Create new agent prompt' : 'Nieuwe agent prompt aanmaken'}</p>
                        <input
                          type="text"
                          value={newProjectName}
                          onChange={e => setNewProjectName(e.target.value)}
                          placeholder={lang === 'en' ? "Agent name (e.g. 'Research assistant')" : "Naam van de agent (bijv. 'Onderzoeksassistent')"}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 outline-none"
                          data-testid="input-new-project-name"
                        />
                        <textarea
                          value={newProjectContent}
                          onChange={e => setNewProjectContent(e.target.value)}
                          rows={5}
                          placeholder={lang === 'en' ? 'Describe the role and instructions of this agent...' : 'Beschrijf de rol en instructies van deze agent...'}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 outline-none font-mono"
                          data-testid="textarea-new-project-content"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={handleCreateProjectPrompt}
                            disabled={loading || !newProjectName.trim()}
                            className="px-4 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                            data-testid="button-create-project-prompt"
                          >
                            {loading ? (lang === 'en' ? 'Creating...' : 'Aanmaken...') : (lang === 'en' ? 'Create' : 'Aanmaken')}
                          </button>
                          <button
                            onClick={() => { setShowNewProjectForm(false); setNewProjectName(''); setNewProjectContent(''); }}
                            className="px-4 py-1.5 text-sm bg-white text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                            data-testid="button-cancel-new-project"
                          >
                            {lang === 'en' ? 'Cancel' : 'Annuleren'}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      {prompts.filter(p => p.section === 'project').map(prompt => (
                        <div key={prompt.id} className="flex items-start justify-between p-4 border border-gray-200 bg-white rounded-xl hover:bg-gray-50 transition-colors">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-gray-900 text-sm">{prompt.name}</p>
                            <p className="text-xs text-gray-500 mt-1 line-clamp-2 font-mono">{prompt.content}</p>
                          </div>
                          <div className="flex gap-1 ml-4 flex-shrink-0">
                            <button
                              onClick={() => { setEditingPrompt(prompt); setPromptContent(prompt.content); setEditingPromptName(prompt.name); }}
                              className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title={lang === 'en' ? 'Edit' : 'Bewerken'}
                              data-testid={`button-edit-project-${prompt.id}`}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            {confirmDeletePromptId === prompt.id ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-red-600 font-medium">{lang === 'en' ? 'Delete?' : 'Verwijderen?'}</span>
                                <button
                                  onClick={() => handleDeleteProjectPrompt(prompt.id)}
                                  disabled={deletingPromptId === prompt.id}
                                  className="px-2 py-1 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                                  data-testid={`button-confirm-delete-prompt-${prompt.id}`}
                                >
                                  {deletingPromptId === prompt.id ? '...' : (lang === 'en' ? 'Yes' : 'Ja')}
                                </button>
                                <button
                                  onClick={() => setConfirmDeletePromptId(null)}
                                  className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200"
                                  data-testid={`button-cancel-delete-prompt-${prompt.id}`}
                                >
                                  {lang === 'en' ? 'No' : 'Nee'}
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setConfirmDeletePromptId(prompt.id)}
                                className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                title={lang === 'en' ? 'Delete' : 'Verwijderen'}
                                data-testid={`button-delete-project-${prompt.id}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {prompts.filter(p => p.section === 'project').length === 0 && !showNewProjectForm && (
                        <p className="text-sm text-gray-400 italic">{lang === 'en' ? 'No agent prompts created yet. Click "New agent prompt" to get started.' : 'Nog geen agent prompts aangemaakt. Klik op "Nieuwe agent prompt" om te beginnen.'}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'rag_settings' && (
            <div className="space-y-6 p-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">{lang === 'en' ? 'RAG Proximity Settings' : 'RAG Nabijheidsinstellingen'}</h2>
                <p className="text-sm text-gray-600">
                  {lang === 'en' ? 'Configure per module how strictly RAG search results are filtered. Select a course or the global default below.' : 'Stel per module in hoe strikt de RAG-zoekresultaten worden gefilterd. Kies hieronder de cursus of de globale standaard.'}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                <Globe className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-blue-900">{lang === 'en' ? 'Adjust settings for:' : 'Instellingen aanpassen voor:'}</p>
                  <p className="text-xs text-blue-600 mt-0.5">{lang === 'en' ? 'Course-specific settings override the global default.' : 'Cursus-specifieke instellingen overschrijven de globale standaard.'}</p>
                </div>
                <div className="relative">
                  <select
                    value={ragSelectedCourseId || ''}
                    onChange={e => {
                      setRagSelectedCourseId(e.target.value || null);
                      setRagSettingsMsg(null);
                    }}
                    className="appearance-none pl-3 pr-8 py-2 text-sm bg-white border border-blue-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-800 min-w-[220px]"
                    data-testid="select-rag-course"
                  >
                    <option value="">🌐 Globale standaard</option>
                    {allCourses.map(course => (
                      <option key={course.id} value={course.id}>
                        {coursesWithOverrides.has(course.id) ? '⚙️ ' : '○ '}{course.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-blue-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              {ragSelectedCourseId ? (
                <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg text-sm border ${coursesWithOverrides.has(ragSelectedCourseId) ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                  {coursesWithOverrides.has(ragSelectedCourseId) ? (
                    <>
                      <span className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                        <strong>{allCourses.find(c => c.id === ragSelectedCourseId)?.name}</strong> heeft eigen instellingen (override actief).
                      </span>
                      <button
                        onClick={() => deleteRagOverride(ragSelectedCourseId)}
                        disabled={ragDeletingOverride || ragSettingsSaving}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-white border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 disabled:opacity-50 transition-colors flex-shrink-0"
                        data-testid="button-delete-rag-override"
                      >
                        {ragDeletingOverride ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Terugzetten naar globaal
                      </button>
                    </>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
                      <strong>{allCourses.find(c => c.id === ragSelectedCourseId)?.name}</strong> gebruikt de globale standaard. Sla op om een eigen instelling te maken.
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm border bg-gray-50 border-gray-200 text-gray-600">
                  <Globe className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  Globale standaard — geldt voor alle cursussen zonder eigen instelling.
                  {coursesWithOverrides.size > 0 && (
                    <span className="ml-1 text-blue-600 font-medium">({coursesWithOverrides.size} cursus{coursesWithOverrides.size !== 1 ? 'sen' : ''} met eigen instelling)</span>
                  )}
                </div>
              )}

              {ragSettingsMsg && (
                <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${ragSettingsMsg.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                  {ragSettingsMsg.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {ragSettingsMsg.text}
                </div>
              )}

              <div className="border border-purple-200 rounded-xl p-5 space-y-4 bg-purple-50">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-purple-600" />
                      {lang === 'en' ? 'Concept extraction' : 'Begrippenextractie'}
                    </h3>
                    <p className="text-xs text-gray-600 mt-1 max-w-2xl">
                      {lang === 'en'
                        ? 'When the AI regenerates the concept list, each candidate concept is verified against the course material. Concepts without sufficient evidence are rejected. Stricter = fewer but more relevant concepts.'
                        : 'Wanneer de AI de begrippenlijst hergenereert, wordt elk kandidaat-begrip gecontroleerd tegen het cursusmateriaal. Begrippen zonder voldoende bewijs worden afgewezen. Strikter = minder maar relevantere begrippen.'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {lang === 'en' ? 'Verification threshold' : 'Verificatie-drempel'} (<span className="font-mono">{ragSettingsState.extraction.similarity_threshold.toFixed(2)}</span>)
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      {lang === 'en'
                        ? 'Minimum similarity per candidate concept. Tip: with text-embedding-3-small, good matches typically score between 0.45 and 0.65.'
                        : 'Minimale overeenkomst per kandidaat-begrip. Tip: bij text-embedding-3-small scoren goede matches typisch tussen 0.45 en 0.65.'}
                    </p>
                    <input
                      type="range"
                      min={0.0}
                      max={0.95}
                      step={0.01}
                      value={ragSettingsState.extraction.similarity_threshold}
                      onChange={e => updateRagExtraction('similarity_threshold', parseFloat(e.target.value))}
                      className="w-full accent-purple-600"
                      data-testid="slider-threshold-extraction"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                      <span>Geen filter (0.00)</span><span>Strikt (0.95)</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Min. bewijschunks (<span className="font-mono">{ragSettingsState.extraction.min_evidence_chunks}</span>)
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      Hoeveel chunks moeten boven de drempel scoren om het begrip te accepteren?
                      Hoger = strikter.
                    </p>
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={1}
                      value={ragSettingsState.extraction.min_evidence_chunks}
                      onChange={e => updateRagExtraction('min_evidence_chunks', parseInt(e.target.value))}
                      className="w-full accent-purple-600"
                      data-testid="slider-min-evidence-extraction"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                      <span>0 (geen filter)</span><span>5 (zeer strikt)</span>
                    </div>
                  </div>
                </div>
              </div>

              {(['chat', 'explain', 'quiz', 'project'] as const).map(mod => {
                const labels: Record<string, string> = { chat: 'Chat', explain: 'Begrippen uitleggen', quiz: 'Quiz', project: 'Project' };
                const s = ragSettingsState[mod];
                return (
                  <div key={mod} className="border border-gray-200 rounded-xl p-5 space-y-4 bg-gray-50">
                    <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                      <SlidersHorizontal className="w-4 h-4 text-blue-600" />
                      {labels[mod]}
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Drempelwaarde (<span className="font-mono">{s.similarity_threshold.toFixed(2)}</span>)
                        </label>
                        <p className="text-xs text-gray-500 mb-2">Minimale overeenkomst voor RAG-chunks (0.0 – 1.0)</p>
                        <input
                          type="range"
                          min={0.10}
                          max={0.95}
                          step={0.01}
                          value={s.similarity_threshold}
                          onChange={e => updateRagModule(mod, 'similarity_threshold', parseFloat(e.target.value))}
                          className="w-full accent-blue-600"
                          data-testid={`slider-threshold-${mod}`}
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                          <span>Breed (0.10)</span><span>Strikt (0.95)</span>
                        </div>
                        {s.similarity_threshold < 0.20 && (
                          <p
                            className="mt-1.5 text-xs text-amber-700"
                            data-testid={`warning-threshold-permissive-${mod}`}
                          >
                            Erg permissief — kan irrelevante passages binnenhalen.
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Max. chunks (<span className="font-mono">{s.match_count}</span>)
                        </label>
                        <p className="text-xs text-gray-500 mb-2">Aantal top-overeenkomende passages (1 – 20)</p>
                        <input
                          type="range"
                          min={1}
                          max={20}
                          step={1}
                          value={s.match_count}
                          onChange={e => updateRagModule(mod, 'match_count', parseInt(e.target.value))}
                          className="w-full accent-blue-600"
                          data-testid={`slider-matchcount-${mod}`}
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                          <span>1</span><span>20</span>
                        </div>
                      </div>

                      <div className="flex flex-col justify-center">
                        <label className="block text-sm font-medium text-gray-700 mb-2">Strikte bronbeperking</label>
                        <p className="text-xs text-gray-500 mb-3">LLM mag alleen antwoorden op basis van de gevonden cursusteksten</p>
                        <button
                          onClick={() => updateRagModule(mod, 'rag_strict_mode', !s.rag_strict_mode)}
                          className={`relative inline-flex items-center gap-3 w-fit px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${s.rag_strict_mode ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                          data-testid={`toggle-strict-${mod}`}
                        >
                          {s.rag_strict_mode ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          {s.rag_strict_mode ? 'Strikt aan' : 'Strikt uit'}
                        </button>
                      </div>
                    </div>

                    {mod === 'explain' && (
                      <div className="border-t border-gray-200 pt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1">{lang === 'en' ? 'Enrich search query' : 'Zoekquery verrijken'}</label>
                        <p className="text-xs text-gray-500 mb-3 max-w-2xl">
                          {lang === 'en'
                            ? 'Expands short concept names with synonyms, key_points and the definition before the embedding model is called. Prevents text-embedding-3-small from returning low similarity scores for isolated terms (e.g. "cohort"). Only active for "Explain concepts"; chat/quiz/project use their own context-rich queries and do not need this enrichment.'
                            : 'Vult korte begripsnamen aan met Nederlandse synoniemen, key_points en de definition voordat het embedding-model wordt aangeroepen. Verhelpt dat text-embedding-3-small voor losse vaktermen (zoals \u201ccohort\u201d) anders lage similarity-scores oplevert. Alleen actief voor \u201cBegrippen uitleggen\u201d; chat/quiz/project gebruiken eigen context-rijke queries en hebben deze verrijking niet nodig.'}
                        </p>
                        <button
                          onClick={() => updateRagModule(mod, 'query_expansion_enabled', !s.query_expansion_enabled)}
                          className={`relative inline-flex items-center gap-3 w-fit px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${s.query_expansion_enabled ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                          data-testid={`toggle-expansion-${mod}`}
                        >
                          {s.query_expansion_enabled ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          {s.query_expansion_enabled ? 'Verrijking aan' : 'Verrijking uit'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center gap-4 pt-2">
                <button
                  onClick={saveRagSettingsAdmin}
                  disabled={ragSettingsSaving}
                  className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
                  data-testid="button-save-rag-settings"
                >
                  {ragSettingsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {ragSettingsSaving ? (lang === 'en' ? 'Saving...' : 'Opslaan...') : (lang === 'en' ? 'Save' : 'Opslaan')}
                </button>
                <button
                  onClick={loadRagSettingsAdmin}
                  disabled={ragSettingsSaving}
                  className="flex items-center gap-2 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                  data-testid="button-reset-rag-settings"
                >
                  <RefreshCw className="w-4 h-4" />
                  {lang === 'en' ? 'Reload' : 'Herladen'}
                </button>
              </div>

              {/* Diagnose: test drempelwaarde */}
              <div className="border border-gray-200 rounded-xl p-5 space-y-4 bg-white mt-6">
                <div>
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Search className="w-4 h-4 text-gray-600" />
                    Diagnose: test drempelwaarde
                  </h3>
                  <p className="text-xs text-gray-600 mt-1 max-w-2xl">
                    Type een zoekterm (bijvoorbeeld een begripsnaam) om te zien welke chunks worden
                    gevonden — zonder drempel toe te passen. Zo kun je inschatten welke drempel
                    realistisch is voor jouw cursusmateriaal.
                  </p>
                  {!isAdmin && !ragSelectedCourseId && (
                    <p className="text-xs text-amber-700 mt-2 flex items-center gap-1.5 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-md w-fit">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      Kies eerst een cursus hierboven — diagnose vereist een cursusselectie voor docenten.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={diagnosticQuery}
                      onChange={e => setDiagnosticQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !diagnosticLoading) runDiagnostic(); }}
                      placeholder="bijv. Cross-over onderzoek"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                      data-testid="input-diagnostic-query"
                    />
                    <button
                      onClick={runDiagnostic}
                      disabled={diagnosticLoading || !diagnosticQuery.trim()}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 text-sm font-medium"
                      data-testid="button-run-diagnostic"
                    >
                      {diagnosticLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      Test
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={diagnosticExpand}
                      onChange={e => setDiagnosticExpand(e.target.checked)}
                      className="accent-blue-600"
                      data-testid="checkbox-diagnostic-expand"
                    />
                    Verrijk de zoekterm met synoniemen (zelfde logica als &ldquo;Begrippen uitleggen&rdquo; gebruikt)
                  </label>
                  {diagnosticExpand && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-gray-600">
                        Optioneel: definition van het begrip (zoals opgeslagen in <code>concepts</code>) voor een eerlijke vergelijking met &ldquo;Begrippen uitleggen&rdquo;.
                      </label>
                      <textarea
                        value={diagnosticDefinition}
                        onChange={e => setDiagnosticDefinition(e.target.value)}
                        rows={2}
                        placeholder="Bijv. 'Een groep mensen met een gemeenschappelijk kenmerk die in de tijd gevolgd wordt.'"
                        className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-full"
                        data-testid="textarea-diagnostic-definition"
                      />
                    </div>
                  )}
                </div>

                {diagnosticError && (
                  <div className="flex items-center gap-2 p-3 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200">
                    <XCircle className="w-4 h-4" />
                    {diagnosticError}
                  </div>
                )}

                {diagnosticResult && (
                  <div className="space-y-3" data-testid="diagnostic-results">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
                      <span>Resultaat voor <strong>"{diagnosticResult.query}"</strong>:</span>
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-mono">
                        Beste score: {diagnosticResult.maxScore.toFixed(3)}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                        {diagnosticResult.chunks.length} chunks teruggegeven
                      </span>
                      {diagnosticResult.candidatesInAllowedFolders !== undefined && (
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                          ({diagnosticResult.candidatesInAllowedFolders} kandidaten in toegestane mappen)
                        </span>
                      )}
                      {diagnosticResult.expanded && (
                        <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs">
                          verrijkte zoekterm gebruikt
                        </span>
                      )}
                    </div>
                    {diagnosticResult.expanded && diagnosticResult.embedQuery && diagnosticResult.embedQuery !== diagnosticResult.query && (
                      <div
                        className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md px-3 py-2"
                        data-testid="text-diagnostic-embed-query"
                      >
                        <span className="font-medium text-blue-900">Verrijkte zoekstring:</span>{' '}
                        <span className="font-mono break-words">{diagnosticResult.embedQuery}</span>
                      </div>
                    )}

                    {diagnosticResult.chunks.length === 0 ? (
                      <div className="text-sm text-gray-500 italic">
                        Geen chunks gevonden. Controleer of de cursus RAG-mappen heeft toegewezen.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-96 overflow-y-auto">
                        {diagnosticResult.chunks.map((chunk, idx) => (
                          <div
                            key={chunk.id}
                            className="border border-gray-200 rounded-lg p-3 bg-gray-50"
                            data-testid={`diagnostic-chunk-${idx}`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <span className="text-xs font-medium text-gray-600 truncate">
                                #{idx + 1} · {chunk.documentTitle}
                              </span>
                              <span
                                className={`text-xs font-mono px-2 py-0.5 rounded-full flex-shrink-0 ${
                                  chunk.similarity >= 0.6
                                    ? 'bg-green-100 text-green-700'
                                    : chunk.similarity >= 0.45
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-red-100 text-red-700'
                                }`}
                                data-testid={`diagnostic-score-${idx}`}
                              >
                                {chunk.similarity.toFixed(3)}
                              </span>
                            </div>
                            <p className="text-xs text-gray-600 line-clamp-2">{chunk.contentPreview}…</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'projects_admin' && <ProjectsAdminTab />}
          {activeTab === 'personas' && <PersonaLibraryTab />}

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
