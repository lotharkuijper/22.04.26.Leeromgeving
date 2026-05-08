import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { Plus, FolderOpen, Users, Hash, Loader2, ArrowRight } from 'lucide-react';

interface ProjectRow {
  id: string;
  title: string;
  research_question: string;
  description: string | null;
  briefing_markdown: string | null;
  course_id: string | null;
  status: string | null;
  max_group_size: number | null;
  allow_self_signup: boolean | null;
  created_at: string;
}
interface MyGroup {
  id: string;
  name: string;
  invite_code: string;
  status: string;
  project_id: string;
}

export function ProjectsPage() {
  const { profile, session } = useAuth();
  const { activeCourseId } = useActiveCourse();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [myGroups, setMyGroups] = useState<Record<string, MyGroup>>({});
  const [loading, setLoading] = useState(true);
  const [creatingGroupForProject, setCreatingGroupForProject] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = session?.access_token;

  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
      // Filter op actieve cursus indien gekozen; oude rijen zonder course_id altijd tonen.
      if (activeCourseId) {
        q = q.or(`course_id.eq.${activeCourseId},course_id.is.null`);
      }
      const { data: projs } = await q;
      const filtered = (projs || []).filter((p: any) => p.status !== 'archived');
      setProjects(filtered as any);

      const { data: memberships } = await supabase
        .from('project_group_members')
        .select('group_id, project_groups(id, name, invite_code, status, project_id)')
        .eq('user_id', profile.id);
      const map: Record<string, MyGroup> = {};
      (memberships || []).forEach((m: any) => {
        if (m.project_groups) map[m.project_groups.project_id] = m.project_groups;
      });
      setMyGroups(map);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [profile?.id, activeCourseId]);

  useEffect(() => { load(); }, [load]);

  const startSolo = async (project: ProjectRow) => {
    if (!token) return;
    setCreatingGroupForProject(project.id);
    setError(null);
    try {
      const r = await fetch('/api/projects/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: project.id, name: `Solo: ${project.title.slice(0, 40)}` }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kon groep niet aanmaken');
      navigate(`/projects/${project.id}/group/${data.group.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingGroupForProject(null);
    }
  };

  const createGroup = async (project: ProjectRow) => {
    if (!token) return;
    const name = window.prompt(`Groepsnaam voor "${project.title}":`, '');
    if (!name) return;
    setCreatingGroupForProject(project.id);
    setError(null);
    try {
      const r = await fetch('/api/projects/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: project.id, name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kon groep niet aanmaken');
      navigate(`/projects/${project.id}/group/${data.group.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingGroupForProject(null);
    }
  };

  const joinByCode = async () => {
    if (!joinCode.trim() || !token) return;
    setJoining(true);
    setError(null);
    try {
      const r = await fetch('/api/projects/groups/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteCode: joinCode.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kon niet aansluiten');
      navigate(`/projects/${data.group.project_id}/group/${data.group.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-1">Projecten</h1>
          <p className="text-gray-600 text-sm">Werk samen aan een onderzoeksproject in een gedeelde projectruimte.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Invite-code"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono w-32"
            data-testid="input-join-code"
          />
          <button
            onClick={joinByCode}
            disabled={!joinCode.trim() || joining}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-900 text-white rounded-lg text-sm disabled:opacity-40"
            data-testid="button-join-group"
          >
            <Hash className="w-4 h-4" /> Aansluiten
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm" data-testid="text-projects-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400"><Loader2 className="w-6 h-6 animate-spin inline" /></div>
      ) : projects.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center">
          <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600">Nog geen projecten in deze cursus. {profile?.role !== 'student' && 'Maak er één aan in het beheer.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map(p => {
            const myGroup = myGroups[p.id];
            const maxSize = p.max_group_size ?? 5;
            return (
              <div key={p.id} className="bg-white border border-gray-200 rounded-2xl p-5 flex flex-col" data-testid={`card-project-${p.id}`}>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">{p.title}</h2>
                <p className="text-sm text-gray-500 mb-3 line-clamp-2">{p.research_question || p.description}</p>
                {p.briefing_markdown && (
                  <p className="text-xs text-gray-400 mb-4 line-clamp-3 whitespace-pre-wrap">{p.briefing_markdown.slice(0, 240)}</p>
                )}
                <div className="text-xs text-gray-500 mb-4 flex items-center gap-3">
                  <span className="flex items-center gap-1"><Users className="w-3 h-3" /> max {maxSize}</span>
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  {myGroup ? (
                    <Link
                      to={`/projects/${p.id}/group/${myGroup.id}`}
                      className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
                      data-testid={`link-open-room-${p.id}`}
                    >
                      Open projectruimte <ArrowRight className="w-4 h-4" />
                    </Link>
                  ) : (
                    <>
                      <button
                        onClick={() => startSolo(p)}
                        disabled={creatingGroupForProject === p.id}
                        className="px-3 py-2 bg-gray-100 text-gray-800 rounded-lg text-sm hover:bg-gray-200 disabled:opacity-40"
                        data-testid={`button-start-solo-${p.id}`}
                      >
                        Solo starten
                      </button>
                      <button
                        onClick={() => createGroup(p)}
                        disabled={creatingGroupForProject === p.id}
                        className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
                        data-testid={`button-create-group-${p.id}`}
                      >
                        <Plus className="w-4 h-4" /> Groep aanmaken
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ProjectsPage;
