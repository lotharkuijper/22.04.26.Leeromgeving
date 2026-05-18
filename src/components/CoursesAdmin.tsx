import { useEffect, useState } from 'react';
import { Plus, Loader2, CheckCircle2, AlertTriangle, BookOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCourseAccess } from '../contexts/CourseAccessContext';

interface CourseRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

export default function CoursesAdmin() {
  const { session } = useAuth();
  const { refreshCourses } = useCourseAccess();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

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
    } catch (err: any) {
      setError(err?.message || 'Onbekende fout');
    } finally {
      setSubmitting(false);
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
            {courses.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between border border-gray-200 rounded-md px-4 py-3 bg-white"
                data-testid={`row-course-${c.id}`}
              >
                <div>
                  <div className="font-medium text-gray-900" data-testid={`text-course-name-${c.id}`}>
                    {c.name}
                  </div>
                  {c.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{c.description}</div>
                  )}
                </div>
                <span
                  className={
                    c.is_active
                      ? 'text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800'
                      : 'text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-700'
                  }
                >
                  {c.is_active ? 'Actief' : 'Inactief'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
