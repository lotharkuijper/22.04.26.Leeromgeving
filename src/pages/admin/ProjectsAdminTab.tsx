import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { supabase } from '../../lib/supabase';
import { Plus, Save, Trash2, FolderOpen, Settings, X, ArrowLeft, Paperclip, Loader2, FileText, Copy, ShieldAlert, Database, Download, Eye, EyeOff, Wrench } from 'lucide-react';

interface ProjectRow {
  id: string;
  title: string;
  research_question: string;
  description: string | null;
  briefing_markdown: string | null;
  goals: string | null;
  rubric_criteria: any[];
  course_id: string | null;
  min_group_size: number | null;
  max_group_size: number | null;
  allow_self_signup: boolean | null;
  status: string | null;
  created_at: string;
}

interface ProjectPersona {
  id: string;
  project_id: string;
  source_persona_id: string | null;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  sort_order: number;
  persona_type?: string;
}

interface ProjectDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  mime_type?: string | null;
  document_ref_id?: string | null;
  is_visible_to_students: boolean;
  uploaded_by: string | null;
  created_at: string;
}

interface RubricDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  is_hidden_rubric?: boolean;
  created_at: string;
}

const UPLOAD_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.log,.pdf,.docx,.pptx,.xlsx,.odt,.ods,.odp';
// Projectdocumenten mogen óók binaire datasets zijn (Jamovi .omv etc.) die
// studenten alleen downloaden — niet als chat-context worden gebruikt.
const PROJECT_DOC_ACCEPT = UPLOAD_ACCEPT + ',.omv,.omt,.sav,.jasp,.rdata,.rds,.sps,.dta';

interface MigrateResult {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export function ProjectsAdminTab() {
  const { session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [editing, setEditing] = useState<Partial<ProjectRow> | null>(null);
  const [rubricLines, setRubricLines] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [detailProject, setDetailProject] = useState<ProjectRow | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null);

  const load = useCallback(async () => {
    let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (activeCourseId) q = q.eq('course_id', activeCourseId);
    const { data, error: e } = await q;
    if (e) setError(e.message); else setProjects((data as any) || []);
  }, [activeCourseId]);

  useEffect(() => { load(); }, [load]);

