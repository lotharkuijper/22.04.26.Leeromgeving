import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  BarChart3,
  Plus,
  FolderOpen,
  Clock,
  CheckCircle,
  PlayCircle,
  FileText,
  TrendingUp,
  Calendar,
  Target,
  BookText,
  X,
} from 'lucide-react';
import type { Database } from '../lib/database.types';

type Project = Database['public']['Tables']['projects']['Row'];
type ProjectSession = Database['public']['Tables']['student_project_sessions']['Row'];

interface ProjectWithSessions extends Project {
  session?: ProjectSession;
}

export function ProjectsPage() {
  const { profile, isDocent, isAdmin } = useAuth();
  const [projects, setProjects] = useState<ProjectWithSessions[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectWithSessions | null>(null);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'available' | 'inProgress' | 'completed'>('available');
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [archiveDialog, setArchiveDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    loadProjects();
    loadSessions();
  }, []);

  const loadProjects = async () => {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading projects:', error);
      return;
    }

    setProjects(data || []);
  };

  const loadSessions = async () => {
    if (!profile) return;

    const { data, error } = await supabase
      .from('student_project_sessions')
      .select('*')
      .eq('student_id', profile.id)
      .order('started_at', { ascending: false });

    if (error) {
      console.error('Error loading sessions:', error);
      return;
    }

    setSessions(data || []);
  };

  const handleStartProject = async (project: Project) => {
    if (!profile) return;

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('student_project_sessions')
        .insert({
          student_id: profile.id,
          project_id: project.id
        })
        .select()
        .single();

      if (error) throw error;

      await loadSessions();
      setSelectedProject({ ...project, session: data });
    } catch (error) {
      console.error('Error starting project:', error);
      alert('Er is een fout opgetreden bij het starten van het project');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateProgress = async (sessionId: string, notes: string) => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from('student_project_sessions')
        .update({
          notes,
          last_activity: new Date().toISOString()
        })
        .eq('id', sessionId);

      if (error) throw error;

      alert('Voortgang opgeslagen!');
      await loadSessions();
    } catch (error) {
      console.error('Error updating progress:', error);
      alert('Er is een fout opgetreden bij het opslaan van je voortgang');
    } finally {
      setLoading(false);
    }
  };

  const handleArchiveProject = async () => {
    if (!archiveDialog || archiving) return;
    setArchiving(true);
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const authHeader = authSession ? `Bearer ${authSession.access_token}` : '';
      const res = await fetch('/api/projects/save-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ sessionId: archiveDialog.sessionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `Opslaan mislukt (${res.status})`);
      }
      setArchiveNotice({
        kind: 'success',
        message: `Een samenvatting van "${archiveDialog.title}" is in je leerdagboek gezet. Je vindt hem terug onder het vak "Projecten".`,
      });
      setArchiveDialog(null);
    } catch (err: any) {
      setArchiveNotice({
        kind: 'error',
        message: `Het opslaan in je leerdagboek is mislukt: ${err?.message || 'onbekende fout'}.`,
      });
      setArchiveDialog(null);
    } finally {
      setArchiving(false);
    }
  };

  const handleCompleteProject = async (sessionId: string) => {
    const confirmComplete = window.confirm('Weet je zeker dat je dit project wilt afronden?');
    if (!confirmComplete) return;

    setLoading(true);
    try {
      const { error } = await supabase
        .from('student_project_sessions')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', sessionId);

      if (error) throw error;

      alert('Project afgerond! Een docent zal je werk beoordelen.');
      await loadSessions();
      setSelectedProject(null);
    } catch (error) {
      console.error('Error completing project:', error);
      alert('Er is een fout opgetreden');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    setLoading(true);
    try {
      const { error } = await supabase.from('projects').insert({
        title: formData.get('title') as string,
        description: formData.get('description') as string,
        learning_objectives: (formData.get('objectives') as string).split('\n').filter(o => o.trim()),
        difficulty_level: formData.get('difficulty') as 'beginner' | 'intermediate' | 'advanced'
      });

      if (error) throw error;

      alert('Project succesvol aangemaakt!');
      setShowNewProjectModal(false);
      await loadProjects();
    } catch (error) {
      console.error('Error creating project:', error);
      alert('Er is een fout opgetreden bij het aanmaken van het project');
    } finally {
      setLoading(false);
    }
  };

  const getProjectsForTab = () => {
    const projectsWithSessions = projects.map(project => {
      const session = sessions.find(s => s.project_id === project.id);
      return { ...project, session };
    });

    switch (activeTab) {
      case 'available':
        return projectsWithSessions.filter(p => !p.session);
      case 'inProgress':
        return projectsWithSessions.filter(p => p.session && p.session.status === 'in_progress');
      case 'completed':
        return projectsWithSessions.filter(p => p.session && p.session.status === 'completed');
      default:
        return [];
    }
  };

  const displayProjects = getProjectsForTab();

  if (selectedProject) {
    const session = sessions.find(s => s.project_id === selectedProject.id);

    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <button
            onClick={() => setSelectedProject(null)}
            className="text-gray-600 hover:text-gray-900 mb-4 flex items-center gap-2"
          >
            ← Terug naar projecten
          </button>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">{selectedProject.title}</h1>
              <div className="flex items-center gap-3">
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                  {selectedProject.difficulty_level}
                </span>
                {session && (
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    session.status === 'completed'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-blue-100 text-blue-700'
                  }`}>
                    {session.status === 'completed' ? 'Afgerond' : 'In uitvoering'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {session && (
                <button
                  onClick={() => setArchiveDialog({ sessionId: session.id, title: selectedProject.title })}
                  data-testid="btn-archive-project"
                  className="px-4 py-2 bg-white text-green-700 border border-green-300 font-semibold rounded-lg hover:bg-green-50 transition-all flex items-center gap-2"
                  title="Laat de leerassistent een samenvatting van dit project in je leerdagboek zetten"
                >
                  <BookText className="w-4 h-4" />
                  Verplaats naar leerdagboek
                </button>
              )}
              {session && session.status === 'in_progress' && (
                <button
                  onClick={() => handleCompleteProject(session.id)}
                  disabled={loading}
                  className="px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg flex items-center gap-2"
                >
                  <CheckCircle className="w-4 h-4" />
                  Project Afronden
                </button>
              )}
            </div>
          </div>
        </div>

        {archiveNotice && (
          <div
            data-testid="archive-notice"
            className={`rounded-xl border px-4 py-3 flex items-start justify-between gap-3 ${
              archiveNotice.kind === 'success'
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            <p className="text-sm">{archiveNotice.message}</p>
            <button
              onClick={() => setArchiveNotice(null)}
              className="text-current opacity-60 hover:opacity-100"
              data-testid="btn-dismiss-archive-notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Beschrijving</h2>
          <p className="text-gray-700 whitespace-pre-wrap">{selectedProject.description}</p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2">
            <Target className="w-5 h-5 text-orange-600" />
            Leerdoelen
          </h2>
          <ul className="space-y-2">
            {selectedProject.learning_objectives?.map((objective, index) => (
              <li key={index} className="flex items-start gap-2 text-gray-700">
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <span>{objective}</span>
              </li>
            ))}
          </ul>
        </div>

        {session ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Je Werk</h2>
            {session.status === 'in_progress' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  handleUpdateProgress(session.id, formData.get('notes') as string);
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Aantekeningen en Bevindingen
                  </label>
                  <textarea
                    name="notes"
                    defaultValue={session.notes || ''}
                    rows={10}
                    placeholder="Documenteer je analyse, bevindingen, conclusies..."
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all outline-none resize-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-6 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-semibold rounded-xl hover:from-orange-600 hover:to-orange-700 transition-all shadow-lg disabled:opacity-50"
                >
                  {loading ? 'Opslaan...' : 'Voortgang Opslaan'}
                </button>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <p className="font-semibold text-green-900 mb-1">Project Afgerond</p>
                  <p className="text-sm text-green-700">
                    Je hebt dit project op {new Date(session.completed_at!).toLocaleDateString('nl-NL')} afgerond.
                  </p>
                </div>
                {session.notes && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Je Aantekeningen</h3>
                    <div className="p-4 bg-gray-50 rounded-lg whitespace-pre-wrap text-gray-700">
                      {session.notes}
                    </div>
                  </div>
                )}
                {session.feedback && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Feedback van Docent</h3>
                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg whitespace-pre-wrap text-blue-900">
                      {session.feedback}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
            <PlayCircle className="w-16 h-16 mx-auto mb-4 text-orange-600" />
            <h3 className="text-xl font-bold text-gray-900 mb-2">Klaar om te beginnen?</h3>
            <p className="text-gray-600 mb-6">Start dit project en begin met je analyse</p>
            <button
              onClick={() => handleStartProject(selectedProject)}
              disabled={loading}
              className="px-6 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-semibold rounded-xl hover:from-orange-600 hover:to-orange-700 transition-all shadow-lg disabled:opacity-50"
            >
              {loading ? 'Starten...' : 'Project Starten'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Projecten</h1>
          <p className="text-gray-600">
            Werk aan praktische data-analyse projecten in epidemiologie en biostatistiek
          </p>
        </div>
        {(isDocent || isAdmin) && (
          <button
            onClick={() => setShowNewProjectModal(true)}
            className="px-4 py-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-semibold rounded-lg hover:from-orange-600 hover:to-orange-700 transition-all shadow-lg flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Nieuw Project
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-2">
            <FolderOpen className="w-6 h-6 text-gray-600" />
            <div>
              <div className="text-2xl font-bold text-gray-900">
                {projects.filter(p => !sessions.find(s => s.project_id === p.id)).length}
              </div>
              <div className="text-sm text-gray-600">Beschikbaar</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-2">
            <Clock className="w-6 h-6 text-blue-600" />
            <div>
              <div className="text-2xl font-bold text-gray-900">
                {sessions.filter(s => s.status === 'in_progress').length}
              </div>
              <div className="text-sm text-gray-600">In Uitvoering</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle className="w-6 h-6 text-green-600" />
            <div>
              <div className="text-2xl font-bold text-gray-900">
                {sessions.filter(s => s.status === 'completed').length}
              </div>
              <div className="text-sm text-gray-600">Afgerond</div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="border-b border-gray-200">
          <div className="flex">
            {[
              { id: 'available', label: 'Beschikbaar', icon: FolderOpen },
              { id: 'inProgress', label: 'In Uitvoering', icon: Clock },
              { id: 'completed', label: 'Afgerond', icon: CheckCircle }
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex items-center gap-2 px-6 py-4 font-medium transition-all ${
                    activeTab === tab.id
                      ? 'text-orange-600 border-b-2 border-orange-600 bg-orange-50'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-6">
          {displayProjects.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <BarChart3 className="w-12 h-12 mx-auto mb-3 text-gray-400" />
              <p>Geen projecten in deze categorie</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {displayProjects.map((project) => (
                <div
                  key={project.id}
                  className="border border-gray-200 rounded-xl p-6 hover:shadow-lg transition-all cursor-pointer"
                  onClick={() => setSelectedProject(project)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-lg font-bold text-gray-900">{project.title}</h3>
                    <span className="px-2 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                      {project.difficulty_level}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 line-clamp-2 mb-4">{project.description}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Calendar className="w-4 h-4" />
                      {new Date(project.created_at).toLocaleDateString('nl-NL')}
                    </div>
                    {project.session && (
                      <span className={`text-xs px-2 py-1 rounded-full font-semibold ${
                        project.session.status === 'completed'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {project.session.status === 'completed' ? 'Afgerond' : 'Bezig'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showNewProjectModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Nieuw Project Aanmaken</h2>
            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Project Titel
                </label>
                <input
                  type="text"
                  name="title"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Beschrijving
                </label>
                <textarea
                  name="description"
                  required
                  rows={4}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Leerdoelen (één per regel)
                </label>
                <textarea
                  name="objectives"
                  required
                  rows={4}
                  placeholder="Voorbeeld:&#10;Cohort studies kunnen analyseren&#10;P-waarden correct interpreteren"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Moeilijkheidsgraad
                </label>
                <select
                  name="difficulty"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all outline-none"
                >
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowNewProjectModal(false)}
                  className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300 transition-all"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 px-4 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-semibold rounded-lg hover:from-orange-600 hover:to-orange-700 transition-all disabled:opacity-50"
                >
                  {loading ? 'Aanmaken...' : 'Project Aanmaken'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {archiveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" data-testid="dialog-archive-project">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-green-100 rounded-xl">
                <BookText className="w-5 h-5 text-green-700" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Verplaats naar leerdagboek</h2>
              <button
                onClick={() => !archiving && setArchiveDialog(null)}
                className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
                data-testid="btn-archive-project-cancel"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-2">
              Je staat op het punt om project <strong>"{archiveDialog.title}"</strong> te archiveren in je leerdagboek.
            </p>
            <p className="text-sm text-gray-600 mb-6">
              De leerassistent schrijft een formatieve samenvatting van je hypothese, analyse-aantekeningen en conclusies. Die notitie verschijnt onder het vak <strong>"Projecten"</strong> in je leerdagboek. Je projectsessie zelf blijft staan; je kunt er nog aan blijven werken.
            </p>

            <div className="flex flex-col gap-3">
              <button
                onClick={handleArchiveProject}
                disabled={archiving}
                data-testid="btn-archive-project-confirm"
                className="px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <BookText className="w-4 h-4" />
                {archiving ? 'Bezig met opslaan...' : 'Ja, samenvatting opslaan'}
              </button>
              <button
                onClick={() => setArchiveDialog(null)}
                disabled={archiving}
                data-testid="btn-archive-project-dismiss"
                className="px-4 py-3 bg-gray-100 text-gray-700 font-semibold rounded-xl hover:bg-gray-200 transition-all disabled:opacity-50"
              >
                Annuleren
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
