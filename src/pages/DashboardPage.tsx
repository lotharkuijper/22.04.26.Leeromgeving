import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageSquare,
  Lightbulb,
  GraduationCap,
  BarChart3,
  BookText,
  ArrowRight,
  PenLine,
  Shield,
  Download,
  FileText,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';
import { useContentTranslation } from '../hooks/useContentTranslation';

type TileKey = 'chat' | 'explain' | 'quiz' | 'project';

interface LastActivities {
  chat: { label: string } | null;
  explain: { label: string } | null;
  quiz: { label: string } | null;
  project: { label: string } | null;
  journal: { title: string; content: string; id: string } | null;
}

interface CourseInfoDoc {
  id: string;
  title: string;
  filename: string;
  file_type: string;
  file_size: number;
}

interface CourseInfo {
  body: string;
  documents: CourseInfoDoc[];
}

interface TileSpec {
  key: TileKey;
  to: string;
  icon: typeof MessageSquare;
  accent: string;
  iconBg: string;
  iconText: string;
  border: string;
  hoverBorder: string;
  titleKey: string;
  emptyKey: string;
  ctaKey: string;
}

const TILES: TileSpec[] = [
  {
    key: 'chat',
    to: '/chat',
    icon: MessageSquare,
    accent: 'from-emerald-50 to-emerald-100',
    iconBg: 'bg-emerald-100',
    iconText: 'text-emerald-700',
    border: 'border-emerald-200',
    hoverBorder: 'hover:border-emerald-400',
    titleKey: 'dashboard.tile.chat.title',
    emptyKey: 'dashboard.tile.chat.empty',
    ctaKey: 'dashboard.tile.chat.cta',
  },
  {
    key: 'explain',
    to: '/explain',
    icon: Lightbulb,
    accent: 'from-amber-50 to-amber-100',
    iconBg: 'bg-amber-100',
    iconText: 'text-amber-700',
    border: 'border-amber-200',
    hoverBorder: 'hover:border-amber-400',
    titleKey: 'dashboard.tile.explain.title',
    emptyKey: 'dashboard.tile.explain.empty',
    ctaKey: 'dashboard.tile.explain.cta',
  },
  {
    key: 'quiz',
    to: '/quiz',
    icon: GraduationCap,
    accent: 'from-sky-50 to-sky-100',
    iconBg: 'bg-sky-100',
    iconText: 'text-sky-700',
    border: 'border-sky-200',
    hoverBorder: 'hover:border-sky-400',
    titleKey: 'dashboard.tile.quiz.title',
    emptyKey: 'dashboard.tile.quiz.empty',
    ctaKey: 'dashboard.tile.quiz.cta',
  },
  {
    key: 'project',
    to: '/projects',
    icon: BarChart3,
    accent: 'from-orange-50 to-orange-100',
    iconBg: 'bg-orange-100',
    iconText: 'text-orange-700',
    border: 'border-orange-200',
    hoverBorder: 'hover:border-orange-400',
    titleKey: 'dashboard.tile.project.title',
    emptyKey: 'dashboard.tile.project.empty',
    ctaKey: 'dashboard.tile.project.cta',
  },
];

function truncate(s: string, n: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n - 1).trimEnd() + '…';
}

function firstName(full: string | null | undefined): string {
  if (!full) return '';
  const parts = full.trim().split(/\s+/);
  return parts[0] ?? '';
}

