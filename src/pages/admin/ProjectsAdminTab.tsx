import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { supabase } from '../../lib/supabase';
import { Plus, Save, Trash2, FolderOpen, Settings, X, ArrowLeft, BookPlus } from 'lucide-react';

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
}

interface CoursePersona {
  id: string;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
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

  const load = useCallback(async () => {
    let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (activeCourseId) q = q.eq('course_id', activeCourseId);
    const { data, error: e } = await q;
    if (e) setError(e.message); else setProjects((data as any) || []);
  }, [activeCourseId]);

  useEffect(() => { load(); }, [load]);

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
                <label className="text-xs font-medium text-gray-700">Rubriekspunten (één per regel)</label>
                <textarea value={rubricLines} onChange={e => setRubricLines(e.target.value)} rows={4} placeholder="Methode is helder onderbouwd&#10;Resultaten worden correct geïnterpreteerd&#10;..." className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-project-rubric" />
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
  const [library, setLibrary] = useState<CoursePersona[]>([]);
  const [adding, setAdding] = useState(false);
  const [showLibPicker, setShowLibPicker] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Partial<ProjectPersona> | null>(null);

  const loadPersonas = useCallback(async () => {
    const { data } = await supabase
      .from('project_personas').select('*')
      .eq('project_id', project.id).order('sort_order');
    setPersonas((data as any) || []);
  }, [project.id]);

  const loadLibrary = useCallback(async () => {
    if (!project.course_id) { setLibrary([]); return; }
    const { data } = await supabase
      .from('course_personas').select('id, name, avatar_emoji, system_prompt')
      .eq('course_id', project.course_id);
    setLibrary((data as any) || []);
  }, [project.course_id]);

  useEffect(() => { loadPersonas(); loadLibrary(); }, [loadPersonas, loadLibrary]);

  const addFromLibrary = async (cp: CoursePersona) => {
    setAdding(true);
    try {
      const r = await fetch(`/api/projects/${project.id}/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ coursePersonaId: cp.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Toevoegen mislukt');
      onInfo(`"${cp.name}" toegevoegd.`);
      setShowLibPicker(false);
      await loadPersonas();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const addCustom = async () => {
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

  const usedSourceIds = new Set(personas.map(p => p.source_persona_id).filter(Boolean));
  const availableLib = library.filter(l => !usedSourceIds.has(l.id));

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
              <p className="text-xs text-gray-500">Beheer persona's voor dit project. Studenten zien deze chatbots in de projectruimte.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900">Persona's in dit project ({personas.length})</h3>
          <div className="flex gap-2">
            <button onClick={() => setShowLibPicker(true)} disabled={availableLib.length === 0} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-40" data-testid="button-pick-from-library">
              <BookPlus className="w-4 h-4" /> Uit bibliotheek
            </button>
            <button onClick={() => setEditingPersona({ name: '', system_prompt: '', avatar_emoji: '🤖', rag_enabled: true })} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg" data-testid="button-add-custom-persona">
              <Plus className="w-4 h-4" /> Eigen persona
            </button>
          </div>
        </div>
        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen persona's. Voeg er één toe vanuit de bibliotheek of maak een eigen variant.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`pp-row-${p.id}`}>
                <span className="text-2xl">{p.avatar_emoji || '🤖'}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">{p.name}</div>
                  <p className="text-xs text-gray-500 line-clamp-2">{p.system_prompt.slice(0, 200)}</p>
                  {p.source_persona_id && <span className="text-[10px] text-gray-400">uit bibliotheek</span>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setEditingPersona(p)} className="px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded" data-testid={`button-edit-pp-${p.id}`}>Bewerk</button>
                  <button onClick={() => removePersona(p)} className="p-2 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-pp-${p.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showLibPicker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-gray-900">Kies een persona uit de bibliotheek</h3>
              <button onClick={() => setShowLibPicker(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            {availableLib.length === 0 ? (
              <p className="text-sm text-gray-500">Geen persona's beschikbaar (alle al toegevoegd of geen bibliotheek voor deze cursus).</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {availableLib.map(cp => (
                  <li key={cp.id} className="py-2 flex items-center gap-3">
                    <span className="text-2xl">{cp.avatar_emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900">{cp.name}</div>
                      <p className="text-xs text-gray-500 line-clamp-1">{cp.system_prompt.slice(0, 140)}</p>
                    </div>
                    <button onClick={() => addFromLibrary(cp)} disabled={adding} className="px-3 py-1 text-sm bg-blue-600 text-white rounded disabled:opacity-40" data-testid={`button-add-lib-${cp.id}`}>
                      Voeg toe
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {editingPersona && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold mb-3">{editingPersona.id ? 'Persona bewerken' : 'Nieuwe persona'}</h3>
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
              <button onClick={addCustom} disabled={adding} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40" data-testid="button-save-pp">
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
