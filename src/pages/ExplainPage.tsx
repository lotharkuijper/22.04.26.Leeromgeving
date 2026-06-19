import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n';
import { intlLocale } from '../i18n/languages';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { evaluateExplanation, llmErrorToDutch } from '../services/llm.service';
import { searchRelevantChunksWithStats, buildContextWithCap, dedupeSourcesByDocument, chunkToDisplaySource, ragDocumentDownloadUrl, openRagDocument, fetchConceptEvidence } from '../services/rag.service';
import { BookOpen, Search, Send, CheckCircle, AlertCircle, RefreshCw, LogOut, Sparkles, Trash2, BookText, X, Loader2, History } from 'lucide-react';
import { SourceList } from '../components/SourceList';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { RAGDiagnostics } from '../components/RAGDiagnostics';
import { PromptDebugBadge } from '../components/PromptDebugBadge';
import { useLearningLevel } from '../hooks/useLearningLevel';
import { LearningLevelSelector } from '../components/LearningLevelSelector';
import type { Database } from '../lib/database.types';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';
import { NoticeBanner, useNotice } from '../components/Notice';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';
import { useContentTranslation, type TranslatableItem } from '../hooks/useContentTranslation';

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
  query_expansion_enabled: boolean;
}

interface RagSettings {
  chat: RagModuleSettings;
  explain: RagModuleSettings;
  quiz: RagModuleSettings;
  project: RagModuleSettings;
}

const RAG_DEFAULTS: RagSettings = {
  chat:    { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: false, query_expansion_enabled: false },
  explain: { similarity_threshold: 0.50, match_count: 5, rag_strict_mode: true,  query_expansion_enabled: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true,  query_expansion_enabled: false },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false, query_expansion_enabled: false },
};

function FeedbackBlock({
  feedback,
  retrievedSources,
  retrievedStats,
  viewerRole,
  t,
  lang,
}: {
  feedback: string;
  retrievedSources: Array<{ title: string; similarity: number; documentId?: string; href?: string; slideStart?: number; slideEnd?: number; fromEvidence?: boolean; snippet?: string }>;
  retrievedStats: { threshold: number; maxSimilarity: number; candidatesConsidered: number; searchPerformed: boolean } | null;
  viewerRole?: string;
  t: (k: string) => string;
  lang: 'nl' | 'en';
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const idPrefix = 'explain-feedback';
  const handleCitationClick = (idx: number) => {
    setSourcesOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`source-${idPrefix}-${idx}`);
      if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };
  const [openSourceError, setOpenSourceError] = useState<string | null>(null);
  const handleOpenSource = (s: { documentId?: string }) => {
    if (!s.documentId) return;
    setOpenSourceError(null);
    openRagDocument(s.documentId).catch((err) => {
      setOpenSourceError(err?.message || 'Kon bron niet openen.');
    });
  };
  return (
    <div className="chic-card p-6">
      <h3 className="text-xl font-bold text-gray-900 mb-4">{t('explain.feedback')}</h3>
      <MarkdownMessage
        content={feedback}
        sources={retrievedSources.map((s, i) => ({ index: i + 1, title: s.title, href: s.href, documentId: s.documentId }))}
        onCitationClick={handleCitationClick}
        onSourceOpen={handleOpenSource}
      />
      {/\(buiten\s+(?:het\s+|dit\s+|de\s+)?cursusmateriaal\)/i.test(feedback) && (
        <div
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
          data-testid="notice-external-knowledge"
        >
          <div className="flex items-start gap-2 mb-1">
            <AlertCircle className="w-4 h-4 text-amber-700 mt-0.5 flex-shrink-0" />
            <h4 className="text-sm font-semibold text-amber-900">{t('explain.externalKnowledgeTitle')}</h4>
          </div>
          <p className="text-sm text-amber-800">{t('explain.externalKnowledgeDesc')}</p>
        </div>
      )}
      {openSourceError && (
        <div
          className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="alert-open-source-error"
        >
          <span className="flex-1 leading-snug">{openSourceError}</span>
          <button
            type="button"
            onClick={() => setOpenSourceError(null)}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            data-testid="button-dismiss-source-error"
          >
            ×
          </button>
        </div>
      )}
      <SourceList
        sources={retrievedSources}
        showSimilarity={false}
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        idPrefix={idPrefix}
        onOpenSource={handleOpenSource}
        slideWord={t('quiz.slideWord')}
        evidenceLabel={t('explain.sources.evidenceBadge')}
        evidenceTitle={t('explain.sources.evidenceBadgeTitle')}
        snippetToggleLabel={t('explain.sources.evidenceSnippetToggle')}
      />
      {retrievedStats && (
        <div className="mt-4">
          <RAGDiagnostics
            matchCount={retrievedSources.length}
            threshold={retrievedStats.threshold}
            maxSimilarity={retrievedStats.maxSimilarity}
            candidatesConsidered={retrievedStats.candidatesConsidered}
            searchPerformed={retrievedStats.searchPerformed}
            viewerRole={viewerRole}
          />
        </div>
      )}
    </div>
  );
}

