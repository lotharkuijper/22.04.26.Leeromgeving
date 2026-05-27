import { useEffect, useState } from 'react';
import { Plus, Loader2, CheckCircle2, AlertTriangle, BookOpen, Pencil, X, Check, Power, Trash2, Users, FolderTree, FolderOpen, UserX, Flame } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCourseAccess } from '../contexts/CourseAccessContext';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

interface CourseRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

interface DeleteCounts {
  members: number;
  projects: number;
  sessions: number;
  journal_entries: number;
  extra_folders: number;
  documents: number;
}

export default function CoursesAdmin() {
  const { session, isAdmin, user } = useAuth();
  const { refreshCourses } = useCourseAccess();
  const { setActiveCourse } = useActiveCourse();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Cursussen waarin de huidige user per-cursus docent is — bepaalt of
  // de 'Beheer leden'-knop in een rij zichtbaar is voor non-admins.
  const [myTeacherCourseIds, setMyTeacherCourseIds] = useState<Set<string>>(new Set());
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Bewerk-state per rij.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Per-rij state voor activeren/deactiveren en verwijderen.
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [rowCounts, setRowCounts] = useState<Record<string, DeleteCounts | null>>({});
  const [confirmBulkMembersId, setConfirmBulkMembersId] = useState<string | null>(null);

  // Leden-beheerdialoog (per-cursus rol: 'student' | 'teacher').
  const [membersTarget, setMembersTarget] = useState<CourseRow | null>(null);
  const [membersList, setMembersList] = useState<Array<{
    user_id: string; member_role: 'student' | 'teacher';
    email: string | null; full_name: string | null;
    global_role: string;
  }>>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberRoleBusy, setMemberRoleBusy] = useState<string | null>(null);

  // Bevestigingsdialoog voor het verwijderen van een cursus.
  const [deleteTarget, setDeleteTarget] = useState<CourseRow | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(null);

  // Cascade-dialoog: verwijder cursus inclusief ALLE gekoppelde data.
  const [cascadeTarget, setCascadeTarget] = useState<CourseRow | null>(null);
  const [cascadeCounts, setCascadeCounts] = useState<DeleteCounts | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(false);
  const [cascadeConfirmText, setCascadeConfirmText] = useState('');
  const [cascadeDialogError, setCascadeDialogError] = useState<string | null>(null);

  function setRowError(id: string, msg: string | null) {
    setRowErrors((m) => ({ ...m, [id]: msg }));
  }

  function setRowCount(id: string, counts: DeleteCounts | null) {
    setRowCounts((m) => ({ ...m, [id]: counts }));
  }

  async function goToAdminTab(courseId: string, tab: string) {
    try {
      await setActiveCourse(courseId);
    } catch (err) {
      console.error('[CoursesAdmin] setActiveCourse failed:', err);
    }
    navigate(`/admin?tab=${tab}`);
  }

  async function bulkRemoveMembers(c: CourseRow) {
    setRowError(c.id, null);
    const token = session?.access_token;
    if (!token) {
      setRowError(c.id, 'Niet ingelogd.');
      return;
    }
    setRowBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}/members`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(c.id, json.error || `Verwijderen mislukt (${res.status})`);
        return;
      }
      // Update counts: members nu 0.
      setRowCounts((m) => {
        const prev = m[c.id];
        if (!prev) return m;
        return { ...m, [c.id]: { ...prev, members: 0 } };
      });
      setConfirmBulkMembersId(null);
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setRowError(c.id, msg);
    } finally {
      setRowBusyId(null);
    }
  }

  async function openMembersDialog(c: CourseRow) {
    setMembersTarget(c);
    setMembersList([]);
    setMembersError(null);
    setMembersLoading(true);
    const token = session?.access_token;
    if (!token) {
      setMembersError('Niet ingelogd.');
      setMembersLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/admin/courses/${c.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersError(json.error || `Laden mislukt (${res.status})`);
      } else {
        setMembersList(json.members || []);
      }
    } catch (err: unknown) {
      setMembersError(err instanceof Error ? err.message : 'Onbekende fout');
    } finally {
      setMembersLoading(false);
    }
  }

  async function changeMemberRole(userId: string, newRole: 'student' | 'teacher', force = false) {
    if (!membersTarget) return;
    const token = session?.access_token;
    if (!token) {
      setMembersError('Niet ingelogd.');
      return;
    }
    setMemberRoleBusy(userId);
    setMembersError(null);
    try {
      const url = `/api/admin/courses/${membersTarget.id}/members/${userId}${force ? '?force=1' : ''}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_role: newRole }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Bij last_teacher-409 mag een admin de wijziging forceren. We
        // vragen expliciet om bevestiging in plaats van stilletjes door te
        // duwen — zo blijft de bescherming zichtbaar.
        if (res.status === 409 && json.code === 'last_teacher' && isAdmin && !force) {
          const ok = window.confirm(
            `${json.error}\n\nWeet je zeker dat je deze cursus zonder docent achterlaat? (Alleen admins kunnen dit forceren.)`
          );
          if (ok) {
            return changeMemberRole(userId, newRole, true);
          }
          setMembersError(json.error);
          return;
        }
        setMembersError(json.error || `Bijwerken mislukt (${res.status})`);
        return;
      }
      setMembersList((prev) => prev.map((m) =>
        m.user_id === userId ? { ...m, member_role: newRole } : m
      ));
    } catch (err: unknown) {
      setMembersError(err instanceof Error ? err.message : 'Onbekende fout');
    } finally {
      setMemberRoleBusy(null);
    }
  }

  async function loadCourses() {
    setLoadingList(true);
    const { data, error: err } = await supabase
      .from('courses')
      .select('id, name, description, is_active')
      .order('name', { ascending: true });
    if (err) {
      console.error('[CoursesAdmin] load error:', err);
    }
    setCourses((data as CourseRow[]) ?? []);
    setLoadingList(false);
  }

  useEffect(() => {
    loadCourses();
  }, []);

  // Laad de set cursussen waarin de huidige user docent is, zodat we de
  // 'Beheer leden'-knop ook tonen voor per-cursus docenten (niet alleen
  // admin). Admins krijgen de knop sowieso, dus voor hen is dit overbodig.
  useEffect(() => {
    if (isAdmin || !user?.id || !session?.access_token) {
      setMyTeacherCourseIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/me/teacher-courses`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          console.warn('[CoursesAdmin] teacher-courses fetch failed:', json.error);
          return;
        }
        const ids = new Set<string>((json.courses || []).map((c: { courseId: string }) => c.courseId));
        setMyTeacherCourseIds(ids);
      } catch (err) {
        if (!cancelled) console.warn('[CoursesAdmin] teacher-courses exception:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, user?.id, session?.access_token]);

  // Open automatisch de members-dialog wanneer ?manageMembers=<id>
  // meegegeven is (bijv. via een link uit /admin → Gebruikers-uitklap).
  // Wacht tot de cursussenlijst geladen is en de bevoegdheid bekend.
  useEffect(() => {
    const wanted = searchParams.get('manageMembers');
    if (!wanted || loadingList || courses.length === 0) return;
    const course = courses.find((c) => c.id === wanted);
    if (!course) return;
    const allowed = isAdmin || myTeacherCourseIds.has(wanted);
    if (!allowed) return;
    if (membersTarget?.id === wanted) return;
    openMembersDialog(course);
    const next = new URLSearchParams(searchParams);
    next.delete('manageMembers');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, loadingList, courses, isAdmin, myTeacherCourseIds]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Cursusnaam is verplicht.');
      return;
    }
    const token = session?.access_token;
    if (!token) {
      setError('Niet ingelogd.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/courses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: trimmed, description: description.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Aanmaken mislukt (${res.status})`);
        return;
      }
      setSuccessMsg(`Cursus "${trimmed}" aangemaakt met RAG- en Projectdata-map.`);
      setName('');
      setDescription('');
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(c: CourseRow) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditDesc(c.description ?? '');
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName('');
    setEditDesc('');
    setEditError(null);
  }

  async function toggleActive(c: CourseRow) {
    setRowError(c.id, null);
    const token = session?.access_token;
    if (!token) {
      setRowError(c.id, 'Niet ingelogd.');
      return;
    }
    setRowBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ is_active: !c.is_active }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(c.id, json.error || `Wijzigen mislukt (${res.status})`);
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setRowError(c.id, msg);
    } finally {
      setRowBusyId(null);
    }
  }

  function requestDelete(c: CourseRow) {
    setRowError(c.id, null);
    setRowCount(c.id, null);
    setDeleteConfirmText('');
    setDeleteDialogError(null);
    setDeleteTarget(c);
  }

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setDeleteConfirmText('');
    setDeleteDialogError(null);
  }

  async function requestCascadeDelete(c: CourseRow) {
    setRowError(c.id, null);
    setRowCount(c.id, null);
    setCascadeConfirmText('');
    setCascadeDialogError(null);
    setCascadeCounts(null);
    setCascadeTarget(c);
    const token = session?.access_token;
    if (!token) {
      setCascadeDialogError('Niet ingelogd.');
      return;
    }
    setCascadeLoading(true);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}?preview=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCascadeDialogError(json.error || `Ophalen van tellingen mislukt (${res.status})`);
        return;
      }
      setCascadeCounts((json.counts ?? null) as DeleteCounts | null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setCascadeDialogError(msg);
    } finally {
      setCascadeLoading(false);
    }
  }

  function closeCascadeDialog() {
    setCascadeTarget(null);
    setCascadeCounts(null);
    setCascadeConfirmText('');
    setCascadeDialogError(null);
  }

  async function confirmCascadeDelete() {
    const c = cascadeTarget;
    if (!c) return;
    if (cascadeConfirmText.trim() !== c.name) return;
    const token = session?.access_token;
    if (!token) {
      setCascadeDialogError('Niet ingelogd.');
      return;
    }
    setRowBusyId(c.id);
    setCascadeDialogError(null);
    let success = false;
    try {
      const res = await fetch(`/api/admin/courses/${c.id}?cascade=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCascadeDialogError(json.error || `Verwijderen mislukt (${res.status})`);
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
      success = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setCascadeDialogError(msg);
    } finally {
      setRowBusyId(null);
      if (success) closeCascadeDialog();
    }
  }

  async function confirmDeleteCourse() {
    const c = deleteTarget;
    if (!c) return;
    if (deleteConfirmText.trim() !== c.name) return;
    const token = session?.access_token;
    if (!token) {
      setDeleteDialogError('Niet ingelogd.');
      return;
    }
    setRowBusyId(c.id);
    setDeleteDialogError(null);
    let success = false;
    try {
      const res = await fetch(`/api/admin/courses/${c.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = json.error || `Verwijderen mislukt (${res.status})`;
        if (res.status === 409 && json.counts) {
          // Schakel terug naar de rij-weergave zodat de admin de
          // category-specifieke cleanup-acties (Beheer leden, Open projecten,
          // Open cursusmap, bulk-leden verwijderen) ziet bij de juiste cursus.
          setRowError(c.id, message);
          setRowCount(c.id, json.counts as DeleteCounts);
          closeDeleteDialog();
        } else {
          setDeleteDialogError(message);
        }
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
      success = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setDeleteDialogError(msg);
    } finally {
      setRowBusyId(null);
      if (success) closeDeleteDialog();
    }
  }

  async function saveEdit(courseId: string) {
    setEditError(null);
    const trimmedName = editName.trim();
    const trimmedDesc = editDesc.trim();
    if (!trimmedName) {
      setEditError('Naam mag niet leeg zijn.');
      return;
    }
    const token = session?.access_token;
    if (!token) {
      setEditError('Niet ingelogd.');
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: trimmedName, description: trimmedDesc }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(json.error || `Bijwerken mislukt (${res.status})`);
        return;
      }
      cancelEdit();
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Onbekende fout';
      setEditError(msg);
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-blue-600" />
          Cursussen beheren
        </h1>
        <p className="text-sm text-gray-600">
          Maak een nieuwe cursus aan. Bij het aanmaken worden automatisch een
          cursusmap met submappen <strong>RAG</strong> en{' '}
          <strong>Projectdata</strong> klaargezet en gekoppeld.
        </p>
      </header>

      <section className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Nieuwe cursus aanmaken</h2>
        <form onSubmit={handleCreate} className="space-y-4" data-testid="form-create-course">
          <div>
            <label htmlFor="course-name" className="block text-sm font-medium text-gray-700 mb-1">
              Naam <span className="text-red-600">*</span>
            </label>
            <input
              id="course-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bijv. MenS2"
              maxLength={120}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
              data-testid="input-course-name"
            />
          </div>
          <div>
            <label htmlFor="course-desc" className="block text-sm font-medium text-gray-700 mb-1">
              Beschrijving (optioneel)
            </label>
            <textarea
              id="course-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
              data-testid="input-course-description"
            />
          </div>

          {error && (
            <div
              className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
              data-testid="text-course-error"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {successMsg && (
            <div
              className="flex items-start gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2"
              data-testid="text-course-success"
            >
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
            data-testid="button-create-course"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Cursus aanmaken
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Bestaande cursussen</h2>
        {loadingList ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Loader2 className="w-4 h-4 animate-spin" /> Laden…
          </div>
        ) : courses.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-courses">
            Nog geen cursussen gevonden.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="list-courses">
            {courses.map((c) => {
              const isEditing = editingId === c.id;
              return (
                <li
                  key={c.id}
                  className="border border-gray-200 rounded-md px-4 py-3 bg-white"
                  data-testid={`row-course-${c.id}`}
                >
                  {isEditing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Naam</label>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={120}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          disabled={editSaving}
                          data-testid={`input-edit-name-${c.id}`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Beschrijving
                        </label>
                        <textarea
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          rows={2}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          disabled={editSaving}
                          data-testid={`input-edit-description-${c.id}`}
                        />
                      </div>
                      {editError && (
                        <div
                          className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                          data-testid={`text-edit-error-${c.id}`}
                        >
                          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <span>{editError}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => saveEdit(c.id)}
                          disabled={editSaving || !editName.trim()}
                          className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-1.5 rounded-md transition-colors"
                          data-testid={`button-save-course-${c.id}`}
                        >
                          {editSaving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                          Opslaan
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                          className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 text-sm font-medium px-3 py-1.5 rounded-md transition-colors"
                          data-testid={`button-cancel-edit-${c.id}`}
                        >
                          <X className="w-3.5 h-3.5" />
                          Annuleren
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-gray-900" data-testid={`text-course-name-${c.id}`}>
                            {c.name}
                          </div>
                          {c.description && (
                            <div className="text-xs text-gray-500 mt-0.5">{c.description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span
                            className={
                              c.is_active
                                ? 'text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800'
                                : 'text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-700'
                            }
                            data-testid={`status-course-active-${c.id}`}
                          >
                            {c.is_active ? 'Actief' : 'Inactief'}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEdit(c)}
                            disabled={rowBusyId === c.id}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 disabled:text-gray-400 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                            title="Naam en beschrijving aanpassen"
                            data-testid={`button-edit-course-${c.id}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            Bewerken
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleActive(c)}
                            disabled={rowBusyId === c.id}
                            className={
                              c.is_active
                                ? 'inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900 disabled:text-gray-400 px-2 py-1 rounded hover:bg-amber-50 transition-colors'
                                : 'inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-900 disabled:text-gray-400 px-2 py-1 rounded hover:bg-green-50 transition-colors'
                            }
                            title={c.is_active ? 'Deactiveer deze cursus' : 'Activeer deze cursus'}
                            data-testid={`button-toggle-active-${c.id}`}
                          >
                            {rowBusyId === c.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Power className="w-3.5 h-3.5" />
                            )}
                            {c.is_active ? 'Deactiveren' : 'Activeren'}
                          </button>
                          {(isAdmin || myTeacherCourseIds.has(c.id)) && (
                            <button
                              type="button"
                              onClick={() => openMembersDialog(c)}
                              disabled={rowBusyId === c.id}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 disabled:text-gray-400 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                              title="Beheer leden en hun rol in deze cursus"
                              data-testid={`button-manage-members-primary-${c.id}`}
                            >
                              <Users className="w-3.5 h-3.5" />
                              Beheer leden
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => requestDelete(c)}
                            disabled={rowBusyId === c.id}
                            className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-900 disabled:text-gray-400 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                            title="Verwijder deze cursus definitief"
                            data-testid={`button-delete-course-${c.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Verwijderen
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => requestCascadeDelete(c)}
                              disabled={rowBusyId === c.id}
                              className="inline-flex items-center gap-1 text-xs font-medium text-white bg-red-700 hover:bg-red-800 disabled:bg-gray-300 disabled:text-gray-100 px-2 py-1 rounded transition-colors"
                              title="Verwijder deze cursus inclusief leden, projecten, dagboek-notities en de hele cursusmap"
                              data-testid={`button-cascade-delete-course-${c.id}`}
                            >
                              <Flame className="w-3.5 h-3.5" />
                              Verwijder cursus + alle data
                            </button>
                          )}
                        </div>
                      </div>
                      {rowErrors[c.id] && (
                        <div
                          className="flex flex-col gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                          data-testid={`text-row-error-${c.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <span>{rowErrors[c.id]}</span>
                          </div>
                          {rowCounts[c.id] && (
                            <div className="pl-6 flex flex-col gap-2" data-testid={`cleanup-actions-${c.id}`}>
                              {rowCounts[c.id]!.members > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {rowCounts[c.id]!.members} lid/leden
                                  </span>
                                  {isAdmin && (
                                    confirmBulkMembersId === c.id ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <span className="text-xs text-amber-800">Alle leden ontkoppelen?</span>
                                        <button
                                          type="button"
                                          onClick={() => bulkRemoveMembers(c)}
                                          disabled={rowBusyId === c.id}
                                          className="inline-flex items-center gap-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-300 px-2 py-1 rounded transition-colors"
                                          data-testid={`button-confirm-bulk-remove-members-${c.id}`}
                                        >
                                          {rowBusyId === c.id ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          ) : (
                                            <Check className="w-3.5 h-3.5" />
                                          )}
                                          Ja, verwijder
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmBulkMembersId(null)}
                                          disabled={rowBusyId === c.id}
                                          className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 px-2 py-1 rounded transition-colors"
                                          data-testid={`button-cancel-bulk-remove-members-${c.id}`}
                                        >
                                          <X className="w-3.5 h-3.5" />
                                          Annuleren
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setConfirmBulkMembersId(c.id)}
                                        disabled={rowBusyId === c.id}
                                        className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-900 disabled:text-gray-400 px-2 py-1 rounded border border-red-200 hover:bg-red-50 transition-colors"
                                        title="Verwijder alle leden van deze cursus"
                                        data-testid={`button-bulk-remove-members-${c.id}`}
                                      >
                                        <UserX className="w-3.5 h-3.5" />
                                        Verwijder alle leden
                                      </button>
                                    )
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openMembersDialog(c)}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-manage-members-${c.id}`}
                                  >
                                    <Users className="w-3.5 h-3.5" />
                                    Beheer leden
                                  </button>
                                </div>
                              )}
                              {rowCounts[c.id]!.projects > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {rowCounts[c.id]!.projects} project(en)
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => goToAdminTab(c.id, 'projects_admin')}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-open-projects-${c.id}`}
                                  >
                                    <FolderTree className="w-3.5 h-3.5" />
                                    Open projecten
                                  </button>
                                </div>
                              )}
                              {(rowCounts[c.id]!.extra_folders > 0 || rowCounts[c.id]!.documents > 0) && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {rowCounts[c.id]!.extra_folders > 0 && `${rowCounts[c.id]!.extra_folders} extra (sub)map(pen)`}
                                    {rowCounts[c.id]!.extra_folders > 0 && rowCounts[c.id]!.documents > 0 && ', '}
                                    {rowCounts[c.id]!.documents > 0 && `${rowCounts[c.id]!.documents} document(en)`}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => goToAdminTab(c.id, 'documents')}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-open-course-folder-${c.id}`}
                                  >
                                    <FolderOpen className="w-3.5 h-3.5" />
                                    Open cursusmap
                                  </button>
                                </div>
                              )}
                              {rowCounts[c.id]!.sessions > 0 && (
                                <div className="text-xs text-gray-700">
                                  {rowCounts[c.id]!.sessions} sessie(s) — worden automatisch opgeruimd als de bijbehorende projecten verdwijnen.
                                </div>
                              )}
                              {rowCounts[c.id]!.journal_entries > 0 && (
                                <div className="text-xs text-gray-700">
                                  {rowCounts[c.id]!.journal_entries} dagboek-notitie(s) — worden automatisch opgeruimd als de bijbehorende projecten verdwijnen.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && rowBusyId !== deleteTarget?.id) closeDeleteDialog();
        }}
      >
        {deleteTarget && (
          <AlertDialogContent data-testid="dialog-delete-course">
            <AlertDialogHeader>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-red-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <AlertDialogTitle>Cursus definitief verwijderen</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    Je staat op het punt de cursus{' '}
                    <span
                      className="font-semibold text-gray-900"
                      data-testid="text-delete-course-name"
                    >
                      {deleteTarget.name}
                    </span>{' '}
                    te verwijderen. Deze actie kan niet ongedaan worden gemaakt.
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>

            <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Verwijderen kan alleen als er geen leden, projecten, dagboek-notities of extra
                mappen/documenten aan de cursus hangen. De standaard cursusmap met submappen
                RAG en Projectdata wordt automatisch opgeruimd.
              </span>
            </div>

            <div>
              <label
                htmlFor="delete-course-confirm-input"
                className="block text-sm font-medium text-gray-700"
              >
                Typ <span className="font-mono font-semibold">{deleteTarget.name}</span> om te
                bevestigen
              </label>
              <input
                id="delete-course-confirm-input"
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                disabled={rowBusyId === deleteTarget.id}
                autoFocus
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100"
                placeholder={deleteTarget.name}
                data-testid="input-delete-course-confirm"
              />
            </div>

            {deleteDialogError && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                data-testid="text-delete-course-error"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{deleteDialogError}</span>
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={rowBusyId === deleteTarget.id}
                data-testid="button-cancel-delete-course"
              >
                Annuleren
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDeleteCourse}
                disabled={
                  rowBusyId === deleteTarget.id ||
                  deleteConfirmText.trim() !== deleteTarget.name
                }
                data-testid="button-confirm-delete-course"
              >
                {rowBusyId === deleteTarget.id && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                <Trash2 className="w-4 h-4" />
                Definitief verwijderen
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={cascadeTarget !== null}
        onOpenChange={(open) => {
          if (!open && rowBusyId !== cascadeTarget?.id) closeCascadeDialog();
        }}
      >
        {cascadeTarget && (
          <AlertDialogContent data-testid="dialog-cascade-delete-course">
            <AlertDialogHeader>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <Flame className="w-5 h-5 text-red-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <AlertDialogTitle>Cursus inclusief alle data verwijderen</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    Je staat op het punt de cursus{' '}
                    <span
                      className="font-semibold text-gray-900"
                      data-testid="text-cascade-course-name"
                    >
                      {cascadeTarget.name}
                    </span>{' '}
                    én alles wat eraan hangt definitief te verwijderen. Deze actie kan
                    niet ongedaan worden gemaakt.
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>

            <div
              className="flex flex-col gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2"
              data-testid="cascade-counts-summary"
            >
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  In één transactie worden de volgende gekoppelde gegevens verwijderd:
                </span>
              </div>
              {cascadeLoading ? (
                <div className="flex items-center gap-2 text-gray-700 pl-6">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Tellingen ophalen…
                </div>
              ) : cascadeCounts ? (
                <ul className="list-disc pl-10 space-y-0.5 text-gray-800">
                  <li data-testid="cascade-count-members">
                    {cascadeCounts.members} lid/leden
                  </li>
                  <li data-testid="cascade-count-projects">
                    {cascadeCounts.projects} project(en) inclusief al hun groepen,
                    persona-gesprekken en checkpoints
                  </li>
                  <li data-testid="cascade-count-sessions">
                    {cascadeCounts.sessions} student-sessie(s)
                  </li>
                  <li data-testid="cascade-count-journal">
                    {cascadeCounts.journal_entries} dagboek-notitie(s) (alleen die aan
                    deze cursus hangen)
                  </li>
                  <li data-testid="cascade-count-extra-folders">
                    {cascadeCounts.extra_folders} extra (sub)map(pen) in de cursusmap
                  </li>
                  <li data-testid="cascade-count-documents">
                    {cascadeCounts.documents} document(en) in de cursusmap
                  </li>
                  <li>
                    De standaard cursusmap met submappen <strong>RAG</strong> en{' '}
                    <strong>Projectdata</strong> en alle koppelingen
                  </li>
                </ul>
              ) : (
                <div className="text-gray-700 pl-6 text-xs">
                  Geen tellingen beschikbaar — bevestiging blijft uitgeschakeld tot de
                  preview is geladen.
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="cascade-course-confirm-input"
                className="block text-sm font-medium text-gray-700"
              >
                Typ <span className="font-mono font-semibold">{cascadeTarget.name}</span>{' '}
                om te bevestigen
              </label>
              <input
                id="cascade-course-confirm-input"
                type="text"
                value={cascadeConfirmText}
                onChange={(e) => setCascadeConfirmText(e.target.value)}
                disabled={rowBusyId === cascadeTarget.id}
                autoFocus
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100"
                placeholder={cascadeTarget.name}
                data-testid="input-cascade-delete-confirm"
              />
            </div>

            {cascadeDialogError && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                data-testid="text-cascade-delete-error"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{cascadeDialogError}</span>
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={rowBusyId === cascadeTarget.id}
                data-testid="button-cancel-cascade-delete"
              >
                Annuleren
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmCascadeDelete}
                disabled={
                  rowBusyId === cascadeTarget.id ||
                  cascadeLoading ||
                  !cascadeCounts ||
                  cascadeConfirmText.trim() !== cascadeTarget.name
                }
                className="bg-red-700 hover:bg-red-800 text-white"
                data-testid="button-confirm-cascade-delete"
              >
                {rowBusyId === cascadeTarget.id && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                <Flame className="w-4 h-4" />
                Cursus + alle data definitief verwijderen
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {/* Leden-beheerdialoog: per-cursus rol student/docent wijzigen. */}
      {membersTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setMembersTarget(null)}
          data-testid="dialog-manage-members"
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Leden van "{membersTarget.name}"
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Stel per cursus in wie student of docent is. Admins en
                  docenten van deze cursus mogen rollen wijzigen. De laatste
                  docent kan niet zomaar gedemoteerd worden — wijs eerst een
                  vervanger aan.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMembersTarget(null)}
                className="p-1 hover:bg-gray-100 rounded"
                data-testid="button-close-members-dialog"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {membersError && (
                <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
                  {membersError}
                </div>
              )}
              {membersLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  Leden laden…
                </div>
              ) : membersList.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">
                  Nog geen leden in deze cursus.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-2 px-2 font-semibold text-gray-700">Naam</th>
                      <th className="text-left py-2 px-2 font-semibold text-gray-700">E-mail</th>
                      <th className="text-left py-2 px-2 font-semibold text-gray-700">Rol in deze cursus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const teacherCount = membersList.filter((mm) => mm.member_role === 'teacher').length;
                      const canEdit = isAdmin || (membersTarget && myTeacherCourseIds.has(membersTarget.id));
                      return membersList.map((m) => {
                        // Voorkom dat de laatste docent zichzelf demoteert
                        // (UI-hint; server blokkeert hetzelfde scenario met 409).
                        const isSoleTeacherSelf = m.member_role === 'teacher'
                          && teacherCount <= 1
                          && m.user_id === user?.id
                          && !isAdmin;
                        return (
                          <tr key={m.user_id} className="border-b border-gray-100" data-testid={`row-member-${m.user_id}`}>
                            <td className="py-2 px-2">{m.full_name || '—'}</td>
                            <td className="py-2 px-2 text-gray-600">{m.email || '—'}</td>
                            <td className="py-2 px-2">
                              {canEdit ? (
                                <select
                                  value={m.member_role}
                                  disabled={memberRoleBusy === m.user_id || isSoleTeacherSelf}
                                  onChange={(e) => changeMemberRole(m.user_id, e.target.value as 'student' | 'teacher')}
                                  className="border border-gray-300 rounded px-2 py-1 text-xs bg-white disabled:opacity-50"
                                  data-testid={`select-member-role-${m.user_id}`}
                                  title={isSoleTeacherSelf ? 'Je bent de laatste docent — wijs eerst een vervanger aan.' : undefined}
                                >
                                  <option value="student">Student</option>
                                  <option value="teacher">Docent</option>
                                </select>
                              ) : (
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  m.member_role === 'teacher'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'bg-green-100 text-green-700'
                                }`}>
                                  {m.member_role === 'teacher' ? 'Docent' : 'Student'}
                                </span>
                              )}
                              {isSoleTeacherSelf && (
                                <span className="ml-2 text-[11px] text-amber-700" data-testid={`text-sole-teacher-${m.user_id}`}>
                                  laatste docent
                                </span>
                              )}
                              {memberRoleBusy === m.user_id && (
                                <Loader2 className="w-3 h-3 inline-block ml-2 animate-spin text-gray-400" />
                              )}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-6 py-3 border-t border-gray-200 flex justify-end">
              <button
                type="button"
                onClick={() => setMembersTarget(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
                data-testid="button-close-members-dialog-footer"
              >
                Sluiten
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
