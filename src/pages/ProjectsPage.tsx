import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import {
  PlayCircle, RefreshCw, ArrowRight, FolderOpen, BookOpen, Loader2,
  AlertCircle, Users,
} from 'lucide-react';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';
import { useContentTranslation, type TranslatableItem } from '../hooks/useContentTranslation';

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
  activeGroup: { id: string; name: string; invite_code: string; status: string; lastCheckpointAt: string | null } | null;
}

interface OverviewCourse {
  course: { id: string; name: string };
  projects: OverviewProject[];
}

export function ProjectsPage() {
  const { t, lang } = useLanguage();
  const { profile, session } = useAuth();
  const { activeCourseId } = useActiveCourse();
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
      if (!r.ok) throw new Error(d.error || t('projects.couldNotLoad'));
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
      if (!r.ok) throw new Error(d.error || t('projects.creationFailed'));
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
      if (!r.ok) throw new Error(d.error || t('projects.restartFailed'));
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
      if (!r.ok) throw new Error(d.error || t('projects.joinFailed'));
      // Sessie-record wordt server-side aangemaakt (supabaseAdmin).
      setJoinDialog(false); setInviteCode('');
      navigate(`/projects/${d.group.project_id}/group/${d.group.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Toon alleen projecten van de actieve cursus. Een project hoort bij precies
  // één cursus; staat de actieve cursus op iets anders, dan mag dat project
  // hier niet verschijnen.
  const visibleCourses = activeCourseId
    ? overview.filter(c => c.course.id === activeCourseId)
    : overview;

  // Vertaal projecttitels + onderzoeksvragen naar de actieve taal (Task #288).
  // De hook MOET vóór elke early-return staan zodat de hook-volgorde tussen
  // renders stabiel blijft (tijdens loading is overview leeg → projectItems leeg).
  const projectItems: Record<string, TranslatableItem> = {};
  for (const c of visibleCourses) {
    for (const p of c.projects) {
      projectItems[`title:${p.id}`] = { text: p.title, format: 'plain' };
      projectItems[`rq:${p.id}`] = { text: p.research_question, format: 'plain' };
    }
  }
  const projT = useContentTranslation(projectItems);

  if (loading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> {t('common.loading')}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-1">{t('projects.title')}</h1>
          <p className="text-gray-600">{t('projects.subtitle')}</p>
          <AutoTranslatedNotice
            isTranslating={projT.isTranslating}
            isTranslated={projT.isTranslated}
            showOriginal={projT.showOriginal}
            onToggle={projT.setShowOriginal}
            className="mt-1"
          />
        </div>
        <button onClick={() => setJoinDialog(true)} className="btn-secondary text-sm" data-testid="button-open-join">
          <Users className="w-4 h-4" /> {t('projects.joinWithCode')}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {visibleCourses.length === 0 ? (
        <div className="chic-card p-12 text-center text-gray-500">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 text-gray-400" />
          <p>{t('projects.notLinked')}</p>
        </div>
      ) : (
        visibleCourses.map(c => (
          <div key={c.course.id} className="chic-card overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
              <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-4 h-4" /> {c.course.name}
              </h2>
              <p className="text-xs text-gray-500">{c.projects.length === 1 ? t('projects.projectCountSingular', { count: '1' }) : t('projects.projectCountPlural', { count: String(c.projects.length) })}</p>
            </div>
            <div className="p-6">
              {c.projects.length === 0 ? (
                <p className="text-sm text-gray-500">{t('projects.noActiveProjects')}</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {c.projects.map(p => {
                    // activeGroup is de bron van waarheid: als de user lid is van een actieve groep
                    // kan hij/zij doorgaan — ongeacht of er een sessie-record bestaat.
                    const inProgress = !!p.activeGroup;
                    const completed = p.sessions.some(s => s.status === 'completed');
                    return (
                      <div key={p.id} className="border border-gray-200 rounded-xl p-5 flex flex-col gap-3" data-testid={`overview-project-${p.id}`}>
                        <div>
                          <div className="font-bold text-gray-900">{projT.values[`title:${p.id}`] || p.title}</div>
                          <p className="text-xs text-gray-500 line-clamp-2 mt-1">{projT.values[`rq:${p.id}`] || p.research_question}</p>
                          <div className="text-[10px] text-gray-400 mt-1">
                            {t('projects.groupSize', { min: String(p.min_group_size ?? 1), max: String(p.max_group_size ?? 5) })}
                            {inProgress && <span className="ml-2 inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{t('projects.inProgress')}</span>}
                            {completed && !inProgress && <span className="ml-2 inline-block px-1.5 py-0.5 bg-green-100 text-green-700 rounded">{t('projects.previouslyCompleted')}</span>}
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 mt-auto">
                          {inProgress && (
                            <button
                              onClick={() => continueExisting(p)}
                              className="flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
                              data-testid={`button-continue-${p.id}`}
                            >
                              <ArrowRight className="w-4 h-4" />
                              {p.activeGroup?.lastCheckpointAt ? (
                                <span className="flex flex-col items-start leading-tight">
                                  <span>{t('projects.continue2')}</span>
                                  <span className="text-[10px] font-normal opacity-80">
                                    {t('projects.lastCheckpoint')} {new Date(p.activeGroup.lastCheckpointAt).toLocaleString(t('common.locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </span>
                              ) : (
                                <span>{t('projects.continue2')}</span>
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => startNew(p)}
                            disabled={busyProjectId === p.id || !!inProgress}
                            className="flex items-center justify-center gap-2 px-3 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-40"
                            data-testid={`button-start-${p.id}`}
                          >
                            <PlayCircle className="w-4 h-4" /> {t('projects.startNewProject')}
                          </button>
                          {(inProgress || completed) && (
                            <button
                              onClick={() => setRestartConfirm(p)}
                              disabled={busyProjectId === p.id}
                              className="flex items-center justify-center gap-2 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40"
                              data-testid={`button-restart-${p.id}`}
                            >
                              <RefreshCw className="w-4 h-4" /> {t('projects.startOver')}
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
            <h3 className="text-lg font-bold mb-2">{t('projects.startOverTitle')}</h3>
            <p className="text-sm text-gray-600 mb-3">
              <span>{t('projects.restartConfirmBefore')} <strong>"{restartConfirm.title}"</strong> {t('projects.restartConfirmAfter')}</span>
            </p>
            <ul className="text-sm text-gray-600 mb-4 space-y-1">
              <li className="flex items-start gap-1.5"><span className="text-green-600 mt-0.5">✓</span> {t('projects.restartBullet1')}</li>
              <li className="flex items-start gap-1.5"><span className="text-orange-500 mt-0.5">!</span> {t('projects.restartBullet2')}</li>
              <li className="flex items-start gap-1.5"><span className="text-orange-500 mt-0.5">!</span> {t('projects.restartBullet3')}</li>
            </ul>
            <p className="text-sm font-medium text-gray-800 mb-4"><span>{t('projects.restartQuestionBefore')} <span className="text-blue-700">"{t('projects.restartQuestionLink')}"</span>{t('projects.restartQuestionAfter')}</span></p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRestartConfirm(null)} className="btn-secondary text-sm" data-testid="button-restart-cancel">{t('projects.cancelContinue')}</button>
              <button onClick={() => restart(restartConfirm)} disabled={busyProjectId === restartConfirm.id} className="btn-danger text-sm" data-testid="button-restart-confirm">
                {busyProjectId === restartConfirm.id ? t('common.loading') : t('projects.restart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {joinDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2">{t('projects.joinAGroup')}</h3>
            <p className="text-sm text-gray-600 mb-3">{t('projects.enterInviteCode')}</p>
            <input
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value.toUpperCase())}
              placeholder={t('projects.codeExample')}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono uppercase"
              data-testid="input-invite-code"
            />
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => { setJoinDialog(false); setInviteCode(''); }} className="btn-secondary text-sm">{t('projects.cancel')}</button>
              <button onClick={joinByCode} disabled={!inviteCode.trim()} className="btn-primary text-sm" data-testid="button-confirm-join">
                {t('projects.join')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectsPage;
