import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { evaluateExplanation } from '../services/llm.service';
import { searchRelevantChunks, formatContextFromChunks } from '../services/rag.service';
import { BookOpen, Search, Send, CheckCircle, AlertCircle, RefreshCw, LogOut, Sparkles, Trash2, BookText, X, Loader2, History } from 'lucide-react';
import { SourceList } from '../components/SourceList';
import type { Database } from '../lib/database.types';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';

type Concept = Database['public']['Tables']['concepts']['Row'];

interface ExplanationHistoryItem {
  id: string;
  conceptId: string;
  conceptName: string;
  conceptCategory: string | null;
  version: number;
  createdAt: string;
}

interface RagModuleSettings {
  similarity_threshold: number;
  match_count: number;
  rag_strict_mode: boolean;
}

interface RagSettings {
  chat: RagModuleSettings;
  explain: RagModuleSettings;
  quiz: RagModuleSettings;
  project: RagModuleSettings;
}

const RAG_DEFAULTS: RagSettings = {
  chat:    { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: false },
  explain: { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false },
};

export function ExplainPage() {
  const { profile, signOut } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [filteredConcepts, setFilteredConcepts] = useState<Concept[]>([]);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [explanation, setExplanation] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'epidemiologie' | 'biostatistiek'>('all');
  const [profileTimeout, setProfileTimeout] = useState(false);
  const [retrievedSources, setRetrievedSources] = useState<Array<{ title: string; similarity: number }>>([]);
  const [conceptSource, setConceptSource] = useState<'course' | 'global' | 'empty' | null>(null);
  const [conceptsLoading, setConceptsLoading] = useState(false);
  const [ragSettings, setRagSettings] = useState<RagSettings>(RAG_DEFAULTS);
  const [explainSystemPrompt, setExplainSystemPrompt] = useState<string | null>(null);
  const [history, setHistory] = useState<ExplanationHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeExplanationId, setActiveExplanationId] = useState<string | null>(null);
  const [archiveDialog, setArchiveDialog] = useState<{ id: string; conceptName: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [historyItemBusy, setHistoryItemBusy] = useState<string | null>(null);

  useEffect(() => {
    const url = activeCourse ? `/api/rag-settings?courseId=${activeCourse}` : '/api/rag-settings';
    fetch(url).then(r => r.ok ? r.json() : null).then(data => {
      if (data) setRagSettings(data);
    }).catch(() => {});
  }, [activeCourse]);

  useEffect(() => {
    fetch('/api/prompt/explain')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.content) setExplainSystemPrompt(data.content); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!profile) {
        console.error('[EXPLAIN] Profile load timeout after 10 seconds');
        setProfileTimeout(true);
      }
    }, 10000);

    return () => clearTimeout(timer);
  }, [profile]);

  useEffect(() => {
    if (profile) loadConcepts();
  }, [activeCourse, profile]);

  useEffect(() => {
    if (profile) loadHistory();
  }, [profile]);

  useEffect(() => {
    filterConcepts();
  }, [searchTerm, categoryFilter, concepts]);

  const loadHistory = async () => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/explain/history', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        console.error('[EXPLAIN] history fetch fout:', res.status);
        return;
      }
      const data = await res.json();
      setHistory(data.items || []);
    } catch (err) {
      console.error('[EXPLAIN] history fout:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSelectHistory = async (item: ExplanationHistoryItem) => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    setHistoryItemBusy(item.id);
    try {
      const res = await fetch(`/api/explain/${item.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        alert('Kon uitleg niet laden.');
        return;
      }
      const data = await res.json();
      // Probeer eerst het volledige concept uit de geladen lijst, anders fallback op join-data
      const fullConcept = concepts.find(c => c.id === data.conceptId) ||
        (data.concept ? { ...data.concept, id: data.conceptId } as Concept : null);
      if (fullConcept) {
        setSelectedConcept(fullConcept);
      }
      setExplanation(data.explanationText || '');
      setFeedback(data.feedback || null);
      setRetrievedSources([]);
      setActiveExplanationId(item.id);
    } catch (err) {
      console.error('[EXPLAIN] select history fout:', err);
    } finally {
      setHistoryItemBusy(null);
    }
  };

  const handleDeleteExplanation = async (id: string) => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    setHistoryItemBusy(id);
    try {
      const res = await fetch(`/api/explain/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Verwijderen mislukt: ${err.error || res.status}`);
        return;
      }
      setDeleteConfirm(null);
      if (activeExplanationId === id) {
        setActiveExplanationId(null);
        setExplanation('');
        setFeedback(null);
      }
      await loadHistory();
    } catch (err: any) {
      alert(`Fout bij verwijderen: ${err?.message || 'onbekend'}`);
    } finally {
      setHistoryItemBusy(null);
    }
  };

  const handleArchiveExplanation = async (id: string, generateSummary: boolean) => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    setArchiving(true);
    try {
      const res = await fetch('/api/explain/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ explanationId: id, generateSummary }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Verplaatsen naar leerdagboek mislukt: ${err.error || res.status}`);
        return;
      }
      const result = await res.json();
      setArchiveDialog(null);
      if (activeExplanationId === id) {
        setActiveExplanationId(null);
        setExplanation('');
        setFeedback(null);
      }
      await loadHistory();
      if (generateSummary && result.summaryFailed) {
        alert('De uitleg is verwijderd, maar de samenvatting kon niet worden opgeslagen in je leerdagboek. Probeer het later opnieuw.');
      }
    } catch (err: any) {
      alert(`Fout bij archiveren: ${err?.message || 'onbekend'}`);
    } finally {
      setArchiving(false);
    }
  };

  const loadConcepts = async () => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;

    setConceptsLoading(true);
    try {
      const params = activeCourse ? `?courseId=${activeCourse}` : '';
      console.log(`[EXPLAIN] Loading concepts from backend${params}`);
      const response = await fetch(`/api/concepts${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!response.ok) {
        console.error('[EXPLAIN] Error loading concepts:', response.status);
        return;
      }

      const data = await response.json();
      console.log(`[EXPLAIN] Loaded ${data.concepts?.length || 0} concepts (source: ${data.source})`);
      setConcepts(data.concepts || []);
      setConceptSource(data.source ?? null);
    } catch (error) {
      console.error('[EXPLAIN] Unexpected error loading concepts:', error);
    } finally {
      setConceptsLoading(false);
    }
  };

  const filterConcepts = () => {
    let filtered = concepts;

    if (categoryFilter !== 'all') {
      filtered = filtered.filter(c => c.category === categoryFilter);
    }

    if (searchTerm) {
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    setFilteredConcepts(filtered);
  };

  const handleSubmitExplanation = async () => {
    if (!selectedConcept || !explanation.trim() || !profile) {
      console.log('[EXPLAIN] Missing required data for submission');
      return;
    }

    setLoading(true);
    setFeedback(null);
    setRetrievedSources([]);

    try {
      console.log('[EXPLAIN] Searching for relevant RAG chunks for concept:', selectedConcept.name);
      const chunks = await searchRelevantChunks(
        `${selectedConcept.name} ${selectedConcept.definition || ''}`,
        ragSettings.explain.similarity_threshold,
        ragSettings.explain.match_count,
        'explain',
        profile?.role || 'student',
        activeCourse
      );

      const sources = chunks.map(chunk => ({
        title: chunk.documentTitle,
        similarity: chunk.similarity
      }));
      setRetrievedSources(sources);

      const context = chunks.length > 0 ? formatContextFromChunks(chunks) : undefined;
      console.log(`[EXPLAIN] Found ${chunks.length} relevant chunks from RAG`);

      console.log('[EXPLAIN] Evaluating explanation for concept:', selectedConcept.name);
      const response = await evaluateExplanation(
        selectedConcept.name,
        explanation,
        selectedConcept.definition || '',
        selectedConcept.key_points || [],
        context,
        sources,
        ragSettings.explain.rag_strict_mode,
        explainSystemPrompt ?? undefined
      );

      console.log('[EXPLAIN] Received feedback from LLM');
      setFeedback(response.content);

      console.log('[EXPLAIN] Saving explanation via API');
      const session = (await supabase.auth.getSession()).data.session;
      if (session?.access_token) {
        const saveRes = await fetch('/api/explain/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            conceptId: selectedConcept.id,
            explanationText: explanation,
            feedback: response.content,
          }),
        });
        if (saveRes.ok) {
          const saved = await saveRes.json();
          setActiveExplanationId(saved.id);
          console.log('[EXPLAIN] Explanation saved successfully', saved.id, 'v' + saved.version);
          await loadHistory();
        } else {
          console.error('[EXPLAIN] save fout:', saveRes.status);
        }
      }
    } catch (error) {
      console.error('[EXPLAIN] Error submitting explanation:', error);
      alert('Er is een fout opgetreden bij het indienen van je uitleg. Probeer het opnieuw.');
    } finally {
      setLoading(false);
    }
  };

  const wordCount = explanation.trim().split(/\s+/).filter(w => w.length > 0).length;

  if (!profile) {
    if (profileTimeout) {
      return (
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center max-w-md mx-auto px-4">
              <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-gray-900 mb-2">Profiel kon niet worden geladen</h2>
              <p className="text-gray-600 mb-6">
                Er is iets misgegaan bij het laden van je profiel. Dit kan komen door een verbindingsprobleem of een technisch probleem.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg"
                >
                  <RefreshCw className="w-5 h-5" />
                  Vernieuw pagina
                </button>
                <button
                  onClick={() => signOut()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all"
                >
                  <LogOut className="w-5 h-5" />
                  Uitloggen
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-600 font-medium">Je profiel wordt geladen...</p>
            <p className="text-sm text-gray-500 mt-2">Een moment geduld</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Ik Leg Uit</h1>
        <p className="text-gray-600">
          Kies een begrip en leg het uit in je eigen woorden. Je krijgt gedetailleerde feedback!
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Begrippen</h2>

          <div className="space-y-4 mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Zoek begrip..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setCategoryFilter('all')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Alle
              </button>
              <button
                onClick={() => setCategoryFilter('epidemiologie')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'epidemiologie'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Epidemiologie
              </button>
              <button
                onClick={() => setCategoryFilter('biostatistiek')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'biostatistiek'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Biostatistiek
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {conceptsLoading && (
              <div className="text-center py-6">
                <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-xs text-gray-500">Begrippen laden...</p>
              </div>
            )}
            {!conceptsLoading && (conceptSource === 'empty' || (conceptSource === 'global' && !!activeCourse)) && (
              <div className="text-center py-6 px-2">
                <Sparkles className="w-8 h-8 mx-auto mb-2 text-purple-300" />
                <p className="text-sm font-medium text-gray-700 mb-1">Nog geen begrippen voor deze cursus</p>
                <p className="text-xs text-gray-500">
                  Vraag de beheerder om begrippen te extraheren via het Admin-paneel (RAG-instellingen).
                </p>
              </div>
            )}
            {!conceptsLoading && (conceptSource === 'course' || (conceptSource === 'global' && !activeCourse)) && filteredConcepts.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-4">
                Geen begrippen gevonden
              </p>
            )}
            {(conceptSource === 'course' || (conceptSource === 'global' && !activeCourse)) && filteredConcepts.map((concept) => {
              const isRagExtracted = concept.key_points?.includes('[RAG-geëxtraheerd uit cursusmateriaal]');
              return (
                <button
                  key={concept.id}
                  onClick={() => {
                    setSelectedConcept(concept);
                    setExplanation('');
                    setFeedback(null);
                  }}
                  className={`w-full text-left p-3 rounded-lg transition-all ${
                    selectedConcept?.id === concept.id
                      ? 'bg-gradient-to-r from-blue-100 to-blue-200 text-blue-900 font-medium'
                      : 'hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm">{concept.name}</span>
                    {isRagExtracted && (
                      <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium shrink-0">AI</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 ml-6">{concept.category}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <History className="w-5 h-5 text-blue-600" />
              Eerder uitgelegd
            </h2>
            {history.length > 0 && (
              <span className="text-xs text-gray-500" data-testid="text-history-count">{history.length}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Klik op een uitleg om die terug te zien. Verwijder of verplaats naar je leerdagboek.
          </p>

          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {historyLoading && (
              <div className="text-center py-4">
                <Loader2 className="w-5 h-5 animate-spin mx-auto text-blue-400" />
              </div>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-4">
                Nog geen uitleg gegeven. Begin met een begrip uit de lijst.
              </p>
            )}
            {!historyLoading && history.map((item) => {
              const isActive = activeExplanationId === item.id;
              const isBusy = historyItemBusy === item.id;
              const isConfirming = deleteConfirm === item.id;
              return (
                <div
                  key={item.id}
                  data-testid={`history-item-${item.id}`}
                  className={`group relative rounded-lg transition-all border ${
                    isActive
                      ? 'bg-gradient-to-r from-blue-100 to-blue-200 border-blue-300'
                      : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  <button
                    onClick={() => handleSelectHistory(item)}
                    disabled={isBusy}
                    data-testid={`btn-history-${item.id}`}
                    className="w-full text-left p-3 pr-16 disabled:opacity-50"
                  >
                    <div className="flex items-start gap-2">
                      <BookOpen className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-700" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-900 truncate">{item.conceptName}</span>
                          {item.version > 1 && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">v{item.version}</span>
                          )}
                        </div>
                        {item.conceptCategory && (
                          <span className="text-xs text-gray-500">{item.conceptCategory}</span>
                        )}
                      </div>
                    </div>
                  </button>
                  <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      data-testid={`btn-archive-explanation-${item.id}`}
                      onClick={(e) => { e.stopPropagation(); setArchiveDialog({ id: item.id, conceptName: item.conceptName }); }}
                      title="Verplaats naar leerdagboek"
                      className="p-1.5 rounded hover:bg-green-200 text-green-700"
                    >
                      <BookText className="w-4 h-4" />
                    </button>
                    <button
                      data-testid={`btn-delete-explanation-${item.id}`}
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(item.id); }}
                      title="Verwijderen"
                      className="p-1.5 rounded hover:bg-red-200 text-red-700"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {isConfirming && (
                    <div className="border-t border-red-200 bg-red-50 p-3 rounded-b-lg">
                      <p className="text-xs text-red-800 mb-2">Weet je zeker dat je deze uitleg wilt verwijderen?</p>
                      <div className="flex gap-2">
                        <button
                          data-testid={`btn-confirm-delete-${item.id}`}
                          onClick={() => handleDeleteExplanation(item.id)}
                          disabled={isBusy}
                          className="flex-1 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          {isBusy ? 'Bezig...' : 'Ja, verwijder'}
                        </button>
                        <button
                          data-testid={`btn-cancel-delete-${item.id}`}
                          onClick={() => setDeleteConfirm(null)}
                          disabled={isBusy}
                          className="flex-1 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded hover:bg-gray-50"
                        >
                          Annuleren
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {!selectedConcept ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-semibold text-gray-900 mb-2">Selecteer een begrip</p>
              <p className="text-sm text-gray-600">Kies een begrip uit de lijst om te beginnen</p>
            </div>
          ) : (
            <>
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">{selectedConcept.name}</h2>
                <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 mb-4">
                  {selectedConcept.category}
                </span>

                <div className="space-y-4">
                  <div className="mb-4">
                    <RAGStatusIndicator strictMode={ragSettings.explain.rag_strict_mode} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Leg dit begrip uit in je eigen woorden
                    </label>
                    <textarea
                      value={explanation}
                      onChange={(e) => setExplanation(e.target.value)}
                      placeholder="Begin met typen..."
                      rows={8}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none resize-none"
                    />
                    <div className="flex justify-between items-center mt-2">
                      <span className={`text-sm ${wordCount >= 50 ? 'text-green-600' : 'text-gray-500'}`}>
                        {wordCount} woorden {wordCount >= 50 && <CheckCircle className="w-4 h-4 inline" />}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={handleSubmitExplanation}
                    disabled={loading}
                    className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <Send className="w-5 h-5" />
                        Verstuur voor feedback
                      </>
                    )}
                  </button>
                </div>
              </div>

              {feedback && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h3 className="text-xl font-bold text-gray-900 mb-4">Feedback</h3>
                  <div className="prose max-w-none text-gray-700 whitespace-pre-wrap">
                    {feedback}
                  </div>
                  <SourceList sources={retrievedSources} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {archiveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-green-100 rounded-xl">
                <BookText className="w-5 h-5 text-green-700" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Verplaats naar leerdagboek</h2>
              <button
                onClick={() => !archiving && setArchiveDialog(null)}
                className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
                data-testid="btn-explain-archive-cancel"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-2">
              Je staat op het punt je uitleg van <strong>"{archiveDialog.conceptName}"</strong> uit de actieve lijst te verwijderen.
            </p>
            <p className="text-sm text-gray-600 mb-6">
              Wil je dat de leerassistent een formatieve samenvatting (met sterke punten, verbeterpunten en een vervolgsuggestie) opslaat in je leerdagboek? Die kun je later teruglezen om op te reflecteren.
            </p>

            <div className="flex flex-col gap-3">
              <button
                data-testid="btn-explain-archive-with-summary"
                onClick={() => handleArchiveExplanation(archiveDialog.id, true)}
                disabled={archiving}
                className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
                Samenvatting opslaan en uitleg afsluiten
              </button>

              <button
                data-testid="btn-explain-archive-without-summary"
                onClick={() => handleArchiveExplanation(archiveDialog.id, false)}
                disabled={archiving}
                className="w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Alleen verwijderen (geen dagboekvermelding)
              </button>

              <button
                data-testid="btn-explain-archive-dismiss"
                onClick={() => setArchiveDialog(null)}
                disabled={archiving}
                className="w-full px-4 py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors disabled:opacity-50"
              >
                Annuleren
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