  const runMigration = async () => {
    if (!session?.access_token) return;
    setMigrating(true);
    setMigrateResult(null);
    setError(null);
    try {
      const r = await fetch('/api/admin/migrate-project-docs-subfolders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Migratie mislukt');
      setMigrateResult(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setMigrating(false);
    }
  };

  const startEdit = (p: Partial<ProjectRow> | null) => {
    if (p) {
      setEditing(p);
      setRubricLines((p.rubric_criteria || []).map((c: any) => typeof c === 'string' ? c : (c.title || c.name || '')).join('\n'));
    } else {
      setEditing({
        title: '', research_question: '', briefing_markdown: '', goals: '',
        rubric_criteria: [], min_group_size: 1, max_group_size: 5, allow_self_signup: true,
        course_id: activeCourseId || null, status: 'active',
      });
      setRubricLines('');
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.title?.trim() || !editing.research_question?.trim()) {
      setError('Titel en onderzoeksvraag zijn verplicht');
      return;
    }
    setSaving(true);
    setError(null);
    const rubric = rubricLines.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ title: s }));
    const payload = {
      title: editing.title.trim(),
      research_question: editing.research_question.trim(),
      description: editing.description || null,
      briefing_markdown: editing.briefing_markdown || null,
      goals: editing.goals || null,
      rubric_criteria: rubric,
      course_id: editing.course_id || activeCourseId || null,
      min_group_size: editing.min_group_size ?? 1,
      max_group_size: editing.max_group_size ?? 5,
      allow_self_signup: editing.allow_self_signup ?? true,
      status: editing.status || 'active',
    };
    if ((payload.min_group_size as number) > (payload.max_group_size as number)) {
      setError('Minimum groepsgrootte mag niet groter zijn dan het maximum');
      setSaving(false); return;
    }
    try {
      if (editing.id) {
        const { error: e } = await supabase.from('projects').update(payload).eq('id', editing.id);
        if (e) throw new Error(e.message);
      } else {
        const { error: e } = await supabase.from('projects').insert(payload);
        if (e) throw new Error(e.message);
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Verwijder dit project? Groepen, chats en checkpoints worden ook verwijderd.')) return;
    const { error: e } = await supabase.from('projects').delete().eq('id', id);
    if (e) setError(e.message); else await load();
  };

  if (detailProject) {
    return <ProjectDetailPanel
      project={detailProject}
      token={session?.access_token || ''}
      onBack={() => { setDetailProject(null); load(); }}
      onError={(m) => setError(m)}
      onInfo={(m) => setInfo(m)}
    />;
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><FolderOpen className="w-5 h-5" /> Projecten</h2>
            <p className="text-sm text-gray-500">{activeCourse ? `Cursus: ${activeCourse.name}` : 'Alle cursussen'}.</p>
          </div>
          <button onClick={() => startEdit(null)} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700" data-testid="button-add-project">
            <Plus className="w-4 h-4" /> Nieuw project
          </button>
        </div>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>}
        {info && <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded text-sm mb-3">{info}</div>}
        {projects.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen projecten in deze cursus.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {projects.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`project-row-${p.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">{p.title}</div>
                  <p className="text-xs text-gray-500 line-clamp-1">{p.research_question}</p>
                  <div className="text-[10px] text-gray-400 mt-1">
                    groepsgrootte {p.min_group_size ?? 1}–{p.max_group_size ?? 5} · {Array.isArray(p.rubric_criteria) ? `${p.rubric_criteria.length} rubriekspunten` : 'geen rubriek'}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setDetailProject(p)} className="flex items-center gap-1 px-2 py-1 text-sm text-blue-700 hover:bg-blue-50 rounded" data-testid={`button-detail-project-${p.id}`}>
                    <Settings className="w-4 h-4" /> Beheer
                  </button>
                  <button onClick={() => startEdit(p)} className="px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded" data-testid={`button-edit-project-${p.id}`}>Bewerk</button>
                  <button onClick={() => remove(p.id)} className="p-2 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-project-${p.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-800 flex items-center gap-2 mb-1">
          <Wrench className="w-4 h-4" /> Onderhoud
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Verplaats bestaande projectbestanden van de platte Projectdata-map naar de juiste projectsubmap
          (Projectdata → [projecttitel]). Veilig om meerdere keren uit te voeren — al gemigreerde bestanden worden overgeslagen.
        </p>
        <button
          onClick={runMigration}
          disabled={migrating}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-40"
          data-testid="button-migrate-subfolders"
        >
          {migrating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
          {migrating ? 'Bezig met migreren…' : 'Mapstructuur herstellen'}
        </button>
        {migrateResult && (
          <div className={`mt-3 px-3 py-2 rounded text-sm border ${migrateResult.failed > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-800'}`} data-testid="text-migrate-result">
            Klaar — {migrateResult.total} gecontroleerd, {migrateResult.migrated} verplaatst, {migrateResult.skipped} al correct, {migrateResult.failed} mislukt.
            {migrateResult.errors.length > 0 && (
              <ul className="mt-1 list-disc list-inside text-xs text-red-700">
                {migrateResult.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold mb-3">{editing.id ? 'Project bewerken' : 'Nieuw project'}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-700">Titel</label>
                <input value={editing.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-project-title" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Onderzoeksvraag</label>
                <input value={editing.research_question || ''} onChange={e => setEditing({ ...editing, research_question: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-project-question" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Beschrijving (kort)</label>
                <textarea value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-project-description" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Doelen / leerdoelen</label>
                <textarea value={editing.goals || ''} onChange={e => setEditing({ ...editing, goals: e.target.value })} rows={3} placeholder="Wat moeten studenten kunnen na dit project?" className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-project-goals" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Briefing (markdown)</label>
                <textarea value={editing.briefing_markdown || ''} onChange={e => setEditing({ ...editing, briefing_markdown: e.target.value })} rows={6} className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" data-testid="textarea-project-briefing" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Rubriekspunten (één per regel — zichtbaar voor studenten)</label>
                <textarea value={rubricLines} onChange={e => setRubricLines(e.target.value)} rows={4} placeholder="Methode is helder onderbouwd&#10;Resultaten worden correct geïnterpreteerd&#10;..." className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-project-rubric" />
                <p className="text-[10px] text-gray-400 mt-1">Wil je een verborgen rubric? Maak in het beheer een "beoordelaar"-persona en koppel daar een rubric-bestand aan.</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700">Min groepsgrootte</label>
                  <input type="number" min={1} max={20} value={editing.min_group_size ?? 1} onChange={e => setEditing({ ...editing, min_group_size: parseInt(e.target.value) || 1 })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-project-minsize" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Max groepsgrootte</label>
                  <input type="number" min={1} max={20} value={editing.max_group_size ?? 5} onChange={e => setEditing({ ...editing, max_group_size: parseInt(e.target.value) || 5 })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-project-maxsize" />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.allow_self_signup ?? true} onChange={e => setEditing({ ...editing, allow_self_signup: e.target.checked })} data-testid="checkbox-project-selfsignup" />
                    Self-signup
                  </label>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditing(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" data-testid="button-cancel-project">Annuleren</button>
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40" data-testid="button-save-project">
                <Save className="w-4 h-4" /> {saving ? 'Opslaan…' : 'Opslaan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectDetailPanel({ project, token, onBack, onError, onInfo }: {
  project: ProjectRow; token: string;
  onBack: () => void; onError: (m: string) => void; onInfo: (m: string) => void;
}) {
  const [personas, setPersonas] = useState<ProjectPersona[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Partial<ProjectPersona> | null>(null);
  const [projectDocs, setProjectDocs] = useState<ProjectDoc[]>([]);
  const [uploadingPDoc, setUploadingPDoc] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<string | null>(null);
  const pdocFileRef = useRef<HTMLInputElement>(null);
  const [rubricDocsMap, setRubricDocsMap] = useState<Record<string, RubricDoc[]>>({});
  const [uploadingRubric, setUploadingRubric] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);

  const loadPersonas = useCallback(async () => {
    const { data } = await supabase
      .from('project_personas').select('*')
      .eq('project_id', project.id).order('sort_order');
    setPersonas((data as any) || []);
  }, [project.id]);

  const loadProjectDocs = useCallback(async () => {
    const r = await fetch(`/api/projects/${project.id}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const d = await r.json();
      setProjectDocs(d.documents || []);
    }
  }, [project.id, token]);

  // Voor evaluator-persona's de bestaande rubric-docs ophalen via een
  // dummy group_id van de eerste groep — de docs zijn echter group-scoped,
  // dus we tonen alleen het aantal en bieden upload aan via de eerste groep.
  // Eenvoudiger: rubric-docs worden ZONDER group_id niet opgehaald in
  // bestaande endpoint. We gebruiken supabase rechtstreeks om alle rijen te
  // lezen als staff (RLS staat staff toe).
  const loadRubricDocs = useCallback(async (personaId: string) => {
    const { data } = await supabase
      .from('project_persona_documents')
      .select('id, filename, byte_size, is_hidden_rubric, created_at')
      .eq('project_id', project.id)
      .eq('persona_id', personaId)
      .eq('is_hidden_rubric', true)
      .order('created_at', { ascending: false });
    setRubricDocsMap(prev => ({ ...prev, [personaId]: (data as any) || [] }));
  }, [project.id]);

  useEffect(() => { loadPersonas(); loadProjectDocs(); }, [loadPersonas, loadProjectDocs]);

  // Lazy-load rubric-lijst per evaluator-persona.
  useEffect(() => {
    personas.filter(p => p.persona_type === 'evaluator').forEach(p => {
      if (!(p.id in rubricDocsMap)) loadRubricDocs(p.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personas]);

  const savePersona = async () => {
    if (!editingPersona || !editingPersona.name?.trim()) { onError('Naam is verplicht'); return; }
    setAdding(true);
    try {
      const isNew = !editingPersona.id;
      const url = isNew
        ? `/api/projects/${project.id}/personas`
        : `/api/projects/${project.id}/personas/${editingPersona.id}`;
      const r = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: editingPersona.name,
          system_prompt: editingPersona.system_prompt || '',
          avatar_emoji: editingPersona.avatar_emoji || '🤖',
          rag_enabled: editingPersona.rag_enabled ?? true,
          persona_type: editingPersona.persona_type || 'conversational',
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Mislukt');
      setEditingPersona(null);
      await loadPersonas();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const removePersona = async (p: ProjectPersona) => {
    if (!confirm(`Verwijder "${p.name}" uit dit project? Alle gesprekken met deze persona gaan verloren.`)) return;
    const r = await fetch(`/api/projects/${project.id}/personas/${p.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      onError(d.error || 'Verwijderen mislukt'); return;
    }
    await loadPersonas();
  };

  const copyToLibrary = async (p: ProjectPersona) => {
    setCopying(p.id);
    try {
      const r = await fetch(`/api/projects/${project.id}/personas/${p.id}/copy-to-library`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kopiëren mislukt');
      onInfo(d.alreadyExists
        ? `"${p.name}" stond al in de bibliotheek.`
        : `"${p.name}" is gekopieerd naar de bibliotheek.`);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setCopying(null);
    }
  };

  const uploadProjectDoc = async (file: File) => {
    if (file.size > 15_000_000) { setLocalError('Bestand is groter dan 15 MB.'); return; }
    setUploadingPDoc(true);
    setLocalError(null);
    setLocalInfo(null);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await fetch(`/api/projects/${project.id}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload mislukt');
      setProjectDocs(prev => [d.document, ...prev]);
      setLocalInfo(`"${file.name}" geüpload.`);
    } catch (e: any) {
      setLocalError(e.message);
    } finally {
      setUploadingPDoc(false);
      if (pdocFileRef.current) pdocFileRef.current.value = '';
    }
  };

  const deleteProjectDoc = async (doc: ProjectDoc) => {
    if (!confirm(`Verwijder "${doc.filename}"?`)) return;
    const r = await fetch(`/api/projects/${project.id}/documents/${doc.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) { onError('Verwijderen mislukt'); return; }
    setProjectDocs(prev => prev.filter(d => d.id !== doc.id));
  };

  const toggleDocVisibility = async (doc: ProjectDoc) => {
    const next = !doc.is_visible_to_students;
    setProjectDocs(prev => prev.map(d => d.id === doc.id ? { ...d, is_visible_to_students: next } : d));
    const r = await fetch(`/api/projects/${project.id}/documents/${doc.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_visible_to_students: next }),
    });
    if (!r.ok) {
      setProjectDocs(prev => prev.map(d => d.id === doc.id ? { ...d, is_visible_to_students: !next } : d));
      onError('Zichtbaarheid wijzigen mislukt');
    }
  };

  const uploadRubric = async (personaId: string, file: File) => {
    if (file.size > 15_000_000) { onError('Bestand is groter dan 15 MB.'); return; }
    setUploadingRubric(personaId);
    try {
      // Verborgen rubrics zijn project/persona-scoped — geen groep nodig.
      const fd = new FormData();
      fd.append('isHiddenRubric', '1');
      fd.append('file', file, file.name);
      const r = await fetch(`/api/projects/${project.id}/personas/${personaId}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Rubric-upload mislukt');
      await loadRubricDocs(personaId);
      onInfo(`Verborgen rubric "${file.name}" gekoppeld.`);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setUploadingRubric(null);
    }
  };

  const deleteRubric = async (personaId: string, doc: RubricDoc) => {
    if (!confirm(`Verwijder verborgen rubric "${doc.filename}"?`)) return;
    // Direct supabase.delete is geblokkeerd door ppd_modify=false; gebruik
    // het server-endpoint dat de juiste autorisatie afhandelt.
    const r = await fetch(
      `/api/projects/${project.id}/personas/${personaId}/documents/${doc.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      onError(d.error || 'Verwijderen mislukt');
      return;
    }
    await loadRubricDocs(personaId);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="p-1.5 hover:bg-gray-100 rounded" data-testid="button-back-projects-admin">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{project.title}</h2>
              <p className="text-xs text-gray-500">Beheer persona's, documenten en rubrics voor dit project.</p>
            </div>
          </div>
        </div>
      </div>

      {localError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2.5 text-sm flex items-start gap-2" data-testid="alert-local-error-projects">
          <span className="mt-0.5 shrink-0">⚠</span>
          <span>{localError}</span>
          <button onClick={() => setLocalError(null)} className="ml-auto text-red-400 hover:text-red-600 shrink-0">✕</button>
        </div>
      )}
      {localInfo && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl px-4 py-2.5 text-sm flex items-center gap-2" data-testid="alert-local-info-projects">
          <span>✓</span>
          <span>{localInfo}</span>
          <button onClick={() => setLocalInfo(null)} className="ml-auto text-green-400 hover:text-green-600">✕</button>
        </div>
      )}

      {/* Projectdocumenten */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-gray-900 flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Projectdocumenten</h3>
            <p className="text-xs text-gray-500">Datasets, opdracht- en bronmateriaal. Tekstbestanden gebruiken alle persona's als context; binaire datasets (zoals Jamovi .omv) kunnen studenten alleen downloaden.</p>
          </div>
          <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer ${uploadingPDoc ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
            {uploadingPDoc ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            Upload bestand
            <input
              ref={pdocFileRef}
              type="file" accept={PROJECT_DOC_ACCEPT} className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadProjectDoc(f); }}
              disabled={uploadingPDoc}
              data-testid="input-upload-project-doc"
            />
          </label>
        </div>
        {projectDocs.length === 0 ? (
          <p className="text-xs text-gray-500">Nog geen projectdocumenten.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {projectDocs.map(d => (
              <li key={d.id} className={`py-2 flex items-center gap-3 ${!d.is_visible_to_students ? 'opacity-50' : ''}`} data-testid={`project-doc-${d.id}`}>
                {d.document_ref_id ? <Database className="w-4 h-4 text-blue-500" /> : <FileText className="w-4 h-4 text-gray-500" />}
                <div className="flex-1 min-w-0 truncate text-sm">{d.filename}</div>
                {d.document_ref_id && (
                  <span className="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-1.5 py-0.5 rounded">Projectdata</span>
                )}
                <div className="text-xs text-gray-400">{d.byte_size ? `${Math.round(d.byte_size / 1024)} KB` : ''}</div>
                <button
                  onClick={() => toggleDocVisibility(d)}
                  className={`p-1 rounded ${d.is_visible_to_students ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}`}
                  title={d.is_visible_to_students ? 'Zichtbaar voor studenten — klik om te verbergen' : 'Verborgen voor studenten — klik om zichtbaar te maken'}
                  data-testid={`button-toggle-visibility-${d.id}`}
                >
                  {d.is_visible_to_students ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={async () => {
                    try {
                      const r = await fetch(`/api/projects/${project.id}/documents/${d.id}/download`, {
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      if (!r.ok) { const j = await r.json().catch(() => ({})); setLocalError(j.error || 'Download mislukt'); return; }
                      const blob = await r.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a'); a.href = url; a.download = d.filename;
                      document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (e: any) { setLocalError(e.message); }
                  }}
                  className="p-1 text-blue-500 hover:bg-blue-50 rounded"
                  title="Download"
                  data-testid={`button-download-project-doc-${d.id}`}
                >
                  <Download className="w-4 h-4" />
                </button>
                <button onClick={() => deleteProjectDoc(d)} className="p-1 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-project-doc-${d.id}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Persona's */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-gray-900">Persona's in dit project ({personas.length})</h3>
            <p className="text-xs text-gray-500">Maak gespreksparters of beoordelaars. Beoordelaars verschijnen niet in de student-chat.</p>
          </div>
          <button onClick={() => setEditingPersona({ name: '', system_prompt: '', avatar_emoji: '🤖', rag_enabled: true, persona_type: 'conversational' })} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg" data-testid="button-add-custom-persona">
            <Plus className="w-4 h-4" /> Nieuwe persona
          </button>
        </div>
        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen persona's. Voeg er één toe.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => {
              const isEval = p.persona_type === 'evaluator';
              const rubricList = rubricDocsMap[p.id] || [];
              return (
                <li key={p.id} className="py-3" data-testid={`pp-row-${p.id}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{p.avatar_emoji || '🤖'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 flex items-center gap-2">
                        {p.name}
                        {isEval && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> beoordelaar</span>}
                        {p.source_persona_id && <span className="text-[10px] text-gray-400">uit bibliotheek</span>}
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-2">{p.system_prompt.slice(0, 200)}</p>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => copyToLibrary(p)} disabled={copying === p.id} className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded flex items-center gap-1 disabled:opacity-40" data-testid={`button-copy-to-lib-${p.id}`}>
                        <Copy className="w-3 h-3" /> {copying === p.id ? 'Bezig…' : 'Kopieer naar bibliotheek'}
                      </button>
                      <button onClick={() => setEditingPersona(p)} className="px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded" data-testid={`button-edit-pp-${p.id}`}>Bewerk</button>
                      <button onClick={() => removePersona(p)} className="p-2 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-pp-${p.id}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {isEval && (
                    <div className="mt-2 ml-10 bg-purple-50/40 border border-purple-100 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-medium text-purple-900 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Verborgen rubric ({rubricList.length})</div>
                        <label className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded cursor-pointer ${uploadingRubric === p.id ? 'bg-gray-100 text-gray-400' : 'bg-purple-600 text-white hover:bg-purple-700'}`}>
                          {uploadingRubric === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
                          Upload rubric
                          <input
                            type="file" accept={UPLOAD_ACCEPT} className="hidden"
                            onChange={e => { const f = e.target.files?.[0]; if (f) uploadRubric(p.id, f); }}
                            disabled={uploadingRubric === p.id}
                            data-testid={`input-upload-rubric-${p.id}`}
                          />
                        </label>
                      </div>
                      {rubricList.length === 0 ? (
                        <p className="text-[11px] text-purple-700/70">Nog geen rubric-bestand gekoppeld. Zonder bestand gebruikt de beoordelaar alleen de leerdoelen van het project.</p>
                      ) : (
                        <ul className="space-y-1">
                          {rubricList.map(r => (
                            <li key={r.id} className="flex items-center gap-2 text-xs" data-testid={`rubric-doc-${r.id}`}>
                              <FileText className="w-3 h-3 text-purple-600" />
                              <span className="flex-1 truncate">{r.filename}</span>
                              <button onClick={() => deleteRubric(p.id, r)} className="p-0.5 text-red-500 hover:bg-red-50 rounded">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editingPersona && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">{editingPersona.id ? 'Persona bewerken' : 'Nieuwe persona'}</h3>
              <button onClick={() => setEditingPersona(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-700">Naam</label>
                  <input value={editingPersona.name || ''} onChange={e => setEditingPersona({ ...editingPersona, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-pp-name" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Emoji</label>
                  <input value={editingPersona.avatar_emoji || ''} onChange={e => setEditingPersona({ ...editingPersona, avatar_emoji: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-pp-emoji" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Type</label>
                <select
                  value={editingPersona.persona_type || 'conversational'}
                  onChange={e => setEditingPersona({ ...editingPersona, persona_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  data-testid="select-pp-type"
                >
                  <option value="conversational">Gesprekspartner — zichtbaar voor studenten in de chat</option>
                  <option value="evaluator">Beoordelaar — verborgen, geeft formatieve beoordeling bij afronden</option>
                </select>
                {editingPersona.persona_type === 'evaluator' && (
                  <p className="text-[11px] text-purple-700 mt-1">Beoordelaars verschijnen niet in de chattabs. Een verborgen rubric kun je na opslaan koppelen via de persona-rij.</p>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">System prompt</label>
                <textarea value={editingPersona.system_prompt || ''} onChange={e => setEditingPersona({ ...editingPersona, system_prompt: e.target.value })} rows={8} className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" data-testid="textarea-pp-prompt" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editingPersona.rag_enabled ?? true} onChange={e => setEditingPersona({ ...editingPersona, rag_enabled: e.target.checked })} data-testid="checkbox-pp-rag" />
                RAG aan (gebruikt cursusmateriaal)
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditingPersona(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">Annuleren</button>
              <button onClick={savePersona} disabled={adding} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40" data-testid="button-save-pp">
                <Save className="w-4 h-4" /> {adding ? 'Opslaan…' : 'Opslaan'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default ProjectsAdminTab;
