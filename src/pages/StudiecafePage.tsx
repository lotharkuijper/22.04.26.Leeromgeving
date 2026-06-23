import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Coffee, Send, Loader2, Pin, PinOff, Lock, Unlock, Trash2, CheckCircle2,
  Award, Megaphone, Smile, MessageCircle, HelpCircle, MessagesSquare, Users,
  Pencil, X, Search, Bell, CheckCheck, Mail, ScanSearch,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { useContentTranslation, type TranslatableItem } from '../hooks/useContentTranslation';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { ChatExcerptCard, type ChatExcerptAttachment } from '../components/ChatExcerptCard';
import { FormulaEditor } from '../components/FormulaEditor';
import { takeStudiecafeHandoff } from '../lib/studiecafeHandoff';

// Studiecafé (Task #304) — per-cursus discussieforum. Studenten posten vragen/
// discussies/tips, reageren, reageren met emoji en markeren vragen als opgelost.
// Docenten modereren volledig (pinnen, sluiten, verwijderen), geven een pluim en
// plaatsen aankondigingen. Realtime via Supabase; auto-vertaling per lezer (#288).

type Category = 'vraag' | 'discussie' | 'samenwerken' | 'check-llm';
type FilterKey = 'all' | Category | 'announcement';
type SortKey = 'recent' | 'newest' | 'active';

