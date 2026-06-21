import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Coffee, Send, Loader2, Pin, PinOff, Lock, Unlock, Trash2, CheckCircle2,
  Award, Megaphone, Smile, MessageCircle, HelpCircle, MessagesSquare, Lightbulb,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { useContentTranslation, type TranslatableItem } from '../hooks/useContentTranslation';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';

// Studiecafé (Task #304) — per-cursus discussieforum. Studenten posten vragen/
// discussies/tips, reageren, reageren met emoji en markeren vragen als opgelost.
// Docenten modereren volledig (pinnen, sluiten, verwijderen), geven een pluim en
// plaatsen aankondigingen. Realtime via Supabase; auto-vertaling per lezer (#288).

type Category = 'vraag' | 'discussie' | 'tip';
type FilterKey = 'all' | Category | 'announcement';

const ALLOWED_REACTION_EMOJI = ['👍', '❤️', '🎉', '🤔', '✅', '🙌'];

interface ReactionSummary { emoji: string; count: number; mine: boolean; }
interface Kudos { by: string; byName: string; at: string; }

interface Thread {
  id: string;
  authorId: string | null;
  authorName: string;
  title: string;
  body: string;
  category: Category;
  isPinned: boolean;
  isLocked: boolean;
  isAnnouncement: boolean;
  isResolved: boolean;
  kudos: Kudos | null;
  reactions: ReactionSummary[];
  replyCount: number;
  lastActivityAt: string;
  createdAt: string;
  isMine: boolean;
}

interface Reply {
  id: string;
  threadId: string;
  authorId?: string | null;
  authorName: string | null;
  body: string;
  kudos: Kudos | null;
  reactions: ReactionSummary[];
  createdAt: string;
  isMine: boolean;
  deleted: boolean;
}

function formatWhen(iso: string, lang: string): string {
  try {
    const d = new Date(iso);
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const mins = Math.round(s / 60);
    const hrs = Math.round(mins / 60);
    const days = Math.round(hrs / 24);
    if (s < 60) return rtf.format(-s, 'second');
    if (mins < 60) return rtf.format(-mins, 'minute');
    if (hrs < 24) return rtf.format(-hrs, 'hour');
    if (days < 7) return rtf.format(-days, 'day');
    return d.toLocaleDateString(lang);
  } catch {
    return '';
  }
}

const CATEGORY_META: Record<Category, { icon: typeof HelpCircle; classes: string }> = {
  vraag: { icon: HelpCircle, classes: 'bg-blue-50 text-blue-700 ring-blue-200' },
  discussie: { icon: MessagesSquare, classes: 'bg-purple-50 text-purple-700 ring-purple-200' },
  tip: { icon: Lightbulb, classes: 'bg-green-50 text-green-700 ring-green-200' },
};

