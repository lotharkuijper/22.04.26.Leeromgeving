import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  PlayCircle, RefreshCw, ArrowRight, FolderOpen, BookOpen, Loader2,
  AlertCircle, Users,
} from 'lucide-react';

interface OverviewProject {
  id: string;
  title: string;
  research_question: string;
  briefing_markdown: string | null;
  course_id: string | null;
  status: string | null;
  min_group_size: number | null;
  max_group_size: number | null;
  sessions: any[];
  lastSession: any | null;
  activeGroup: { id: string; name: string; invite_code: string; status: string } | null;
}

interface OverviewCourse {
  course: { id: string; name: string };
  projects: OverviewProject[];
}

export function ProjectsPage() {
  const { profile, session } = useAuth();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<OverviewCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [restartConfirm, setRestartConfirm] = useState<OverviewProject | null>(null);
  const [joinDialog, setJoinDialog] = useState(false);
  const [inviteCode, setInviteCode] = useState('');

  const token = session?.access_token;

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch('/api/projects/student-overview', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kon projecten niet laden');
      setOverview(d.courses || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const startNew = async (p: OverviewProject) => {
    if (!profile?.id || !token) return;
    setBusyProjectId(p.id);
    setError(null);
    try {
      // Maak direct een groep (van 1 om mee te beginnen) en navigeer naar
      // de projectruimte. Daar kunnen groepsgenoten via invite-code aansluiten.
      const r = await fetch('/api/projects/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: p.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Aanmaken mislukt');
      // Sessie-record wordt server-side aangemaakt (supabaseAdmin).
      navigate(`/projects/${p.id}/group/${d.group.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyProjectId(null);
    }
  };

  const continueExisting = (p: OverviewProject) => {
    if (p.activeGroup) {
      navigate(`/projects/${p.id}/group/${p.activeGroup.id}`);
    }
  };

  const restart = async (p: OverviewProject) => {
    if (!token) return;
    setBusyProjectId(p.id);
    setError(null);
    try {
      const r = await fetch('/api/projects/student-restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: p.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Herstarten mislukt');
      setRestartConfirm(null);
      await load();
      await startNew(p);
    } catch (e: any) {
      setError(e.message);
      setRestartConfirm(null);
    } finally {
      setBusyProjectId(null);
    }
  };

  const joinByCode = async () => {
    if (!inviteCode.trim() || !token) return;
    setError(null);
    try {
      const r = await fetch('/api/projects/groups/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteCode: inviteCode.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Aansluiten mislukt');
      // Sessie-record wordt server-side aangemaakt (supabaseAdmin).
      setJoinDialog(false); setInviteCode('');
      navigate(`/projects/${d.group.project_id}/group/${d.group.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Laden…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-1">Projecten</h1>
          <p className="text-gray-600">Werk in groepen aan een onderzoeksproject. Je kunt opnieuw beginnen of doorgaan met je vorige werk.</p>
        </div>
        <button onClick={() => setJoinDialog(true)} className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg text-sm font-medium" data-testid="button-open-join">
          <Users className="w-4 h-4" /> Aansluiten met invite-code
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {overview.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-500">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 text-gray-400" />
          <p>Je bent nog niet aan een cursus met projecten gekoppeld. Vraag je docent om je toe te voegen.</p>
        </div>
      ) : (
        overview.map(c => (
          <div key={c.course.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
              <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-4 h-4" /> {c.course.name}
              </h2>
              <p className="text-xs text-gray-500">{c.projects.length} project{c.projects.length === 1 ? '' : 'en'} beschikbaar</p>
            </div>
            <div className="p-6">
              {c.projects.length === 0 ? (
                <p className="text-sm text-gray-500">Nog geen actieve projecten in deze cursus.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {c.projects.map(p => {
                    const inProgress = p.activeGroup && p.lastSession && p.lastSession.status !== 'completed';
                    const completed = p.sessions.some(s => s.status === 'completed');
                    return (
                      <div key={p.id} className="border border-gray-200 rounded-xl p-5 flex flex-col gap-3" data-testid={`overview-project-${p.id}`}>
                        <div>
                          <div className="font-bold text-gray-900">{p.title}</div>
                          <p className="text-xs text-gray-500 line-clamp-2 mt-1">{p.research_question}</p>
                          <div className="text-[10px] text-gray-400 mt-1">
                            groep {p.min_group_size ?? 1}–{p.max_group_size ?? 5}
                            {inProgress && <span className="ml-2 inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">bezig</span>}
                            {completed && !inProgress && <span className="ml-2 inline-block px-1.5 py-0.5 bg-green-100 text-green-700 rounded">eerder afgerond</span>}
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 mt-auto">
                          {inProgress && (
                            <button
                              onClick={() => continueExisting(p)}
                              className="flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
                              data-testid={`button-continue-${p.id}`}
                            >
                              <ArrowRight className="w-4 h-4" /> Vervolg laatste sessie
                            </button>
                          )}
                          <button
                            onClick={() => startNew(p)}
                            disabled={busyProjectId === p.id || !!inProgress}
                            className="flex items-center justify-center gap-2 px-3 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-40"
                            data-testid={`button-start-${p.id}`}
                          >
                            <PlayCircle className="w-4 h-4" /> Start nieuw project
                          </button>
                          {(inProgress || completed) && (
                            <button
                              onClick={() => setRestartConfirm(p)}
                              disabled={busyProjectId === p.id}
                              className="flex items-center justify-center gap-2 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40"
                              data-testid={`button-restart-${p.id}`}
                            >
                              <RefreshCw className="w-4 h-4" /> Herstart (sluit huidige af)
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))
      )}

      {restartConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2">Project opnieuw starten?</h3>
            <p className="text-sm text-gray-600 mb-4">
              Je huidige sessie van <strong>"{restartConfirm.title}"</strong> wordt afgesloten en als afgerond gemarkeerd. Je oude voortgang blijft bewaard. Daarna start een verse projectruimte met een nieuwe groep.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRestartConfirm(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" data-testid="button-restart-cancel">Annuleren</button>
              <button onClick={() => restart(restartConfirm)} disabled={busyProjectId === restartConfirm.id} className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-40" data-testid="button-restart-confirm">
                {busyProjectId === restartConfirm.id ? 'Bezig…' : 'Ja, herstarten'}
              </button>
            </div>
          </div>
        </div>
      )}

      {joinDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2">Aansluiten bij een groep</h3>
            <p className="text-sm text-gray-600 mb-3">Vul de invite-code in die je van een groepsgenoot hebt gekregen.</p>
            <input
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value.toUpperCase())}
              placeholder="bijv. ABC123"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono uppercase"
              data-testid="input-invite-code"
            />
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => { setJoinDialog(false); setInviteCode(''); }} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">Annuleren</button>
              <button onClick={joinByCode} disabled={!inviteCode.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40" data-testid="button-confirm-join">
                Aansluiten
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectsPage;
