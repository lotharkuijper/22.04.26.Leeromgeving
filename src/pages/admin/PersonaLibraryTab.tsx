import { useState, useEffect, useCallback } from 'react';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { supabase } from '../../lib/supabase';
import { Plus, Save, Trash2, Bot } from 'lucide-react';

interface CoursePersona {
  id: string;
  course_id: string;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  is_default: boolean;
}

const DEFAULT_CONSULTANT_PROMPT = `Je bent een rustige onderzoeks-consultant voor een groep VU-studenten epi/biostat. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".`;

export function PersonaLibraryTab() {
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [personas, setPersonas] = useState<CoursePersona[]>([]);
  const [editing, setEditing] = useState<Partial<CoursePersona> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const save = async () => {
    if (!editing || !activeCourseId) return;
    if (!editing.name?.trim()) { setError('Naam is verplicht'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        course_id: activeCourseId,
        name: editing.name.trim(),
        avatar_emoji: editing.avatar_emoji || '🤖',
        system_prompt: editing.system_prompt || '',
        rag_enabled: editing.rag_enabled ?? true,
        rag_folder_ids: Array.isArray(editing.rag_folder_ids) ? editing.rag_folder_ids : [],
        is_default: editing.is_default ?? false,
      };
      if (editing.id) {
        const { error: e } = await supabase.from('course_personas').update(payload).eq('id', editing.id);
        if (e) throw new Error(e.message);
      } else {
        const { error: e } = await supabase.from('course_personas').insert(payload);
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
    if (!confirm('Weet je zeker dat je deze persona wilt verwijderen?')) return;
    const { error: e } = await supabase.from('course_personas').delete().eq('id', id);
    if (e) setError(e.message); else await load();
  };

  const seedConsultant = async () => {
    if (!activeCourseId) return;
    const { error: e } = await supabase.from('course_personas').insert({
      course_id: activeCourseId,
      name: 'Consultant',
      avatar_emoji: '🧑‍🏫',
      system_prompt: DEFAULT_CONSULTANT_PROMPT,
      rag_enabled: true,
      is_default: true,
    });
    if (e) setError(e.message); else await load();
  };

  if (!activeCourseId) {
    return (
      <div className="p-8 text-center text-gray-500 bg-white rounded-2xl border border-gray-200">
        Kies eerst een actieve cursus om persona's te beheren.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Bot className="w-5 h-5" /> Persona-bibliotheek</h2>
            <p className="text-sm text-gray-500">Cursus: {activeCourse?.name}. Studenten kiezen uit deze lijst in elke projectruimte.</p>
          </div>
          <div className="flex gap-2">
            {personas.length === 0 && (
              <button onClick={seedConsultant} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg" data-testid="button-seed-consultant">
                Voeg standaard Consultant toe
              </button>
            )}
            <button
              onClick={() => setEditing({ name: '', avatar_emoji: '🤖', system_prompt: '', rag_enabled: true, rag_folder_ids: [], is_default: false })}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              data-testid="button-add-persona"
            >
              <Plus className="w-4 h-4" /> Nieuwe persona
            </button>
          </div>
        </div>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>}
        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen persona's. Voeg er één toe — anders krijgen studenten de algemene Consultant te zien.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`persona-row-${p.id}`}>
                <span className="text-2xl">{p.avatar_emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {p.name}
                    {p.is_default && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">standaard</span>}
                    {!p.rag_enabled && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">RAG uit</span>}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{p.system_prompt.slice(0, 200)}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setEditing(p)} className="p-2 text-gray-500 hover:bg-gray-100 rounded" data-testid={`button-edit-persona-${p.id}`}>
                    Bewerk
                  </button>
                  <button onClick={() => remove(p.id)} className="p-2 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-persona-${p.id}`}>
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
            <h3 className="text-lg font-bold mb-3">{editing.id ? 'Persona bewerken' : 'Nieuwe persona'}</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-gray-700">Naam</label>
                  <input value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-persona-name" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Emoji</label>
                  <input value={editing.avatar_emoji || ''} onChange={e => setEditing({ ...editing, avatar_emoji: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="input-persona-emoji" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">System prompt</label>
                <textarea value={editing.system_prompt || ''} onChange={e => setEditing({ ...editing, system_prompt: e.target.value })} rows={8} className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" data-testid="textarea-persona-prompt" />
              </div>
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editing.rag_enabled ?? true} onChange={e => setEditing({ ...editing, rag_enabled: e.target.checked })} data-testid="checkbox-persona-rag" />
                  RAG aan
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editing.is_default ?? false} onChange={e => setEditing({ ...editing, is_default: e.target.checked })} data-testid="checkbox-persona-default" />
                  Standaardpersona
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditing(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" data-testid="button-cancel-persona">Annuleren</button>
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40" data-testid="button-save-persona">
                <Save className="w-4 h-4" /> {saving ? 'Opslaan…' : 'Opslaan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PersonaLibraryTab;