export function StudiecafePage() {
  const { session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const { t, lang } = useLanguage();
  const courseId = activeCourseId;

  const [threads, setThreads] = useState<Thread[]>([]);
  const [repliesByThread, setRepliesByThread] = useState<Record<string, Reply[]>>({});
  const [isStaff, setIsStaff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Composer (nieuwe thread).
  const [showComposer, setShowComposer] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('vraag');
  const [newAnnouncement, setNewAnnouncement] = useState(false);
  const [posting, setPosting] = useState(false);

  // Reply-composer per uitgeklapte thread.
  const [replyBody, setReplyBody] = useState('');
  const [replying, setReplying] = useState(false);

  // Emoji-picker: welk doel staat open ('thread:<id>' | 'reply:<id>' | null).
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (session?.access_token) return session.access_token;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [session]);

  const apiFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init?.headers) Object.assign(headers, init.headers as Record<string, string>);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(path, { ...init, headers });
  }, [getToken]);

  const loadThreads = useCallback(async () => {
    if (!courseId) return;
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setThreads(d.threads || []);
        setIsStaff(!!d.isStaff);
        setError(null);
      } else {
        setError(d.error || t('studiecafe.loadError'));
      }
    } catch {
      setError(t('studiecafe.loadError'));
    } finally {
      setLoading(false);
    }
  }, [courseId, apiFetch, t]);

  const loadReplies = useCallback(async (threadId: string) => {
    if (!courseId) return;
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}/replies`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setRepliesByThread((prev) => ({ ...prev, [threadId]: d.replies || [] }));
    } catch { /* stil */ }
  }, [courseId, apiFetch]);

  useEffect(() => {
    setLoading(true);
    setThreads([]);
    setRepliesByThread({});
    setExpandedId(null);
    if (courseId) loadThreads();
    else setLoading(false);
  }, [courseId, loadThreads]);

  // ── Realtime: bij elke wijziging een gedebouncede refetch ─────────────────
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandedRef = useRef<string | null>(null);
  useEffect(() => { expandedRef.current = expandedId; }, [expandedId]);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      loadThreads();
      if (expandedRef.current) loadReplies(expandedRef.current);
    }, 400);
  }, [loadThreads, loadReplies]);
  const scheduleRef = useRef(scheduleRefetch);
  useEffect(() => { scheduleRef.current = scheduleRefetch; }, [scheduleRefetch]);

  useEffect(() => {
    if (!courseId) return;
    const channel = supabase
      .channel(`studiecafe-${courseId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studiecafe_threads', filter: `course_id=eq.${courseId}` }, () => scheduleRef.current())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studiecafe_replies', filter: `course_id=eq.${courseId}` }, () => scheduleRef.current())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [courseId]);

  // ── Vertaling (Task #288): één Record over alle zichtbare titels/bodies ───
  const translatableItems = useMemo(() => {
    const items: Record<string, TranslatableItem> = {};
    for (const th of threads) {
      items[`t:${th.id}:title`] = { text: th.title, format: 'plain' };
      items[`t:${th.id}:body`] = { text: th.body, format: 'plain' };
    }
    for (const [tid, reps] of Object.entries(repliesByThread)) {
      for (const r of reps) {
        if (!r.deleted && r.body) items[`r:${tid}:${r.id}:body`] = { text: r.body, format: 'plain' };
      }
    }
    return items;
  }, [threads, repliesByThread]);
  const { values, isTranslating, isTranslated, showOriginal, setShowOriginal } = useContentTranslation(translatableItems);
  const tr = (key: string, fallback: string) => values[key] ?? fallback;

  // ── Acties ────────────────────────────────────────────────────────────────
  const createThread = async () => {
    if (!courseId || !newTitle.trim() || !newBody.trim()) return;
    setPosting(true);
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads`, {
        method: 'POST',
        body: JSON.stringify({ title: newTitle, body: newBody, category: newCategory, isAnnouncement: isStaff && newAnnouncement }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setNewTitle(''); setNewBody(''); setNewCategory('vraag'); setNewAnnouncement(false); setShowComposer(false);
        await loadThreads();
      } else {
        setError(d.error || t('studiecafe.postError'));
      }
    } finally {
      setPosting(false);
    }
  };

  const toggleExpand = async (threadId: string) => {
    if (expandedId === threadId) { setExpandedId(null); return; }
    setExpandedId(threadId);
    setReplyBody('');
    if (!repliesByThread[threadId]) await loadReplies(threadId);
  };

  const submitReply = async (threadId: string) => {
    if (!courseId || !replyBody.trim()) return;
    setReplying(true);
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setReplyBody('');
        await loadReplies(threadId);
        await loadThreads();
      } else {
        setError(d.error || t('studiecafe.postError'));
      }
    } finally {
      setReplying(false);
    }
  };

  const react = async (targetType: 'thread' | 'reply', targetId: string, emoji: string) => {
    if (!courseId) return;
    setPickerFor(null);
    const r = await apiFetch(`/api/studiecafe/${courseId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ targetType, targetId, emoji }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return;
    if (targetType === 'thread') {
      setThreads((prev) => prev.map((x) => (x.id === targetId ? { ...x, reactions: d.reactions } : x)));
    } else {
      setRepliesByThread((prev) => {
        const copy: Record<string, Reply[]> = {};
        for (const k of Object.keys(prev)) copy[k] = prev[k].map((x) => (x.id === targetId ? { ...x, reactions: d.reactions } : x));
        return copy;
      });
    }
  };

  const toggleKudos = async (targetType: 'thread' | 'reply', targetId: string) => {
    if (!courseId) return;
    const r = await apiFetch(`/api/studiecafe/${courseId}/kudos`, {
      method: 'POST',
      body: JSON.stringify({ targetType, targetId }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return;
    if (targetType === 'thread') {
      setThreads((prev) => prev.map((x) => (x.id === targetId ? { ...x, kudos: d.kudos } : x)));
    } else {
      setRepliesByThread((prev) => {
        const copy: Record<string, Reply[]> = {};
        for (const k of Object.keys(prev)) copy[k] = prev[k].map((x) => (x.id === targetId ? { ...x, kudos: d.kudos } : x));
        return copy;
      });
    }
  };

  const patchThread = async (threadId: string, patch: { isPinned?: boolean; isLocked?: boolean; isResolved?: boolean }) => {
    if (!courseId) return;
    const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (r.ok) await loadThreads();
  };

  const deleteThread = async (threadId: string) => {
    if (!courseId || !window.confirm(t('studiecafe.confirmDelete'))) return;
    const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}`, { method: 'DELETE' });
    if (r.ok) { if (expandedId === threadId) setExpandedId(null); await loadThreads(); }
  };

  const deleteReply = async (replyId: string, threadId: string) => {
    if (!courseId || !window.confirm(t('studiecafe.confirmDelete'))) return;
    const r = await apiFetch(`/api/studiecafe/${courseId}/replies/${replyId}`, { method: 'DELETE' });
    if (r.ok) { await loadReplies(threadId); await loadThreads(); }
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return threads;
    if (filter === 'announcement') return threads.filter((x) => x.isAnnouncement);
    return threads.filter((x) => x.category === filter && !x.isAnnouncement);
  }, [threads, filter]);

  const filterChips: { key: FilterKey; label: string }[] = [
    { key: 'all', label: t('studiecafe.filter.all') },
    { key: 'vraag', label: t('studiecafe.filter.vraag') },
    { key: 'discussie', label: t('studiecafe.filter.discussie') },
    { key: 'tip', label: t('studiecafe.filter.tip') },
    { key: 'announcement', label: t('studiecafe.filter.announcement') },
  ];

  if (!courseId) {
    return (
      <div className="max-w-2xl mx-auto text-center py-20" data-testid="studiecafe-no-course">
        <Coffee className="w-12 h-12 mx-auto text-amber-500 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{t('studiecafe.title')}</h1>
        <p className="text-gray-500">{t('studiecafe.noCourse')}</p>
      </div>
    );
  }

  const renderReactions = (targetType: 'thread' | 'reply', targetId: string, reactions: ReactionSummary[]) => {
    const pickerKey = `${targetType}:${targetId}`;
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {reactions.map((rx) => (
          <button
            key={rx.emoji}
            onClick={() => react(targetType, targetId, rx.emoji)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ring-1 transition-colors ${rx.mine ? 'bg-amber-100 ring-amber-300 text-amber-900' : 'bg-slate-50 ring-slate-200 text-slate-600 hover:bg-slate-100'}`}
            data-testid={`reaction-${targetType}-${targetId}-${rx.emoji}`}
          >
            <span>{rx.emoji}</span>
            <span className="font-medium">{rx.count}</span>
          </button>
        ))}
        <div className="relative">
          <button
            onClick={() => setPickerFor(pickerFor === pickerKey ? null : pickerKey)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            title={t('studiecafe.actions.react')}
            data-testid={`button-react-${targetType}-${targetId}`}
          >
            <Smile className="w-4 h-4" />
          </button>
          {pickerFor === pickerKey && (
            <div className="absolute z-20 bottom-full mb-1 left-0 flex gap-1 bg-white rounded-xl shadow-lg ring-1 ring-slate-200 p-1.5">
              {ALLOWED_REACTION_EMOJI.map((e) => (
                <button
                  key={e}
                  onClick={() => react(targetType, targetId, e)}
                  className="w-8 h-8 rounded-lg hover:bg-slate-100 text-lg leading-none transition-colors"
                  data-testid={`emoji-${targetType}-${targetId}-${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto" data-testid="page-studiecafe">
      {/* HEADER */}
      <div className="rounded-2xl bg-gradient-to-r from-amber-500 to-rose-500 text-white p-6 shadow-md mb-6">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
            <Coffee className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight" data-testid="text-studiecafe-title">{t('studiecafe.title')}</h1>
            <p className="text-white/90 text-sm">
              {activeCourse?.name ? `${activeCourse.name} · ` : ''}{t('studiecafe.subtitle')}
            </p>
          </div>
        </div>
      </div>

      {/* COMPOSER */}
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-4 mb-5">
        {!showComposer ? (
          <button
            onClick={() => setShowComposer(true)}
            className="w-full text-left px-4 py-3 rounded-xl bg-slate-50 text-slate-500 hover:bg-slate-100 transition-colors"
            data-testid="button-open-composer"
          >
            {t('studiecafe.compose.prompt')}
          </button>
        ) : (
          <div className="space-y-3">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              maxLength={200}
              placeholder={t('studiecafe.compose.titlePlaceholder')}
              className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none"
              data-testid="input-thread-title"
            />
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              maxLength={8000}
              rows={4}
              placeholder={t('studiecafe.compose.bodyPlaceholder')}
              className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none resize-y"
              data-testid="input-thread-body"
            />
            <div className="flex flex-wrap items-center gap-2">
              {(['vraag', 'discussie', 'tip'] as Category[]).map((c) => {
                const Icon = CATEGORY_META[c].icon;
                return (
                  <button
                    key={c}
                    onClick={() => setNewCategory(c)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm ring-1 transition-colors ${newCategory === c ? CATEGORY_META[c].classes + ' ring-2' : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'}`}
                    data-testid={`select-category-${c}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t(`studiecafe.category.${c}` as any)}
                  </button>
                );
              })}
              {isStaff && (
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm ring-1 ring-slate-200 cursor-pointer hover:bg-slate-50" data-testid="toggle-announcement">
                  <input type="checkbox" checked={newAnnouncement} onChange={(e) => setNewAnnouncement(e.target.checked)} className="accent-amber-500" />
                  <Megaphone className="w-3.5 h-3.5 text-amber-600" />
                  {t('studiecafe.compose.announcement')}
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowComposer(false); setNewTitle(''); setNewBody(''); }}
                className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 transition-colors"
                data-testid="button-cancel-thread"
              >
                {t('studiecafe.compose.cancel')}
              </button>
              <button
                onClick={createThread}
                disabled={posting || !newTitle.trim() || !newBody.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                data-testid="button-submit-thread"
              >
                {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {t('studiecafe.compose.submit')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* FILTERS + VERTAAL-NOTICE */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {filterChips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${filter === c.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}
              data-testid={`filter-${c.key}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <AutoTranslatedNotice
          isTranslating={isTranslating}
          isTranslated={isTranslated}
          showOriginal={showOriginal}
          onToggle={setShowOriginal}
        />
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 ring-1 ring-red-200 text-sm" data-testid="text-error">{error}</div>
      )}

      {/* FEED */}
      {loading ? (
        <div className="flex justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400" data-testid="text-empty">
          <Coffee className="w-10 h-10 mx-auto mb-3 text-slate-300" />
          <p>{t('studiecafe.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((th) => {
            const CatIcon = CATEGORY_META[th.category].icon;
            const replies = repliesByThread[th.id] || [];
            const expanded = expandedId === th.id;
            return (
              <div
                key={th.id}
                className={`bg-white rounded-2xl ring-1 shadow-sm overflow-hidden ${th.isAnnouncement ? 'ring-amber-300' : 'ring-slate-200'}`}
                data-testid={`thread-${th.id}`}
              >
                {th.isAnnouncement && (
                  <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 text-amber-800 text-xs font-semibold">
                    <Megaphone className="w-3.5 h-3.5" /> {t('studiecafe.announcement')}
                  </div>
                )}
                <div className="p-4">
                  {/* META-RIJ */}
                  <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
                    {!th.isAnnouncement && (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ring-1 ${CATEGORY_META[th.category].classes}`}>
                        <CatIcon className="w-3 h-3" />{t(`studiecafe.category.${th.category}` as any)}
                      </span>
                    )}
                    {th.isPinned && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600"><Pin className="w-3 h-3" />{t('studiecafe.pinned')}</span>}
                    {th.isResolved && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700" data-testid={`badge-resolved-${th.id}`}><CheckCircle2 className="w-3 h-3" />{t('studiecafe.resolved')}</span>}
                    {th.isLocked && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500"><Lock className="w-3 h-3" />{t('studiecafe.locked')}</span>}
                    <span className="text-slate-400">{th.authorName} · {formatWhen(th.lastActivityAt, lang)}</span>
                  </div>

                  {/* TITEL + BODY */}
                  <h3 className="font-semibold text-slate-900 mb-1" data-testid={`text-thread-title-${th.id}`}>{tr(`t:${th.id}:title`, th.title)}</h3>
                  <p className="text-slate-700 whitespace-pre-wrap text-sm">{tr(`t:${th.id}:body`, th.body)}</p>

                  {th.kudos && (
                    <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 text-xs ring-1 ring-rose-200" data-testid={`kudos-thread-${th.id}`}>
                      <Award className="w-3.5 h-3.5" /> {t('studiecafe.kudosFrom', { name: th.kudos.byName })}
                    </div>
                  )}

                  {/* ACTIE-RIJ */}
                  <div className="flex items-center gap-3 mt-3 flex-wrap">
                    {renderReactions('thread', th.id, th.reactions)}
                    <button
                      onClick={() => toggleExpand(th.id)}
                      className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors"
                      data-testid={`button-replies-${th.id}`}
                    >
                      <MessageCircle className="w-4 h-4" />
                      {th.replyCount} {t('studiecafe.repliesWord')}
                    </button>

                    <div className="flex items-center gap-1 ml-auto">
                      {(th.category === 'vraag') && (th.isMine || isStaff) && (
                        <button
                          onClick={() => patchThread(th.id, { isResolved: !th.isResolved })}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-green-50 hover:text-green-600 transition-colors"
                          title={th.isResolved ? t('studiecafe.actions.markUnresolved') : t('studiecafe.actions.markResolved')}
                          data-testid={`button-resolve-${th.id}`}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                      )}
                      {isStaff && (
                        <>
                          <button onClick={() => toggleKudos('thread', th.id)} className={`p-1.5 rounded-lg transition-colors ${th.kudos ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-400 hover:bg-rose-50 hover:text-rose-500'}`} title={th.kudos ? t('studiecafe.actions.removeKudos') : t('studiecafe.actions.kudos')} data-testid={`button-kudos-${th.id}`}>
                            <Award className="w-4 h-4" />
                          </button>
                          <button onClick={() => patchThread(th.id, { isPinned: !th.isPinned })} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors" title={th.isPinned ? t('studiecafe.actions.unpin') : t('studiecafe.actions.pin')} data-testid={`button-pin-${th.id}`}>
                            {th.isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                          </button>
                          <button onClick={() => patchThread(th.id, { isLocked: !th.isLocked })} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors" title={th.isLocked ? t('studiecafe.actions.unlock') : t('studiecafe.actions.lock')} data-testid={`button-lock-${th.id}`}>
                            {th.isLocked ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                          </button>
                        </>
                      )}
                      {(th.isMine || isStaff) && (
                        <button onClick={() => deleteThread(th.id)} className="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors" title={t('studiecafe.actions.delete')} data-testid={`button-delete-thread-${th.id}`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* REPLIES */}
                {expanded && (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 space-y-3" data-testid={`replies-${th.id}`}>
                    {replies.length === 0 && (
                      <p className="text-sm text-slate-400" data-testid={`text-no-replies-${th.id}`}>{t('studiecafe.noReplies')}</p>
                    )}
                    {replies.map((rp) => (
                      <div key={rp.id} className="flex gap-2" data-testid={`reply-${rp.id}`}>
                        <div className="w-1.5 rounded-full bg-slate-200 shrink-0 self-stretch" />
                        <div className="flex-1 min-w-0">
                          {rp.deleted ? (
                            <p className="text-sm italic text-slate-400">{t('studiecafe.deletedReply')}</p>
                          ) : (
                            <>
                              <div className="text-xs text-slate-400 mb-0.5">{rp.authorName} · {formatWhen(rp.createdAt, lang)}</div>
                              <p className="text-sm text-slate-700 whitespace-pre-wrap">{tr(`r:${th.id}:${rp.id}:body`, rp.body)}</p>
                              {rp.kudos && (
                                <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-[11px] ring-1 ring-rose-200" data-testid={`kudos-reply-${rp.id}`}>
                                  <Award className="w-3 h-3" /> {t('studiecafe.kudosFrom', { name: rp.kudos.byName })}
                                </div>
                              )}
                              <div className="flex items-center gap-2 mt-1.5">
                                {renderReactions('reply', rp.id, rp.reactions)}
                                <div className="flex items-center gap-1 ml-auto">
                                  {isStaff && (
                                    <button onClick={() => toggleKudos('reply', rp.id)} className={`p-1 rounded-md transition-colors ${rp.kudos ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-300 hover:bg-rose-50 hover:text-rose-500'}`} title={rp.kudos ? t('studiecafe.actions.removeKudos') : t('studiecafe.actions.kudos')} data-testid={`button-kudos-reply-${rp.id}`}>
                                      <Award className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                  {(rp.isMine || isStaff) && (
                                    <button onClick={() => deleteReply(rp.id, th.id)} className="p-1 rounded-md text-slate-300 hover:bg-red-50 hover:text-red-600 transition-colors" title={t('studiecafe.actions.delete')} data-testid={`button-delete-reply-${rp.id}`}>
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* REPLY-COMPOSER */}
                    {th.isLocked && !isStaff ? (
                      <p className="text-sm text-slate-400 flex items-center gap-1.5" data-testid={`text-locked-${th.id}`}><Lock className="w-3.5 h-3.5" />{t('studiecafe.lockedHint')}</p>
                    ) : (
                      <div className="flex items-end gap-2 pt-1">
                        <textarea
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          rows={1}
                          maxLength={8000}
                          placeholder={t('studiecafe.replyPlaceholder')}
                          className="flex-1 px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none resize-y text-sm bg-white"
                          data-testid={`input-reply-${th.id}`}
                        />
                        <button
                          onClick={() => submitReply(th.id)}
                          disabled={replying || !replyBody.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 text-white text-sm font-medium disabled:opacity-50 hover:bg-slate-800 transition-colors"
                          data-testid={`button-submit-reply-${th.id}`}
                        >
                          {replying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