// De categorieën die in de composer/edit-pickers en filters verschijnen.
const COMPOSER_CATEGORIES: Category[] = ['vraag', 'discussie', 'samenwerken', 'check-llm'];

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
  attachments?: ChatExcerptAttachment[];
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
  attachments?: ChatExcerptAttachment[];
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
  samenwerken: { icon: Users, classes: 'bg-green-50 text-green-700 ring-green-200' },
  'check-llm': { icon: ScanSearch, classes: 'bg-amber-50 text-amber-700 ring-amber-200' },
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
  const [sort, setSort] = useState<SortKey>('recent');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Ongelezen-markering (Task #307/#312): seenBaseline = de zachte-uitrol-vloer
  // (per-cursus last_seen). We bevriezen die bij binnenkomst. `reads` houdt per
  // thread bij wanneer hij voor het laatst is geopend; een thread blijft "nieuw"
  // tot hij INDIVIDUEEL is geopend, niet meer voor alle threads tegelijk bij het
  // openen van de pagina.
  const [seenBaseline, setSeenBaseline] = useState<string | null>(null);
  const [reads, setReads] = useState<Record<string, string>>({});
  // Task #327: bewust-ongelezen markeringen. Een thread hierin licht ALTIJD op als
  // "nieuw", ook backlog-threads met activiteit vóór de vloer (anders dan #324, dat
  // alleen de read-rij wiste en dus enkel post-vloer-threads weer kon tonen).
  const [manualUnread, setManualUnread] = useState<Set<string>>(new Set());
  const markedSeenRef = useRef(false);

  // Inline bewerken (auteur of staff).
  const [editingThread, setEditingThread] = useState<{ id: string; title: string; body: string; category: Category } | null>(null);
  const [editingReply, setEditingReply] = useState<{ id: string; body: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Composer (nieuwe thread).
  const [showComposer, setShowComposer] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('vraag');
  const [newAnnouncement, setNewAnnouncement] = useState(false);
  const [posting, setPosting] = useState(false);
  // Bijlage (chat-citaat) voor de nieuwe-thread-composer (Task #351).
  const [newAttachment, setNewAttachment] = useState<ChatExcerptAttachment | null>(null);
  const newBodyRef = useRef<HTMLTextAreaElement>(null);

  // Reply-composer per uitgeklapte thread.
  const [replyBody, setReplyBody] = useState('');
  const [replying, setReplying] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Bijlage (chat-citaat) voor de reply-composer (Task #352). Komt binnen via de
  // chat-overdracht met mode='reply': de student kiest een bestaand topic en het
  // AI-antwoord wordt als reactie geplaatst i.p.v. als nieuwe thread.
  const [replyAttachment, setReplyAttachment] = useState<ChatExcerptAttachment | null>(null);

  // Emoji-picker: welk doel staat open ('thread:<id>' | 'reply:<id>' | null).
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  // Meldingsvoorkeuren (Task #311) — e-mail-digest opt-out per gebruiker.
  const [showNotifPrefs, setShowNotifPrefs] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<{ emailReplies: boolean; emailAnnouncements: boolean }>({
    emailReplies: true,
    emailAnnouncements: true,
  });
  const [notifPrefsLoaded, setNotifPrefsLoaded] = useState(false);
  const [savingNotifPrefs, setSavingNotifPrefs] = useState(false);

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

  const loadNotifPrefs = useCallback(async () => {
    try {
      const r = await apiFetch('/api/studiecafe/notification-prefs');
      const d = await r.json().catch(() => ({}));
      if (r.ok && d && typeof d === 'object') {
        setNotifPrefs({
          emailReplies: d.email_replies !== false,
          emailAnnouncements: d.email_announcements !== false,
        });
      }
    } catch { /* stille terugval op defaults */ } finally {
      setNotifPrefsLoaded(true);
    }
  }, [apiFetch]);

  const saveNotifPref = useCallback(
    async (patch: Partial<{ emailReplies: boolean; emailAnnouncements: boolean }>) => {
      const next = { ...notifPrefs, ...patch };
      setNotifPrefs(next); // optimistisch
      setSavingNotifPrefs(true);
      try {
        const r = await apiFetch('/api/studiecafe/notification-prefs', {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d && typeof d === 'object') {
          setNotifPrefs({
            emailReplies: d.email_replies !== false,
            emailAnnouncements: d.email_announcements !== false,
          });
        }
      } catch { /* houd optimistische waarde */ } finally {
        setSavingNotifPrefs(false);
      }
    },
    [apiFetch, notifPrefs],
  );

  useEffect(() => { loadNotifPrefs(); }, [loadNotifPrefs]);

  const loadThreads = useCallback(async () => {
    if (!courseId) return;
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setThreads(d.threads || []);
        setIsStaff(!!d.isStaff);
        setError(null);
        // Merge de server-leesstatus met lokaal (optimistisch) gezette reads zodat
        // een net-geopende thread niet terugspringt naar "nieuw" bij een refetch:
        // per thread wint de laatste read-timestamp.
        const serverReads: Record<string, string> = (d.reads && typeof d.reads === 'object') ? d.reads : {};
        setReads((prev) => {
          const merged: Record<string, string> = { ...prev };
          for (const [tid, at] of Object.entries(serverReads)) {
            if (typeof at === 'string' && (!merged[tid] || at > merged[tid])) merged[tid] = at;
          }
          return merged;
        });
        // Bewust-ongelezen markeringen (#327): server is leidend op een refetch.
        const serverManual: string[] = Array.isArray(d.manualUnread) ? d.manualUnread : [];
        setManualUnread(new Set(serverManual.filter((x) => typeof x === 'string')));
        // Eénmalig per bezoek: bevries de zachte-uitrol-vloer. Anders dan #307
        // markeren we het bezoek NIET meer als "alles gezien" — per-thread reads
        // doen dat. Alleen bij de allereerste keer (geen vloer) leggen we de vloer
        // vast op nu, zodat de bestaande backlog niet als ongelezen oplicht.
        if (!markedSeenRef.current) {
          markedSeenRef.current = true;
          if (d.lastSeenAt) {
            setSeenBaseline(d.lastSeenAt);
          } else {
            const sr = await apiFetch(`/api/studiecafe/${courseId}/seen`, { method: 'POST' }).catch(() => null);
            const sd = sr ? await sr.json().catch(() => null) : null;
            setSeenBaseline(sd?.lastSeenAt ?? new Date().toISOString());
          }
        }
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
    markedSeenRef.current = false;
    setSeenBaseline(null);
    setReads({});
    setManualUnread(new Set());
    if (courseId) loadThreads();
    else setLoading(false);
  }, [courseId, loadThreads]);

  // Overdracht vanuit de chat (Task #351): open de composer met het AI-citaat
  // als bijlage en de juiste categorie voorgeselecteerd. Eenmalig bij mount.
  useEffect(() => {
    const handoff = takeStudiecafeHandoff();
    if (!handoff) return;
    // Reply-modus (Task #352): laad de bijlage in de reply-composer en toon een
    // banner zodat de student eerst een bestaand topic kiest. Geen nieuwe-thread-
    // composer openen.
    if (handoff.mode === 'reply') {
      setReplyAttachment(handoff.attachment);
      return;
    }
    setNewAttachment(handoff.attachment);
    if (COMPOSER_CATEGORIES.includes(handoff.category as Category)) {
      setNewCategory(handoff.category as Category);
    }
    setShowComposer(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markeer één thread als gelezen (Task #312): optimistisch lokaal + persisteren.
  // Nudge de nav-badge zodat hij meteen meedaalt zonder op de poll te wachten.
  const markRead = useCallback((threadId: string) => {
    if (!courseId) return;
    const ts = new Date().toISOString();
    setReads((prev) => {
      const cur = prev[threadId];
      if (cur && cur >= ts) return prev;
      return { ...prev, [threadId]: ts };
    });
    // Openen heft een eerdere bewust-ongelezen markering (#327) op.
    setManualUnread((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
    apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}/read`, { method: 'POST' })
      .then(() => { try { window.dispatchEvent(new Event('studiecafe-unread-refresh')); } catch { /* noop */ } })
      .catch(() => {});
  }, [courseId, apiFetch]);

  // Markeer ALLE zichtbare threads als gelezen (Task #314): optimistisch lokaal +
  // persisteren via één server-call. Werkt de nav-badge meteen bij naar 0.
  const markAllRead = useCallback(() => {
    if (!courseId) return;
    const ts = new Date().toISOString();
    setReads((prev) => {
      const next = { ...prev };
      for (const th of threads) {
        const cur = next[th.id];
        if (!cur || cur < ts) next[th.id] = ts;
      }
      return next;
    });
    // "Alles gelezen" heft ook alle bewust-ongelezen markeringen (#327) op.
    setManualUnread((prev) => (prev.size ? new Set() : prev));
    apiFetch(`/api/studiecafe/${courseId}/read-all`, { method: 'POST' })
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        if (d && Array.isArray(d.threadIds) && typeof d.readAt === 'string') {
          setReads((prev) => {
            const next = { ...prev };
            for (const id of d.threadIds) {
              const cur = next[id];
              if (!cur || cur < d.readAt) next[id] = d.readAt;
            }
            return next;
          });
        }
        try { window.dispatchEvent(new Event('studiecafe-unread-refresh')); } catch { /* noop */ }
      })
      .catch(() => {});
  }, [courseId, apiFetch, threads]);

  // Markeer één thread weer als ongelezen (Task #324/#327): zet optimistisch de
  // bewust-ongelezen markering zodat de thread ALTIJD weer als "nieuw" oplicht,
  // ook backlog vóór de vloer. Nudge de nav-badge zodat hij meteen weer oploopt.
  const markUnread = useCallback((threadId: string) => {
    if (!courseId) return;
    setManualUnread((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.add(threadId);
      return next;
    });
    apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}/unread`, { method: 'POST' })
      .then(() => { try { window.dispatchEvent(new Event('studiecafe-unread-refresh')); } catch { /* noop */ } })
      .catch(() => {});
  }, [courseId, apiFetch]);

  // ── Realtime: bij elke wijziging een gedebouncede refetch ─────────────────
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandedRef = useRef<string | null>(null);
  useEffect(() => { expandedRef.current = expandedId; }, [expandedId]);
  const markReadRef = useRef(markRead);
  useEffect(() => { markReadRef.current = markRead; }, [markRead]);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      loadThreads();
      // Houdt de actueel geopende thread "gelezen": nieuwe activiteit terwijl hij
      // openstaat mag hem niet opnieuw als "nieuw" markeren (Task #312).
      if (expandedRef.current) {
        loadReplies(expandedRef.current);
        markReadRef.current(expandedRef.current);
      }
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
      items[`t:${th.id}:body`] = { text: th.body, format: 'markdown' };
    }
    for (const [tid, reps] of Object.entries(repliesByThread)) {
      for (const r of reps) {
        if (!r.deleted && r.body) items[`r:${tid}:${r.id}:body`] = { text: r.body, format: 'markdown' };
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
        body: JSON.stringify({
          title: newTitle,
          body: newBody,
          category: newCategory,
          isAnnouncement: isStaff && newAnnouncement,
          attachments: newAttachment ? [newAttachment] : [],
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setNewTitle(''); setNewBody(''); setNewCategory('vraag'); setNewAnnouncement(false); setShowComposer(false);
        setNewAttachment(null);
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
    // Openen = gelezen (Task #312): alleen deze thread verliest zijn markering.
    markRead(threadId);
    if (!repliesByThread[threadId]) await loadReplies(threadId);
  };

  const submitReply = async (threadId: string) => {
    if (!courseId || !replyBody.trim()) return;
    setReplying(true);
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}/replies`, {
        method: 'POST',
        body: JSON.stringify({
          body: replyBody,
          attachments: replyAttachment ? [replyAttachment] : [],
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setReplyBody('');
        setReplyAttachment(null);
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

  const patchThread = async (
    threadId: string,
    patch: { isPinned?: boolean; isLocked?: boolean; isResolved?: boolean; isAnnouncement?: boolean; title?: string; body?: string; category?: Category },
  ) => {
    if (!courseId) return;
    const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (r.ok) await loadThreads();
  };

  const startEditThread = (th: Thread) => {
    setEditingReply(null);
    setEditingThread({ id: th.id, title: th.title, body: th.body, category: th.category });
  };

  const saveEditThread = async () => {
    if (!courseId || !editingThread) return;
    const { id, title, body, category } = editingThread;
    if (!title.trim() || !body.trim()) return;
    setSavingEdit(true);
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/threads/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, body, category }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setEditingThread(null); await loadThreads(); }
      else setError(d.error || t('studiecafe.postError'));
    } finally {
      setSavingEdit(false);
    }
  };

  const startEditReply = (rp: Reply) => {
    setEditingThread(null);
    setEditingReply({ id: rp.id, body: rp.body });
  };

  const saveEditReply = async (threadId: string) => {
    if (!courseId || !editingReply || !editingReply.body.trim()) return;
    setSavingEdit(true);
    try {
      const r = await apiFetch(`/api/studiecafe/${courseId}/replies/${editingReply.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: editingReply.body }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setEditingReply(null); await loadReplies(threadId); }
      else setError(d.error || t('studiecafe.postError'));
    } finally {
      setSavingEdit(false);
    }
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
    let list = threads;
    if (filter === 'announcement') list = list.filter((x) => x.isAnnouncement);
    else if (filter !== 'all') list = list.filter((x) => x.category === filter && !x.isAnnouncement);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((x) => x.title.toLowerCase().includes(q) || x.body.toLowerCase().includes(q));
    return list;
  }, [threads, filter, search]);

  // Sorteren op de geladen set (≤200 threads). Vastgezet + aankondigingen blijven
  // bovenaan; daarbinnen geldt de gekozen sortering. ISO-timestamps sorteren
  // lexicografisch correct.
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.isAnnouncement !== b.isAnnouncement) return a.isAnnouncement ? -1 : 1;
      if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt);
      if (sort === 'active') return (b.replyCount - a.replyCount) || b.lastActivityAt.localeCompare(a.lastActivityAt);
      return b.lastActivityAt.localeCompare(a.lastActivityAt);
    });
    return arr;
  }, [filtered, sort]);

  // Ongelezen-helpers (Task #312): een thread is "nieuw" als zijn laatste
  // activiteit ná de bevroren vloer ligt ÉN hij niet individueel is geopend (geen
  // read, of de read is ouder dan de activiteit). Geen vloer (eerste bezoek ooit)
  // ⇒ niets is nieuw.
  const isUnread = useCallback(
    (th: Thread) => {
      // Bewust-ongelezen (#327): omzeilt de vloer- en read-checks.
      if (manualUnread.has(th.id)) return true;
      if (!seenBaseline || th.lastActivityAt <= seenBaseline) return false;
      const readAt = reads[th.id];
      if (readAt && th.lastActivityAt <= readAt) return false;
      return true;
    },
    [seenBaseline, reads, manualUnread],
  );
  // Mag deze thread weer als "nieuw" worden getoond? Sinds #327 mag dat voor ELK
  // gesprek dat nu gelezen is — ook backlog vóór de vloer; de bewust-ongelezen
  // markering omzeilt de vloer-check. Toont de knop dus niet voor wat al "nieuw" is.
  const canMarkUnread = useCallback((th: Thread) => !isUnread(th), [isUnread]);
  const unreadStats = useMemo(() => {
    let count = 0;
    let hasAnnouncement = false;
    for (const th of threads) {
      if (isUnread(th)) {
        count += 1;
        if (th.isAnnouncement) hasAnnouncement = true;
      }
    }
    return { count, hasAnnouncement };
  }, [threads, isUnread]);

  const filterChips: { key: FilterKey; label: string }[] = [
    { key: 'all', label: t('studiecafe.filter.all') },
    { key: 'vraag', label: t('studiecafe.filter.vraag') },
    { key: 'discussie', label: t('studiecafe.filter.discussie') },
    { key: 'samenwerken', label: t('studiecafe.filter.samenwerken') },
    { key: 'check-llm', label: t('studiecafe.filter.check-llm') },
    { key: 'announcement', label: t('studiecafe.filter.announcement') },
  ];

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'recent', label: t('studiecafe.sort.recent') },
    { key: 'newest', label: t('studiecafe.sort.newest') },
    { key: 'active', label: t('studiecafe.sort.active') },
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
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight" data-testid="text-studiecafe-title">{t('studiecafe.title')}</h1>
            <p className="text-white/90 text-sm">
              {activeCourse?.name ? `${activeCourse.name} · ` : ''}{t('studiecafe.subtitle')}
            </p>
          </div>
          <div className="relative ml-auto shrink-0">
            <button
              onClick={() => setShowNotifPrefs((v) => !v)}
              className="w-10 h-10 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
              title={t('studiecafe.notifications.title')}
              aria-label={t('studiecafe.notifications.title')}
              aria-expanded={showNotifPrefs}
              data-testid="button-notification-prefs"
            >
              <Bell className="w-5 h-5" />
            </button>
            {showNotifPrefs && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowNotifPrefs(false)}
                  data-testid="overlay-notification-prefs"
                />
                <div
                  className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white text-slate-700 rounded-2xl ring-1 ring-slate-200 shadow-xl z-20 p-4"
                  data-testid="popover-notification-prefs"
                >
                  <div className="flex items-center justify-between mb-1">
                    <h2 className="font-semibold text-slate-900">{t('studiecafe.notifications.title')}</h2>
                    {savingNotifPrefs && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                  </div>
                  <p className="text-xs text-slate-500 mb-3">{t('studiecafe.notifications.subtitle')}</p>
                  <label className="flex items-start gap-3 py-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 accent-amber-500"
                      checked={notifPrefs.emailReplies}
                      disabled={!notifPrefsLoaded || savingNotifPrefs}
                      onChange={(e) => saveNotifPref({ emailReplies: e.target.checked })}
                      data-testid="switch-email-replies"
                    />
                    <span className="text-sm">
                      <span className="block font-medium text-slate-800">{t('studiecafe.notifications.repliesLabel')}</span>
                      <span className="block text-xs text-slate-500">{t('studiecafe.notifications.repliesHint')}</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 py-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 accent-amber-500"
                      checked={notifPrefs.emailAnnouncements}
                      disabled={!notifPrefsLoaded || savingNotifPrefs}
                      onChange={(e) => saveNotifPref({ emailAnnouncements: e.target.checked })}
                      data-testid="switch-email-announcements"
                    />
                    <span className="text-sm">
                      <span className="block font-medium text-slate-800">{t('studiecafe.notifications.announcementsLabel')}</span>
                      <span className="block text-xs text-slate-500">{t('studiecafe.notifications.announcementsHint')}</span>
                    </span>
                  </label>
                  <p className="text-[11px] text-slate-400 mt-2">{t('studiecafe.notifications.digestNote')}</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* REPLY-MODUS BANNER (Task #352): chat-overdracht wil dit AI-antwoord als
          reactie in een bestaand topic plaatsen. Vraag de student een topic te
          openen; de bijlage verschijnt dan in de reply-composer. */}
      {replyAttachment && (
        <div className="bg-amber-50 ring-1 ring-amber-200 rounded-2xl p-4 mb-5 space-y-3" data-testid="banner-reply-attachment">
          <div className="flex items-start gap-2">
            <MessageCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-800">{t('studiecafe.replyAttachment.bannerTitle')}</p>
              <p className="text-xs text-amber-700 mt-0.5">{t('studiecafe.replyAttachment.bannerHint')}</p>
            </div>
            <button
              onClick={() => setReplyAttachment(null)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors shrink-0"
              data-testid="button-cancel-reply-attachment"
            >
              <X className="w-3.5 h-3.5" />{t('studiecafe.replyAttachment.cancel')}
            </button>
          </div>
          <ChatExcerptCard attachment={replyAttachment} />
        </div>
      )}

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
              ref={newBodyRef}
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              maxLength={8000}
              rows={4}
              placeholder={t('studiecafe.compose.bodyPlaceholder')}
              className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none resize-y"
              data-testid="input-thread-body"
            />
            <FormulaEditor
              value={newBody}
              onChange={setNewBody}
              textareaRef={newBodyRef}
              testidPrefix="thread"
            />
            {newAttachment && (
              <ChatExcerptCard
                attachment={newAttachment}
                onRemove={() => setNewAttachment(null)}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {COMPOSER_CATEGORIES.map((c) => {
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
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
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

      {/* ZOEKEN + SORTEREN */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('studiecafe.search.placeholder')}
            className="w-full pl-9 pr-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none text-sm bg-white"
            data-testid="input-search"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-slate-500">
          {t('studiecafe.sort.label')}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none text-sm bg-white text-slate-700"
            data-testid="select-sort"
          >
            {sortOptions.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 ring-1 ring-red-200 text-sm" data-testid="text-error">{error}</div>
      )}

      {unreadStats.count > 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-rose-50 text-rose-800 ring-1 ring-rose-200 text-sm font-medium flex items-center justify-between gap-3 flex-wrap" data-testid="banner-unread">
          <span>
            {unreadStats.hasAnnouncement
              ? t('studiecafe.unread.bannerAnnouncement')
              : unreadStats.count === 1
                ? t('studiecafe.unread.bannerOne')
                : t('studiecafe.unread.bannerMany', { count: unreadStats.count })}
          </span>
          <button
            onClick={markAllRead}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100 transition-colors shrink-0 font-medium"
            data-testid="button-mark-all-read"
          >
            <CheckCheck className="w-4 h-4" />
            {t('studiecafe.unread.markAllRead')}
          </button>
        </div>
      )}

      {/* FEED */}
      {loading ? (
        <div className="flex justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-slate-400" data-testid="text-empty">
          <Coffee className="w-10 h-10 mx-auto mb-3 text-slate-300" />
          <p>{search.trim() ? t('studiecafe.noResults') : t('studiecafe.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((th) => {
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
                <div className={`p-4 ${isUnread(th) ? 'border-l-4 border-rose-400' : ''}`}>
                  {/* META-RIJ */}
                  <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
                    {isUnread(th) && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-semibold ring-1 ring-rose-200" data-testid={`badge-unread-${th.id}`}>
                        {t('studiecafe.unread.thread')}
                      </span>
                    )}
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

                  {/* TITEL + BODY (of inline-bewerken) */}
                  {editingThread?.id === th.id ? (
                    <div className="space-y-2 mb-2" data-testid={`edit-thread-${th.id}`}>
                      <input
                        value={editingThread.title}
                        onChange={(e) => setEditingThread((s) => (s ? { ...s, title: e.target.value } : s))}
                        maxLength={200}
                        className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none text-sm"
                        data-testid={`input-edit-thread-title-${th.id}`}
                      />
                      <textarea
                        value={editingThread.body}
                        onChange={(e) => setEditingThread((s) => (s ? { ...s, body: e.target.value } : s))}
                        maxLength={8000}
                        rows={4}
                        className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none resize-y text-sm"
                        data-testid={`input-edit-thread-body-${th.id}`}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        {COMPOSER_CATEGORIES.map((c) => {
                          const Icon = CATEGORY_META[c].icon;
                          return (
                            <button
                              key={c}
                              onClick={() => setEditingThread((s) => (s ? { ...s, category: c } : s))}
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs ring-1 transition-colors ${editingThread.category === c ? CATEGORY_META[c].classes + ' ring-2' : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'}`}
                              data-testid={`select-edit-category-${th.id}-${c}`}
                            >
                              <Icon className="w-3.5 h-3.5" />
                              {t(`studiecafe.category.${c}` as any)}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingThread(null)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors text-sm"
                          data-testid={`button-cancel-edit-thread-${th.id}`}
                        >
                          <X className="w-3.5 h-3.5" />{t('studiecafe.edit.cancel')}
                        </button>
                        <button
                          onClick={saveEditThread}
                          disabled={savingEdit || !editingThread.title.trim() || !editingThread.body.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:opacity-50 hover:bg-slate-800 transition-colors"
                          data-testid={`button-save-edit-thread-${th.id}`}
                        >
                          {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}{t('studiecafe.edit.save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h3 className="font-semibold text-slate-900 mb-1" data-testid={`text-thread-title-${th.id}`}>{tr(`t:${th.id}:title`, th.title)}</h3>
                      <MarkdownMessage
                        content={tr(`t:${th.id}:body`, th.body)}
                        className="prose prose-sm max-w-none text-slate-700 prose-p:my-1.5"
                      />
                      {(th.attachments ?? []).map((att, i) => (
                        <div key={i} className="mt-2">
                          <ChatExcerptCard attachment={att} />
                        </div>
                      ))}
                    </>
                  )}

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
                      {canMarkUnread(th) && (
                        <button
                          onClick={() => markUnread(th.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                          title={t('studiecafe.unread.markUnread')}
                          data-testid={`button-mark-unread-${th.id}`}
                        >
                          <Mail className="w-4 h-4" />
                        </button>
                      )}
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
                      {(th.isMine || isStaff) && editingThread?.id !== th.id && (
                        <button onClick={() => startEditThread(th)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors" title={t('studiecafe.actions.edit')} data-testid={`button-edit-thread-${th.id}`}>
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      {isStaff && (
                        <>
                          <button onClick={() => toggleKudos('thread', th.id)} className={`p-1.5 rounded-lg transition-colors ${th.kudos ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-400 hover:bg-rose-50 hover:text-rose-500'}`} title={th.kudos ? t('studiecafe.actions.removeKudos') : t('studiecafe.actions.kudos')} data-testid={`button-kudos-${th.id}`}>
                            <Award className="w-4 h-4" />
                          </button>
                          <button onClick={() => patchThread(th.id, { isAnnouncement: !th.isAnnouncement })} className={`p-1.5 rounded-lg transition-colors ${th.isAnnouncement ? 'text-amber-600 hover:bg-amber-50' : 'text-slate-400 hover:bg-amber-50 hover:text-amber-600'}`} title={th.isAnnouncement ? t('studiecafe.actions.unannounce') : t('studiecafe.actions.announce')} data-testid={`button-announce-${th.id}`}>
                            <Megaphone className="w-4 h-4" />
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
                          ) : editingReply?.id === rp.id ? (
                            <div className="space-y-2" data-testid={`edit-reply-${rp.id}`}>
                              <div className="text-xs text-slate-400 mb-0.5">{rp.authorName} · {formatWhen(rp.createdAt, lang)}</div>
                              <textarea
                                value={editingReply.body}
                                onChange={(e) => setEditingReply((s) => (s ? { ...s, body: e.target.value } : s))}
                                maxLength={8000}
                                rows={3}
                                className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-400 outline-none resize-y text-sm bg-white"
                                data-testid={`input-edit-reply-${rp.id}`}
                              />
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => setEditingReply(null)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors text-xs"
                                  data-testid={`button-cancel-edit-reply-${rp.id}`}
                                >
                                  <X className="w-3.5 h-3.5" />{t('studiecafe.edit.cancel')}
                                </button>
                                <button
                                  onClick={() => saveEditReply(th.id)}
                                  disabled={savingEdit || !editingReply.body.trim()}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 text-white text-xs font-medium disabled:opacity-50 hover:bg-slate-800 transition-colors"
                                  data-testid={`button-save-edit-reply-${rp.id}`}
                                >
                                  {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}{t('studiecafe.edit.save')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="text-xs text-slate-400 mb-0.5">{rp.authorName} · {formatWhen(rp.createdAt, lang)}</div>
                              <MarkdownMessage
                                content={tr(`r:${th.id}:${rp.id}:body`, rp.body)}
                                className="prose prose-sm max-w-none text-slate-700 prose-p:my-1"
                              />
                              {(rp.attachments ?? []).map((att, i) => (
                                <div key={i} className="mt-2">
                                  <ChatExcerptCard attachment={att} />
                                </div>
                              ))}
                              {rp.kudos && (
                                <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-[11px] ring-1 ring-rose-200" data-testid={`kudos-reply-${rp.id}`}>
                                  <Award className="w-3 h-3" /> {t('studiecafe.kudosFrom', { name: rp.kudos.byName })}
                                </div>
                              )}
                              <div className="flex items-center gap-2 mt-1.5">
                                {renderReactions('reply', rp.id, rp.reactions)}
                                <div className="flex items-center gap-1 ml-auto">
                                  {(rp.isMine || isStaff) && (
                                    <button onClick={() => startEditReply(rp)} className="p-1 rounded-md text-slate-300 hover:bg-slate-100 hover:text-slate-600 transition-colors" title={t('studiecafe.actions.edit')} data-testid={`button-edit-reply-${rp.id}`}>
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                  )}
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
                      <div className="space-y-2 pt-1">
                        {expandedId === th.id && replyAttachment && (
                          <div data-testid={`reply-attachment-preview-${th.id}`}>
                            <p className="text-xs text-amber-700 mb-1 flex items-center gap-1.5">
                              <MessageCircle className="w-3.5 h-3.5" />
                              {t('studiecafe.replyAttachment.includedHint')}
                            </p>
                            <ChatExcerptCard
                              attachment={replyAttachment}
                              onRemove={() => setReplyAttachment(null)}
                            />
                          </div>
                        )}
                        <FormulaEditor
                          value={replyBody}
                          onChange={setReplyBody}
                          textareaRef={replyRef}
                          testidPrefix={`reply-${th.id}`}
                        />
                        <div className="flex items-end gap-2">
                          <textarea
                            ref={replyRef}
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