export function ExplainPage() {
  const { t, lang } = useLanguage();
  const { profile, signOut } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const { level: learningLevel, setLevel: setLearningLevel } = useLearningLevel(activeCourse);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [filteredConcepts, setFilteredConcepts] = useState<Concept[]>([]);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [explanation, setExplanation] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAllConcepts, setShowAllConcepts] = useState(false);
  const [profileTimeout, setProfileTimeout] = useState(false);
  const [retrievedSources, setRetrievedSources] = useState<Array<{ title: string; similarity: number; documentId?: string; href?: string; slideStart?: number; slideEnd?: number; fromEvidence?: boolean; snippet?: string }>>([]);
  const [feedbackError, setFeedbackError] = useState<{ title: string; detail?: string } | null>(null);
  const [retrievedStats, setRetrievedStats] = useState<{
    threshold: number;
    maxSimilarity: number;
    candidatesConsidered: number;
    searchPerformed: boolean;
  } | null>(null);
  const [conceptSource, setConceptSource] = useState<'course' | 'global' | 'empty' | null>(null);
  const [conceptsLoading, setConceptsLoading] = useState(false);
  // Vertaal begrip-namen + categorieën naar de actieve taal (Task #288). De
  // definities worden bewust niet getoond (de oefening is juist uitleggen zonder
  // voorkennis), dus alleen de zichtbare naam + categorie gaan mee.
  const conceptItems: Record<string, TranslatableItem> = {};
  for (const c of concepts) {
    if (c?.id) {
      conceptItems[`name:${c.id}`] = { text: c.name, format: 'plain' };
      if (c.category) conceptItems[`cat:${c.id}`] = { text: c.category, format: 'plain' };
    }
  }
  const conceptT = useContentTranslation(conceptItems);
  const conceptName = (c: Concept) => conceptT.values[`name:${c.id}`] || c.name;
  const conceptCategory = (c: Concept) => (c.category ? conceptT.values[`cat:${c.id}`] || c.category : c.category);
  const [ragSettings, setRagSettings] = useState<RagSettings>(RAG_DEFAULTS);
  const [explainSystemPrompt, setExplainSystemPrompt] = useState<string | null>(null);
  const [history, setHistory] = useState<ExplanationHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeExplanationId, setActiveExplanationId] = useState<string | null>(null);
  const [deleteSummaryDialog, setDeleteSummaryDialog] = useState<{ id: string; conceptName: string } | null>(null);
  const [deletingWithSummary, setDeletingWithSummary] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [historyItemBusy, setHistoryItemBusy] = useState<string | null>(null);
  const { notice: pageNotice, setNotice: setPageNotice, clearNotice: clearPageNotice } = useNotice();

  useEffect(() => {
    const url = activeCourse ? `/api/rag-settings?courseId=${activeCourse}` : '/api/rag-settings';
    fetch(url).then(r => r.ok ? r.json() : null).then(data => {
      if (data) setRagSettings(data);
    }).catch(() => {});
  }, [activeCourse]);

  useEffect(() => {
    const url = activeCourse ? `/api/prompt/explain?courseId=${activeCourse}` : '/api/prompt/explain';
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.content) setExplainSystemPrompt(data.content); })
      .catch(() => {});
  }, [activeCourse]);

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
  }, [profile, activeCourse]);

  useEffect(() => {
    filterConcepts();
  }, [searchTerm, concepts]);

  const loadHistory = async () => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    // Zonder actieve cursus tonen we geen uitleg-geschiedenis (consistent met de
    // chat- en quizlijsten die ook leeg blijven zonder actieve cursus).
    if (!activeCourse) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const url = `/api/explain/history?courseId=${encodeURIComponent(activeCourse)}`;
      const res = await fetch(url, {
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
        setPageNotice({ kind: 'error', message: t('explain.couldNotLoad') });
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
      setFeedbackError(null);
      setRetrievedSources([]);
      setRetrievedStats(null);
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
        setPageNotice({ kind: 'error', message: t('explain.deleteFailed', { detail: String(err.error || res.status) }) });
        return;
      }
      setDeleteConfirm(null);
      if (activeExplanationId === id) {
        setActiveExplanationId(null);
        setExplanation('');
        setFeedback(null);
        setFeedbackError(null);
      }
      await loadHistory();
    } catch (err: any) {
      setPageNotice({ kind: 'error', message: t('explain.deleteError', { message: err?.message || '?' }) });
    } finally {
      setHistoryItemBusy(null);
    }
  };

  const handleDeleteWithSummary = async (id: string, generateSummary: boolean) => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) return;
    setDeletingWithSummary(true);
    try {
      const res = await fetch('/api/explain/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ explanationId: id, generateSummary, lang: (localStorage.getItem('lair-vu-lang') || 'nl'), courseId: activeCourse }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setPageNotice({ kind: 'error', message: t('explain.deleteFailed', { detail: String(err.error || res.status) }) });
        return;
      }
      const result = await res.json();
      setDeleteSummaryDialog(null);
      if (activeExplanationId === id) {
        setActiveExplanationId(null);
        setExplanation('');
        setFeedback(null);
        setFeedbackError(null);
      }
      await loadHistory();
      if (generateSummary && result.summaryFailed) {
        setPageNotice({
          kind: 'warning',
          message: t('explain.deletedSummaryFailed'),
        });
      }
    } catch (err: any) {
      setPageNotice({ kind: 'error', message: t('explain.deleteError', { message: err?.message || '?' }) });
    } finally {
      setDeletingWithSummary(false);
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
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      filtered = filtered.filter(c => {
        if (c.name.toLowerCase().includes(term)) return true;
        if (c.definition && c.definition.toLowerCase().includes(term)) return true;
        if (Array.isArray(c.key_points) && c.key_points.some(kp => kp.toLowerCase().includes(term))) return true;
        return false;
      });
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
    setFeedbackError(null);
    setRetrievedSources([]);
    setRetrievedStats(null);

    try {
      console.log('[EXPLAIN] Searching for relevant RAG chunks for concept:', selectedConcept.name);
      // De begripsnaam is het primaire zoeksignaal. Wanneer query-uitbreiding
      // aanstaat, voegen we een statische synoniemenlijst + de definition +
      // key_points toe; voor korte Nederlandse vaktermen (bv. "cohort") tilt
      // dat de top-similarity meetbaar omhoog zonder de drempel te verlagen.
      const expansionEnabled = ragSettings.explain.query_expansion_enabled;
      const ragResult = await searchRelevantChunksWithStats(
        selectedConcept.name,
        ragSettings.explain.similarity_threshold,
        ragSettings.explain.match_count,
        'explain',
        profile?.role || 'student',
        activeCourse,
        expansionEnabled
          ? {
              enabled: true,
              definition: selectedConcept.definition || undefined,
              keyPoints: selectedConcept.key_points || undefined,
            }
          : undefined
      );
      // Task #243: voeg de bij extractie opgeslagen bewijsfragmenten samen met
      // de live RAG-resultaten. Zo is er voor geëxtraheerde begrippen altijd
      // cursusmateriaal-context beschikbaar, ook als de live zoekopdracht door
      // drempel/instellingen niets oplevert. Dedupe op chunk-id of op
      // document+begin-van-tekst; bij dubbels houden we de hoogste similarity.
      const storedEvidence = selectedConcept.id
        ? await fetchConceptEvidence(selectedConcept.id)
        : [];
      // Documenten waarvan minstens één fragment bij de extractie is vastgelegd
      // (concept_evidence). Hiermee tonen we per bron de "vastgelegd"-badge,
      // los van of dezelfde bron ook live via RAG werd gevonden.
      const evidenceDocIds = new Set(
        storedEvidence.map(e => e.documentId).filter((id): id is string => !!id)
      );
      // Per bron-document het bij de extractie vastgelegde snippet, zodat de
      // student het exacte fragment kan inzien. Bij meerdere fragmenten per
      // document winnt het hoogst-scorende.
      const evidenceSnippetByDoc = new Map<string, { snippet: string; similarity: number }>();
      for (const e of storedEvidence) {
        if (!e.documentId || !e.content) continue;
        const cur = evidenceSnippetByDoc.get(e.documentId);
        if (!cur || (e.similarity || 0) > cur.similarity) {
          evidenceSnippetByDoc.set(e.documentId, { snippet: e.content, similarity: e.similarity || 0 });
        }
      }
      const mergedMap = new Map<string, typeof ragResult.chunks[number]>();
      for (const ch of [...ragResult.chunks, ...storedEvidence]) {
        const key = ch.id || `${ch.documentId || ''}:${(ch.content || '').slice(0, 80)}`;
        const existing = mergedMap.get(key);
        if (!existing || (ch.similarity || 0) > (existing.similarity || 0)) {
          mergedMap.set(key, ch);
        }
      }
      const chunks = Array.from(mergedMap.values()).sort(
        (a, b) => (b.similarity || 0) - (a.similarity || 0)
      );
      setRetrievedStats({
        threshold: ragResult.threshold,
        maxSimilarity: Math.max(ragResult.maxSimilarity, ...chunks.map(c => c.similarity || 0), 0),
        candidatesConsidered: ragResult.candidatesConsidered,
        searchPerformed: ragResult.searchPerformed,
      });

      const allSources = chunks.map(chunk => {
        const fromEvidence = !!(chunk.documentId && evidenceDocIds.has(chunk.documentId));
        const snippet = chunk.documentId ? evidenceSnippetByDoc.get(chunk.documentId)?.snippet : undefined;
        return {
          ...chunkToDisplaySource(chunk),
          href: ragDocumentDownloadUrl(chunk.documentId),
          fromEvidence,
          snippet: fromEvidence ? snippet : undefined,
        };
      });
      // Studenten zien per bron-document maximaal de top 3 (de meest relevante
      // hoofdstukken). Alle chunks gaan nog wel mee als context naar het LLM.
      const displaySources = dedupeSourcesByDocument(allSources, 3);
      setRetrievedSources(displaySources);

      const built = chunks.length > 0
        ? buildContextWithCap(chunks)
        : { context: '', usedChunks: 0, totalChunks: 0, truncated: false, charTrimmed: false };
      const context = built.context.length > 0 ? built.context : undefined;
      if (built.truncated) {
        console.log(`[EXPLAIN] Context capped: using ${built.usedChunks}/${built.totalChunks} chunks (${built.context.length} chars)`);
      }
      console.log(`[EXPLAIN] Found ${chunks.length} relevant chunks from RAG (showing top ${displaySources.length} unieke documenten)`);

      console.log('[EXPLAIN] Evaluating explanation for concept:', selectedConcept.name);
      let response;
      try {
        response = await evaluateExplanation(
          selectedConcept.name,
          explanation,
          selectedConcept.definition || '',
          selectedConcept.key_points || [],
          context,
          displaySources,
          ragSettings.explain.rag_strict_mode,
          explainSystemPrompt ?? undefined,
          learningLevel
        );
      } catch (llmErr) {
        console.error('[EXPLAIN] LLM evaluation failed:', llmErr);
        setFeedbackError(llmErrorToDutch(llmErr, lang));
        // Bewust géén /api/explain/save aanroepen: we willen geen "fout-feedback"
        // versies in de geschiedenis vervuilen.
        return;
      }

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
      setFeedbackError({
        title: t('explain.submitError'),
        detail: error instanceof Error ? error.message : undefined,
      });
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
              <h2 className="text-xl font-bold text-gray-900 mb-2">{t('chat.profileLoadFailed')}</h2>
              <p className="text-gray-600 mb-6">
                {t('chat.profileLoadFailedDetail')}
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg"
                >
                  <RefreshCw className="w-5 h-5" />
                  {t('chat.refreshPage')}
                </button>
                <button
                  onClick={() => signOut()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all"
                >
                  <LogOut className="w-5 h-5" />
                  {t('nav.logout')}
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
            <p className="text-gray-600 font-medium">{t('chat.profileLoading')}</p>
            <p className="text-sm text-gray-500 mt-2">{t('chat.profileLoadingWait')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <NoticeBanner notice={pageNotice} onDismiss={clearPageNotice} />
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('explain.title')}</h1>
        <p className="text-gray-600">{t('explain.subtitle')}</p>
        <div className="mt-2">
          <PromptDebugBadge section="explain" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
        <div className="chic-card p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">{t('explain.concepts')}</h2>

          <div className="space-y-4 mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder={t('explain.searchConceptPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 chic-input text-sm"
                data-testid="input-search-concept"
              />
            </div>
          </div>

          {conceptSource === 'global' && !activeCourse && (
            <div
              className="mb-3 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
              data-testid="banner-global-concepts"
            >
              <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
              <span>{t('explain.globalConceptsBanner')}</span>
            </div>
          )}

          {(() => {
            const hasConcepts = conceptSource === 'course' || (conceptSource === 'global' && !activeCourse);
            const renderConceptButton = (concept: Concept) => {
              const isRagExtracted = concept.key_points?.includes('[RAG-geëxtraheerd uit cursusmateriaal]');
              return (
                <button
                  key={concept.id}
                  id={`concept-item-${concept.id}`}
                  onClick={() => {
                    setSelectedConcept(concept);
                    setExplanation('');
                    setFeedback(null);
                    setFeedbackError(null);
                  }}
                  className={`w-full text-left p-3 rounded-lg transition-all ${
                    selectedConcept?.id === concept.id
                      ? 'bg-gradient-to-r from-blue-100 to-blue-200 text-blue-900 font-medium'
                      : 'hover:bg-gray-100 text-gray-700'
                  }`}
                  data-testid={`button-concept-${concept.id}`}
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm flex-1 truncate">{conceptName(concept)}</span>
                    {isRagExtracted && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium shrink-0">AI</span>
                    )}
                    {concept.category && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium shrink-0 max-w-[8rem] truncate" title={conceptCategory(concept)}>
                        {conceptCategory(concept)}
                      </span>
                    )}
                  </div>
                </button>
              );
            };

            if (conceptsLoading) {
              return (
                <div className="text-center py-6">
                  <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-xs text-gray-500">{t('explain.loadingConcepts')}</p>
                </div>
              );
            }

            if (!hasConcepts) {
              return (
                <div className="text-center py-6 px-2">
                  <Sparkles className="w-8 h-8 mx-auto mb-2 text-purple-300" />
                  <p className="text-sm font-medium text-gray-700 mb-1">{t('explain.noConceptsForCourse')}</p>
                  <p className="text-xs text-gray-500">{t('explain.noConceptsForCourseHint')}</p>
                </div>
              );
            }

            const total = concepts.length;
            const sortedAlpha = [...concepts].sort((a, b) =>
              a.name.localeCompare(b.name, intlLocale(lang), { sensitivity: 'base' })
            );

            if (searchTerm) {
              if (filteredConcepts.length === 0) {
                return (
                  <div className="text-center py-6 px-2 space-y-3">
                    <p className="text-sm text-gray-500">{t('explain.noConceptsFound')}</p>
                    <button
                      onClick={() => setSearchTerm('')}
                      className="btn-secondary text-xs"
                      data-testid="button-clear-search"
                    >
                      {t('explain.clearSearch')}
                    </button>
                  </div>
                );
              }
              return (
                <div className="space-y-2 max-h-[500px] overflow-y-auto" data-testid="list-search-results">
                  {filteredConcepts.map(renderConceptButton)}
                </div>
              );
            }

            const seen = new Set<string>();
            const recentConcepts: Concept[] = [];
            for (const h of history) {
              if (seen.has(h.conceptId)) continue;
              const match = concepts.find(c => c.id === h.conceptId);
              if (!match) continue;
              seen.add(h.conceptId);
              recentConcepts.push(match);
              if (recentConcepts.length >= 5) break;
            }
            const usingRecent = recentConcepts.length > 0;
            const shortList = usingRecent ? recentConcepts : sortedAlpha.slice(0, 5);
            const shortHeading = usingRecent ? t('explain.recentlyViewed') : t('explain.recommendedStart');

            const letters = Array.from(new Set(sortedAlpha.map(c => (c.name[0] || '#').toUpperCase()))).sort();
            const jumpToLetter = (letter: string) => {
              const target = sortedAlpha.find(c => (c.name[0] || '#').toUpperCase() === letter);
              if (!target) return;
              const el = document.getElementById(`concept-item-${target.id}`);
              if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };

            return (
              <div className="space-y-3">
                {!showAllConcepts && (
                  <>
                    <h3 className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{shortHeading}</h3>
                    <div className="space-y-2" data-testid="list-short-concepts">
                      {shortList.map(renderConceptButton)}
                    </div>
                  </>
                )}
                {showAllConcepts && (
                  <>
                    <div
                      className="flex flex-wrap gap-1"
                      role="navigation"
                      aria-label={t('explain.azStripAria')}
                      data-testid="strip-az"
                    >
                      {letters.map(letter => (
                        <button
                          key={letter}
                          onClick={() => jumpToLetter(letter)}
                          className="w-6 h-6 text-[11px] font-semibold rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
                          data-testid={`button-az-${letter}`}
                        >
                          {letter}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-2 max-h-[500px] overflow-y-auto" data-testid="list-all-concepts">
                      {sortedAlpha.map(renderConceptButton)}
                    </div>
                  </>
                )}
                {total > shortList.length && (
                  <button
                    onClick={() => setShowAllConcepts(v => !v)}
                    className="w-full text-center text-sm text-blue-700 hover:underline py-1"
                    data-testid="button-toggle-all-concepts"
                  >
                    {showAllConcepts
                      ? t('explain.showLess')
                      : t('explain.viewAllN', { n: String(total) })}
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        <div className="chic-card p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <History className="w-5 h-5 text-blue-600" />
              {t('explain.previouslyExplained')}
            </h2>
            {history.length > 0 && (
              <span className="text-xs text-gray-500" data-testid="text-history-count">{history.length}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-3">
            {t('explain.historyHint')}
          </p>

          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {historyLoading && (
              <div className="text-center py-4">
                <Loader2 className="w-5 h-5 animate-spin mx-auto text-blue-400" />
              </div>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-4">
                {t('explain.noHistoryYet')}
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
                      data-testid={`btn-delete-explanation-journal-${item.id}`}
                      onClick={(e) => { e.stopPropagation(); setDeleteSummaryDialog({ id: item.id, conceptName: item.conceptName }); }}
                      title={t('explain.deleteToJournal')}
                      className="p-1.5 rounded hover:bg-green-200 text-green-700"
                    >
                      <BookText className="w-4 h-4" />
                    </button>
                    <button
                      data-testid={`btn-delete-explanation-${item.id}`}
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(item.id); }}
                      title={t('explain.delete')}
                      className="p-1.5 rounded hover:bg-red-200 text-red-700"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {isConfirming && (
                    <div className="border-t border-red-200 bg-red-50 p-3 rounded-b-lg">
                      <p className="text-xs text-red-800 mb-2">{t('explain.deleteConfirm')}</p>
                      <div className="flex gap-2">
                        <button
                          data-testid={`btn-confirm-delete-${item.id}`}
                          onClick={() => handleDeleteExplanation(item.id)}
                          disabled={isBusy}
                          className="flex-1 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          {isBusy ? '...' : t('explain.yesDelete')}
                        </button>
                        <button
                          data-testid={`btn-cancel-delete-${item.id}`}
                          onClick={() => setDeleteConfirm(null)}
                          disabled={isBusy}
                          className="flex-1 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded hover:bg-gray-50"
                        >
                          {t('explain.cancel')}
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
            <div className="chic-card p-12 text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-semibold text-gray-900 mb-2">{t('explain.selectConcept')}</p>
              <p className="text-sm text-gray-600">{t('explain.selectConceptSub')}</p>
            </div>
          ) : (
            <>
              <div className="chic-card p-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">{conceptName(selectedConcept)}</h2>
                <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 mb-2">
                  {conceptCategory(selectedConcept)}
                </span>
                <AutoTranslatedNotice
                  isTranslating={conceptT.isTranslating}
                  isTranslated={conceptT.isTranslated}
                  showOriginal={conceptT.showOriginal}
                  onToggle={conceptT.setShowOriginal}
                  className="mb-4"
                />

                <div className="space-y-4">
                  <div className="mb-4">
                    <RAGStatusIndicator strictMode={ragSettings.explain.rag_strict_mode} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      {t('explain.explainLabel')}
                    </label>
                    <textarea
                      value={explanation}
                      onChange={(e) => setExplanation(e.target.value)}
                      placeholder={t('explain.typingPlaceholder')}
                      rows={8}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none resize-none"
                    />
                    <div className="flex justify-between items-center mt-2">
                      <span className={`text-sm ${wordCount >= 50 ? 'text-green-600' : 'text-gray-500'}`}>
                        {wordCount} {t('explain.words')} {wordCount >= 50 && <CheckCircle className="w-4 h-4 inline" />}
                      </span>
                    </div>
                  </div>

                  <LearningLevelSelector
                    value={learningLevel}
                    onChange={setLearningLevel}
                    className="pt-1"
                  />

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
                        {t('explain.submitForFeedback')}
                      </>
                    )}
                  </button>
                </div>
              </div>

              {feedbackError && (
                <div
                  className="bg-red-50 border border-red-200 rounded-2xl p-6"
                  data-testid="block-feedback-error"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-semibold text-red-900 mb-1">
                        {t('explain.feedbackCouldNotGenerate')}
                      </h3>
                      <p className="text-red-800 mb-2" data-testid="text-feedback-error-title">
                        {feedbackError.title}
                      </p>
                      {feedbackError.detail && (
                        <details className="mb-3 group" data-testid="details-feedback-error">
                          <summary className="text-sm text-red-700 cursor-pointer select-none hover:underline">
                            {t('explain.technicalDetails')}
                          </summary>
                          <p
                            className="mt-2 text-xs text-red-700 bg-red-100/60 border border-red-200 rounded-md px-3 py-2 whitespace-pre-wrap font-mono"
                            data-testid="text-feedback-error-detail"
                          >
                            {feedbackError.detail}
                          </p>
                        </details>
                      )}
                      <p className="text-xs text-red-700 mb-4">
                        <>{t('explain.notSavedBefore')} <strong>{t('explain.notSavedBold')}</strong> {t('explain.notSavedAfter')}</>
                      </p>
                      <button
                        onClick={handleSubmitExplanation}
                        disabled={loading}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed font-medium text-sm"
                        data-testid="button-retry-feedback"
                      >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        {t('explain.tryAgain')}
                      </button>
                    </div>
                  </div>
                  {retrievedSources.length > 0 && (
                    <div className="mt-5 pt-4 border-t border-red-200">
                      <SourceList
                        sources={retrievedSources}
                        showSimilarity={false}
                        slideWord={t('quiz.slideWord')}
                        evidenceLabel={t('explain.sources.evidenceBadge')}
                        evidenceTitle={t('explain.sources.evidenceBadgeTitle')}
                        snippetToggleLabel={t('explain.sources.evidenceSnippetToggle')}
                      />
                    </div>
                  )}
                </div>
              )}

              {feedback && (
                <FeedbackBlock
                  feedback={feedback}
                  retrievedSources={retrievedSources}
                  retrievedStats={retrievedStats}
                  viewerRole={profile?.role}
                  t={t}
                  lang={lang}
                />
              )}
            </>
          )}
        </div>
      </div>

      {deleteSummaryDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-green-100 rounded-xl">
                <BookText className="w-5 h-5 text-green-700" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">{t('explain.deleteDialogTitle')}</h2>
              <button
                onClick={() => !deletingWithSummary && setDeleteSummaryDialog(null)}
                className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
                data-testid="btn-explain-delete-cancel"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-2">
              <>{t('explain.deleteConfirmBefore')} <strong>"{deleteSummaryDialog.conceptName}"</strong> {t('explain.deleteConfirmAfter')}</>
            </p>
            <p className="text-sm text-gray-600 mb-6">
              {t('explain.deleteQuestion')}
            </p>

            <div className="flex flex-col gap-3">
              <button
                data-testid="btn-explain-delete-with-summary"
                onClick={() => handleDeleteWithSummary(deleteSummaryDialog.id, true)}
                disabled={deletingWithSummary}
                className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deletingWithSummary ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
                {t('explain.deleteWithSummaryBtn')}
              </button>

              <button
                data-testid="btn-explain-delete-without-summary"
                onClick={() => handleDeleteWithSummary(deleteSummaryDialog.id, false)}
                disabled={deletingWithSummary}
                className="w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('explain.deleteWithoutSummaryBtn')}
              </button>

              <button
                data-testid="btn-explain-delete-dismiss"
                onClick={() => setDeleteSummaryDialog(null)}
                disabled={deletingWithSummary}
                className="w-full px-4 py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors disabled:opacity-50"
              >
                {t('explain.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
