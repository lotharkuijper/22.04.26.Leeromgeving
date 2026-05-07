import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import {
  evaluateOpenAnswer,
  evaluateCasusAnswer,
  fetchQuizPrompts,
  llmErrorToDutch,
  type QuizQuestion,
  type QuestionType,
  type AnswerEvaluation,
  type MCQQuestion,
  type OpenQuestion,
  type CasusQuestion,
  type QuizSource,
} from '../services/llm.service';
import { generateMixedQuiz, fetchSourceMix, distributeMix, SOURCE_LABELS, SOURCE_COLORS, type SourceMix, type MixCounts } from '../services/quiz-mix.service';
import { searchRelevantChunksWithStats, buildContextWithCap, type DocumentChunk } from '../services/rag.service';
import { getQuizTopics, type QuizTopic } from '../services/quiz-topic.service';
import { SourceList, type SourceItem } from '../components/SourceList';
import { RAGDiagnostics } from '../components/RAGDiagnostics';
import {
  Play,
  CheckCircle,
  XCircle,
  RotateCcw,
  TrendingUp,
  Award,
  AlertCircle,
  RefreshCw,
  ListChecks,
  PenLine,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Trash2,
  BookText,
  X,
  Loader2,
  Search,
  Calendar,
} from 'lucide-react';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';

type QuizState = 'setup' | 'ready' | 'active' | 'completed';

// Antwoord-objecten zoals ze in `quiz_attempts.answers` worden opgeslagen.
interface MCQAnswer {
  type: 'mcq';
  selectedIndex: number;
  isCorrect: boolean;
}
interface FreeTextAnswer {
  type: 'open' | 'casus';
  text: string;
  evaluation: AnswerEvaluation | null;
}
type QuizAnswer = MCQAnswer | FreeTextAnswer;

interface QuizAttemptRow {
  id: string;
  topics: string[] | null;
  difficulty: string | null;
  question_type: 'mcq' | 'open' | 'casus' | null;
  questions_data: QuizQuestion[] | null;
  answers: QuizAnswer[] | null;
  score_percentage: number | null;
  total_questions: number | null;
  created_at: string;
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
  explain: { similarity_threshold: 0.50, match_count: 5, rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false },
};

const QUESTION_TYPE_META: Record<QuestionType, { label: string; subtitle: string; icon: typeof ListChecks }> = {
  mcq:   { label: 'Meerkeuze',   subtitle: '4 opties, directe feedback', icon: ListChecks },
  open:  { label: 'Open vraag',  subtitle: 'Vrije tekst, AI-beoordeling met percentagescore', icon: PenLine },
  casus: { label: 'Casus',       subtitle: 'Probleemschets + open antwoord, AI-beoordeling', icon: ClipboardList },
};

function difficultyDutch(d: string | null | undefined): string {
  if (d === 'easy') return 'Makkelijk';
  if (d === 'medium') return 'Gemiddeld';
  if (d === 'hard') return 'Moeilijk';
  return d || '';
}

