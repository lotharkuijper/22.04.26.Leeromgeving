import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { Bot, FolderOpen, Trash2, Pencil, Plus, Save, X, Download } from 'lucide-react';

interface CoursePersona {
  id: string;
  course_id: string;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  is_default: boolean;
  persona_type?: string | null;
}

interface ProjectOption {
  id: string;
  title: string;
}

const EMPTY_FORM = {
  name: '',
  avatar_emoji: '🤖',
  system_prompt: '',
  rag_enabled: true,
  persona_type: 'conversational' as string,
};

export function PersonaLibraryTab() {
  const { isAdmin, session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const { lang, t } = useLanguage();
  const [personas, setPersonas] = useState<CoursePersona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<typeof EMPTY_FORM & { id?: string }>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [fetchTarget, setFetchTarget] = useState<CoursePersona | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!activeCourseId) { setPersonas([]); return; }
    const { data, error: e } = await supabase
      .from('course_personas')
      .select('*')
      .eq('course_id', activeCourseId)
      .order('is_default', { ascending: false });
    if (e) setError(e.message); else setPersonas((data as any) || []);
  }, [activeCourseId]);

  useEffect(() => { load(); }, [load]);

  const loadProjects = useCallback(async () => {
    if (!activeCourseId) return;
    const { data } = await supabase
      .from('projects')
      .select('id, title')
      .eq('course_id', activeCourseId)
      .order('created_at', { ascending: false });
    setProjects((data as any) || []);
  }, [activeCourseId]);

  const authHeader = () =>
    session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};

  const removePersona = async (p: CoursePersona) => {
    const confirmed = window.confirm(
      lang === 'en'
        ? `Remove "${p.name}" from the library? This cannot be undone.`
        : `Verwijder "${p.name}" uit de bibliotheek? Dit kan niet ongedaan worden gemaakt.`
    );
    if (!confirmed) return;
    setDeleting(p.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/course-personas/${p.id}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || (lang === 'en' ? 'Could not delete persona' : 'Verwijderen mislukt'));
      } else {
        await load();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const startEdit = (p: CoursePersona) => {
    setForm({
      id: p.id,
      name: p.name,
      avatar_emoji: p.avatar_emoji,
      system_prompt: p.system_prompt,
      rag_enabled: p.rag_enabled,
      persona_type: p.persona_type || 'conversational',
    });
    setEditingId(p.id);
    setError(null);
  };

  const startNew = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId('new');
    setError(null);
  };

  const cancelEdit = () => { setEditingId(null); setError(null); };

  const savePersona = async () => {
    if (!form.name.trim()) { setError(lang === 'en' ? 'Name is required' : 'Naam is verplicht'); return; }
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === 'new';
      const url = isNew ? '/api/admin/course-personas' : `/api/admin/course-personas/${editingId}`;
      const body = isNew ? { course_id: activeCourseId, ...form } : form;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || (lang === 'en' ? 'Save failed' : 'Opslaan mislukt'));
      } else {
        setEditingId(null);
        await load();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openFetchModal = async (p: CoursePersona) => {
    setFetchTarget(p);
    setSelectedProjectId('');
    setFetchMsg(null);
    setError(null);
    await loadProjects();
  };

  useEffect(() => {
    if (projects.length === 1 && fetchTarget && !selectedProjectId) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, fetchTarget, selectedProjectId]);

  const closeFetchModal = () => { setFetchTarget(null); setFetchMsg(null); };

  const fetchToProject = async () => {
    if (!fetchTarget || !selectedProjectId) return;
    setFetching(true);
    setFetchMsg(null);
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/personas/from-library/${fetchTarget.id}`, {
        method: 'POST',
        headers: { ...authHeader() },
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFetchMsg({ ok: false, text: d.error || (lang === 'en' ? 'Could not add persona' : 'Toevoegen mislukt') });
      } else {
        setFetchMsg({ ok: true, text: lang === 'en' ? `"${fetchTarget.name}" added to project.` : `"${fetchTarget.name}" is aan het project toegevoegd.` });
      }
    } catch (err: any) {
      setFetchMsg({ ok: false, text: err.message });
    } finally {
      setFetching(false);
    }
  };

  if (!activeCourseId) {
    return (
      <div className="p-8 text-center text-gray-500 bg-white rounded-2xl border border-gray-200">
        {t('admin.personaLib.selectCourse')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Bot className="w-5 h-5" /> {t('admin.personaLib.title')}</h2>
            <p className="text-sm text-gray-500">
              {t('admin.personaLib.courseLabel')}: {activeCourse?.name}. {t('admin.personaLib.descPre')} <strong>{t('admin.personaLib.descProjectNav')}</strong>. {t('admin.personaLib.descPost')}
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={startNew}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg"
              data-testid="button-new-cp"
            >
              <Plus className="w-4 h-4" />{lang === 'en' ? 'New template' : 'Nieuw sjabloon'}
            </button>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-100 text-blue-800 px-3 py-2 rounded text-xs flex items-start gap-2 mb-3">
          <FolderOpen className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{t('admin.personaLib.readOnlyHint')}</span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>
        )}

        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">{t('admin.personaLib.empty')}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`persona-row-${p.id}`}>
                <span className="text-2xl">{p.avatar_emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {p.name}
                    {p.persona_type === 'evaluator' && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.evaluator')}</span>}
                    {p.is_default && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.default')}</span>}
                    {!p.rag_enabled && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.ragOff')}</span>}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{p.system_prompt.slice(0, 200)}</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => openFetchModal(p)}
                    className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded flex items-center gap-1"
                    data-testid={`button-fetch-cp-${p.id}`}
                  >
                    <Download className="w-3 h-3" />
                    {lang === 'en' ? 'Use in project' : 'Gebruik in project'}
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => startEdit(p)}
                        className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded"
                        title={lang === 'en' ? 'Edit' : 'Bewerk'}
                        data-testid={`button-edit-cp-${p.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removePersona(p)}
                        disabled={deleting === p.id}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-40"
                        title={lang === 'en' ? 'Remove from library' : 'Verwijder uit bibliotheek'}
                        data-testid={`button-delete-cp-${p.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editingId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">
                {editingId === 'new'
                  ? (lang === 'en' ? 'New library template' : 'Nieuw bibliotheek-sjabloon')
                  : (lang === 'en' ? 'Edit library template' : 'Sjabloon bewerken')}
              </h3>
              <button onClick={cancelEdit} className="p-1 hover:bg-gray-100 rounded" data-testid="button-cancel-cp">
                <X className="w-4 h-4" />
              </button>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-700">{lang === 'en' ? 'Name' : 'Naam'}</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    data-testid="input-cp-name"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Emoji</label>
                  <input
                    value={form.avatar_emoji}
                    onChange={e => setForm({ ...form, avatar_emoji: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    data-testid="input-cp-emoji"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Type</label>
                <select
                  value={form.persona_type}
                  onChange={e => setForm({ ...form, persona_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  data-testid="select-cp-type"
                >
                  <option value="conversational">{lang === 'en' ? 'Conversational partner — visible to students' : 'Gesprekspartner — zichtbaar voor studenten'}</option>
                  <option value="evaluator">{lang === 'en' ? 'Evaluator — hidden, for formative assessment' : 'Beoordelaar — verborgen, formatieve beoordeling'}</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">System prompt</label>
                <textarea
                  value={form.system_prompt}
                  onChange={e => setForm({ ...form, system_prompt: e.target.value })}
                  rows={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono"
                  data-testid="textarea-cp-prompt"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.rag_enabled}
                  onChange={e => setForm({ ...form, rag_enabled: e.target.checked })}
                  data-testid="checkbox-cp-rag"
                />
                RAG aan (gebruikt cursusmateriaal)
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={cancelEdit} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">
                {lang === 'en' ? 'Cancel' : 'Annuleren'}
              </button>
              <button
                onClick={savePersona}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40"
                data-testid="button-save-cp"
              >
                <Save className="w-4 h-4" />
                {saving ? (lang === 'en' ? 'Saving…' : 'Opslaan…') : (lang === 'en' ? 'Save' : 'Opslaan')}
              </button>
            </div>
          </div>
        </div>
      )}

      {fetchTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">
                {lang === 'en' ? 'Use in project' : 'Gebruik in project'}
              </h3>
              <button onClick={closeFetchModal} className="p-1 hover:bg-gray-100 rounded" data-testid="button-close-fetch">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              {lang === 'en'
                ? `Add "${fetchTarget.name}" as an independent copy to a project. The copy can be edited separately from this template.`
                : `Voeg "${fetchTarget.name}" als onafhankelijke kopie toe aan een project. De kopie kan daarna vrij worden bewerkt, los van dit sjabloon.`}
            </p>
            {fetchMsg && (
              <div className={`px-3 py-2 rounded text-sm mb-3 ${fetchMsg.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                {fetchMsg.text}
              </div>
            )}
            {projects.length === 0 ? (
              <p className="text-sm text-gray-500 mb-3">
                {lang === 'en' ? 'No projects found in this course.' : 'Geen projecten gevonden in deze cursus.'}
              </p>
            ) : (
              <select
                value={selectedProjectId}
                onChange={e => setSelectedProjectId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-3"
                data-testid="select-fetch-project"
              >
                <option value="">{lang === 'en' ? '— Select a project —' : '— Kies een project —'}</option>
                {projects.map(pr => (
                  <option key={pr.id} value={pr.id}>{pr.title}</option>
                ))}
              </select>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={closeFetchModal} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">
                {lang === 'en' ? 'Close' : 'Sluiten'}
              </button>
              {projects.length > 0 && !fetchMsg?.ok && (
                <button
                  onClick={fetchToProject}
                  disabled={!selectedProjectId || fetching}
                  className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40"
                  data-testid="button-confirm-fetch"
                >
                  <Download className="w-4 h-4" />
                  {fetching
                    ? (lang === 'en' ? 'Adding…' : 'Toevoegen…')
                    : (lang === 'en' ? 'Add to project' : 'Voeg toe aan project')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PersonaLibraryTab;
