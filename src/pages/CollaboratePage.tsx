import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  Users,
  Plus,
  MessageSquare,
  UserPlus,
  TrendingUp,
  Calendar,
  CheckCircle,
  Clock,
  Target
} from 'lucide-react';
import type { Database } from '../lib/database.types';

type Group = Database['public']['Tables']['collaboration_groups']['Row'];
type GroupMember = Database['public']['Tables']['group_members']['Row'];
type SharedProject = Database['public']['Tables']['shared_projects']['Row'];

interface GroupWithDetails extends Group {
  memberCount?: number;
  projectCount?: number;
  members?: Array<GroupMember & { profile?: { full_name: string; email: string } }>;
  projects?: SharedProject[];
}

export function CollaboratePage() {
  const { profile } = useAuth();
  const [groups, setGroups] = useState<GroupWithDetails[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithDetails | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadGroups();
  }, []);

  useEffect(() => {
    if (selectedGroup) {
      loadGroupDetails(selectedGroup.id);
    }
  }, [selectedGroup?.id]);

  const loadGroups = async () => {
    if (!profile) return;

    const { data: memberData, error: memberError } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('student_id', profile.id);

    if (memberError) {
      console.error('Error loading group memberships:', memberError);
      return;
    }

    const groupIds = memberData?.map(m => m.group_id) || [];

    if (groupIds.length === 0) {
      setGroups([]);
      return;
    }

    const { data: groupsData, error: groupsError } = await supabase
      .from('collaboration_groups')
      .select('*')
      .in('id', groupIds)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (groupsError) {
      console.error('Error loading groups:', groupsError);
      return;
    }

    const groupsWithCounts = await Promise.all(
      (groupsData || []).map(async (group) => {
        const { count: memberCount } = await supabase
          .from('group_members')
          .select('*', { count: 'exact', head: true })
          .eq('group_id', group.id);

        const { count: projectCount } = await supabase
          .from('shared_projects')
          .select('*', { count: 'exact', head: true })
          .eq('group_id', group.id);

        return {
          ...group,
          memberCount: memberCount || 0,
          projectCount: projectCount || 0
        };
      })
    );

    setGroups(groupsWithCounts);
  };

  const loadGroupDetails = async (groupId: string) => {
    const { data: membersData, error: membersError } = await supabase
      .from('group_members')
      .select('*, profiles!group_members_student_id_fkey(full_name, email)')
      .eq('group_id', groupId);

    if (membersError) {
      console.error('Error loading members:', membersError);
      return;
    }

    const { data: projectsData, error: projectsError } = await supabase
      .from('shared_projects')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });

    if (projectsError) {
      console.error('Error loading projects:', projectsError);
      return;
    }

    setSelectedGroup(prev => prev ? {
      ...prev,
      members: membersData as any,
      projects: projectsData || []
    } : null);
  };

  const handleCreateGroup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!profile) return;

    const formData = new FormData(e.currentTarget);
    setLoading(true);

    try {
      const { data: groupData, error: groupError } = await supabase
        .from('collaboration_groups')
        .insert({
          name: formData.get('name') as string,
          description: formData.get('description') as string,
          created_by: profile.id
        })
        .select()
        .single();

      if (groupError) throw groupError;

      const { error: memberError } = await supabase
        .from('group_members')
        .insert({
          group_id: groupData.id,
          student_id: profile.id,
          role: 'admin'
        });

      if (memberError) throw memberError;

      alert(`Groep aangemaakt! Uitnodigingscode: ${groupData.invite_code}`);
      setShowCreateModal(false);
      await loadGroups();
    } catch (error) {
      console.error('Error creating group:', error);
      alert('Er is een fout opgetreden bij het aanmaken van de groep');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinGroup = async () => {
    if (!profile || !joinCode.trim()) return;

    setLoading(true);
    try {
      const { data: groupData, error: groupError } = await supabase
        .from('collaboration_groups')
        .select('id')
        .eq('invite_code', joinCode.trim())
        .eq('status', 'active')
        .maybeSingle();

      if (groupError) throw groupError;
      if (!groupData) {
        alert('Ongeldige uitnodigingscode');
        return;
      }

      const { data: existingMember } = await supabase
        .from('group_members')
        .select('id')
        .eq('group_id', groupData.id)
        .eq('student_id', profile.id)
        .maybeSingle();

      if (existingMember) {
        alert('Je bent al lid van deze groep');
        return;
      }

      const { error: memberError } = await supabase
        .from('group_members')
        .insert({
          group_id: groupData.id,
          student_id: profile.id,
          role: 'member'
        });

      if (memberError) throw memberError;

      alert('Succesvol toegevoegd aan de groep!');
      setShowJoinModal(false);
      setJoinCode('');
      await loadGroups();
    } catch (error) {
      console.error('Error joining group:', error);
      alert('Er is een fout opgetreden bij het toetreden tot de groep');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSharedProject = async (groupId: string, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    setLoading(true);
    try {
      const { error } = await supabase.from('shared_projects').insert({
        group_id: groupId,
        title: formData.get('title') as string,
        description: formData.get('description') as string
      });

      if (error) throw error;

      alert('Gezamenlijk project aangemaakt!');
      await loadGroupDetails(groupId);
    } catch (error) {
      console.error('Error creating shared project:', error);
      alert('Er is een fout opgetreden');
    } finally {
      setLoading(false);
    }
  };

  if (selectedGroup) {
    const isAdmin = selectedGroup.members?.find(m => m.student_id === profile?.id)?.role === 'admin';

    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <button
            onClick={() => setSelectedGroup(null)}
            className="text-gray-600 hover:text-gray-900 mb-4 flex items-center gap-2"
          >
            ← Terug naar groepen
          </button>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">{selectedGroup.name}</h1>
              <p className="text-gray-600">{selectedGroup.description}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <Users className="w-6 h-6 text-pink-600" />
              <div>
                <div className="text-2xl font-bold text-gray-900">
                  {selectedGroup.members?.length || 0}
                </div>
                <div className="text-sm text-gray-600">Leden</div>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <Target className="w-6 h-6 text-orange-600" />
              <div>
                <div className="text-2xl font-bold text-gray-900">
                  {selectedGroup.projects?.length || 0}
                </div>
                <div className="text-sm text-gray-600">Projecten</div>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <Calendar className="w-6 h-6 text-blue-600" />
              <div>
                <div className="text-sm font-bold text-gray-900">
                  {new Date(selectedGroup.created_at).toLocaleDateString('nl-NL')}
                </div>
                <div className="text-sm text-gray-600">Aangemaakt</div>
              </div>
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="bg-gradient-to-r from-pink-50 to-pink-100 rounded-2xl border border-pink-200 p-6">
            <h3 className="font-semibold text-pink-900 mb-2">Uitnodigingscode</h3>
            <div className="flex items-center gap-3">
              <code className="flex-1 px-4 py-2 bg-white rounded-lg font-mono text-lg text-gray-900 border border-pink-200">
                {selectedGroup.invite_code}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedGroup.invite_code || '');
                  alert('Code gekopieerd!');
                }}
                className="px-4 py-2 bg-pink-600 text-white font-semibold rounded-lg hover:bg-pink-700 transition-colors"
              >
                Kopieer
              </button>
            </div>
            <p className="text-sm text-pink-700 mt-2">
              Deel deze code met anderen om ze uit te nodigen voor je groep
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Users className="w-6 h-6 text-pink-600" />
            Groepsleden
          </h2>
          <div className="space-y-2">
            {selectedGroup.members?.map((member) => (
              <div key={member.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-500 to-pink-600 flex items-center justify-center text-white font-semibold">
                    {(member.profile as any)?.full_name?.[0] || '?'}
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">
                      {(member.profile as any)?.full_name || 'Gebruiker'}
                    </p>
                    <p className="text-sm text-gray-600">
                      {(member.profile as any)?.email}
                    </p>
                  </div>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                  member.role === 'admin'
                    ? 'bg-pink-100 text-pink-700'
                    : 'bg-gray-200 text-gray-700'
                }`}>
                  {member.role === 'admin' ? 'Beheerder' : 'Lid'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Target className="w-6 h-6 text-orange-600" />
              Gezamenlijke Projecten
            </h2>
          </div>

          {isAdmin && (
            <form onSubmit={(e) => handleCreateSharedProject(selectedGroup.id, e)} className="mb-6 p-4 bg-gray-50 rounded-lg">
              <h3 className="font-semibold text-gray-900 mb-3">Nieuw Project Starten</h3>
              <div className="space-y-3">
                <input
                  type="text"
                  name="title"
                  placeholder="Project titel"
                  required
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all outline-none"
                />
                <textarea
                  name="description"
                  placeholder="Project beschrijving"
                  required
                  rows={3}
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all outline-none resize-none"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-2 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition-all disabled:opacity-50"
                >
                  {loading ? 'Aanmaken...' : 'Project Aanmaken'}
                </button>
              </div>
            </form>
          )}

          {selectedGroup.projects && selectedGroup.projects.length > 0 ? (
            <div className="space-y-3">
              {selectedGroup.projects.map((project) => (
                <div key={project.id} className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-gray-900">{project.title}</h3>
                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                      project.status === 'completed'
                        ? 'bg-green-100 text-green-700'
                        : project.status === 'in_progress'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-200 text-gray-700'
                    }`}>
                      {project.status === 'completed' ? 'Afgerond' : project.status === 'in_progress' ? 'Bezig' : 'Niet gestart'}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2">{project.description}</p>
                  <div className="text-xs text-gray-500">
                    Aangemaakt op {new Date(project.created_at).toLocaleDateString('nl-NL')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <Target className="w-12 h-12 mx-auto mb-3 text-gray-400" />
              <p>Nog geen gezamenlijke projecten</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Samenwerken</h1>
          <p className="text-gray-600">
            Werk samen met medestudenten aan projecten en leer van elkaar
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowJoinModal(true)}
            className="px-4 py-2 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300 transition-all flex items-center gap-2"
          >
            <UserPlus className="w-4 h-4" />
            Groep Joinen
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition-all shadow-lg flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Nieuwe Groep
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <Users className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Nog geen groepen</h2>
          <p className="text-gray-600 mb-6">
            Maak een nieuwe groep aan of join een bestaande groep met een uitnodigingscode
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => setShowJoinModal(true)}
              className="px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300 transition-all flex items-center gap-2"
            >
              <UserPlus className="w-5 h-5" />
              Groep Joinen
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-6 py-3 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition-all shadow-lg flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Nieuwe Groep
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => (
            <div
              key={group.id}
              onClick={() => setSelectedGroup(group)}
              className="bg-white rounded-2xl border border-gray-200 p-6 hover:shadow-xl transition-all cursor-pointer"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-pink-500 to-pink-600 flex items-center justify-center text-white">
                  <Users className="w-6 h-6" />
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-pink-100 text-pink-700 font-semibold">
                  Actief
                </span>
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{group.name}</h3>
              <p className="text-sm text-gray-600 line-clamp-2 mb-4">{group.description}</p>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-1 text-gray-600">
                  <Users className="w-4 h-4" />
                  <span>{group.memberCount} leden</span>
                </div>
                <div className="flex items-center gap-1 text-gray-600">
                  <Target className="w-4 h-4" />
                  <span>{group.projectCount} projecten</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Nieuwe Groep Aanmaken</h2>
            <form onSubmit={handleCreateGroup} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Groepsnaam
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  placeholder="bijv. Epidemiologie Team 1"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Beschrijving
                </label>
                <textarea
                  name="description"
                  required
                  rows={3}
                  placeholder="Waar gaat jullie groep zich mee bezighouden?"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all outline-none resize-none"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300 transition-all"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 px-4 py-3 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition-all disabled:opacity-50"
                >
                  {loading ? 'Aanmaken...' : 'Groep Aanmaken'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Groep Joinen</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Uitnodigingscode
                </label>
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="Voer de uitnodigingscode in"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all outline-none font-mono"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowJoinModal(false);
                    setJoinCode('');
                  }}
                  className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300 transition-all"
                >
                  Annuleren
                </button>
                <button
                  onClick={handleJoinGroup}
                  disabled={loading || !joinCode.trim()}
                  className="flex-1 px-4 py-3 bg-gradient-to-r from-pink-500 to-pink-600 text-white font-semibold rounded-lg hover:from-pink-600 hover:to-pink-700 transition-all disabled:opacity-50"
                >
                  {loading ? 'Joinen...' : 'Groep Joinen'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
