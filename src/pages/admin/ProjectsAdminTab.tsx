import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { supabase } from '../../lib/supabase';
import { Plus, Save, Trash2, FolderOpen, Copy } from 'lucide-react';

interface ProjectRow {
  id: string;
  title: string;
  research_question: string;
  description: string | null;
  briefing_markdown: string | null;
  rubric_criteria: any[];
  course_id: string | null;
  max_group_size: number | null;
  allow_self_signup: boolean | null;
  status: string | null;
  created_at: string;
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
        title: '', research_question: '', briefing_markdown: '',
        rubric_criteria: [], max_group_size: 5, allow_self_signup: true,
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
      rubric_criteria: rubric,
      course_id: editing.course_id || activeCourseId || null,
      max_group_size: editing.max_group_size ?? 5,
      allow_self_signup: editing.allow_self_signup ?? true,
      status: editing.status || 'active',
    };
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

  const copyPersonas = async (p: ProjectRow) => {
    if (!session?.access_token) return;
    setInfo(null);
    setError(null);
    try {
      const r = await fetch('/api/projects/copy-personas-from-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ projectId: p.id }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kopiëren mislukt');
      setInfo(data.alreadyExists
        ? `Project "${p.title}" heeft al persona's — niets gekopieerd.`
        : `${data.copied} persona's gekopieerd naar "${p.title}".`);
    } catch (e: any) {
      setError(e.message);
    }
  };

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
                    max {p.max_group_size ?? 5} · {Array.isArray(p.rubric_criteria) ? `${p.rubric_criteria.length} rubriekspunten` : 'geen rubriek'}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => copyPersonas(p)} className="p-2 text-gray-500 hover:bg-gray-100 rounded text-xs" title="Kopieer persona's uit bibliotheek" data-testid={`button-copy-personas-${p.id}`}>
                    <Copy className="w-4 h-4" />
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
                <label className="text-xs font-medium text-gray-700">Briefing (markdown)</label>
                <textarea value={editing.briefing_markdown || ''} onChange={e => setEditing({ ...editing, briefing_markdown: e.target.value })} rows={6} className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" data-testid="textarea-project-briefing" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Rubriekspunten (één per regel)</label>
                <textarea value={rubricLines} onChange={e => setRubricLines(e.target.value)} rows={4} placeholder="Methode is helder onderbouwd&#10;Resultaten worden correct geïnterpreteerd&#10;..." className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-project-rubric" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700">Max groepsgrootte</label>
                  <input type="number" min={1} max={20} value={editing.max_group_size ?? 5} onChange={e => setEditing({ ...editing, max_group_size: parseInt(e.target.value) || 5 })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-project-maxsize" />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.allow_self_signup ?? true} onChange={e => setEditing({ ...editing, allow_self_signup: e.target.checked })} data-testid="checkbox-project-selfsignup" />
                    Studenten mogen zelf groepen vormen
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

export default ProjectsAdminTab;
