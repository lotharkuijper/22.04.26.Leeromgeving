import { useState, useEffect, useCallback } from 'react';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { supabase } from '../../lib/supabase';
import { Bot, FolderOpen } from 'lucide-react';

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

export function PersonaLibraryTab() {
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [personas, setPersonas] = useState<CoursePersona[]>([]);
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

  if (!activeCourseId) {
    return (
      <div className="p-8 text-center text-gray-500 bg-white rounded-2xl border border-gray-200">
        Kies eerst een actieve cursus om de bibliotheek te bekijken.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Bot className="w-5 h-5" /> Persona-bibliotheek</h2>
            <p className="text-sm text-gray-500">
              Cursus: {activeCourse?.name}. Read-only overzicht — persona's maak je aan binnen <strong>Projecten → Beheer</strong>.
              Vanuit een project kun je een persona met de knop "Kopieer naar bibliotheek" hierin terugplaatsen voor hergebruik.
            </p>
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-100 text-blue-800 px-3 py-2 rounded text-xs flex items-start gap-2 mb-3">
          <FolderOpen className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>De bibliotheek is een centrale verzameling. Wijzigingen aan een persona doe je in het project waar hij draait.</span>
        </div>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>}
        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen persona's in deze bibliotheek.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`persona-row-${p.id}`}>
                <span className="text-2xl">{p.avatar_emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {p.name}
                    {p.persona_type === 'evaluator' && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">beoordelaar</span>}
                    {p.is_default && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">standaard</span>}
                    {!p.rag_enabled && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">RAG uit</span>}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{p.system_prompt.slice(0, 200)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default PersonaLibraryTab;