export function DashboardPage() {
  const { profile, isAdmin, isDocent } = useAuth();
  const { activeCourse, activeCourseId } = useActiveCourse();
  const { t, lang } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LastActivities>({
    chat: null,
    explain: null,
    quiz: null,
    project: null,
    journal: null,
  });
  const [courseInfo, setCourseInfo] = useState<CourseInfo | null>(null);
  const courseBodyT = useContentTranslation({
    body: { text: courseInfo?.body || '', format: 'markdown' },
  });

  useEffect(() => {
    let cancelled = false;
    if (!activeCourseId) {
      setCourseInfo(null);
      return;
    }
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess?.session?.access_token;
        const res = await fetch(`/api/courses/${activeCourseId}/info`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) {
          setCourseInfo({ body: json.body || '', documents: json.documents || [] });
        }
      } catch {
        /* stil falen — header is optioneel */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCourseId]);

  async function downloadCourseInfoFile(documentId: string) {
    if (!activeCourseId) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      const res = await fetch(
        `/api/courses/${activeCourseId}/info/documents/${documentId}/download`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok) return;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const { url } = await res.json();
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!profile?.id) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const [convRes, explRes, quizRes, personaRes, projRes, journalRes] = await Promise.all([
          activeCourseId
            ? supabase
                .from('conversations')
                .select('id, title, updated_at')
                .eq('user_id', profile.id)
                .eq('status', 'active')
                .eq('course_id', activeCourseId)
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle()
            : supabase
                .from('conversations')
                .select('id, title, updated_at')
                .eq('user_id', profile.id)
                .eq('status', 'active')
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
          activeCourseId
            ? supabase
                .from('student_explanations')
                .select('id, created_at, concepts!inner(name, course_id)')
                .eq('student_id', profile.id)
                .eq('concepts.course_id', activeCourseId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
            : supabase
                .from('student_explanations')
                .select('id, created_at, concepts(name)')
                .eq('student_id', profile.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
          activeCourseId
            ? supabase
                .from('quiz_attempts')
                .select('id, topics, score_percentage, created_at')
                .eq('student_id', profile.id)
                .eq('course_id', activeCourseId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
            : supabase
                .from('quiz_attempts')
                .select('id, topics, score_percentage, created_at')
                .eq('student_id', profile.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
          supabase
            .from('group_persona_messages')
            .select('id, created_at, group_persona_threads!inner(persona_id, project_personas!inner(name, project_id, projects!inner(title, course_id)))')
            .eq('user_id', profile.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          activeCourseId
            ? supabase
                .from('student_project_sessions')
                .select('id, last_activity, projects!inner(title, course_id)')
                .eq('student_id', profile.id)
                .eq('projects.course_id', activeCourseId)
                .order('last_activity', { ascending: false })
                .limit(1)
                .maybeSingle()
            : supabase
                .from('student_project_sessions')
                .select('id, last_activity, projects(title)')
                .eq('student_id', profile.id)
                .order('last_activity', { ascending: false })
                .limit(1)
                .maybeSingle(),
          supabase
            .from('learning_journal_entries')
            .select('id, title, content, updated_at')
            .eq('user_id', profile.id)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        const next: LastActivities = {
          chat: null,
          explain: null,
          quiz: null,
          project: null,
          journal: null,
        };

        if (convRes.data) {
          const title = (convRes.data.title as string | null) ?? '';
          next.chat = { label: title.trim() || t('dashboard.tile.chat.untitled') };
        }
        if (explRes.data) {
          const concept = (explRes.data as { concepts?: { name?: string } | { name?: string }[] | null }).concepts;
          let name: string | undefined;
          if (Array.isArray(concept)) name = concept[0]?.name;
          else if (concept) name = concept.name;
          next.explain = { label: name?.trim() || t('dashboard.tile.explain.unknown') };
        }
        if (quizRes.data) {
          const topics = (quizRes.data.topics as string[] | null) ?? [];
          const score = quizRes.data.score_percentage as number | null;
          const topicLabel = topics.length > 0
            ? topics.slice(0, 2).join(', ') + (topics.length > 2 ? ` +${topics.length - 2}` : '')
            : t('dashboard.tile.quiz.unknownTopic');
          const scoreLabel = typeof score === 'number' ? ` · ${score}%` : '';
          next.quiz = { label: `${topicLabel}${scoreLabel}` };
        }
        // Voorkeur: laatste persona-conversatie van de student (titel + persona).
        // Fallback: laatste student_project_sessions rij (alleen titel).
        const pickOne = (v: unknown): Record<string, unknown> | undefined => {
          if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? undefined;
          if (v && typeof v === 'object') return v as Record<string, unknown>;
          return undefined;
        };

        let projectLabel: string | null = null;
        if (personaRes.data) {
          const thread = pickOne((personaRes.data as Record<string, unknown>).group_persona_threads);
          const persona = pickOne(thread?.project_personas);
          const project = pickOne(persona?.projects);
          const courseMatches =
            !activeCourseId || (project?.course_id as string | undefined) === activeCourseId;
          if (courseMatches) {
            const title = (project?.title as string | undefined)?.trim();
            const titleLabel = title || t('dashboard.tile.project.unknown');
            const personaName = (persona?.name as string | undefined)?.trim();
            projectLabel = personaName ? `${titleLabel} · ${personaName}` : titleLabel;
          }
        }
        if (!projectLabel && projRes.data) {
          const project = pickOne((projRes.data as Record<string, unknown>).projects);
          const title = (project?.title as string | undefined)?.trim();
          projectLabel = title || t('dashboard.tile.project.unknown');
        }
        if (projectLabel) {
          next.project = { label: projectLabel };
        }
        if (journalRes.data) {
          next.journal = {
            id: journalRes.data.id as string,
            title: ((journalRes.data.title as string | null) ?? '').trim(),
            content: ((journalRes.data.content as string | null) ?? '').trim(),
          };
        }

        setData(next);
      } catch (err) {
        console.error('[DASHBOARD] load error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, lang, activeCourseId]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return t('dashboard.greet.night');
    if (h < 12) return t('dashboard.greet.morning');
    if (h < 18) return t('dashboard.greet.afternoon');
    return t('dashboard.greet.evening');
  })();
  const name = firstName(profile?.full_name);

  return (
    <div
      className="space-y-8"
      data-testid="page-dashboard"
    >
      {/* Welcome hero */}
      <section
        className="rounded-3xl p-8 md:p-10 bg-white/70 backdrop-blur-md border border-white/60 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(56,189,248,0.25)] ring-1 ring-sky-100/60"
        data-testid="hero-welcome"
      >
        <p className="text-sm font-medium text-sky-800/80 mb-1" data-testid="text-greeting">
          {name ? `${greeting}, ${name}` : greeting}
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 tracking-tight">
          {t('dashboard.heroQuestion')}
        </h1>
        {activeCourse ? (
          <p className="mt-3 text-sm text-slate-700" data-testid="text-active-course">
            {t('dashboard.activeCourse', { name: activeCourse.name })}
          </p>
        ) : (
          <p className="mt-3 text-sm text-slate-700" data-testid="text-no-active-course">
            {t('dashboard.noActiveCourse')}{' '}
            <Link
              to="/choose-course"
              data-testid="link-choose-course"
              className="font-semibold text-sky-700 underline hover:text-sky-900"
            >
              {t('dashboard.chooseCourse')}
            </Link>
          </p>
        )}
      </section>

      {/* Cursus-info header (Task #202) — alleen tonen als er inhoud is */}
      {courseInfo && (courseInfo.body.trim() || courseInfo.documents.length > 0) && (
        <section
          className="rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-md p-6 md:p-8 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(15,23,42,0.15)]"
          data-testid="section-course-info"
        >
          <div className="flex items-center gap-2 mb-3">
            <BookText className="h-5 w-5 text-sky-700" />
            <h2 className="text-lg font-semibold text-slate-900">{t('dashboard.courseInfo.title')}</h2>
          </div>
          {courseInfo.body.trim() && (
            <div data-testid="text-course-info-body">
              <MarkdownMessage content={courseBodyT.values.body || courseInfo.body} />
              <AutoTranslatedNotice
                isTranslating={courseBodyT.isTranslating}
                isTranslated={courseBodyT.isTranslated}
                showOriginal={courseBodyT.showOriginal}
                onToggle={courseBodyT.setShowOriginal}
                className="mt-2"
              />
            </div>
          )}
          {courseInfo.documents.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-2">
                {t('dashboard.courseInfo.downloads')}
              </h3>
              <ul className="space-y-1.5">
                {courseInfo.documents.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => downloadCourseInfoFile(d.id)}
                      className="inline-flex items-center gap-2 rounded px-2 py-1 text-sm text-sky-700 hover:bg-sky-50"
                      data-testid={`button-download-course-info-${d.id}`}
                    >
                      <FileText className="h-4 w-4 text-slate-400" />
                      <span className="truncate">{d.title || d.filename}</span>
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Action tiles */}
      <section
        className="grid grid-cols-1 md:grid-cols-2 gap-5"
        aria-label={t('dashboard.tilesAriaLabel')}
      >
        {TILES.map((tile) => {
          const last = data[tile.key];
          const Icon = tile.icon;
          const hasLast = !!last;
          return (
            <Link
              key={tile.key}
              to={tile.to}
              data-testid={`tile-${tile.key}`}
              className={`group relative block rounded-2xl border bg-white/75 backdrop-blur-md p-6 transition-all hover:shadow-xl hover:-translate-y-0.5 hover:bg-white/90 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(15,23,42,0.15)] ${tile.border} ${tile.hoverBorder} focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-500`}
            >
              <div className={`absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r ${tile.accent}`} aria-hidden />
              <div className="flex items-start gap-4">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${tile.iconBg} ${tile.iconText} flex-shrink-0`}>
                  <Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold text-slate-900">{t(tile.titleKey as never)}</h2>
                  {loading ? (
                    <div className="mt-2 h-4 w-3/4 rounded bg-slate-100 animate-pulse" />
                  ) : hasLast ? (
                    <p
                      className="mt-2 text-sm text-slate-700 line-clamp-2"
                      data-testid={`tile-${tile.key}-last`}
                    >
                      {t('dashboard.tile.continueAt')}{' '}
                      <span className="font-medium text-slate-900">{truncate(last!.label, 80)}</span>
                    </p>
                  ) : (
                    <p
                      className="mt-2 text-sm text-slate-500"
                      data-testid={`tile-${tile.key}-empty`}
                    >
                      {t(tile.emptyKey as never)}
                    </p>
                  )}
                  <div className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 group-hover:text-slate-900">
                    <span>{t(tile.ctaKey as never)}</span>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </section>

      {/* Journal snippet */}
      <section
        className="rounded-2xl border border-emerald-200/70 bg-white/70 backdrop-blur-md p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(16,185,129,0.25)] ring-1 ring-emerald-100/60"
        data-testid="section-journal-snippet"
        aria-label={t('dashboard.journal.title')}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          {loading ? (
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-100 text-green-700 flex-shrink-0">
                <BookText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-slate-900">{t('dashboard.journal.title')}</h2>
                <div className="mt-2 h-4 w-2/3 rounded bg-green-100 animate-pulse" />
              </div>
            </div>
          ) : data.journal ? (
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-100 text-green-700 flex-shrink-0">
                <BookText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1" data-testid="text-journal-last">
                <h2 className="text-base font-semibold text-slate-900">{t('dashboard.journal.title')}</h2>
                {data.journal.title && (
                  <p className="mt-1 text-sm font-medium text-slate-800">{truncate(data.journal.title, 80)}</p>
                )}
                <div className="text-sm text-slate-700 line-clamp-2 overflow-hidden">
                  <MarkdownMessage
                    content={truncate(data.journal.content, 140)}
                    className="prose prose-sm max-w-none prose-p:my-0 prose-p:inline prose-p:text-slate-700 prose-strong:text-slate-900"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-1" data-testid="text-journal-empty" />
          )}
          <Link
            to="/feedback"
            data-testid="btn-journal-write"
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-green-500 to-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:from-green-600 hover:to-emerald-700 transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
          >
            <PenLine className="h-4 w-4" />
            {t('dashboard.journal.write')}
          </Link>
        </div>
      </section>

      {/* Admin/docent compact block */}
      {(isAdmin || isDocent) && (
        <section
          className="rounded-2xl border border-slate-200/70 bg-white/65 backdrop-blur-md p-4 flex flex-wrap items-center justify-between gap-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-100/60"
          data-testid="section-admin-access"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-200 text-slate-700 flex-shrink-0">
              <Shield className="h-4 w-4" />
            </div>
            <p className="text-sm text-slate-700">
              {t('dashboard.adminInline', {
                role: isAdmin ? t('dashboard.role.administrator') : t('dashboard.role.docent'),
              })}
            </p>
          </div>
          <Link
            to="/admin"
            data-testid="btn-go-admin"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500"
          >
            {t('dashboard.goToAdmin')}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      )}
    </div>
  );
}

export default DashboardPage;