function questionTypeDutch(t: string | null | undefined): string {
  if (t === 'mcq') return 'Meerkeuze';
  if (t === 'open') return 'Open vraag';
  if (t === 'casus') return 'Casus';
  return t || '';
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('nl-NL', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function topicsLabelOf(row: QuizAttemptRow): string {
  if (Array.isArray(row.topics) && row.topics.length > 0) return row.topics.join(', ');
  return '(zonder onderwerp)';
}

export function QuizPage() {
  const { profile } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();

  const [state, setState] = useState<QuizState>('setup');

  // Setup
  const [availableTopics, setAvailableTopics] = useState<QuizTopic[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [topicsSource, setTopicsSource] = useState<QuizTopic['source'] | null>(null);
  const [selectedTopicIds, setSelectedTopicIds] = useState<Set<string>>(new Set());
  const [topicSearch, setTopicSearch] = useState('');
  const [questionType, setQuestionType] = useState<QuestionType>('mcq');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [numQuestions, setNumQuestions] = useState(5);
  const [setupValidationError, setSetupValidationError] = useState<string | null>(null);

  // Active quiz
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [showExplanation, setShowExplanation] = useState(false); // mcq inline feedback
  const [draftText, setDraftText] = useState(''); // typed text for current open/casus question
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<{ title: string; detail?: string } | null>(null);

  // Generation + RAG
  const [loading, setLoading] = useState(false);
  const [ragSources, setRagSources] = useState<SourceItem[]>([]);
  const [ragStats, setRagStats] = useState<{
    threshold: number;
    maxSimilarity: number;
    candidatesConsidered: number;
    searchPerformed: boolean;
  } | null>(null);
  const [ragSettings, setRagSettings] = useState<RagSettings>(RAG_DEFAULTS);
  const [feedbackError, setFeedbackError] = useState<{ title: string; detail?: string } | null>(null);
  const [contextStats, setContextStats] = useState<{ used: number; total: number; charTrimmed: boolean } | null>(null);

  // Bronnen-mix per cursus (Task #57)
  const [sourceMix, setSourceMix] = useState<SourceMix>({ pct_rag: 50, pct_itembank: 0, pct_llm: 50 });
  const [lastMixCounts, setLastMixCounts] = useState<MixCounts | null>(null);

  // Per-begrip beschikbaarheid (Task #57): toont aan jou hoeveel RAG-documenten
  // en ItemBank-vragen per geselecteerd begrip beschikbaar zijn, zodat je
  // weet of de bronnen-mix vermoedelijk genoeg materiaal vindt.
  type ConceptAvailability = {
    primary_folder_id: string | null;
    rag_doc_count: number | null;
    itembank_question_count: number;
    itembank_mcq_count?: number;
    itembank_open_count?: number;
    itembank_count_truncated?: boolean;
  };
  const [conceptAvailability, setConceptAvailability] = useState<Record<string, ConceptAvailability>>({});
  const [availabilityLoading, setAvailabilityLoading] = useState(false);

  // Resultatenlijst
  const [attempts, setAttempts] = useState<QuizAttemptRow[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(null);
  const [archiveDialog, setArchiveDialog] = useState<{ id: string; label: string } | null>(null);
  const [archiving, setArchiving] = useState(false);

  // Direct opslaan-flow op het "Quiz voltooid!"-scherm. Werkt ook als de
  // quiz_attempts-rij niet bewaard kon worden, dus losgekoppeld van de
  // resultatenlijst-flow hierboven.
  const [savingSummary, setSavingSummary] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'saved'; journalEntryId: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Kiezen van quiz-onderwerpen + recente pogingen herladen wanneer cursus
  // wisselt of gebruiker beschikbaar wordt.
  useEffect(() => { void loadAttempts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [profile?.id]);
  // Triggered op zowel cursus-wissel als zodra het profiel binnenkomt — anders
  // blijven gebruikers die de pagina bezoeken voordat AuthContext klaar is
  // hangen op een lege onderwerpenlijst.
  useEffect(() => { void loadTopics(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeCourse, profile?.id]);
  useEffect(() => {
    if (!activeCourse) return;
    void fetchSourceMix(activeCourse).then(setSourceMix);
  }, [activeCourse]);

  // Beschikbaarheid bijwerken zodra de geselecteerde concepten of de cursus
  // veranderen — debounced via een micro-delay zodat snelle aan/uit-clicks
  // geen request-storm veroorzaken.
  useEffect(() => {
    if (!activeCourse) { setConceptAvailability({}); return; }
    const ids = Array.from(selectedTopicIds);
    if (ids.length === 0) { setConceptAvailability({}); return; }
    let cancelled = false;
    setAvailabilityLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        const res = await fetch('/api/quiz/concept-availability', {
          method: 'POST',
          headers,
          body: JSON.stringify({ courseId: activeCourse, conceptIds: ids }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data?.availability) {
          setConceptAvailability(data.availability);
        }
      } catch (err) {
        console.warn('[QUIZ] concept-availability ophalen mislukt:', err);
        if (!cancelled) setConceptAvailability({});
      } finally {
        if (!cancelled) setAvailabilityLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [activeCourse, selectedTopicIds]);

  useEffect(() => {
    const url = activeCourse ? `/api/rag-settings?courseId=${activeCourse}` : '/api/rag-settings';
    fetch(url).then(r => r.ok ? r.json() : null).then(data => {
      if (data) setRagSettings(data);
    }).catch(() => {});
  }, [activeCourse]);

  const loadTopics = useCallback(async () => {
    if (!profile) return;
    setTopicsLoading(true);
    setTopicsError(null);
    try {
      const list = await getQuizTopics(activeCourse);
      setAvailableTopics(list);
      setTopicsSource(list.length > 0 ? list[0].source : 'empty');
      setSelectedTopicIds(prev => {
        const next = new Set<string>();
        for (const t of list) if (prev.has(t.id)) next.add(t.id);
        return next;
      });
    } catch (err: any) {
      console.error('[QUIZ] loadTopics error:', err);
      setTopicsError(err?.message || 'Kon onderwerpen niet laden');
      setAvailableTopics([]);
    } finally {
      setTopicsLoading(false);
    }
  }, [activeCourse, profile]);

  const loadAttempts = useCallback(async () => {
    if (!profile) return;
    setAttemptsLoading(true);
    setAttemptsError(null);
    const { data, error } = await supabase
      .from('quiz_attempts')
      .select('id, topics, difficulty, question_type, questions_data, answers, score_percentage, total_questions, created_at')
      .eq('student_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[QUIZ] loadAttempts error:', error);
      // Detecteer ontbrekende migratie en geef een duidelijke instructie.
      const isSchemaError = (error as any)?.code === '42703'
        || /column .* does not exist/i.test(error.message || '');
      setAttemptsError(
        isSchemaError
          ? 'De quiz-database is nog niet bijgewerkt naar het nieuwe model. ' +
            'Je beheerder moet migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql in Supabase toepassen. ' +
            'Tot dat moment kun je nog wel quizzes genereren en oefenen, maar afgeronde pogingen worden nog niet bewaard.'
          : error.message,
      );
      setAttempts([]);
    } else {
      setAttempts((data || []) as QuizAttemptRow[]);
    }
    setAttemptsLoading(false);
  }, [profile]);

  const filteredTopics = useMemo(() => {
    const q = topicSearch.trim().toLowerCase();
    if (!q) return availableTopics;
    return availableTopics.filter(t => t.name.toLowerCase().includes(q)
      || (t.category || '').toLowerCase().includes(q));
  }, [availableTopics, topicSearch]);

  const selectedTopics = useMemo(
    () => availableTopics.filter(t => selectedTopicIds.has(t.id)),
    [availableTopics, selectedTopicIds],
  );

  const toggleTopic = (id: string) => {
    setSelectedTopicIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (setupValidationError) setSetupValidationError(null);
  };

  const handleStartQuiz = async () => {
    setSetupValidationError(null);
    if (selectedTopicIds.size === 0) {
      setSetupValidationError('Kies minstens één onderwerp.');
      return;
    }

    setLoading(true);
    setRagSources([]);
    setFeedbackError(null);
    setContextStats(null);
    setRagStats(null);

    const topicNames = selectedTopics.map(t => t.name);

    try {
      let ragContext: string | undefined;
      if (activeCourse !== null) {
        let chunks: DocumentChunk[] = [];
        try {
          const ragResult = await searchRelevantChunksWithStats(
            topicNames.join(', '),
            ragSettings.quiz.similarity_threshold,
            ragSettings.quiz.match_count,
            'quiz',
            profile?.role || 'student',
            activeCourse,
            undefined,
            selectedTopics.map(t => t.id),
          );
          setRagStats({
            threshold: ragResult.threshold,
            maxSimilarity: ragResult.maxSimilarity,
            candidatesConsidered: ragResult.candidatesConsidered,
            searchPerformed: ragResult.searchPerformed,
          });
          chunks = ragResult.chunks;
        } catch (ragErr) {
          console.warn('[QUIZ] RAG search failed, generating without context:', ragErr);
        }

        if (chunks.length > 0) {
          const built = buildContextWithCap(chunks);
          if (built.context.length > 0) {
            ragContext = built.context;
          }
          setRagSources(chunks.map(c => ({ title: c.documentTitle, similarity: c.similarity })));
          setContextStats({ used: built.usedChunks, total: built.totalChunks, charTrimmed: built.charTrimmed });
        }
      }

      let generated: QuizQuestion[];
      let mixCounts: MixCounts = { rag: 0, itembank: 0, llm: 0 };
      try {
        const result = await generateMixedQuiz({
          courseId: activeCourse,
          conceptIds: selectedTopics.map(t => t.id),
          topicNames,
          difficulty,
          questionType,
          numQuestions,
          ragContext,
          ragStrictMode: ragSettings.quiz.rag_strict_mode,
          mix: sourceMix,
        });
        generated = result.questions;
        mixCounts = result.counts;
      } catch (llmErr) {
        console.error('[QUIZ] Mixed quiz generation failed:', llmErr);
        setFeedbackError(llmErrorToDutch(llmErr));
        return;
      }
      if (generated.length === 0) {
        setFeedbackError({ title: 'Er konden geen vragen worden samengesteld uit de geselecteerde bronnen.' });
        return;
      }
      setLastMixCounts(mixCounts);

      // Initialiseer antwoorden in de juiste shape
      const init: QuizAnswer[] = generated.map(q => {
        if (q.type === 'mcq') return { type: 'mcq', selectedIndex: -1, isCorrect: false } as MCQAnswer;
        return { type: q.type, text: '', evaluation: null } as FreeTextAnswer;
      });

      setQuestions(generated);
      setAnswers(init);
      setCurrentQuestion(0);
      setShowExplanation(false);
      setDraftText('');
      setEvalError(null);
      setState('ready');
    } catch (error) {
      console.error('Error generating quiz:', error);
      setFeedbackError({
        title: 'Er is een fout opgetreden bij het genereren van de quiz.',
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  const goToQuestion = (idx: number) => {
    setCurrentQuestion(idx);
    const a = answers[idx];
    if (!a) {
      setShowExplanation(false);
      setDraftText('');
    } else if (a.type === 'mcq') {
      setShowExplanation(a.selectedIndex !== -1);
      setDraftText('');
    } else {
      setShowExplanation(a.evaluation !== null);
      setDraftText(a.text || '');
    }
    setEvalError(null);
  };

  const handleSelectMCQ = (answerIndex: number) => {
    const q = questions[currentQuestion] as MCQQuestion;
    setAnswers(prev => {
      const next = [...prev];
      next[currentQuestion] = {
        type: 'mcq',
        selectedIndex: answerIndex,
        isCorrect: answerIndex === q.correctAnswer,
      };
      return next;
    });
    setShowExplanation(true);
  };

  const handleSubmitFreeText = async () => {
    const q = questions[currentQuestion];
    if (q.type === 'mcq') return;
    const text = draftText.trim();
    if (!text) {
      setEvalError({ title: 'Schrijf eerst een antwoord voor je inlevert.' });
      return;
    }

    setEvaluating(true);
    setEvalError(null);
    try {
      // Geef de beheerde "quiz_evaluate_open"-prompt mee als systemPersona
      // zodat docenten het beoordelingsgedrag (toon, rubriek-strengte, ...) via
      // de admin-UI kunnen bijsturen zonder code-wijziging.
      const quizPrompts = await fetchQuizPrompts();
      const evaluatorPrompt = quizPrompts.quiz_evaluate_open || undefined;
      const evaluation: AnswerEvaluation = q.type === 'open'
        ? await evaluateOpenAnswer(q as OpenQuestion, text, evaluatorPrompt)
        : await evaluateCasusAnswer(q as CasusQuestion, text, evaluatorPrompt);

      setAnswers(prev => {
        const next = [...prev];
        next[currentQuestion] = { type: q.type, text, evaluation };
        return next;
      });
      setShowExplanation(true);
    } catch (err) {
      console.error('[QUIZ] evaluation failed:', err);
      setEvalError(llmErrorToDutch(err));
    } finally {
      setEvaluating(false);
    }
  };

  const handleNextQuestion = () => {
    if (currentQuestion < questions.length - 1) {
      goToQuestion(currentQuestion + 1);
    } else {
      void handleFinishQuiz();
    }
  };

  const handlePreviousQuestion = () => {
    if (currentQuestion > 0) goToQuestion(currentQuestion - 1);
  };

  const computeScorePercentage = (qs: QuizQuestion[], ans: QuizAnswer[]): number => {
    if (qs.length === 0) return 0;
    let total = 0;
    let count = 0;
    for (let i = 0; i < qs.length; i++) {
      const a = ans[i];
      if (!a) continue;
      if (a.type === 'mcq') { total += a.isCorrect ? 100 : 0; count++; }
      else if (a.evaluation) { total += a.evaluation.score; count++; }
    }
    if (count === 0) return 0;
    return Math.round(total / count);
  };

  const handleFinishQuiz = async () => {
    const scorePct = computeScorePercentage(questions, answers);
    const correctCount = answers.filter(a => a && a.type === 'mcq' && a.isCorrect).length;

    if (profile) {
      const { error } = await supabase.from('quiz_attempts').insert({
        student_id: profile.id,
        topics: selectedTopics.map(t => t.name),
        difficulty,
        question_type: questionType,
        questions_data: questions,
        answers,
        score: questionType === 'mcq' ? correctCount : scorePct,
        total_questions: questions.length,
        score_percentage: scorePct,
      });
      if (error) {
        console.error('[QUIZ] insert quiz_attempt failed:', error);
        const isSchemaError = (error as any)?.code === '42703'
          || /column .* does not exist/i.test(error.message || '');
        // Niet blokkerend voor de UI — toon summary alsnog, maar geef hint.
        setFeedbackError({
          title: isSchemaError
            ? 'Je quiz kon niet in je geschiedenis worden opgeslagen omdat de quiz-database nog niet is bijgewerkt naar het nieuwe model.'
            : 'Je quiz kon niet in je geschiedenis worden opgeslagen.',
          detail: isSchemaError
            ? 'Vraag je beheerder om migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql in Supabase toe te passen.'
            : error.message,
        });
      }
    }

    setState('completed');
    void loadAttempts();
  };

  const handleRestart = () => {
    setState('setup');
    setQuestions([]);
    setAnswers([]);
    setCurrentQuestion(0);
    setShowExplanation(false);
    setDraftText('');
    setRagSources([]);
    setRagStats(null);
    setFeedbackError(null);
    setContextStats(null);
    setEvalError(null);
    setSetupValidationError(null);
    setSummaryStatus({ kind: 'idle' });
  };

  const handleSaveSummaryToJournal = async () => {
    if (savingSummary) return;
    setSavingSummary(true);
    setSummaryStatus({ kind: 'idle' });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authHeader = session ? `Bearer ${session.access_token}` : '';
      const scorePct = computeScorePercentage(questions, answers);

      const res = await fetch('/api/quiz/save-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({
          topics: selectedTopics.map(t => t.name),
          difficulty,
          questionType,
          questions,
          answers,
          scorePercentage: scorePct,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `Opslaan mislukt (${res.status})`);
      }

      const data = await res.json();
      setSummaryStatus({ kind: 'saved', journalEntryId: data.journalEntryId });
    } catch (err: any) {
      setSummaryStatus({ kind: 'error', message: err?.message || 'Onbekende fout' });
    } finally {
      setSavingSummary(false);
    }
  };

  const handleArchive = async (attemptId: string, generateSummary: boolean) => {
    setArchiving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authHeader = session ? `Bearer ${session.access_token}` : '';

      const res = await fetch('/api/quiz/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ attemptId, generateSummary }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Verwijderen mislukt (${res.status})`);
      }

      const result = await res.json();
      setAttempts(prev => prev.filter(a => a.id !== attemptId));
      if (expandedAttemptId === attemptId) setExpandedAttemptId(null);
      setArchiveDialog(null);

      if (generateSummary && result.summaryFailed) {
        alert('De quiz is verwijderd, maar de samenvatting kon niet in je leerdagboek worden opgeslagen. Probeer het later opnieuw.');
      }
    } catch (err: any) {
      alert(`Fout bij verwijderen: ${err.message}`);
    } finally {
      setArchiving(false);
    }
  };

  const currentQ = questions[currentQuestion];
  const currentAnswer = answers[currentQuestion];

  // ────────────────────────────────────────────────────────────
  // SETUP SCREEN
  // ────────────────────────────────────────────────────────────
  if (state === 'setup') {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Quiz</h1>
          <p className="text-gray-600">
            Kies één of meerdere onderwerpen en een vraagtype. De leerassistent genereert daar een quiz over,
            beoordeelt jouw open antwoorden met feedback + feed forward, en zet de afgeronde quiz onderaan deze pagina.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* SETUP LEFT COLUMN */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 p-6 space-y-6">
            <h2 className="text-xl font-bold text-gray-900">Nieuwe quiz starten</h2>

            {/* TOPICS */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Onderwerpen ({selectedTopicIds.size} geselecteerd)
              </label>

              {topicsLoading && (
                <p className="text-sm text-gray-500 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Onderwerpen laden…
                </p>
              )}

              {!topicsLoading && topicsError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {topicsError}
                  <button
                    onClick={() => void loadTopics()}
                    className="ml-2 underline hover:no-underline"
                    data-testid="button-topics-retry"
                  >
                    Opnieuw proberen
                  </button>
                </div>
              )}

              {!topicsLoading && !topicsError && availableTopics.length === 0 && (
                <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                  Voor deze cursus zijn nog geen onderwerpen beschikbaar. Vraag je docent om eerst begrippen toe te voegen.
                </p>
              )}

              {!topicsLoading && !topicsError && availableTopics.length > 0 && (
                <>
                  {topicsSource === 'global' && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-2">
                      Voor de actieve cursus zijn nog geen specifieke onderwerpen — je ziet nu de algemene lijst.
                    </p>
                  )}

                  <div className="relative mb-2">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={topicSearch}
                      onChange={e => setTopicSearch(e.target.value)}
                      placeholder="Zoek in onderwerpen…"
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-cyan-500 focus:border-transparent outline-none text-sm"
                      data-testid="input-topic-search"
                    />
                  </div>

                  <div
                    className="max-h-60 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 bg-white"
                    data-testid="list-quiz-topics"
                  >
                    {filteredTopics.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500">Geen onderwerpen gevonden voor "{topicSearch}".</div>
                    ) : filteredTopics.map(t => {
                      const checked = selectedTopicIds.has(t.id);
                      return (
                        <label
                          key={t.id}
                          className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${checked ? 'bg-cyan-50' : ''}`}
                          data-testid={`row-topic-${t.id}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTopic(t.id)}
                            className="w-4 h-4 accent-cyan-600"
                            data-testid={`checkbox-topic-${t.id}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">{t.name}</div>
                            {t.category && <div className="text-xs text-gray-500">{t.category}</div>}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {selectedTopics.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedTopics.map(t => (
                        <span
                          key={t.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-800 text-xs"
                          data-testid={`chip-selected-topic-${t.id}`}
                        >
                          {t.name}
                          <button
                            onClick={() => toggleTopic(t.id)}
                            className="hover:text-cyan-900"
                            aria-label={`Verwijder ${t.name}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {selectedTopics.length > 0 && (
                    <div className="mt-3 border border-gray-200 rounded-lg bg-gray-50 p-3" data-testid="panel-concept-availability">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-700">
                          Beschikbaar materiaal per begrip
                        </span>
                        {availabilityLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-500" />}
                      </div>
                      <ul className="space-y-1">
                        {selectedTopics.map(t => {
                          const a = conceptAvailability[t.id];
                          const ragCount = a?.rag_doc_count;
                          const ibCount = a?.itembank_question_count ?? 0;
                          const hasRag = (ragCount ?? 0) > 0;
                          const hasIb = ibCount > 0;
                          return (
                            <li
                              key={t.id}
                              className="flex items-center justify-between text-xs"
                              data-testid={`avail-row-${t.id}`}
                            >
                              <span className="text-gray-800 truncate flex-1 mr-2">{t.name}</span>
                              <span className="flex items-center gap-1.5">
                                <span
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${hasRag ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}
                                  title={ragCount === null ? 'Geen primaire RAG-folder gekoppeld' : `${ragCount} document(en) in primaire folder`}
                                  data-testid={`avail-rag-${t.id}`}
                                >
                                  RAG: {ragCount === null ? '—' : ragCount}
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${hasIb ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-600'}`}
                                  title={(() => {
                                    const mcq = a?.itembank_mcq_count ?? 0;
                                    const open = a?.itembank_open_count ?? 0;
                                    const split = (mcq > 0 || open > 0) ? ` (${mcq} mcq · ${open} open)` : '';
                                    return a?.itembank_count_truncated
                                      ? `Ten minste ${ibCount} ItemBank-vraag/vragen${split} — exacte telling beperkt door cap`
                                      : `${ibCount} ItemBank-vraag/vragen${split} via koppelingen`;
                                  })()}
                                  data-testid={`avail-itembank-${t.id}`}
                                >
                                  IB: {a?.itembank_count_truncated ? `≥${ibCount}` : ibCount}
                                </span>
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-100 text-violet-800"
                                  title="LLM-creatief is altijd beschikbaar — Groq genereert toepassings- en transfervragen zonder externe bron"
                                  data-testid={`avail-llm-${t.id}`}
                                >
                                  LLM
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="text-[11px] text-gray-500 mt-2">
                        Heeft een begrip "RAG: —"? Dan is er nog geen primaire cursus-folder gekoppeld
                        en valt de generator terug op de algemene cursus-mappen.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* QUESTION TYPE */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Vraagtype</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(Object.keys(QUESTION_TYPE_META) as QuestionType[]).map(t => {
                  const meta = QUESTION_TYPE_META[t];
                  const Icon = meta.icon;
                  const active = questionType === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setQuestionType(t)}
                      className={`text-left p-3 rounded-xl border-2 transition-all ${
                        active
                          ? 'border-cyan-500 bg-cyan-50'
                          : 'border-gray-200 hover:border-cyan-300 hover:bg-gray-50'
                      }`}
                      data-testid={`button-question-type-${t}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-5 h-5 ${active ? 'text-cyan-700' : 'text-gray-600'}`} />
                        <span className="font-semibold text-gray-900">{meta.label}</span>
                      </div>
                      <div className="text-xs text-gray-600">{meta.subtitle}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* DIFFICULTY */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Moeilijkheidsgraad</label>
              <div className="grid grid-cols-3 gap-3">
                {(['easy', 'medium', 'hard'] as const).map(level => (
                  <button
                    key={level}
                    onClick={() => setDifficulty(level)}
                    className={`px-4 py-3 rounded-lg font-medium transition-all ${
                      difficulty === level
                        ? 'bg-gradient-to-r from-cyan-500 to-cyan-600 text-white shadow-lg'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                    data-testid={`button-difficulty-${level}`}
                  >
                    {difficultyDutch(level)}
                  </button>
                ))}
              </div>
            </div>

            {/* NUM QUESTIONS */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Aantal vragen: {numQuestions}
              </label>
              <input
                type="range"
                min={3}
                max={questionType === 'mcq' ? 10 : 6}
                value={numQuestions}
                onChange={e => setNumQuestions(parseInt(e.target.value))}
                className="w-full"
                data-testid="input-num-questions"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>3</span>
                <span>{questionType === 'mcq' ? 10 : 6}</span>
              </div>
              {questionType !== 'mcq' && (
                <p className="text-xs text-gray-500 mt-1">
                  Voor open vragen en casussen blijft het aantal beperkt — elke vraag wordt door het taalmodel beoordeeld.
                </p>
              )}
            </div>

            <div>
              <RAGStatusIndicator strictMode={ragSettings.quiz.rag_strict_mode} />
            </div>

            {/* Bronnen-mix preview */}
            {(() => {
              const planned = distributeMix(numQuestions, sourceMix, questionType);
              const items: Array<{ key: QuizSource; n: number }> = [
                { key: 'rag', n: planned.rag },
                { key: 'itembank', n: planned.itembank },
                { key: 'llm', n: planned.llm },
              ].filter(x => x.n > 0);
              if (items.length === 0) return null;
              return (
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3" data-testid="block-mix-preview">
                  <div className="text-xs font-semibold text-gray-700 mb-2">Bronnen voor deze quiz</div>
                  <div className="flex flex-wrap gap-2">
                    {items.map(it => (
                      <span
                        key={it.key}
                        className={`text-xs px-2 py-1 rounded-full border ${SOURCE_COLORS[it.key]}`}
                        data-testid={`badge-mix-${it.key}`}
                      >
                        {SOURCE_LABELS[it.key]}: {it.n}
                      </span>
                    ))}
                  </div>
                  {questionType === 'casus' && sourceMix.pct_itembank > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      ItemBank bevat geen casussen — voor dit vraagtype wordt deze bron overgeslagen en aangevuld met creatieve LLM-vragen.
                    </p>
                  )}
                </div>
              );
            })()}

            {lastMixCounts && (lastMixCounts.itembank > 0 || lastMixCounts.rag > 0 || lastMixCounts.llm > 0) && (
              <div className="text-xs text-gray-600" data-testid="text-last-mix-counts">
                Vorige quiz bevatte: {lastMixCounts.rag} cursus · {lastMixCounts.itembank} ItemBank · {lastMixCounts.llm} creatief
              </div>
            )}

            {setupValidationError && (
              <p className="text-sm text-red-600" data-testid="text-setup-validation-error">
                {setupValidationError}
              </p>
            )}

            <button
              onClick={handleStartQuiz}
              disabled={loading || selectedTopicIds.size === 0}
              className="w-full px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              data-testid="button-generate-quiz"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  Quiz genereren en starten
                </>
              )}
            </button>

            {feedbackError && !loading && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5" data-testid="block-quiz-error">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-semibold text-red-900 mb-1">
                      Quiz kon niet gegenereerd worden
                    </h3>
                    <p className="text-red-800 text-sm mb-2" data-testid="text-quiz-error-title">
                      {feedbackError.title}
                    </p>
                    {feedbackError.detail && (
                      <details className="mb-3 group" data-testid="details-quiz-error">
                        <summary className="text-sm text-red-700 cursor-pointer select-none hover:underline">
                          Technische details
                        </summary>
                        <p
                          className="mt-2 text-xs text-red-700 bg-red-100/60 border border-red-200 rounded-md px-3 py-2 whitespace-pre-wrap font-mono"
                          data-testid="text-quiz-error-detail"
                        >
                          {feedbackError.detail}
                        </p>
                      </details>
                    )}
                    {contextStats && contextStats.total > 0 && (
                      <p className="text-xs text-red-700 mb-3" data-testid="text-quiz-context-stats-error">
                        {contextStats.used < contextStats.total
                          ? `${contextStats.used} van ${contextStats.total} gevonden passages waren meegestuurd (de rest is overgeslagen om de prompt onder de limiet te houden).`
                          : contextStats.charTrimmed
                            ? `Alle ${contextStats.total} gevonden passages zijn meegestuurd, maar de inhoud van een passage is ingekort om de prompt onder de limiet te houden.`
                            : `Alle ${contextStats.total} gevonden passages waren beschikbaar voor het taalmodel.`}
                      </p>
                    )}
                    <button
                      onClick={handleStartQuiz}
                      disabled={loading || selectedTopicIds.size === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed font-medium text-sm"
                      data-testid="button-quiz-retry"
                    >
                      <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                      Probeer opnieuw
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN: short hint card */}
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-2">Hoe werkt het?</h3>
              <ul className="text-sm text-gray-700 space-y-2 list-disc pl-4">
                <li>Bij <strong>meerkeuze</strong> krijg je per vraag direct correct/incorrect te zien.</li>
                <li>Bij <strong>open vragen</strong> typ je een antwoord; je krijgt feedback, feed forward en een score van 0–100.</li>
                <li>Bij <strong>casussen</strong> lees je eerst een korte probleemschets, en daarna geldt hetzelfde als bij open vragen.</li>
                <li>Afgeronde quizzes verschijnen onderaan deze pagina. Verwijderen kan altijd, eventueel met een notitie in je leerdagboek.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* RESULTATENLIJST onderaan */}
        <ResultsList
          attempts={attempts}
          loading={attemptsLoading}
          error={attemptsError}
          expandedId={expandedAttemptId}
          onToggleExpand={(id) => setExpandedAttemptId(prev => prev === id ? null : id)}
          onAskDelete={(row) => setArchiveDialog({ id: row.id, label: topicsLabelOf(row) })}
        />

        {/* ARCHIVE DIALOG */}
        {archiveDialog && (
          <ArchiveDialog
            label={archiveDialog.label}
            archiving={archiving}
            onClose={() => !archiving && setArchiveDialog(null)}
            onConfirm={(withSummary) => handleArchive(archiveDialog.id, withSummary)}
          />
        )}
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────
  // READY SCREEN
  // ────────────────────────────────────────────────────────────
  if (state === 'ready') {
    const topicsText = selectedTopics.map(t => t.name).join(', ');
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 space-y-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
            <Play className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Quiz klaar!</h1>
            <p className="text-gray-600">
              {questions.length} {QUESTION_TYPE_META[questionType].label.toLowerCase()}-vragen over <strong>{topicsText}</strong> — {difficultyDutch(difficulty)} niveau
            </p>
          </div>
          {ragSources.length > 0 && (
            <div className="text-left bg-purple-50 border border-purple-200 rounded-xl p-4">
              <SourceList sources={ragSources} label="Gebaseerd op cursusmateriaal" />
            </div>
          )}
          {contextStats && contextStats.total > 0 && (contextStats.used < contextStats.total || contextStats.charTrimmed) && (
            <p
              className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-left"
              data-testid="text-quiz-context-stats"
            >
              {contextStats.used < contextStats.total
                ? `Let op: ${contextStats.used} van ${contextStats.total} gevonden passages zijn meegestuurd naar het taalmodel (de hoogst-scorende eerst).`
                : `Let op: alle ${contextStats.total} gevonden passages zijn meegestuurd, maar de inhoud van een passage is ingekort om de prompt onder de limiet te houden.`}
            </p>
          )}
          {ragStats && (
            <div className="text-left">
              <RAGDiagnostics
                matchCount={ragSources.length}
                threshold={ragStats.threshold}
                maxSimilarity={ragStats.maxSimilarity}
                candidatesConsidered={ragStats.candidatesConsidered}
                searchPerformed={ragStats.searchPerformed}
                viewerRole={profile?.role}
              />
            </div>
          )}
          <button
            onClick={() => { setState('active'); goToQuestion(0); }}
            data-testid="button-start-quiz"
            className="inline-flex items-center gap-2 px-8 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg"
          >
            <Play className="w-5 h-5" />
            Quiz starten
          </button>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────
  // ACTIVE SCREEN
  // ────────────────────────────────────────────────────────────
  if (state === 'active' && currentQ) {
    const isMCQ = currentQ.type === 'mcq';
    const isFreeText = currentQ.type === 'open' || currentQ.type === 'casus';
    const isAnsweredMCQ = currentAnswer?.type === 'mcq' && currentAnswer.selectedIndex !== -1;
    const isEvaluatedFree = currentAnswer && currentAnswer.type !== 'mcq' && currentAnswer.evaluation !== null;
    const canGoNext = isMCQ ? isAnsweredMCQ : isEvaluatedFree;

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{selectedTopics.map(t => t.name).join(', ')}</h1>
            <p className="text-gray-600 text-sm">
              {QUESTION_TYPE_META[questionType].label} — {difficultyDutch(difficulty)} niveau
            </p>
            {ragSources.length > 0 && (
              <p className="text-xs text-purple-700 mt-1 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500" />
                Gebaseerd op {ragSources.length} bron{ragSources.length !== 1 ? 'nen' : ''} uit cursusmateriaal
              </p>
            )}
            {ragStats && (
              <div className="mt-1">
                <RAGDiagnostics
                  matchCount={ragSources.length}
                  threshold={ragStats.threshold}
                  maxSimilarity={ragStats.maxSimilarity}
                  candidatesConsidered={ragStats.candidatesConsidered}
                  searchPerformed={ragStats.searchPerformed}
                  viewerRole={profile?.role}
                />
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900">
              {currentQuestion + 1} / {questions.length}
            </div>
            <div className="text-sm text-gray-600">
              {answers.filter(a => (a.type === 'mcq' && a.selectedIndex !== -1) || (a.type !== 'mcq' && a.evaluation)).length} beantwoord
            </div>
          </div>
        </div>

        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-cyan-600 transition-all duration-300"
            style={{ width: `${((currentQuestion + 1) / questions.length) * 100}%` }}
          />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8 space-y-6">
          {/* Casus context bovenaan */}
          {currentQ.type === 'casus' && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900" data-testid="block-casus-context">
              <div className="font-semibold mb-1 text-amber-800">Casus</div>
              <p className="whitespace-pre-wrap">{currentQ.context}</p>
            </div>
          )}

          {/* Vraagregel */}
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center text-white font-bold flex-shrink-0">
              {currentQuestion + 1}
            </div>
            <div className="flex-1">
              {(currentQ as MCQQuestion).source && (
                <span
                  className={`inline-block text-xs px-2 py-0.5 rounded-full border mb-2 ${SOURCE_COLORS[(currentQ as MCQQuestion).source as QuizSource]}`}
                  data-testid={`badge-source-${(currentQ as MCQQuestion).source}`}
                >
                  {SOURCE_LABELS[(currentQ as MCQQuestion).source as QuizSource]}
                </span>
              )}
              <h2 className="text-xl font-semibold text-gray-900" data-testid="text-current-question">{currentQ.question}</h2>
            </div>
          </div>

          {/* MCQ opties */}
          {isMCQ && (
            <div className="space-y-3">
              {(currentQ as MCQQuestion).options.map((option, index) => {
                const a = currentAnswer as MCQAnswer | undefined;
                const isSelected = a?.selectedIndex === index;
                const isCorrectAnswer = index === (currentQ as MCQQuestion).correctAnswer;
                const showCorrect = isAnsweredMCQ && isCorrectAnswer;
                const showWrong = isAnsweredMCQ && isSelected && !isCorrectAnswer;

                return (
                  <button
                    key={index}
                    onClick={() => !isAnsweredMCQ && handleSelectMCQ(index)}
                    disabled={isAnsweredMCQ}
                    data-testid={`button-mcq-option-${index}`}
                    className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
                      showCorrect ? 'border-green-500 bg-green-50'
                        : showWrong ? 'border-red-500 bg-red-50'
                        : isSelected ? 'border-cyan-500 bg-cyan-50'
                        : 'border-gray-200 hover:border-cyan-300 hover:bg-gray-50'
                    } ${isAnsweredMCQ ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold ${
                          showCorrect ? 'bg-green-600 text-white'
                            : showWrong ? 'bg-red-600 text-white'
                            : isSelected ? 'bg-cyan-600 text-white'
                            : 'bg-gray-200 text-gray-700'
                        }`}>
                          {String.fromCharCode(65 + index)}
                        </div>
                        <span className="text-gray-900">{option}</span>
                      </div>
                      {showCorrect && <CheckCircle className="w-5 h-5 text-green-600" />}
                      {showWrong && <XCircle className="w-5 h-5 text-red-600" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* MCQ uitleg */}
          {isMCQ && showExplanation && currentAnswer?.type === 'mcq' && (
            <div className={`p-4 rounded-xl border-2 ${currentAnswer.isCorrect ? 'border-green-200 bg-green-50' : 'border-orange-200 bg-orange-50'}`}>
              <div className="flex items-start gap-3">
                {currentAnswer.isCorrect
                  ? <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  : <XCircle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />}
                <div>
                  <p className={`font-semibold mb-1 ${currentAnswer.isCorrect ? 'text-green-900' : 'text-orange-900'}`}>
                    {currentAnswer.isCorrect ? 'Correct!' : 'Helaas, dat is niet juist'}
                  </p>
                  <p className={`text-sm ${currentAnswer.isCorrect ? 'text-green-800' : 'text-orange-800'}`}>
                    {(currentQ as MCQQuestion).explanation}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Free-text antwoordveld */}
          {isFreeText && (
            <div className="space-y-3">
              <textarea
                value={draftText}
                onChange={e => setDraftText(e.target.value)}
                disabled={isEvaluatedFree || evaluating}
                placeholder="Schrijf hier jouw antwoord in volledige zinnen…"
                rows={6}
                className="w-full p-3 rounded-xl border-2 border-gray-200 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none disabled:bg-gray-50 disabled:text-gray-700 text-sm resize-y"
                data-testid="textarea-free-answer"
              />
              {!isEvaluatedFree && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSubmitFreeText}
                    disabled={evaluating || !draftText.trim()}
                    className="px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    data-testid="button-submit-free-answer"
                  >
                    {evaluating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                    Antwoord inleveren
                  </button>
                  {evaluating && <span className="text-sm text-gray-500">Bezig met beoordelen…</span>}
                </div>
              )}

              {evalError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4" data-testid="block-eval-error">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-red-900">Beoordeling mislukt</p>
                      <p className="text-sm text-red-800 mb-2">{evalError.title}</p>
                      {evalError.detail && (
                        <details className="text-xs text-red-700">
                          <summary className="cursor-pointer hover:underline">Technische details</summary>
                          <p className="mt-1 font-mono whitespace-pre-wrap bg-red-100/60 rounded-md px-2 py-1">{evalError.detail}</p>
                        </details>
                      )}
                      <button
                        onClick={handleSubmitFreeText}
                        className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
                        data-testid="button-eval-retry"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Opnieuw proberen
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {isEvaluatedFree && currentAnswer && currentAnswer.type !== 'mcq' && currentAnswer.evaluation && (
                <FreeTextEvaluationBlock evaluation={currentAnswer.evaluation} modelAnswer={(currentQ as OpenQuestion | CasusQuestion).modelAnswer} />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={handlePreviousQuestion}
            disabled={currentQuestion === 0}
            className="px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-prev-question"
          >
            Vorige
          </button>
          <button
            onClick={handleNextQuestion}
            disabled={!canGoNext}
            className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-next-question"
          >
            {currentQuestion === questions.length - 1 ? 'Afronden' : 'Volgende'}
          </button>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────
  // COMPLETED SCREEN
  // ────────────────────────────────────────────────────────────
  if (state === 'completed') {
    const percentage = computeScorePercentage(questions, answers);
    const passed = percentage >= 70;
    const topicsText = selectedTopics.map(t => t.name).join(', ');

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center space-y-6">
          <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center ${
            passed ? 'bg-gradient-to-br from-green-500 to-emerald-600' : 'bg-gradient-to-br from-orange-500 to-orange-600'
          }`}>
            <Award className="w-12 h-12 text-white" />
          </div>

          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Quiz voltooid!</h1>
            <p className="text-gray-600">Je hebt de quiz over "{topicsText}" afgerond</p>
          </div>

          <div className="inline-block px-8 py-6 bg-gray-50 rounded-2xl">
            <div className="text-6xl font-bold text-gray-900 mb-2" data-testid="text-final-score">{percentage}%</div>
            <div className="text-gray-600">{questions.length} vragen — {QUESTION_TYPE_META[questionType].label}</div>
          </div>

          <div className={`p-4 rounded-xl ${passed ? 'bg-green-50 border border-green-200' : 'bg-orange-50 border border-orange-200'}`}>
            <p className={`font-semibold ${passed ? 'text-green-900' : 'text-orange-900'}`}>
              {passed ? 'Goed gedaan! Je hebt de quiz succesvol afgerond.' : 'Blijf oefenen! Je hebt minimaal 70% nodig om te slagen.'}
            </p>
          </div>

          {feedbackError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-left">
              {feedbackError.title}{feedbackError.detail ? ` — ${feedbackError.detail}` : ''}
            </p>
          )}

          {/* Samenvatting-naar-leerdagboek status */}
          {summaryStatus.kind === 'saved' && (
            <div
              className="text-left bg-green-50 border border-green-200 rounded-xl p-4 flex items-start gap-3"
              data-testid="block-summary-saved"
            >
              <CheckCircle className="w-5 h-5 text-green-700 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold text-green-900 mb-0.5">Notitie opgeslagen in je leerdagboek</p>
                <p className="text-sm text-green-800">
                  Je kunt 'm later teruglezen op de pagina <a href="/feedback" className="underline hover:no-underline font-medium">Leer Dagboek</a>.
                </p>
              </div>
            </div>
          )}
          {summaryStatus.kind === 'error' && (
            <div
              className="text-left bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3"
              data-testid="block-summary-error"
            >
              <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold text-red-900 mb-0.5">Opslaan mislukt</p>
                <p className="text-sm text-red-800">{summaryStatus.message}</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 justify-center">
            {summaryStatus.kind !== 'saved' && (
              <button
                onClick={handleSaveSummaryToJournal}
                disabled={savingSummary}
                className="px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-save-summary"
              >
                {savingSummary ? <Loader2 className="w-5 h-5 animate-spin" /> : <BookText className="w-5 h-5" />}
                {savingSummary
                  ? 'Samenvatting wordt opgesteld…'
                  : summaryStatus.kind === 'error'
                    ? 'Opnieuw proberen'
                    : 'Bewaar samenvatting in leerdagboek'}
              </button>
            )}
            <button
              onClick={handleRestart}
              className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg flex items-center gap-2"
              data-testid="button-new-quiz"
            >
              <RotateCcw className="w-5 h-5" />
              Nieuwe quiz
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-cyan-600" />
            Antwoordenoverzicht
          </h2>
          <div className="space-y-4">
            {questions.map((q, index) => (
              <QuestionReviewCard key={index} index={index} question={q} answer={answers[index]} />
            ))}
          </div>
          {ragSources.length > 0 && (
            <div className="mt-2">
              <SourceList sources={ragSources} label="Quiz gebaseerd op cursusmateriaal" />
            </div>
          )}
          {ragStats && (
            <div className="mt-3">
              <RAGDiagnostics
                matchCount={ragSources.length}
                threshold={ragStats.threshold}
                maxSimilarity={ragStats.maxSimilarity}
                candidatesConsidered={ragStats.candidatesConsidered}
                searchPerformed={ragStats.searchPerformed}
                viewerRole={profile?.role}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// HELPER COMPONENTS (in dezelfde file conform fullstack-js skill)
// ────────────────────────────────────────────────────────────

function FreeTextEvaluationBlock({ evaluation, modelAnswer }: { evaluation: AnswerEvaluation; modelAnswer?: string }) {
  const passed = evaluation.score >= 70;
  return (
    <div className={`rounded-xl border-2 p-4 space-y-3 ${passed ? 'border-green-200 bg-green-50' : 'border-orange-200 bg-orange-50'}`} data-testid="block-free-evaluation">
      <div className="flex items-center justify-between">
        <div className={`text-sm font-semibold ${passed ? 'text-green-900' : 'text-orange-900'}`}>
          Beoordeling
        </div>
        <div
          className={`px-3 py-1 rounded-full text-sm font-bold ${passed ? 'bg-green-600 text-white' : 'bg-orange-600 text-white'}`}
          data-testid="text-eval-score"
        >
          {evaluation.score}/100
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-600 mb-1">Feedback</div>
        <p className="text-sm text-gray-900 whitespace-pre-wrap" data-testid="text-eval-feedback">{evaluation.feedback}</p>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-600 mb-1">Feed forward</div>
        <p className="text-sm text-gray-900 whitespace-pre-wrap" data-testid="text-eval-feedforward">{evaluation.feedforward}</p>
      </div>
      {modelAnswer && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-700 hover:underline">Voorbeeld-antwoord van het model</summary>
          <p className="mt-2 text-gray-800 whitespace-pre-wrap bg-white/70 border border-gray-200 rounded-md p-2">{modelAnswer}</p>
        </details>
      )}
    </div>
  );
}

function QuestionReviewCard({ index, question, answer }: { index: number; question: QuizQuestion; answer: QuizAnswer | undefined }) {
  if (question.type === 'mcq') {
    const a = answer && answer.type === 'mcq' ? answer : null;
    const isCorrect = !!a?.isCorrect;
    return (
      <div className={`p-4 rounded-xl border-2 ${isCorrect ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0 ${isCorrect ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
            {index + 1}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-900 mb-2">{question.question}</p>
            <div className="space-y-1 text-sm">
              <p className={isCorrect ? 'text-green-700' : 'text-red-700'}>
                <strong>Jouw antwoord:</strong> {a && a.selectedIndex >= 0 ? question.options[a.selectedIndex] : '(geen antwoord)'}
              </p>
              {!isCorrect && (
                <p className="text-green-700">
                  <strong>Correct antwoord:</strong> {question.options[question.correctAnswer]}
                </p>
              )}
              <p className="text-gray-700 mt-2"><strong>Uitleg:</strong> {question.explanation}</p>
            </div>
          </div>
          {isCorrect ? <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" /> : <XCircle className="w-6 h-6 text-red-600 flex-shrink-0" />}
        </div>
      </div>
    );
  }

  const a = answer && answer.type !== 'mcq' ? answer : null;
  const ev = a?.evaluation;
  const passed = ev ? ev.score >= 70 : false;
  return (
    <div className={`p-4 rounded-xl border-2 ${ev ? (passed ? 'border-green-200 bg-green-50' : 'border-orange-200 bg-orange-50') : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0 ${ev ? (passed ? 'bg-green-600 text-white' : 'bg-orange-600 text-white') : 'bg-gray-400 text-white'}`}>
          {index + 1}
        </div>
        <div className="flex-1 min-w-0">
          {question.type === 'casus' && (
            <p className="text-xs italic text-gray-600 mb-1 whitespace-pre-wrap"><strong>Casus:</strong> {question.context}</p>
          )}
          <p className="font-semibold text-gray-900 mb-2">{question.question}</p>
          <div className="space-y-1 text-sm">
            <p className="text-gray-800"><strong>Jouw antwoord:</strong> {(a?.text || '(geen antwoord)').trim()}</p>
            {ev && (
              <>
                <p className="text-gray-800"><strong>Score:</strong> {ev.score}/100</p>
                <p className="text-gray-800"><strong>Feedback:</strong> {ev.feedback}</p>
                <p className="text-gray-800"><strong>Feed forward:</strong> {ev.feedforward}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultsList({
  attempts, loading, error, expandedId, onToggleExpand, onAskDelete,
}: {
  attempts: QuizAttemptRow[];
  loading: boolean;
  error: string | null;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onAskDelete: (row: QuizAttemptRow) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6" data-testid="block-results-list">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-cyan-600" />
          Jouw afgeronde quizzes
        </h2>
        <span className="text-sm text-gray-500">{attempts.length} {attempts.length === 1 ? 'quiz' : 'quizzes'}</span>
      </div>

      {loading && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Laden…</p>}
      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>}

      {!loading && !error && attempts.length === 0 && (
        <p className="text-sm text-gray-500">Je hebt nog geen quizzes afgerond. Start hierboven je eerste quiz.</p>
      )}

      {!loading && !error && attempts.length > 0 && (
        <ul className="divide-y divide-gray-200">
          {attempts.map(row => {
            const expanded = expandedId === row.id;
            const score = row.score_percentage;
            return (
              <li key={row.id} className="py-3" data-testid={`row-attempt-${row.id}`}>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => onToggleExpand(row.id)}
                    className="flex-1 text-left flex items-center gap-3 hover:bg-gray-50 -mx-2 px-2 py-2 rounded-lg"
                    data-testid={`button-expand-attempt-${row.id}`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${
                      score == null ? 'bg-gray-400' : score >= 70 ? 'bg-green-600' : 'bg-orange-500'
                    }`}>
                      {score == null ? '–' : `${score}%`}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">{topicsLabelOf(row)}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                        <Calendar className="w-3 h-3" /> {formatDateTime(row.created_at)}
                        <span>•</span>
                        <span>{questionTypeDutch(row.question_type)}</span>
                        <span>•</span>
                        <span>{difficultyDutch(row.difficulty)}</span>
                        <span>•</span>
                        <span>{row.total_questions || 0} vragen</span>
                      </div>
                    </div>
                    {expanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
                  </button>
                  <button
                    onClick={() => onAskDelete(row)}
                    className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50"
                    title="Verwijder en eventueel notitie in leerdagboek opslaan"
                    data-testid={`button-delete-attempt-${row.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {expanded && (
                  <div className="mt-3 pl-13 ml-0 space-y-3" data-testid={`block-attempt-detail-${row.id}`}>
                    {(row.questions_data || []).map((q, idx) => (
                      <QuestionReviewCard
                        key={idx}
                        index={idx}
                        question={q}
                        answer={(row.answers || [])[idx]}
                      />
                    ))}
                    {(!row.questions_data || row.questions_data.length === 0) && (
                      <p className="text-sm text-gray-500">Geen detailgegevens beschikbaar voor deze quiz.</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ArchiveDialog({
  label, archiving, onClose, onConfirm,
}: {
  label: string;
  archiving: boolean;
  onClose: () => void;
  onConfirm: (withSummary: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-green-100 rounded-xl">
            <BookText className="w-5 h-5 text-green-700" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Verplaats naar leerdagboek</h2>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
            data-testid="btn-quiz-archive-cancel"
            disabled={archiving}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-2">
          Je staat op het punt de quiz <strong>"{label}"</strong> te verwijderen.
        </p>
        <p className="text-sm text-gray-600 mb-6">
          Wil je dat de leerassistent eerst een formatieve samenvatting van deze quiz opslaat in je leerdagboek?
          Die samenvatting bevat jouw resultaten, feedback en feed forward, en kun je later teruglezen om op te reflecteren.
        </p>

        <div className="flex flex-col gap-3">
          <button
            data-testid="btn-quiz-archive-with-summary"
            onClick={() => onConfirm(true)}
            disabled={archiving}
            className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
            Samenvatting opslaan en quiz verwijderen
          </button>

          <button
            data-testid="btn-quiz-archive-without-summary"
            onClick={() => onConfirm(false)}
            disabled={archiving}
            className="w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Alleen verwijderen (geen dagboekvermelding)
          </button>

          <button
            data-testid="btn-quiz-archive-dismiss"
            onClick={onClose}
            disabled={archiving}
            className="w-full px-4 py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Annuleren
          </button>
        </div>
      </div>
    </div>
  );
}
