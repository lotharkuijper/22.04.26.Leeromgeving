import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Terminal } from 'lucide-react';

interface PromptInfo {
  id?: string;
  name: string;
  is_active?: boolean;
  source?: 'database' | 'fallback';
}

interface ActivePromptsResponse {
  chat: PromptInfo | null;
  explain: PromptInfo | null;
  quiz: PromptInfo[];
}

interface Props {
  section: 'chat' | 'explain' | 'quiz';
}

export function PromptDebugBadge({ section }: Props) {
  const { profile } = useAuth();
  const [data, setData] = useState<ActivePromptsResponse | null>(null);

  const isStaff = profile?.role === 'admin' || profile?.role === 'teacher';

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session || cancelled) return;
      fetch('/api/debug/active-prompts', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d && !cancelled) setData(d); })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [isStaff]);

  if (!isStaff || !data) return null;

  if (section === 'chat' || section === 'explain') {
    const info = section === 'chat' ? data.chat : data.explain;
    if (!info) return null;
    const isFallback = info.source === 'fallback';
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 font-mono leading-none"
        title="Debug: actieve systeemprompt"
        data-testid={`debug-prompt-${section}`}
      >
        <Terminal className="w-3 h-3 shrink-0 text-gray-300" />
        <span>
          prompt:{' '}
          <span className={isFallback ? 'text-amber-500' : 'text-gray-600 font-semibold'}>
            {info.name}
          </span>
          {isFallback && <span className="text-amber-400 ml-1">(standaard)</span>}
        </span>
      </div>
    );
  }

  if (section === 'quiz') {
    const prompts = data.quiz;
    if (prompts.length === 0) {
      return (
        <div
          className="flex items-center gap-1.5 text-[11px] text-amber-500 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 font-mono leading-none"
          data-testid="debug-prompt-quiz"
        >
          <Terminal className="w-3 h-3 shrink-0" />
          <span>quiz prompts: standaard (DB niet geconfigureerd)</span>
        </div>
      );
    }
    return (
      <div
        className="text-[11px] text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 font-mono leading-none space-y-0.5"
        title="Debug: actieve quiz-prompts"
        data-testid="debug-prompt-quiz"
      >
        <div className="flex items-center gap-1 mb-1">
          <Terminal className="w-3 h-3 text-gray-300" />
          <span className="text-gray-400">quiz prompts:</span>
        </div>
        {prompts.map(p => (
          <div key={p.name} className="pl-4">
            <span className={p.is_active ? 'text-gray-600 font-semibold' : 'line-through text-gray-300'}>
              {p.name}
            </span>
            {!p.is_active && <span className="text-gray-300 ml-1">(inactief)</span>}
          </div>
        ))}
      </div>
    );
  }

  return null;
}
