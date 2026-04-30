import { useEffect, useMemo, useState } from 'react';
import { Save, Loader2, Sparkles, Database, FileText, FolderOpen, Trash2, Plus } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';

interface Concept {
  id: string;
  name: string;
  category?: string | null;
  course_id?: string | null;
}

interface ItembankSection {
  exsection_path: string[];
  count: number;
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
        .select('id, name, category, course_id, key_points')
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
        .from('folders')
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
      if (!res.ok) throw new Error(data.error || 'Opslaan mislukt');
      if (data.mix) setMix(data.mix);
      showMsg('success', 'Bronnen-mix opgeslagen.');
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : 'Onbekende fout');
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
      if (!res.ok) throw new Error(data.error || 'Opslaan mislukt');
      showMsg('success', `Koppelingen opgeslagen (${data.saved}).`);
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : 'Onbekende fout');
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
      if (!res.ok) throw new Error(data.error || 'Opslaan mislukt');
      showMsg('success', `RAG-koppelingen opgeslagen (${data.saved}).`);
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : 'Onbekende fout');
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
      if (!res.ok) throw new Error(data.error || 'Opslaan mislukt');
      showMsg('success', `Prompt "${PROMPT_LABELS[name] || name}" opgeslagen.`);
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : 'Onbekende fout');
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
        Selecteer eerst een actieve cursus om quiz-bronnen te beheren.
      </div>
    );
  }

  const mixSum = mix.pct_rag + mix.pct_itembank + mix.pct_llm;

  return (
    <div className="space-y-8" data-testid="panel-quiz-sources">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Quiz-bronnen voor {activeCourse?.name || 'cursus'}</h2>
        <p className="text-sm text-gray-600">
          Bepaal waar quizvragen vandaan komen: cursusmateriaal (RAG), de ShareStats-itembank, of vrij door het LLM gegenereerd.
          De mix-percentages, koppelingen aan begrippen en de prompts beheer je hier.
        </p>
      </div>

      {!schemaReady && (
        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-sm text-yellow-900">
          De database-migratie <code>20260430160000_quiz_sources_management.sql</code> is nog niet toegepast.
          Voer deze uit in het Supabase SQL-dashboard om quiz-bronnenbeheer te activeren.
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
          <Sparkles className="w-4 h-4" /> Bronnen-mix per cursus
        </h3>
        <p className="text-xs text-gray-600">
          Geef voor elke bron het percentage vragen in een quiz. De server normaliseert naar totaal 100%.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MixField label="RAG (cursusmateriaal)" value={mix.pct_rag} onChange={v => setMixField('pct_rag', v)} testId="input-mix-rag" />
          <MixField label="ItemBank" value={mix.pct_itembank} onChange={v => setMixField('pct_itembank', v)} testId="input-mix-itembank" />
          <MixField label="LLM-creatief" value={mix.pct_llm} onChange={v => setMixField('pct_llm', v)} testId="input-mix-llm" />
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${mixSum === 100 ? 'text-gray-500' : 'text-amber-700'}`} data-testid="text-mix-sum">
            Som: {mixSum}% {mixSum !== 100 && '(wordt genormaliseerd bij opslaan)'}
          </span>
          <button
            onClick={handleSaveMix}
            disabled={savingMix}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
            data-testid="button-save-mix"
          >
            <Save className="w-4 h-4" />
            {savingMix ? 'Opslaan...' : 'Mix opslaan'}
          </button>
        </div>
      </section>

      {/* ItemBank-mappings */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-itembank-mappings">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Database className="w-4 h-4" /> Koppeling begrip → ItemBank-sectie
        </h3>
        <p className="text-xs text-gray-600">
          Per begrip kun je één of meerdere itembank-secties (exsection-paden) koppelen. Vragen worden geselecteerd
          op exact prefix-match, dus een hoger niveau dekt automatisch alle onderliggende paden.
        </p>
        {sections.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            Geen itembank-secties beschikbaar. Importeer eerst items via "ShareStats Import".
          </p>
        ) : (
          <div className="space-y-3">
            {concepts.map(concept => {
              const conceptMappings = mappings.filter(m => m.concept_id === concept.id);
              return (
                <div key={concept.id} className="border border-gray-200 rounded-lg p-3" data-testid={`mapping-row-${concept.id}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="font-medium text-gray-900">{concept.name}</span>
                      {concept.category && <span className="ml-2 text-xs text-gray-500">{concept.category}</span>}
                    </div>
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
                      <option value="">+ koppel sectie...</option>
                      {sections.map((s, idx) => (
                        <option key={s.exsection_path.join('/')} value={idx}>
                          {s.exsection_path.join(' / ')} ({s.count})
                        </option>
                      ))}
                    </select>
                  </div>
                  {conceptMappings.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">Nog geen secties gekoppeld</p>
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
                              aria-label="Verwijder"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button
          onClick={handleSaveMappings}
          disabled={savingMappings}
          className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
          data-testid="button-save-mappings"
        >
          <Save className="w-4 h-4" />
          {savingMappings ? 'Opslaan...' : 'Koppelingen opslaan'}
        </button>
      </section>

      {/* RAG-folder mapping */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-rag-folder-mapping">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <FolderOpen className="w-4 h-4" /> Primaire RAG-folder per begrip
        </h3>
        <p className="text-xs text-gray-600">
          Koppel ieder begrip aan één primaire folder met cursusmateriaal. De RAG-bron van de quizgenerator zoekt eerst
          binnen deze folder; als er geen koppeling is, valt de zoekopdracht terug op de algemene RAG-instellingen van de cursus.
        </p>
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
                  <option value="">— geen folder —</option>
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
          {savingRag ? 'Opslaan...' : 'RAG-koppelingen opslaan'}
        </button>
      </section>

      {/* Quiz prompts */}
      <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-4" data-testid="section-quiz-prompts">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <FileText className="w-4 h-4" /> Quiz-prompts
        </h3>
        <p className="text-xs text-gray-600">
          Vier prompts sturen hoe de LLM-bron quizvragen genereert en hoe open antwoorden worden beoordeeld.
        </p>
        {prompts.length === 0 && !loading && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 inline-flex items-center gap-1">
            <Plus className="w-3 h-3" /> Quiz-prompts worden bij eerste server-start automatisch aangemaakt — herstart de server als ze niet verschijnen.
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
                {savingPromptName === p.name ? 'Opslaan...' : 'Opslaan'}
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
