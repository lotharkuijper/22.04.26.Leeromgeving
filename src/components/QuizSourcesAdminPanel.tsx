import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Save, Loader2, Sparkles, Database, FileText, FolderOpen, Trash2, Plus, Lightbulb, Search, Wand2, Upload, BarChart3, CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react';
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

interface BulkCandidate {
  exsection_path: string[];
  count: number;
  mcq_count: number;
  open_count: number;
  similarity: number;
  above_threshold: boolean;
  already_linked: boolean;
}

interface BulkResult {
  conceptId: string;
  conceptName: string;
  currentMappings: string[][];
  candidates: BulkCandidate[];
}

interface CsvImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
  totalRows: number;
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
  // Onderscheid een opgeslagen mix van de hardcoded standaard. `false` = er is
  // (nog) geen rij voor deze cursus, dus de getoonde 50:0:50 is slechts een
  // standaard en niet wat de docent ooit heeft bewaard.
  const [mixConfigured, setMixConfigured] = useState(false);
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

  // Automatische bulk-matching: één klik koppelt alle begrippen aan de
  // semantisch dichtstbijzijnde itembank-secties. De docent reviewt het
  // voorstel (drempel + checkboxes) en past geaccepteerde koppelingen toe.
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
  const [bulkThreshold, setBulkThreshold] = useState(0.35);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());

  // CSV-import van een eigen itembank (bron-agnostisch).
  const [csvText, setCsvText] = useState('');
  const [csvLabel, setCsvLabel] = useState('');
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [showCsvHelp, setShowCsvHelp] = useState(false);

  // Inklapbare grote overzichtsblokken — standaard ingeklapt zodat de pagina
  // binnen één scherm past.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    coverage: true,
    itembankSections: true,
    prompts: true,
  });
  const toggleCollapsed = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

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
    // Reset cursus-specifieke staat zodat waarden van een vorige cursus (of een
    // mislukte load) niet blijven hangen tijdens het wisselen.
    setMix({ pct_rag: 50, pct_itembank: 0, pct_llm: 50 });
    setMixConfigured(false);
    try {
      // Concepten van de cursus. Schema-bewust: sommige Supabase-instances
      // hebben de `concepts.course_id`-migratie wél (dan staat de koppeling in
      // de kolom), andere niet (dan loopt de koppeling via de `key_points`-
      // marker `course_id:<uuid>`). We proberen daarom eerst mét `course_id` en
      // vallen bij een ontbrekende kolom (PostgREST 400) terug op de variant
      // zónder, zodat er nooit nul begrippen laden. Het filter hieronder dekt
      // beide modi.
      let conceptRows: any[] | null = null;
      let hasCourseIdCol = true;
      {
        const withCol = await supabase
          .from('concepts')
          .select('id, name, category, course_id, key_points, definition')
          .order('name');
        if (withCol.error) {
          hasCourseIdCol = false;
          const fallback = await supabase
            .from('concepts')
            .select('id, name, category, key_points, definition')
            .order('name');
          if (fallback.error) {
            showMsg('error', t('admin.quizSources.conceptsLoadFailed', { error: fallback.error.message }));
          }
          conceptRows = fallback.data || [];
        } else {
          conceptRows = withCol.data || [];
        }
      }
      const courseMarker = `course_id:${courseId}`;
      const filtered = (conceptRows || []).filter((c: any) => {
        if (hasCourseIdCol && c.course_id === courseId) return true;
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
        const secRes = await fetch(`/api/admin/itembank-sections?courseId=${encodeURIComponent(courseId)}`, { headers });
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
          // `updated_at` is alleen aanwezig als er echt een opgeslagen rij is.
          setMixConfigured(!!mixData.updated_at);
        } else {
          const errData = await mixRes.json().catch(() => null);
          showMsg('error', t('admin.quizSources.mixLoadFailed', { error: errData?.error || String(mixRes.status) }));
        }
      } catch (err) {
        showMsg('error', t('admin.quizSources.mixLoadFailed', { error: err instanceof Error ? err.message : 'network' }));
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
      setMixConfigured(true);
      showMsg('success', t('admin.quizSources.mixSaved'));
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.unknownError'));
    }
    setSavingMix(false);
  }

  async function handleSaveMappings() {
    if (!activeCourseId) return;
    // Voeg eerst de groen gevinkte bulk-voorstellen samen met de bestaande
    // mappings; daarna persisteren we alles in één keer. Zo doet één knop
    // ("Koppelingen opslaan") zowel het vastleggen als het opslaan.
    let merged = mappings;
    if (bulkResults) {
      const additions: ItembankMapping[] = [];
      const has = (cid: string, pathKey: string) =>
        merged.some(m => m.concept_id === cid && m.exsection_path.join('/') === pathKey)
        || additions.some(m => m.concept_id === cid && m.exsection_path.join('/') === pathKey);
      for (const r of bulkResults) {
        for (const cand of r.candidates) {
          const pathKey = cand.exsection_path.join('/');
          if (!bulkSelected.has(`${r.conceptId}|${pathKey}`)) continue;
          if (!has(r.conceptId, pathKey)) {
            additions.push({ concept_id: r.conceptId, exsection_path: cand.exsection_path });
          }
        }
      }
      if (additions.length > 0) {
        merged = [...merged, ...additions];
        setMappings(merged);
      }
      setBulkResults(null);
      setBulkSelected(new Set());
    }
    setSavingMappings(true);
    try {
      const res = await fetch(`/api/admin/itembank-mappings/${activeCourseId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mappings: merged }),
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
          courseId: activeCourseId,
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

  // Live dekkings-overzicht: per begrip het aantal gekoppelde itembank-vragen,
  // berekend uit de huidige (nog niet opgeslagen) mappings + de secties. Spiegelt
  // de server-prefix-match: een mapping-pad dekt alle secties die ermee beginnen.
  const coverage = useMemo(() => {
    const norm = (p: string[]) => p.map(s => String(s ?? '').toLowerCase().trim());
    return concepts.map(c => {
      const cms = mappings.filter(m => m.concept_id === c.id);
      let total = 0, mcq = 0, open = 0;
      if (cms.length > 0) {
        const normMaps = cms.map(m => norm(m.exsection_path));
        for (const s of sections) {
          const sp = norm(s.exsection_path);
          const hit = normMaps.some(mp => mp.length <= sp.length && mp.every((seg, i) => seg === sp[i]));
          if (hit) {
            total += s.count;
            mcq += s.mcq_count ?? 0;
            open += s.open_count ?? 0;
          }
        }
      }
      return { id: c.id, name: c.name, total, mcq, open, linked: cms.length > 0 };
    });
  }, [concepts, mappings, sections]);

  const coverageGaps = coverage.filter(c => c.total === 0).length;

  async function handleBulkMatch() {
    if (!activeCourseId) return;
    setBulkLoading(true);
    try {
      const res = await fetch('/api/admin/itembank-bulk-match', {
        method: 'POST',
        headers,
        body: JSON.stringify({ courseId: activeCourseId, threshold: bulkThreshold, topN: 3 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.quizSources.bulk.error'));
      const results = (data.results || []) as BulkResult[];
      // De standaard-selectie wordt door een effect afgeleid van de actieve
      // drempel (zie hieronder), zodat het schuiven van de drempel de groene
      // vinkjes live bijwerkt zonder opnieuw te hoeven matchen.
      setBulkResults(results);
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.bulk.error'));
    }
    setBulkLoading(false);
  }

  // Houd de standaard-selectie gelijk met de actieve drempel: elke kandidaat
  // met voldoende overeenkomst (similarity ≥ drempel) staat groen aangevinkt,
  // óók al-gekoppelde. Het verschuiven van de drempel werkt de vinkjes direct
  // bij; al-gekoppelde koppelingen blijven idempotent bij het vastleggen.
  useEffect(() => {
    if (!bulkResults) return;
    const sel = new Set<string>();
    for (const r of bulkResults) {
      for (const cand of r.candidates) {
        if (cand.similarity >= bulkThreshold) {
          sel.add(`${r.conceptId}|${cand.exsection_path.join('/')}`);
        }
      }
    }
    setBulkSelected(sel);
  }, [bulkResults, bulkThreshold]);

  function toggleBulkSelect(conceptId: string, pathKey: string) {
    setBulkSelected(prev => {
      const next = new Set(prev);
      const key = `${conceptId}|${pathKey}`;
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }


  async function handleImportCsv() {
    if (!activeCourseId) return;
    setCsvImporting(true);
    setCsvResult(null);
    try {
      const res = await fetch('/api/admin/itembank/import-csv', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          courseId: activeCourseId,
          csvText,
          courseLabel: csvLabel.trim() || activeCourse?.name || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (Array.isArray(data.errors)) setCsvResult({ imported: 0, skipped: data.errors.length, errors: data.errors, totalRows: data.totalRows ?? 0 });
        throw new Error(data.error || t('admin.quizSources.csv.error'));
      }
      setCsvResult(data as CsvImportResult);
      setCsvText('');
      showMsg('success', t('admin.quizSources.csv.imported', { count: String(data.imported) }));
      // Secties herladen zodat de nieuwe CSV-secties direct koppelbaar zijn.
      try {
        const secRes = await fetch(`/api/admin/itembank-sections?courseId=${encodeURIComponent(activeCourseId)}`, { headers });
        if (secRes.ok) {
          const secData = await secRes.json();
          setSections(secData.sections || []);
        }
      } catch { /* niet kritiek */ }
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : t('admin.quizSources.csv.error'));
    }
    setCsvImporting(false);
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
  // Spiegelt server-`normalizeMix`: zo ziet de docent vóór het opslaan welke
  // percentages er straks echt worden bewaard (de getypte waarden veranderen
  // dus niet "vanzelf" na de klik).
  const normalizedMix = (() => {
    const r0 = Math.max(0, Math.min(100, mix.pct_rag || 0));
    const i0 = Math.max(0, Math.min(100, mix.pct_itembank || 0));
    const l0 = Math.max(0, Math.min(100, mix.pct_llm || 0));
    const sum = r0 + i0 + l0;
    if (sum === 0) return { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };
    if (sum === 100) return { pct_rag: r0, pct_itembank: i0, pct_llm: l0 };
    const r = Math.round((r0 * 100) / sum);
    const i = Math.round((i0 * 100) / sum);
    return { pct_rag: r, pct_itembank: i, pct_llm: 100 - r - i };
  })();

  return (
    <div className="space-y-5" data-testid="panel-quiz-sources">
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
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-source-mix">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4" /> {t('admin.quizSources.mix.title')}
          {mixConfigured ? (
            <span className="ml-2 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700" data-testid="badge-mix-configured">
              {t('admin.quizSources.mix.savedBadge')}
            </span>
          ) : (
            <span className="ml-2 text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-500" data-testid="badge-mix-default">
              {t('admin.quizSources.mix.defaultBadge')}
            </span>
          )}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.mix.desc')}</p>
        {!mixConfigured && (
          <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-2" data-testid="text-mix-default-hint">
            {t('admin.quizSources.mix.defaultHint')}
          </p>
        )}
        <div className="space-y-2">
          <MixField label={t('admin.quizSources.mix.rag')} value={mix.pct_rag} onChange={v => setMixField('pct_rag', v)} testId="input-mix-rag" />
          <MixField label="ItemBank" value={mix.pct_itembank} onChange={v => setMixField('pct_itembank', v)} testId="input-mix-itembank" />
          <MixField label={t('admin.quizSources.mix.llm')} value={mix.pct_llm} onChange={v => setMixField('pct_llm', v)} testId="input-mix-llm" />
        </div>
        {mixSum !== 100 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2" data-testid="text-mix-normalized-preview">
            {t('admin.quizSources.mix.normalizedPreview', {
              rag: String(normalizedMix.pct_rag),
              itembank: String(normalizedMix.pct_itembank),
              llm: String(normalizedMix.pct_llm),
            })}
          </p>
        )}
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

      {/* Dekkings-overzicht */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-coverage">
        <h3 className="font-semibold text-gray-900">
          <button
            type="button"
            onClick={() => toggleCollapsed('coverage')}
            className="flex items-center gap-2 w-full text-left"
            aria-expanded={!collapsed.coverage}
            title={collapsed.coverage ? t('admin.quizSources.toggleExpand') : t('admin.quizSources.toggleCollapse')}
            data-testid="button-toggle-coverage"
          >
            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${collapsed.coverage ? '-rotate-90' : ''}`} />
            <BarChart3 className="w-4 h-4" /> {t('admin.quizSources.coverage.title')}
            {coverage.length > 0 && coverageGaps > 0 && (
              <span className="ml-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700" data-testid="badge-coverage-gaps">
                {t('admin.quizSources.coverage.gapsBadge', { count: String(coverageGaps) })}
              </span>
            )}
          </button>
        </h3>
        {!collapsed.coverage && (<>
        <p className="text-xs text-gray-600">{t('admin.quizSources.coverage.desc')}</p>
        {coverage.length === 0 ? null : coverageGaps > 0 ? (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 inline-flex items-center gap-1" data-testid="text-coverage-gaps">
            <AlertCircle className="w-3.5 h-3.5" /> {t('admin.quizSources.coverage.gaps', { count: String(coverageGaps) })}
          </p>
        ) : (
          <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2 inline-flex items-center gap-1" data-testid="text-coverage-ok">
            <CheckCircle2 className="w-3.5 h-3.5" /> {t('admin.quizSources.coverage.allCovered')}
          </p>
        )}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{t('admin.quizSources.coverage.conceptCol')}</th>
                  <th className="text-right px-3 py-2 font-medium w-20">{t('admin.quizSources.itembank.totalCol')}</th>
                  <th className="text-right px-3 py-2 font-medium w-16">MCQ</th>
                  <th className="text-right px-3 py-2 font-medium w-16">Open</th>
                </tr>
              </thead>
              <tbody>
                {coverage.length === 0 ? (
                  <tr data-testid="row-coverage-empty">
                    <td colSpan={4} className="px-3 py-4 text-center text-gray-500">{t('admin.quizSources.coverage.empty')}</td>
                  </tr>
                ) : (
                  coverage.map(c => (
                    <tr key={c.id} className={`border-t border-gray-100 ${c.total === 0 ? 'bg-amber-50' : ''}`} data-testid={`row-coverage-${c.id}`}>
                      <td className="px-3 py-1.5 text-gray-800">{c.name}</td>
                      <td className={`px-3 py-1.5 text-right font-medium ${c.total === 0 ? 'text-amber-700' : 'text-gray-800'}`} data-testid={`text-coverage-total-${c.id}`}>{c.total}</td>
                      <td className={`px-3 py-1.5 text-right ${c.mcq === 0 ? 'text-gray-400' : 'text-gray-700'}`}>{c.mcq}</td>
                      <td className={`px-3 py-1.5 text-right ${c.open === 0 ? 'text-gray-400' : 'text-gray-700'}`}>{c.open}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        </>)}
      </section>

      {/* ItemBank-mappings */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-itembank-mappings">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Database className="w-4 h-4" /> {t('admin.quizSources.itembank.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.itembank.desc')}</p>

        {/* Automatische bulk-matching */}
        {sections.length > 0 && (
          <div className="border border-violet-200 bg-violet-50 rounded-lg p-3 space-y-3" data-testid="block-bulk-match">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px]">
                <p className="text-sm font-semibold text-violet-900 inline-flex items-center gap-1">
                  <Wand2 className="w-4 h-4" /> {t('admin.quizSources.bulk.title')}
                </p>
                <p className="text-[11px] text-violet-800 mt-0.5">{t('admin.quizSources.bulk.desc')}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-3">
                  <label className="text-[11px] text-violet-900 inline-flex items-center gap-2">
                    {t('admin.quizSources.bulk.threshold', { pct: (bulkThreshold * 100).toFixed(0) })}
                    <input
                      type="range"
                      min={0.2}
                      max={0.7}
                      step={0.05}
                      value={bulkThreshold}
                      onChange={e => setBulkThreshold(Number(e.target.value))}
                      className="w-28"
                      data-testid="input-bulk-threshold"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleBulkMatch}
                    disabled={bulkLoading}
                    className="px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1"
                    data-testid="button-bulk-match"
                  >
                    {bulkLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                    {bulkLoading ? t('admin.quizSources.bulk.running') : t('admin.quizSources.bulk.run')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleSaveMappings}
                  disabled={savingMappings}
                  className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center justify-center gap-1"
                  data-testid="button-save-mappings"
                >
                  {savingMappings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  {savingMappings ? t('admin.quizSources.itembank.saving') : t('admin.quizSources.itembank.save')}
                </button>
              </div>
            </div>

            {bulkResults && (
              <div className="space-y-2" data-testid="bulk-match-results">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-violet-800">
                    {t('admin.quizSources.bulk.selectedInfo', { count: String(bulkSelected.size) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setBulkResults(null); setBulkSelected(new Set()); }}
                    className="text-[11px] text-violet-700 hover:text-violet-900"
                    data-testid="button-bulk-dismiss"
                  >
                    {t('admin.quizSources.bulk.dismiss')}
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {bulkResults.filter(r => r.candidates.length > 0).map(r => (
                    <div key={r.conceptId} className="bg-white border border-violet-100 rounded p-2" data-testid={`bulk-concept-${r.conceptId}`}>
                      <p className="text-xs font-semibold text-gray-900 mb-1">{r.conceptName}</p>
                      <ul className="space-y-1">
                        {r.candidates.map(cand => {
                          const pathKey = cand.exsection_path.join('/');
                          const selKey = `${r.conceptId}|${pathKey}`;
                          const isStrong = cand.similarity >= bulkThreshold;
                          return (
                            <li key={pathKey} className="flex items-center gap-2 text-[11px]" data-testid={`bulk-cand-${r.conceptId}-${pathKey}`}>
                              <input
                                type="checkbox"
                                checked={bulkSelected.has(selKey)}
                                onChange={() => toggleBulkSelect(r.conceptId, pathKey)}
                                className="accent-emerald-600"
                                data-testid={`checkbox-bulk-${r.conceptId}-${pathKey}`}
                              />
                              <span className="flex-1 min-w-0 truncate text-gray-800">{cand.exsection_path.join(' / ')}</span>
                              <span className={`px-1.5 py-0.5 rounded whitespace-nowrap ${isStrong ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-500'}`} data-testid={`text-bulk-sim-${r.conceptId}-${pathKey}`}>
                                {(cand.similarity * 100).toFixed(0)}% · {isStrong ? t('admin.quizSources.bulk.strongLabel') : t('admin.quizSources.bulk.weakLabel')}
                              </span>
                              <span className="text-gray-500 w-24 text-right">
                                {t('admin.quizSources.bulk.itemInfo', { count: String(cand.count), mcq: String(cand.mcq_count), open: String(cand.open_count) })}
                              </span>
                              {cand.already_linked && (
                                <span className="text-violet-600">{t('admin.quizSources.itembank.alreadyLinked')}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {sections.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            {t('admin.quizSources.itembank.noSections')}
          </p>
        ) : (
          <>
            <div className="border border-gray-200 rounded-lg overflow-hidden" data-testid="table-itembank-sections-overview">
              <button
                type="button"
                onClick={() => toggleCollapsed('itembankSections')}
                className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-700 text-left hover:bg-gray-100"
                aria-expanded={!collapsed.itembankSections}
                title={collapsed.itembankSections ? t('admin.quizSources.toggleExpand') : t('admin.quizSources.toggleCollapse')}
                data-testid="button-toggle-itembank-sections"
              >
                <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${collapsed.itembankSections ? '-rotate-90' : ''}`} />
                {t('admin.quizSources.itembank.available', { count: String(sections.length) })}
              </button>
              {!collapsed.itembankSections && (
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
              )}
            </div>
          <ConceptAccordion concepts={concepts} testIdPrefix="itembank" renderConcept={concept => {
              const conceptMappings = mappings.filter(m => m.concept_id === concept.id);
              return (
                <div key={concept.id} className="border border-gray-200 rounded-lg p-3 max-w-xl" data-testid={`mapping-row-${concept.id}`}>
                  <div className="mb-2 min-w-0">
                    <span className="font-medium text-gray-900 break-words">{concept.name}</span>
                    {concept.category && <span className="ml-2 text-xs text-gray-500">{concept.category}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
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
                      className="text-xs border border-gray-300 rounded px-2 py-1 max-w-[12rem]"
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
            }} />
          </>
        )}
      </section>

      {/* CSV-import eigen itembank */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-csv-import">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Upload className="w-4 h-4" /> {t('admin.quizSources.csv.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.csv.desc')}</p>
        <button
          type="button"
          onClick={() => setShowCsvHelp(v => !v)}
          className="text-xs text-sky-700 hover:text-sky-900 underline"
          data-testid="button-csv-help-toggle"
        >
          {showCsvHelp ? t('admin.quizSources.csv.hideHelp') : t('admin.quizSources.csv.showHelp')}
        </button>
        {showCsvHelp && (
          <div className="text-[11px] bg-sky-50 border border-sky-200 rounded p-3 space-y-1 text-sky-900" data-testid="block-csv-help">
            <p>{t('admin.quizSources.csv.helpIntro')}</p>
            <pre className="bg-white border border-sky-100 rounded p-2 overflow-x-auto whitespace-pre">{t('admin.quizSources.csv.helpFormat')}</pre>
            <p>{t('admin.quizSources.csv.helpNote')}</p>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('admin.quizSources.csv.labelField')}</label>
          <input
            type="text"
            value={csvLabel}
            onChange={e => setCsvLabel(e.target.value)}
            placeholder={activeCourse?.name || t('admin.quizSources.csv.labelPlaceholder')}
            className="w-full max-w-sm px-3 py-1.5 border border-gray-300 rounded text-xs"
            data-testid="input-csv-label"
          />
          <p className="text-[11px] text-gray-500 mt-1">{t('admin.quizSources.csv.labelHint')}</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('admin.quizSources.csv.textField')}</label>
          <textarea
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            rows={8}
            placeholder={t('admin.quizSources.csv.textPlaceholder')}
            className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs"
            data-testid="textarea-csv-text"
          />
        </div>
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async e => {
              const file = e.target.files?.[0];
              if (file) setCsvText(await file.text());
              e.target.value = '';
            }}
            className="text-xs"
            data-testid="input-csv-file"
          />
          <button
            type="button"
            onClick={handleImportCsv}
            disabled={csvImporting || csvText.trim().length === 0}
            className="px-4 py-2 bg-sky-600 text-white text-sm font-medium rounded-lg hover:bg-sky-700 disabled:opacity-50 inline-flex items-center gap-2"
            data-testid="button-csv-import"
          >
            {csvImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {csvImporting ? t('admin.quizSources.csv.importing') : t('admin.quizSources.csv.import')}
          </button>
        </div>
        {csvResult && (
          <div className="text-xs border border-gray-200 rounded p-3 space-y-1" data-testid="block-csv-result">
            <p className="text-emerald-800 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {t('admin.quizSources.csv.resultImported', { count: String(csvResult.imported), total: String(csvResult.totalRows) })}
            </p>
            {csvResult.skipped > 0 && (
              <div className="text-amber-800">
                <p className="inline-flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> {t('admin.quizSources.csv.resultSkipped', { count: String(csvResult.skipped) })}</p>
                <ul className="mt-1 ml-4 list-disc text-[11px] text-amber-700">
                  {csvResult.errors.slice(0, 10).map((er, i) => (
                    <li key={i} data-testid={`text-csv-error-${i}`}>{t('admin.quizSources.csv.rowError', { row: String(er.row), reason: er.reason })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* RAG-folder mapping */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-rag-folder-mapping">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <FolderOpen className="w-4 h-4" /> {t('admin.quizSources.rag.title')}
        </h3>
        <p className="text-xs text-gray-600">{t('admin.quizSources.rag.desc')}</p>
        <ConceptAccordion concepts={concepts} testIdPrefix="rag" renderConcept={concept => {
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
          }} />
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
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3" data-testid="section-quiz-prompts">
        <h3 className="font-semibold text-gray-900">
          <button
            type="button"
            onClick={() => toggleCollapsed('prompts')}
            className="flex items-center gap-2 w-full text-left"
            aria-expanded={!collapsed.prompts}
            title={collapsed.prompts ? t('admin.quizSources.toggleExpand') : t('admin.quizSources.toggleCollapse')}
            data-testid="button-toggle-prompts"
          >
            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${collapsed.prompts ? '-rotate-90' : ''}`} />
            <FileText className="w-4 h-4" /> {t('admin.quizSources.prompts.title')}
          </button>
        </h3>
        {!collapsed.prompts && (<>
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
        </>)}
      </section>
    </div>
  );
}

function MixField({ label, value, onChange, testId }: { label: string; value: number; onChange: (v: number) => void; testId: string }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs font-medium text-gray-700 w-44 shrink-0">{label}</label>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={e => onChange(parseInt(e.target.value, 10))}
        className="w-44 max-w-full"
        data-testid={testId}
      />
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
        className="w-14 px-2 py-1 text-xs border border-gray-300 rounded"
        data-testid={`${testId}-number`}
      />
      <span className="text-xs text-gray-500">%</span>
    </div>
  );
}

function groupConceptsByLetter(concepts: Concept[]): { letter: string; items: Concept[] }[] {
  const map = new Map<string, Concept[]>();
  const sorted = [...concepts].sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));
  for (const c of sorted) {
    const first = (c.name.trim()[0] || '#').toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : '#';
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter)!.push(c);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, items]) => ({ letter, items }));
}

function ConceptAccordion({
  concepts,
  renderConcept,
  testIdPrefix,
}: {
  concepts: Concept[];
  renderConcept: (concept: Concept) => ReactNode;
  testIdPrefix: string;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState('');
  const [openLetters, setOpenLetters] = useState<Set<string>>(new Set());

  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const filtered = useMemo(
    () => (searching ? concepts.filter(c => c.name.toLowerCase().includes(q)) : concepts),
    [concepts, q, searching]
  );
  const groups = useMemo(() => groupConceptsByLetter(filtered), [filtered]);

  const toggleLetter = (letter: string) =>
    setOpenLetters(prev => {
      const next = new Set(prev);
      if (next.has(letter)) next.delete(letter);
      else next.add(letter);
      return next;
    });
  const isOpen = (letter: string) => searching || openLetters.has(letter);

  return (
    <div className="space-y-2" data-testid={`accordion-${testIdPrefix}`}>
      <div className="relative max-w-xs">
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('admin.quizSources.search.placeholder')}
          className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded text-xs"
          data-testid={`input-search-${testIdPrefix}`}
        />
      </div>
      {groups.length === 0 ? (
        <p className="text-xs text-gray-500 italic" data-testid={`text-no-results-${testIdPrefix}`}>
          {t('admin.quizSources.search.noResults', { q: search.trim() })}
        </p>
      ) : (
        <div className="space-y-1.5">
          {groups.map(g => {
            const open = isOpen(g.letter);
            return (
              <div key={g.letter} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleLetter(g.letter)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-left"
                  aria-expanded={open}
                  title={open ? t('admin.quizSources.toggleCollapse') : t('admin.quizSources.toggleExpand')}
                  data-testid={`button-group-${testIdPrefix}-${g.letter}`}
                >
                  <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? '' : '-rotate-90'}`} />
                  <span className="font-semibold text-gray-800 text-sm">{g.letter}</span>
                  <span className="text-[11px] text-gray-500">{g.items.length}</span>
                </button>
                {open && (
                  <div className="p-2 space-y-2" data-testid={`group-body-${testIdPrefix}-${g.letter}`}>
                    {g.items.map(renderConcept)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
