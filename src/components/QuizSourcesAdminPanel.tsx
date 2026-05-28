import { useEffect, useMemo, useState } from 'react';
import { Save, Loader2, Sparkles, Database, FileText, FolderOpen, Trash2, Plus, Lightbulb, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';

interface Concept {
  id: string;
  name: string;
  category?: string | null;
  course_id?: string | null;
  definition?: string | null;
}

interface MappingSuggestion {
  exsection_path: string[];
  count: number;
  similarity: number;
}

interface DiagnoseCandidate {
  exsection_path: string[];
  count: number;
  mcq_count: number;
  open_count: number;
  matched_tokens: string[];
  score: number;
}

interface DiagnoseResult {
  current_mappings: string[][];
  tokens_used: string[];
  tokens_truncated: boolean;
  total_sections_scanned: number;
  candidates: DiagnoseCandidate[];
}

interface ItembankSection {
  exsection_path: string[];
  count: number;
  mcq_count?: number;
  open_count?: number;
  topic?: string | null;
}

interface ItembankMapping {
  id?: string;
  concept_id: string;
  exsection_path: string[];
}

interface RagSource {
  id?: string;
  concept_id: string;
  folder_id: string | null;
}

interface SourceMix {
  pct_rag: number;
  pct_itembank: number;
  pct_llm: number;
}

interface QuizPrompt {
  id?: string;
  name: string;
  content: string;
  is_active?: boolean;
}

interface FolderRow {
  id: string;
  name: string;
}

const PROMPT_LABELS: Record<string, string> = {
  quiz_generate_strict: 'Strikt (alleen RAG)',
  quiz_generate_blended: 'Gemengd (RAG + algemene kennis)',
  quiz_generate_creative: 'Creatief (transfer/casus)',
  quiz_evaluate_open: 'Beoordelen open antwoorden',
};

export function QuizSourcesAdminPanel() {
  const { session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(false);
  const [savingMix, setSavingMix] = useState(false);
  const [savingMappings, setSavingMappings] = useState(false);
  const [savingRag, setSavingRag] = useState(false);
  const [savingPromptName, setSavingPromptName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [schemaReady, setSchemaReady] = useState(true);

  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [sections, setSections] = useState<ItembankSection[]>([]);

  const [mix, setMix] = useState<SourceMix>({ pct_rag: 50, pct_itembank: 0, pct_llm: 50 });
  const [mappings, setMappings] = useState<ItembankMapping[]>([]);
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [prompts, setPrompts] = useState<QuizPrompt[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});

  // Embedding-gebaseerde mapping-suggesties per concept (Task #57). De docent
  // klikt op "Stel mapping voor" en krijgt de top-3 itembank-secties die qua
  // betekenis het dichtst bij het begrip liggen, klaar om met één klik
  // toe te voegen aan de huidige mappings.
  const [suggestionsByConcept, setSuggestionsByConcept] = useState<Record<string, MappingSuggestion[]>>({});
  const [suggestingConceptId, setSuggestingConceptId] = useState<string | null>(null);

  // Fase 1: deterministische diagnose — toont per begrip welke ShareStats-
  // secties (case-insensitief, op begripsnaam + queryExpansion-synoniemen)
  // zouden matchen. Geen LLM/embedding-call, puur substring-scoring.
  const [diagnoseByConcept, setDiagnoseByConcept] = useState<Record<string, DiagnoseResult>>({});
  const [diagnosingConceptId, setDiagnosingConceptId] = useState<string | null>(null);

  const headers = useMemo(
    () =>
      session?.access_token
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }
        : { 'Content-Type': 'application/json' },
    [session?.access_token]
  );

  useEffect(() => {
    if (!activeCourseId) return;
    void loadAll(activeCourseId);
  }, [activeCourseId, session?.access_token]);

  function showMsg(type: 'success' | 'error', text: string) {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  }

  async function loadAll(courseId: string) {
    setLoading(true);
    try {
      // Concepten van de cursus
      const { data: conceptRows } = await supabase
        .from('concepts')
        .select('id, name, category, course_id, key_points, definition')
        .order('name');
      const courseMarker = `course_id:${courseId}`;
      const filtered = (conceptRows || []).filter((c: any) => {
        if (c.course_id === courseId) return true;
        if ((c.key_points || []).includes(courseMarker)) return true;
        if (!c.course_id && !(c.key_points || []).some((kp: string) => kp.startsWith('course_id:'))) return true;
        return false;
      });
      setConcepts(filtered);

      // Folders voor RAG-koppeling
      const { data: folderRows } = await supabase
        .from('document_folders')
        .select('id, name')
        .order('name');
      setFolders(folderRows || []);

      // Itembank-secties
      try {
        const secRes = await fetch('/api/admin/itembank-sections', { headers });
        const secData = await secRes.json();
        if (secRes.status === 503) {
          setSchemaReady(false);
        } else if (secRes.ok) {
          setSchemaReady(true);
          setSections(secData.sections || []);
        }
      } catch {
        // niet kritiek
      }

      // Mix
      try {
        const mixRes = await fetch(`/api/quiz-sources-mix/${courseId}`, { headers });
        if (mixRes.ok) {
          const mixData = await mixRes.json();
          setSchemaReady(mixData.schema_ready !== false);
          if (mixData.mix) setMix(mixData.mix);
        }
      } catch {
        /* niet kritiek */
      }

      // Mappings
      try {
        const mapRes = await fetch(`/api/admin/itembank-mappings/${courseId}`, { headers });
        if (mapRes.ok) {
          const mapData = await mapRes.json();
          setMappings(mapData.mappings || []);
        }
      } catch {
        /* niet kritiek */
      }

      // RAG sources
      try {
        const ragRes = await fetch(`/api/admin/concept-rag-sources/${courseId}`, { headers });
        if (ragRes.ok) {
          const ragData = await ragRes.json();
          setRagSources(ragData.sources || []);
        }
      } catch {
        /* niet kritiek */
      }

      // Quiz-prompts
      try {
        const promptRes = await fetch('/api/admin/quiz-prompts', { headers });
        if (promptRes.ok) {
          const promptData = await promptRes.json();
          const list = (promptData.prompts || []) as QuizPrompt[];
          setPrompts(list);
          const drafts: Record<string, string> = {};
          for (const p of list) drafts[p.name] = p.content;
          setPromptDrafts(drafts);
        }
      } catch {
        /* niet kritiek */
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveMix() {
    if (!activeCourseId) return;
    setSavingMix(true);
    try {
      const res = await fetch(`/api/admin/quiz-sources-mix/${activeCourseId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(mix),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.saveFailed'));
      if (data.mix) setMix(data.mix);
      showMsg('success', t('admin.quizSources.mixSaved'));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.unknownError'));
    }
    setSavingMix(false);
  }

  async function handleSaveMappings() {
    if (!activeCourseId) return;
    setSavingMappings(true);
    try {
      const res = await fetch(`/api/admin/itembank-mappings/${activeCourseId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mappings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.saveFailed'));
      showMsg('success', t('admin.quizSources.mappingsSaved', { saved: String(data.saved) }));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.unknownError'));
    }
    setSavingMappings(false);
  }

  async function handleSaveRagSources() {
    if (!activeCourseId) return;
    setSavingRag(true);
    try {
      const res = await fetch(`/api/admin/concept-rag-sources/${activeCourseId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ sources: ragSources.filter(s => s.folder_id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.saveFailed'));
      showMsg('success', t('admin.quizSources.ragLinksSaved', { saved: String(data.saved) }));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.unknownError'));
    }
    setSavingRag(false);
  }

  async function handleSavePrompt(name: string) {
    setSavingPromptName(name);
    try {
      const res = await fetch(`/api/admin/quiz-prompts/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: promptDrafts[name] || '', is_active: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.saveFailed'));
      showMsg('success', t('admin.quizSources.promptSaved', { label: PROMPT_LABELS[name] || name }));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.unknownError'));
    }
    setSavingPromptName(null);
  }

  function setMixField(field: keyof SourceMix, value: number) {
    setMix(prev => ({ ...prev, [field]: Math.max(0, Math.min(100, value)) }));
  }

  function addMapping(conceptId: string, sectionPath: string[]) {
    if (!sectionPath || sectionPath.length === 0) return;
    setMappings(prev => {
      const exists = prev.some(
        m => m.concept_id === conceptId && m.exsection_path.join('/') === sectionPath.join('/')
      );
      if (exists) return prev;
      return [...prev, { concept_id: conceptId, exsection_path: sectionPath }];
    });
  }

  function removeMapping(conceptId: string, pathKey: string) {
    setMappings(prev => prev.filter(m => !(m.concept_id === conceptId && m.exsection_path.join('/') === pathKey)));
  }

  async function handleSuggestMappings(concept: Concept) {
    setSuggestingConceptId(concept.id);
    try {
      const res = await fetch('/api/admin/itembank-mapping-suggestions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conceptName: concept.name,
          conceptDefinition: concept.definition || null,
          topN: 3,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.suggestFailed'));
      setSuggestionsByConcept(prev => ({ ...prev, [concept.id]: data.suggestions || [] }));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.suggestError'));
    }
    setSuggestingConceptId(null);
  }

  function dismissSuggestions(conceptId: string) {
    setSuggestionsByConcept(prev => {
      const next = { ...prev };
      delete next[conceptId];
      return next;
    });
  }

  async function handleDiagnose(concept: Concept) {
    if (!activeCourseId) return;
    setDiagnosingConceptId(concept.id);
    try {
      const res = await fetch('/api/admin/itembank-mapping-diagnose', {
        method: 'POST',
        headers,
        body: JSON.stringify({ conceptId: concept.id, courseId: activeCourseId, topN: 8 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.itembank.diagnoseError'));
      setDiagnoseByConcept(prev => ({ ...prev, [concept.id]: data as DiagnoseResult }));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.itembank.diagnoseError'));
    }
    setDiagnosingConceptId(null);
  }

  function dismissDiagnose(conceptId: string) {
    setDiagnoseByConcept(prev => {
      const next = { ...prev };
      delete next[conceptId];
      return next;
    });
  }

  function setRagFolder(conceptId: string, folderId: string) {
    setRagSources(prev => {
      const others = prev.filter(s => s.concept_id !== conceptId);
      if (!folderId) return others;
      return [...others, { concept_id: conceptId, folder_id: folderId }];
    });
  }

  if (!activeCourseId) {
    return (
      <div className="p-6 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
        {t('admin.quizSources.selectCourseFirst')}
      </div>
    );
  }

  const mixSum = mix.pct_rag + mix.pct_itembank + mix.pct_llm;

  return (
    <div className="space-y-8" data-testid="panel-quiz-sources">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-lg font-bold text-gray-900 mb-1">{t('admin.quizSources.title', { name: activeCourse?.name || '' })}</h2>
        <p className="text-sm text-gray-600">{t('admin.quizSources.desc')}</p>
      </div>

      {!schemaReady && (
        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-sm text-yellow-900">
          {t('admin.quizSources.schemaNotReady')}
        </div>
      )}

      {msg && (
        <div className={`rounded-lg px-4 py-2 text-sm ${msg.type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
          {msg.text}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      )}

      {/* Mix-sliders */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-source-mix">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4" /> {t('admin.quizSources.mix.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.mix.desc')}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MixField label={t('admin.quizSources.mix.rag')} value={mix.pct_rag} onChange={v => setMixField('pct_rag', v)} testId="input-mix-rag" />
          <MixField label="ItemBank" value={mix.pct_itembank} onChange={v => setMixField('pct_itembank', v)} testId="input-mix-itembank" />
          <MixField label={t('admin.quizSources.mix.llm')} value={mix.pct_llm} onChange={v => setMixField('pct_llm', v)} testId="input-mix-llm" />
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${mixSum === 100 ? 'text-gray-500' : 'text-amber-700'}`} data-testid="text-mix-sum">
            {t('admin.quizSources.mix.sum', { sum: String(mixSum) })} {mixSum !== 100 && t('admin.quizSources.mix.normalized')}
          </span>
          <button
            onClick={handleSaveMix}
            disabled={savingMix}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
            data-testid="button-save-mix"
          >
            <Save className="w-4 h-4" />
            {savingMix ? t('admin.quizSources.mix.saving') : t('admin.quizSources.mix.save')}
          </button>
        </div>
      </section>

      {/* ItemBank-mappings */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-itembank-mappings">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Database className="w-4 h-4" /> {t('admin.quizSources.itembank.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.itembank.desc')}</p>
        {sections.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            {t('admin.quizSources.itembank.noSections')}
          </p>
        ) : (
          <>
            <div className="border border-gray-200 rounded-lg overflow-hidden" data-testid="table-itembank-sections-overview">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-700">
                {t('admin.quizSources.itembank.available', { count: String(sections.length) })}
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">{t('admin.quizSources.itembank.sectionCol')}</th>
                      <th className="text-right px-3 py-2 font-medium w-16">{t('admin.quizSources.itembank.totalCol')}</th>
                      <th className="text-right px-3 py-2 font-medium w-16">MCQ</th>
                      <th className="text-right px-3 py-2 font-medium w-16">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sections.map(s => {
                      const key = s.exsection_path.join('/');
                      const mcq = s.mcq_count ?? 0;
                      const open = s.open_count ?? 0;
                      return (
                        <tr key={key} className="border-t border-gray-100" data-testid={`row-section-${key}`}>
                          <td className="px-3 py-1.5 text-gray-800">{s.exsection_path.join(' / ')}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700" data-testid={`text-section-total-${key}`}>{s.count}</td>
                          <td className={`px-3 py-1.5 text-right ${mcq === 0 ? 'text-gray-400' : 'text-gray-700'}`} data-testid={`text-section-mcq-${key}`}>{mcq}</td>
                          <td className={`px-3 py-1.5 text-right ${open === 0 ? 'text-gray-400' : 'text-gray-700'}`} data-testid={`text-section-open-${key}`}>{open}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          <div className="space-y-3">
            {concepts.map(concept => {
              const conceptMappings = mappings.filter(m => m.concept_id === concept.id);
              return (
                <div key={concept.id} className="border border-gray-200 rounded-lg p-3" data-testid={`mapping-row-${concept.id}`}>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-900">{concept.name}</span>
                      {concept.category && <span className="ml-2 text-xs text-gray-500">{concept.category}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSuggestMappings(concept)}
                        disabled={suggestingConceptId === concept.id}
                        className="px-2 py-1 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded text-xs text-amber-900 inline-flex items-center gap-1 disabled:opacity-50"
                        data-testid={`button-suggest-mapping-${concept.id}`}
                      >
                        {suggestingConceptId === concept.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lightbulb className="w-3 h-3" />
                        )}
                        {t('admin.quizSources.itembank.suggestMapping')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDiagnose(concept)}
                        disabled={diagnosingConceptId === concept.id}
                        className="px-2 py-1 bg-sky-50 border border-sky-200 hover:bg-sky-100 rounded text-xs text-sky-900 inline-flex items-center gap-1 disabled:opacity-50"
                        data-testid={`button-diagnose-mapping-${concept.id}`}
                      >
                        {diagnosingConceptId === concept.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Search className="w-3 h-3" />
                        )}
                        {t('admin.quizSources.itembank.diagnoseButton')}
                      </button>
                      <select
                        onChange={e => {
                          const idx = parseInt(e.target.value, 10);
                          if (!Number.isNaN(idx) && sections[idx]) {
                            addMapping(concept.id, sections[idx].exsection_path);
                            e.target.value = '';
                          }
                        }}
                        className="text-xs border border-gray-300 rounded px-2 py-1"
                        defaultValue=""
                        data-testid={`select-section-${concept.id}`}
                      >
                        <option value="">{t('admin.quizSources.itembank.linkSection')}</option>
                        {sections.map((s, idx) => {
                          const mcq = s.mcq_count ?? 0;
                          const open = s.open_count ?? 0;
                          return (
                            <option key={s.exsection_path.join('/')} value={idx}>
                              {s.exsection_path.join(' / ')} ({s.count} · {mcq} mcq / {open} open)
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </div>
                  {conceptMappings.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">{t('admin.quizSources.itembank.noSectionsLinked')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {conceptMappings.map(m => {
                        const key = m.exsection_path.join('/');
                        return (
                          <span
                            key={key}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900"
                            data-testid={`mapping-tag-${concept.id}-${key}`}
                          >
                            {m.exsection_path.join(' / ')}
                            <button
                              onClick={() => removeMapping(concept.id, key)}
                              className="hover:text-red-600"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {diagnoseByConcept[concept.id] && (
                    <div className="mt-3 p-2 bg-sky-50 border border-sky-200 rounded" data-testid={`diagnose-${concept.id}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-sky-900 inline-flex items-center gap-1">
                          <Search className="w-3 h-3" /> {t('admin.quizSources.itembank.diagnoseTitle')}
                        </span>
                        <button
                          type="button"
                          onClick={() => dismissDiagnose(concept.id)}
                          className="text-xs text-sky-700 hover:text-sky-900"
                          data-testid={`button-dismiss-diagnose-${concept.id}`}
                        >
                          {t('admin.quizSources.itembank.suggestionsClose')}
                        </button>
                      </div>
                      <p className="text-[11px] text-sky-800 mb-1" data-testid={`text-diagnose-scanned-${concept.id}`}>
                        {t('admin.quizSources.itembank.diagnoseScanned', { count: String(diagnoseByConcept[concept.id].total_sections_scanned) })}
                      </p>
                      <p className="text-[11px] text-sky-700 mb-2 italic">
                        {t('admin.quizSources.itembank.diagnoseTokens', {
                          count: String(diagnoseByConcept[concept.id].tokens_used.length),
                          list: diagnoseByConcept[concept.id].tokens_used.join(', ') + (diagnoseByConcept[concept.id].tokens_truncated ? ' …' : ''),
                        })}
                      </p>
                      {diagnoseByConcept[concept.id].candidates.length === 0 ? (
                        <p className="text-xs text-sky-800 italic">{t('admin.quizSources.itembank.diagnoseNone')}</p>
                      ) : (
                        <ul className="space-y-1">
                          {diagnoseByConcept[concept.id].candidates.map(c => {
                            const pathKey = c.exsection_path.join('/');
                            const already = mappings.some(
                              m => m.concept_id === concept.id && m.exsection_path.join('/') === pathKey
                            );
                            return (
                              <li
                                key={pathKey}
                                className="flex items-center justify-between gap-2 text-xs"
                                data-testid={`diagnose-hit-${concept.id}-${pathKey}`}
                              >
                                <span className="text-sky-900 flex-1 min-w-0">
                                  <span className="font-medium">{c.exsection_path.join(' / ')}</span>
                                  <span className="ml-2 text-sky-700">
                                    {t('admin.quizSources.itembank.diagnoseHit', {
                                      count: String(c.count),
                                      mcq: String(c.mcq_count),
                                      open: String(c.open_count),
                                      tokens: String(c.score),
                                      matched: c.matched_tokens.join(', '),
                                    })}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  onClick={() => addMapping(concept.id, c.exsection_path)}
                                  disabled={already}
                                  className="px-2 py-0.5 bg-sky-200 text-sky-900 rounded hover:bg-sky-300 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                                  data-testid={`button-add-diagnose-${concept.id}-${pathKey}`}
                                >
                                  <Plus className="w-3 h-3" />
                                  {already ? t('admin.quizSources.itembank.alreadyLinked') : t('admin.quizSources.itembank.addSuggestion')}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  {suggestionsByConcept[concept.id] && (
                    <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded" data-testid={`suggestions-${concept.id}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-amber-900 inline-flex items-center gap-1">
                          <Lightbulb className="w-3 h-3" /> {t('admin.quizSources.itembank.suggestionsTitle')}
                        </span>
                        <button
                          type="button"
                          onClick={() => dismissSuggestions(concept.id)}
                          className="text-xs text-amber-700 hover:text-amber-900"
                        >
                          {t('admin.quizSources.itembank.suggestionsClose')}
                        </button>
                      </div>
                      {suggestionsByConcept[concept.id].length === 0 ? (
                        <p className="text-xs text-amber-800 italic">{t('admin.quizSources.itembank.suggestionsNone')}</p>
                      ) : (
                        <ul className="space-y-1">
                          {suggestionsByConcept[concept.id].map(s => {
                            const pathKey = s.exsection_path.join('/');
                            const already = mappings.some(
                              m => m.concept_id === concept.id && m.exsection_path.join('/') === pathKey
                            );
                            return (
                              <li
                                key={pathKey}
                                className="flex items-center justify-between gap-2 text-xs"
                                data-testid={`suggestion-${concept.id}-${pathKey}`}
                              >
                                <span className="text-amber-900 flex-1 truncate">
                                  {s.exsection_path.join(' / ')}
                                  <span className="ml-2 text-amber-700">
                                    ({t('admin.quizSources.itembank.suggestionInfo', { count: String(s.count), pct: (s.similarity * 100).toFixed(0) })})
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  onClick={() => addMapping(concept.id, s.exsection_path)}
                                  disabled={already}
                                  className="px-2 py-0.5 bg-amber-200 text-amber-900 rounded hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                                  data-testid={`button-add-suggestion-${concept.id}-${pathKey}`}
                                >
                                  <Plus className="w-3 h-3" />
                                  {already ? t('admin.quizSources.itembank.alreadyLinked') : t('admin.quizSources.itembank.addSuggestion')}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </>
        )}
        <button
          onClick={handleSaveMappings}
          disabled={savingMappings}
          className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
          data-testid="button-save-mappings"
        >
          <Save className="w-4 h-4" />
          {savingMappings ? t('admin.quizSources.itembank.saving') : t('admin.quizSources.itembank.save')}
        </button>
      </section>

      {/* RAG-folder mapping */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-rag-folder-mapping">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <FolderOpen className="w-4 h-4" /> {t('admin.quizSources.rag.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.rag.desc')}</p>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {concepts.map(concept => {
            const current = ragSources.find(s => s.concept_id === concept.id);
            return (
              <div key={concept.id} className="flex items-center gap-3 p-2 border border-gray-100 rounded">
                <span className="flex-1 text-sm text-gray-800">{concept.name}</span>
                <select
                  value={current?.folder_id || ''}
                  onChange={e => setRagFolder(concept.id, e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 max-w-xs"
                  data-testid={`select-rag-folder-${concept.id}`}
                >
                  <option value="">{t('admin.quizSources.rag.noFolder')}</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <button
          onClick={handleSaveRagSources}
          disabled={savingRag}
          className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
          data-testid="button-save-rag-sources"
        >
          <Save className="w-4 h-4" />
          {savingRag ? t('admin.quizSources.rag.saving') : t('admin.quizSources.rag.save')}
        </button>
      </section>

      {/* Quiz prompts */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-quiz-prompts">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <FileText className="w-4 h-4" /> {t('admin.quizSources.prompts.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.prompts.desc')}</p>
        {prompts.length === 0 && !loading && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 inline-flex items-center gap-1">
            <Plus className="w-3 h-3" /> {t('admin.quizSources.prompts.noPrompts')}
          </p>
        )}
        {prompts.map(p => (
          <div key={p.name} className="border border-gray-200 rounded-lg p-3" data-testid={`prompt-row-${p.name}`}>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-900">{PROMPT_LABELS[p.name] || p.name}</h4>
              <button
                onClick={() => handleSavePrompt(p.name)}
                disabled={savingPromptName === p.name}
                className="px-3 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-800 disabled:opacity-50 flex items-center gap-1"
                data-testid={`button-save-prompt-${p.name}`}
              >
                <Save className="w-3 h-3" />
                {savingPromptName === p.name ? t('admin.quizSources.prompts.saving') : t('admin.quizSources.prompts.save')}
              </button>
            </div>
            <textarea
              value={promptDrafts[p.name] || ''}
              onChange={e => setPromptDrafts(prev => ({ ...prev, [p.name]: e.target.value }))}
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs"
              data-testid={`textarea-prompt-${p.name}`}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

function MixField({ label, value, onChange, testId }: { label: string; value: number; onChange: (v: number) => void; testId: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={e => onChange(parseInt(e.target.value, 10))}
          className="flex-1"
          data-testid={testId}
        />
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
          className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
        />
        <span className="text-xs text-gray-500">%</span>
      </div>
    </div>
  );
}
