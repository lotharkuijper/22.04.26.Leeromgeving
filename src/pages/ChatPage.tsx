import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { sendChatMessage, llmErrorToDutch, type Message } from '../services/llm.service';
import { searchRelevantChunksWithStats, buildContextWithCap, dedupeSourcesByDocument, chunkToDisplaySource, ragDocumentDownloadUrl, openRagDocument, type DocumentChunk } from '../services/rag.service';
import { SourceList, type SourceItem } from '../components/SourceList';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { RAGDiagnostics } from '../components/RAGDiagnostics';
import { Send, MessageSquare, Plus, AlertCircle, RefreshCw, LogOut, BookText, Trash2, X, Loader2, Eye, Download, FileText, TrendingUp, Coffee, Copy, Check } from 'lucide-react';
import { stashStudiecafeHandoff } from '../lib/studiecafeHandoff';
import { type ChatExcerptAttachment } from '../components/ChatExcerptCard';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';
import { DocumentViewer, type ViewerContext } from '../components/DocumentViewer';
import { ViewerErrorBoundary } from '../components/ViewerErrorBoundary';
import { NoticeBanner, useNotice } from '../components/Notice';
import { PromptDebugBadge } from '../components/PromptDebugBadge';
import { useLearningLevel } from '../hooks/useLearningLevel';
import { LearningLevelSelector } from '../components/LearningLevelSelector';


interface ChatMessage extends Message {
  id: string;
  timestamp: string;
  retrievedContext?: any;
}

interface Conversation {
  id: string;
  title: string;
  created_at: string;
}

interface RagModuleSettings {
  similarity_threshold: number;
  match_count: number;
  rag_strict_mode: boolean;
}

interface RagSettings {
  chat: RagModuleSettings;
  explain: RagModuleSettings;
  quiz: RagModuleSettings;
  project: RagModuleSettings;
}

const RAG_DEFAULTS: RagSettings = {
  chat:    { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: false },
  explain: { similarity_threshold: 0.50, match_count: 5, rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false },
};

// Minimale vorm van een Studiecafé-thread voor de in-chat topic-kiezer (Task #354).
interface ReplyThreadOption {
  id: string;
  title: string;
  category: string;
  isLocked: boolean;
  replyCount: number;
}

function AssistantMessageBody({
  messageId,
  content,
  retrievedContext,
  onRequestSource,
}: {
  messageId: string;
  content: string;
  retrievedContext?: any;
  onRequestSource: (s: { documentId?: string; title: string }) => void;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // In-chat topic-kiezer (Task #354): de student kan een bestaand open topic van
  // de actieve cursus kiezen vóór hij naar het Studiecafé gaat.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threads, setThreads] = useState<ReplyThreadOption[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  // Direct plaatsen (Task #358): de student plaatst het AI-antwoord met één klik
  // als reactie in het gekozen topic, zonder eerst naar het Studiecafé te gaan.
  const [postingThreadId, setPostingThreadId] = useState<string | null>(null);
  const [postResult, setPostResult] = useState<{ ok: boolean; threadId?: string; title?: string } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);
  const dispRaw: SourceItem[] = (retrievedContext?.displaySources as SourceItem[] | undefined)
    ?? (retrievedContext?.chunks
          ? dedupeSourcesByDocument(
              (retrievedContext.chunks as any[]).map((c) => ({
                ...chunkToDisplaySource(c),
                href: ragDocumentDownloadUrl(c.documentId),
              })),
              5
            )
          : []);
  const citationSources = dispRaw.map((s, i) => ({
    index: i + 1,
    title: s.title,
    href: s.href,
    documentId: s.documentId,
  }));
  const handleCitationClick = (idx: number) => {
    setSourcesOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`source-${messageId}-${idx}`);
      if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };
  const handleOpenSource = (s: { documentId?: string; title: string }) => {
    if (!s.documentId) return;
    onRequestSource(s);
  };
  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard niet beschikbaar */ }
  };
  const buildExcerptAttachment = (): ChatExcerptAttachment => ({
    type: 'chat_excerpt',
    content,
    sources: citationSources.map((s) => ({
      index: s.index,
      title: s.title,
      documentId: s.documentId,
    })),
    meta: {
      module: 'chat',
      ...(activeCourse ? { courseId: activeCourse } : {}),
      capturedAt: new Date().toISOString(),
    },
  });
  const handleCheckLLM = () => {
    stashStudiecafeHandoff({
      v: 1,
      courseId: activeCourse ?? null,
      category: 'check-llm',
      attachment: buildExcerptAttachment(),
      mode: 'thread',
    });
    navigate('/studiecafe');
  };
  const loadThreads = async () => {
    if (!activeCourse) { setThreads([]); return; }
    setThreadsLoading(true);
    setThreadsError(false);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const r = await fetch(`/api/studiecafe/${activeCourse}/threads`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error('threads');
      const d = await r.json();
      const list: ReplyThreadOption[] = (Array.isArray(d.threads) ? d.threads : [])
        .filter((th: any) => !th.isLocked)
        .map((th: any) => ({
          id: th.id,
          title: th.title,
          category: th.category,
          isLocked: !!th.isLocked,
          replyCount: th.replyCount || 0,
        }));
      setThreads(list);
    } catch {
      setThreadsError(true);
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  };
  const handleCheckLLMReply = () => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next) {
      setThreadSearch('');
      loadThreads();
    }
  };
  const handlePickThread = (threadId: string | null) => {
    stashStudiecafeHandoff({
      v: 1,
      courseId: activeCourse ?? null,
      category: 'check-llm',
      attachment: buildExcerptAttachment(),
      mode: 'reply',
      ...(threadId ? { targetThreadId: threadId } : {}),
    });
    setPickerOpen(false);
    navigate('/studiecafe');
  };
  // Task #358: plaats het AI-antwoord direct als reactie in het gekozen topic.
  const handlePostReply = async (thread: ReplyThreadOption) => {
    if (!activeCourse || postingThreadId) return;
    setPostingThreadId(thread.id);
    setPostResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const r = await fetch(`/api/studiecafe/${activeCourse}/threads/${thread.id}/replies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          body: t('chat.replyPicker.defaultBody'),
          attachments: [buildExcerptAttachment()],
        }),
      });
      if (!r.ok) throw new Error('post');
      setPostResult({ ok: true, threadId: thread.id, title: thread.title });
      setPickerOpen(false);
    } catch {
      setPostResult({ ok: false });
    } finally {
      setPostingThreadId(null);
    }
  };
  const handleViewPostedTopic = () => {
    if (!postResult?.threadId) { navigate('/studiecafe'); return; }
    navigate(`/studiecafe?thread=${encodeURIComponent(postResult.threadId)}`);
  };
  return (
    <>
      <MarkdownMessage
        content={content}
        sources={citationSources}
        onCitationClick={handleCitationClick}
        onSourceOpen={handleOpenSource}
      />
      {dispRaw.length > 0 && (
        <SourceList
          sources={dispRaw}
          label={t('chat.sourcesFromMaterial')}
          showSimilarity={false}
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
          idPrefix={messageId}
          onOpenSource={handleOpenSource}
          uniqueLabel={t('chat.uniqueWord')}
          slideWord={t('quiz.slideWord')}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 mt-3 pt-2 border-t border-gray-200">
        <button
          type="button"
          onClick={handleCheckLLM}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100 transition-colors"
          title={t('chat.checkLLMHint')}
          data-testid={`button-check-llm-${messageId}`}
        >
          <Coffee className="w-3.5 h-3.5" />
          {t('chat.checkLLM')}
        </button>
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={handleCheckLLMReply}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100 transition-colors"
            title={t('chat.checkLLMReplyHint')}
            data-testid={`button-check-llm-reply-${messageId}`}
            aria-expanded={pickerOpen}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t('chat.checkLLMReply')}
          </button>
          {pickerOpen && (
            <div
              className="absolute z-20 mt-1 left-0 w-72 max-w-[90vw] bg-white rounded-xl ring-1 ring-slate-200 shadow-lg p-2"
              data-testid={`thread-picker-${messageId}`}
            >
              <p className="text-xs font-medium text-slate-600 px-1 pb-1.5">{t('chat.replyPicker.title')}</p>
              <input
                type="text"
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                placeholder={t('chat.replyPicker.searchPlaceholder')}
                className="w-full px-2.5 py-1.5 text-sm rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-amber-300 outline-none mb-1.5"
                data-testid={`input-thread-search-${messageId}`}
              />
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {threadsLoading ? (
                  <p className="text-xs text-slate-400 px-1 py-2 flex items-center gap-1.5" data-testid={`thread-picker-loading-${messageId}`}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />{t('chat.replyPicker.loading')}
                  </p>
                ) : threadsError ? (
                  <p className="text-xs text-red-500 px-1 py-2" data-testid={`thread-picker-error-${messageId}`}>{t('chat.replyPicker.error')}</p>
                ) : (() => {
                  const q = threadSearch.trim().toLowerCase();
                  const filtered = q ? threads.filter((th) => th.title.toLowerCase().includes(q)) : threads;
                  if (filtered.length === 0) {
                    return <p className="text-xs text-slate-400 px-1 py-2" data-testid={`thread-picker-empty-${messageId}`}>{t('chat.replyPicker.empty')}</p>;
                  }
                  return filtered.map((th) => (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => handlePostReply(th)}
                      disabled={!!postingThreadId}
                      title={t('chat.replyPicker.postHint')}
                      className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg hover:bg-amber-50 transition-colors disabled:opacity-60 disabled:cursor-wait"
                      data-testid={`button-pick-thread-${th.id}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-slate-700 truncate">{th.title}</span>
                        <span className="block text-[11px] text-slate-400">{t('chat.replyPicker.replyCount').replace('{n}', String(th.replyCount))}</span>
                      </span>
                      {postingThreadId === th.id
                        ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-amber-600" />
                        : <Send className="w-3.5 h-3.5 shrink-0 text-amber-500" />}
                    </button>
                  ));
                })()}
              </div>
              <button
                type="button"
                onClick={() => handlePickThread(null)}
                className="w-full text-left mt-1.5 pt-1.5 border-t border-slate-100 px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                data-testid={`button-pick-in-studiecafe-${messageId}`}
              >
                {t('chat.replyPicker.chooseOnPage')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopyMarkdown}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-200 transition-colors"
          title={t('chat.copyMarkdown')}
          data-testid={`button-copy-markdown-${messageId}`}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? t('chat.copied') : t('chat.copyMarkdown')}
        </button>
      </div>
      {postResult && (
        postResult.ok ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 text-xs text-green-700 bg-green-50 ring-1 ring-green-200 rounded-lg px-2.5 py-1.5"
            data-testid={`reply-post-success-${messageId}`}
          >
            <Check className="w-3.5 h-3.5 shrink-0" />
            <span>{t('chat.replyPicker.posted').replace('{title}', postResult.title ?? '')}</span>
            <button
              type="button"
              onClick={handleViewPostedTopic}
              className="ml-auto inline-flex items-center gap-1 font-medium text-green-800 underline hover:no-underline"
              data-testid={`button-view-posted-topic-${messageId}`}
            >
              <Coffee className="w-3.5 h-3.5" />
              {t('chat.replyPicker.viewTopic')}
            </button>
          </div>
        ) : (
          <div
            className="mt-2 flex items-center gap-2 text-xs text-red-700 bg-red-50 ring-1 ring-red-200 rounded-lg px-2.5 py-1.5"
            data-testid={`reply-post-error-${messageId}`}
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{t('chat.replyPicker.postError')}</span>
          </div>
        )
      )}
    </>
  );
}

export function ChatPage() {
  const { profile, signOut } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const { level: learningLevel, setLevel: setLearningLevel } = useLearningLevel(activeCourse);
  const { t, lang } = useLanguage();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [profileTimeout, setProfileTimeout] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{ conversationId: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ragSettings, setRagSettings] = useState<RagSettings>(RAG_DEFAULTS);
  const [feedbackError, setFeedbackError] = useState<{ title: string; detail?: string } | null>(null);
  const [contextStats, setContextStats] = useState<{ used: number; total: number; charTrimmed: boolean } | null>(null);
  const [pendingRetry, setPendingRetry] = useState<{ history: Message[]; isFirstMessage: boolean } | null>(null);
  const [sourceChoice, setSourceChoice] = useState<{ documentId: string; title: string } | null>(null);
  const [viewerDoc, setViewerDoc] = useState<{ documentId: string; title: string } | null>(null);
  const [viewerContext, setViewerContext] = useState<ViewerContext | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingViewerRef = useRef(false);
  const VIEWER_MIN_PX = 340;
  const VIEWER_DEFAULT_PX = 480;
  // Ruimte die NIET naar het documentpaneel mag: gespreks-zijbalk (256px) +
  // flex-gaps + sleep-handvat + een minimale chatbreedte (480px). Zo kan het
  // chatvenster nooit te smal worden, ongeacht hoe ver je het paneel versleept.
  const VIEWER_RESERVED_PX = 792;
  const [isDraggingViewer, setIsDraggingViewer] = useState(false);
  const [viewerWidth, setViewerWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem('leap-chat-viewer-width'));
      return Number.isFinite(stored) && stored >= VIEWER_MIN_PX ? stored : VIEWER_DEFAULT_PX;
    } catch {
      return VIEWER_DEFAULT_PX;
    }
  });

  // Auto-resize van het chat-invoerveld: groeit mee met de tekst tot ~8 regels
  // (max 200px) en gaat daarna scrollen, zodat langere vragen comfortabel passen.
  useEffect(() => {
    const ta = chatInputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [input]);

  // Bewaar de gekozen breedte van het documentpaneel tussen sessies.
  useEffect(() => {
    try { localStorage.setItem('leap-chat-viewer-width', String(Math.round(viewerWidth))); } catch { /* localStorage kan geblokkeerd zijn */ }
  }, [viewerWidth]);

  // Sleep-logica voor de scheiding tussen chat en documentpaneel. De globale
  // luisteraars doen niets tenzij er actief gesleept wordt (draggingViewerRef).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingViewerRef.current) return;
      const cont = splitRef.current;
      if (!cont) return;
      const rect = cont.getBoundingClientRect();
      const raw = rect.right - e.clientX;
      const max = Math.max(VIEWER_MIN_PX, rect.width - VIEWER_RESERVED_PX);
      setViewerWidth(Math.min(Math.max(raw, VIEWER_MIN_PX), max));
    };
    const stop = () => {
      if (!draggingViewerRef.current) return;
      draggingViewerRef.current = false;
      setIsDraggingViewer(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      // Veiligheidsreset als de component tijdens het slepen verdwijnt.
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);
  const { notice: pageNotice, setNotice: setPageNotice, clearNotice: clearPageNotice } = useNotice();

  useEffect(() => {
    const url = activeCourse ? `/api/rag-settings?courseId=${activeCourse}` : '/api/rag-settings';
    fetch(url).then(r => r.ok ? r.json() : null).then(data => {
      if (data) setRagSettings(data);
    }).catch(() => {});
  }, [activeCourse]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!profile) {
        console.error('[CHAT] Profile load timeout after 10 seconds');
        setProfileTimeout(true);
      }
    }, 10000);

    return () => clearTimeout(timer);
  }, [profile]);

  useEffect(() => {
    if (!profile) {
      console.log('[CHAT] Waiting for profile to load...');
      return;
    }
    console.log('[CHAT] Profile loaded, loading conversations');
    loadConversations();
  }, [profile, activeCourse]);

  useEffect(() => {
    if (currentConversationId) {
      loadMessages(currentConversationId);
      setFeedbackError(null);
      setContextStats(null);
      setPendingRetry(null);
    }
  }, [currentConversationId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadConversations = async () => {
    if (!profile) {
      console.log('[CHAT] Profile not yet loaded, skipping conversation load');
      return;
    }

    // Zonder actieve cursus tonen we geen chats (consistent met de andere
    // cursus-gescoorde lijsten). Studenten zien zo alleen de gesprekken die
    // binnen de actieve cursus zijn gevoerd.
    if (!activeCourse) {
      setConversations([]);
      return;
    }

    try {
      console.log('[CHAT] Loading conversations for user:', profile.id, 'course:', activeCourse);

      const { data, error } = await supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('user_id', profile.id)
        .eq('status', 'active')
        .eq('module_type', 'general')
        .eq('course_id', activeCourse)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[CHAT] Error loading conversations:', error);
        setPageNotice({
          kind: 'error',
          message: t('chat.loadConversationsError'),
        });
        return;
      }

      console.log('[CHAT] Loaded conversations:', data?.length || 0);
      setConversations(data || []);
      // Bij cursuswissel kan de geopende conversatie tot een andere cursus
      // behoren. Selecteer alleen een gesprek dat in de huidige (cursus-gefilterde)
      // lijst voorkomt; anders openen we het meest recente gesprek, of wissen we
      // de selectie + berichten als deze cursus nog geen gesprekken heeft.
      const ids = new Set((data || []).map(c => c.id));
      if (data && data.length > 0) {
        if (!currentConversationId || !ids.has(currentConversationId)) {
          setCurrentConversationId(data[0].id);
        }
      } else {
        setCurrentConversationId(null);
        setMessages([]);
      }
    } catch (error) {
      console.error('[CHAT] Unexpected error loading conversations:', error);
      setPageNotice({
        kind: 'error',
        message: t('chat.loadConversationsUnexpected'),
      });
    }
  };

  const loadMessages = async (conversationId: string) => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading messages:', error);
      return;
    }

    setMessages(data.map(msg => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      timestamp: msg.created_at,
      retrievedContext: msg.retrieved_context
    })));
  };

  const createNewConversation = async () => {
    if (!profile) {
      console.error('No profile found');
      setPageNotice({
        kind: 'error',
        message: t('chat.profileNotLoadedRelogin'),
      });
      return;
    }
    // Gesprekken horen bij een cursus; zonder actieve cursus zou een gesprek
    // nergens zichtbaar zijn. Blokkeer het aanmaken met een duidelijke melding.
    if (!activeCourse) {
      setPageNotice({
        kind: 'error',
        message: t('chat.selectCourseFirst'),
      });
      return;
    }

    console.log('Creating conversation for user:', profile.id, 'role:', profile.role);

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        user_id: profile.id,
        title: t('chat.newConversationTitle'),
        module_type: 'general',
        course_id: activeCourse,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating conversation:', error);
      setPageNotice({
        kind: 'error',
        message: t('chat.createConversationFailed', { error: error.message }),
      });
      return;
    }

    console.log('Conversation created:', data);
    setConversations([data, ...conversations]);
    setCurrentConversationId(data.id);
    setMessages([]);
  };

  const handleDelete = async (conversationId: string, generateSummary: boolean) => {
    setDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authHeader = session ? `Bearer ${session.access_token}` : '';

      const res = await fetch('/api/chat/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: JSON.stringify({ conversationId, generateSummary, lang, courseId: activeCourse }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('chat.deleteFailedStatus', { status: String(res.status) }));
      }

      const result = await res.json();

      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (currentConversationId === conversationId) {
        const remaining = conversations.filter(c => c.id !== conversationId);
        setCurrentConversationId(remaining.length > 0 ? remaining[0].id : null);
        if (remaining.length === 0) setMessages([]);
      }
      setDeleteDialog(null);

      if (generateSummary && result.summaryFailed) {
        setPageNotice({
          kind: 'warning',
          message: t('chat.deleteSummaryFailed'),
        });
      }
    } catch (err: any) {
      setPageNotice({ kind: 'error', message: t('chat.deleteError', { error: String(err.message) }) });
    } finally {
      setDeleting(false);
    }
  };

  const handleRequestSource = (s: { documentId?: string; title: string }) => {
    if (!s.documentId) return;
    setDownloadError(null);
    setSourceChoice({ documentId: s.documentId, title: s.title });
  };

  const handleDownloadChoice = () => {
    if (!sourceChoice) return;
    const { documentId } = sourceChoice;
    setSourceChoice(null);
    openRagDocument(documentId).catch((err) => {
      setDownloadError(err?.message || t('chat.openSourceFailed'));
    });
  };

  const handleViewChoice = () => {
    if (!sourceChoice) return;
    // Wis de oude viewer-context meteen zodat een nieuw bericht tijdens het laden
    // van de nieuwe bron niet per ongeluk de vorige pagina/dia meestuurt.
    setViewerContext(null);
    setViewerDoc({ documentId: sourceChoice.documentId, title: sourceChoice.title });
    setSourceChoice(null);
  };

  // Bouwt een korte notitie over wat de student op dit moment in de viewer ziet,
  // zodat het taalmodel daar in zijn antwoord rekening mee kan houden.
  const buildViewerNote = (ctx: ViewerContext | null): string => {
    if (!ctx) return '';
    const isSlides = ctx.sourceType === 'pptx';
    if (lang === 'en') {
      const unit = isSlides ? 'slide' : 'page';
      return `\n\nThe student is currently viewing ${unit} ${ctx.page} of ${ctx.totalPages} of the source "${ctx.title}". Take this into account where relevant.`;
    }
    const unit = isSlides ? 'dia' : 'pagina';
    return `\n\nDe student bekijkt op dit moment ${unit} ${ctx.page} van ${ctx.totalPages} van de bron "${ctx.title}". Betrek dit waar relevant in je antwoord.`;
  };

  const sendToAssistant = async (history: Message[], isFirstMessage: boolean) => {
    if (!currentConversationId || !profile) return;

    setLoading(true);
    setFeedbackError(null);
    setContextStats(null);

    const userContent = history[history.length - 1]?.content ?? '';

    try {
      console.log('[CHAT] Searching for relevant RAG chunks...');
      let chunks: DocumentChunk[] = [];
      let ragStats: {
        threshold: number;
        maxSimilarity: number;
        candidatesConsidered: number;
        searchPerformed: boolean;
      } = {
        threshold: ragSettings.chat.similarity_threshold,
        maxSimilarity: 0,
        candidatesConsidered: 0,
        searchPerformed: false,
      };
      try {
        const stats = await searchRelevantChunksWithStats(
          userContent,
          ragSettings.chat.similarity_threshold,
          ragSettings.chat.match_count,
          'general',
          profile?.role || 'student',
          activeCourse
        );
        chunks = stats.chunks;
        ragStats = {
          threshold: stats.threshold,
          maxSimilarity: stats.maxSimilarity,
          candidatesConsidered: stats.candidatesConsidered,
          searchPerformed: stats.searchPerformed,
        };
        if (chunks.length === 0) {
          console.log('[CHAT] No RAG documents available, using LLM without context');
        } else {
          console.log(`[CHAT] Found ${chunks.length} relevant chunks from RAG`);
        }
      } catch (ragError) {
        console.warn('[CHAT] RAG search failed, continuing without context:', ragError);
      }

      const built = chunks.length > 0
        ? buildContextWithCap(chunks)
        : { context: '', usedChunks: 0, totalChunks: 0, truncated: false, charTrimmed: false };
      const viewerNote = buildViewerNote(viewerContext);
      const context = [built.context, viewerNote].filter(Boolean).join('') || undefined;
      if (built.totalChunks > 0) {
        setContextStats({ used: built.usedChunks, total: built.totalChunks, charTrimmed: built.charTrimmed });
      }
      if (built.truncated) {
        console.log(`[CHAT] Context capped: using ${built.usedChunks}/${built.totalChunks} chunks (${built.context.length} chars)`);
      }

      // Dedupliceer chunks naar maximaal 5 unieke documenten zodat de
      // [1]…[N] in het antwoord overeenkomen met wat de student ziet in
      // de inklapbare bronnenlijst onder het bericht.
      const displaySources: SourceItem[] = dedupeSourcesByDocument(
        chunks.map((c) => ({
          ...chunkToDisplaySource(c),
          href: ragDocumentDownloadUrl(c.documentId),
        })),
        5
      );

      console.log('[CHAT] Sending message to LLM...');
      let response;
      try {
        response = await sendChatMessage(
          history,
          context,
          ragSettings.chat.rag_strict_mode,
          displaySources.length > 0 ? displaySources : undefined,
          learningLevel,
          activeCourse || undefined
        );
      } catch (llmErr) {
        console.error('[CHAT] LLM call failed:', llmErr);
        setFeedbackError(llmErrorToDutch(llmErr, lang));
        setPendingRetry({ history, isFirstMessage });
        return;
      }

      const retrievedContext = {
        chunks,
        displaySources,
        stats: {
          threshold: ragStats.threshold,
          maxSimilarity: ragStats.maxSimilarity,
          candidatesConsidered: ragStats.candidatesConsidered,
          searchPerformed: ragStats.searchPerformed,
        },
      };

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.content,
        timestamp: new Date().toISOString(),
        retrievedContext,
      };

      setMessages(prev => [...prev, assistantMessage]);

      await supabase.from('messages').insert({
        conversation_id: currentConversationId,
        role: 'assistant',
        content: assistantMessage.content,
        retrieved_context: assistantMessage.retrievedContext || {}
      });

      if (isFirstMessage) {
        const title = userContent.slice(0, 50) + (userContent.length > 50 ? '...' : '');
        await supabase
          .from('conversations')
          .update({ title })
          .eq('id', currentConversationId);
        await loadConversations();
      }

      setPendingRetry(null);
    } catch (error: any) {
      console.error('[CHAT] Error sending message:', error);
      setFeedbackError({
        title: t('chat.sendMessageError'),
        detail: error?.message || undefined,
      });
      setPendingRetry({ history, isFirstMessage });
    } finally {
      setLoading(false);
    }
  };

  const handleSendMessage = async (overrideText?: string) => {
    const text = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!text || !currentConversationId || !profile) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };

    const isFirstMessage = messages.length === 0;
    const history: Message[] = [
      ...messages.slice(-10).map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user' as const, content: userMessage.content },
    ];

    setMessages(prev => [...prev, userMessage]);
    setInput('');

    try {
      await supabase.from('messages').insert({
        conversation_id: currentConversationId,
        role: 'user',
        content: userMessage.content
      });
    } catch (e) {
      console.error('[CHAT] insert user message failed:', e);
    }

    await sendToAssistant(history, isFirstMessage);
  };

  const handleRetry = () => {
    if (pendingRetry) {
      sendToAssistant(pendingRetry.history, pendingRetry.isFirstMessage);
    }
  };

  // Task #296: vraag de tutor expliciet om een eerlijk "klaar voor een hoger
  // niveau?"-oordeel. De student initieert dit; de bot doet het nooit uit zichzelf.
  const askReadiness = () => {
    if (loading) return;
    handleSendMessage(t('learningLevel.readinessPrompt'));
  };

  if (!profile) {
    if (profileTimeout) {
      return (
        <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
          <div className="text-center max-w-md mx-auto px-4">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">{t('chat.profileLoadFailed')}</h2>
            <p className="text-gray-600 mb-6">
              {t('chat.profileLoadFailedDetail')}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => window.location.reload()}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg"
              >
                <RefreshCw className="w-5 h-5" />
                {t('chat.refreshPage')}
              </button>
              <button
                onClick={() => signOut()}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all"
              >
                <LogOut className="w-5 h-5" />
                {t('nav.logout')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600 font-medium">{t('chat.profileLoading')}</p>
          <p className="text-sm text-gray-500 mt-2">{t('chat.profileLoadingWait')}</p>
        </div>
      </div>
    );
  }

  return (
    <>
    {pageNotice && (
      <div className="mb-3">
        <NoticeBanner notice={pageNotice} onDismiss={clearPageNotice} />
      </div>
    )}
    <div ref={splitRef} className="h-[calc(100vh-8rem)] flex gap-4">
      <div className="w-64 chic-card p-4 flex flex-col">
        <button
          onClick={createNewConversation}
          disabled={!profile}
          className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg mb-4 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-5 h-5" />
          {t('chat.newChat')}
        </button>

        <div className="mb-3">
          <PromptDebugBadge section="chat" />
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {conversations.map(conv => (
            <div
              key={conv.id}
              className={`group relative flex items-start rounded-lg transition-all ${
                currentConversationId === conv.id
                  ? 'bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 font-medium'
                  : 'hover:bg-gray-100 text-gray-700'
              }`}
            >
              <button
                data-testid={`btn-conversation-${conv.id}`}
                onClick={() => setCurrentConversationId(conv.id)}
                className="flex-1 text-left p-3"
              >
                <div className="flex items-start gap-2">
                  <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span className="text-sm line-clamp-2 pr-6">{conv.title}</span>
                </div>
              </button>
              <button
                data-testid={`btn-delete-${conv.id}`}
                onClick={(e) => { e.stopPropagation(); setDeleteDialog({ conversationId: conv.id, title: conv.title }); }}
                title={t('chat.deleteTitle')}
                className="absolute right-2 top-2.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 text-red-600"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 chic-card flex flex-col">
        {!currentConversationId ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-semibold mb-2">{t('chat.noConversationSelected')}</p>
              <p className="text-sm">{t('chat.startNewToBegin')}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-gray-500 mt-8">
                  <p className="text-lg font-semibold mb-2">{t('chat.startConversation')}</p>
                  <p className="text-sm">{t('chat.askQuestion')}</p>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white'
                        : 'bg-gray-100 text-gray-900'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <AssistantMessageBody
                        messageId={msg.id}
                        content={msg.content}
                        retrievedContext={msg.retrievedContext}
                        onRequestSource={handleRequestSource}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    )}
                    {msg.role === 'assistant' && (() => {
                      const stats = msg.retrievedContext?.stats as
                        | { threshold: number; maxSimilarity: number; candidatesConsidered?: number; searchPerformed?: boolean }
                        | undefined;
                      const chunks = (msg.retrievedContext?.chunks ?? []) as Array<{ similarity?: number | string }>;
                      if (!stats && chunks.length === 0) return null;
                      const fallbackMax = chunks.length > 0
                        ? Math.max(...chunks.map((c) => Number(c.similarity) || 0))
                        : 0;
                      return (
                        <div className="mt-3">
                          <RAGDiagnostics
                            matchCount={chunks.length}
                            threshold={stats?.threshold ?? ragSettings.chat.similarity_threshold}
                            maxSimilarity={stats?.maxSimilarity ?? fallbackMax}
                            candidatesConsidered={stats?.candidatesConsidered}
                            searchPerformed={stats?.searchPerformed ?? true}
                            viewerRole={profile?.role}
                          />
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl px-4 py-3">
                    <div className="flex gap-2">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}

              {feedbackError && !loading && (
                <div
                  className="bg-red-50 border border-red-200 rounded-2xl p-5"
                  data-testid="block-chat-error"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-red-900 mb-1">
                        {t('chat.errorGenerating')}
                      </h3>
                      <p className="text-red-800 text-sm mb-2" data-testid="text-chat-error-title">
                        {feedbackError.title}
                      </p>
                      {feedbackError.detail && (
                        <details className="mb-3 group" data-testid="details-chat-error">
                          <summary className="text-sm text-red-700 cursor-pointer select-none hover:underline">
                            {t('chat.technicalDetails')}
                          </summary>
                          <p
                            className="mt-2 text-xs text-red-700 bg-red-100/60 border border-red-200 rounded-md px-3 py-2 whitespace-pre-wrap font-mono"
                            data-testid="text-chat-error-detail"
                          >
                            {feedbackError.detail}
                          </p>
                        </details>
                      )}
                      {contextStats && contextStats.total > 0 && (
                        <p
                          className="text-xs text-red-700 mb-3"
                          data-testid="text-chat-context-stats-error"
                        >
                          {contextStats.used < contextStats.total
                            ? t('chat.contextStatsPartialError', { used: String(contextStats.used), total: String(contextStats.total) })
                            : contextStats.charTrimmed
                              ? t('chat.contextStatsTrimmedError', { total: String(contextStats.total) })
                              : t('chat.contextStatsAllError', { total: String(contextStats.total) })}
                        </p>
                      )}
                      <button
                        onClick={handleRetry}
                        disabled={loading || !pendingRetry}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed font-medium text-sm"
                        data-testid="button-chat-retry"
                      >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        {t('chat.retry')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {!feedbackError && contextStats && contextStats.total > 0 && (contextStats.used < contextStats.total || contextStats.charTrimmed) && (
                <div className="flex justify-start">
                  <p
                    className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 max-w-[80%]"
                    data-testid="text-chat-context-stats"
                  >
                    {contextStats.used < contextStats.total
                      ? t('chat.contextStatsPartialNote', { used: String(contextStats.used), total: String(contextStats.total) })
                      : t('chat.contextStatsTrimmedNote', { total: String(contextStats.total) })}
                  </p>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-gray-200 p-4">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <RAGStatusIndicator strictMode={ragSettings.chat.rag_strict_mode} />
                <div className="flex items-end gap-2 ml-auto">
                  <LearningLevelSelector
                    value={learningLevel}
                    onChange={setLearningLevel}
                    compact
                    className="min-w-[240px]"
                  />
                  <button
                    type="button"
                    onClick={askReadiness}
                    disabled={loading}
                    title={t('learningLevel.readinessHint')}
                    className="px-3 py-1.5 text-xs rounded-md border border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                    data-testid="button-readiness-chat"
                  >
                    <TrendingUp className="w-3.5 h-3.5" />
                    {t('learningLevel.readinessButton')}
                  </button>
                </div>
              </div>
              <div className="flex gap-3 items-end">
                <textarea
                  ref={chatInputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!loading) handleSendMessage();
                    }
                  }}
                  placeholder={t('chat.inputPlaceholder')}
                  aria-label={t('chat.inputPlaceholder')}
                  rows={3}
                  className="flex-1 px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none resize-none leading-relaxed min-h-[88px] max-h-[200px] overflow-y-auto"
                  disabled={loading}
                  data-testid="input-chat-message"
                />
                <button
                  onClick={() => handleSendMessage()}
                  disabled={loading || !input.trim()}
                  className="px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {viewerDoc && (
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            draggingViewerRef.current = true;
            setIsDraggingViewer(true);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
          }}
          onDoubleClick={() => setViewerWidth(VIEWER_DEFAULT_PX)}
          role="separator"
          aria-orientation="vertical"
          title={t('chat.viewerResizeHint')}
          className="hidden md:flex w-2 shrink-0 cursor-col-resize items-center justify-center group touch-none"
          data-testid="divider-document-viewer"
        >
          <div className="h-16 w-1 rounded-full bg-gray-300 group-hover:bg-green-500 transition-colors" />
        </div>
      )}

      {viewerDoc && (
        <div
          className="flex shrink-0 chic-card flex-col overflow-hidden p-0"
          style={{ width: viewerWidth, minWidth: VIEWER_MIN_PX, maxWidth: `calc(100% - ${VIEWER_RESERVED_PX}px)` }}
          data-testid="panel-document-viewer"
        >
          <ViewerErrorBoundary
            key={viewerDoc.documentId}
            documentId={viewerDoc.documentId}
            labels={{
              closeViewer: t('docViewer.closeViewer'),
              cannotDisplay: t('docViewer.cannotDisplay'),
              downloadInstead: t('docViewer.downloadInstead'),
            }}
            onClose={() => { setViewerDoc(null); setViewerContext(null); }}
          >
            <DocumentViewer
              documentId={viewerDoc.documentId}
              title={viewerDoc.title}
              lang={lang}
              onClose={() => { setViewerDoc(null); setViewerContext(null); }}
              onContextChange={setViewerContext}
            />
          </ViewerErrorBoundary>
        </div>
      )}
    </div>

    {isDraggingViewer && (
      <div className="fixed inset-0 z-[60] cursor-col-resize" data-testid="overlay-viewer-resize" />
    )}

    {downloadError && (
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg" data-testid="alert-download-error">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <span className="flex-1 leading-snug">{downloadError}</span>
        <button
          type="button"
          onClick={() => setDownloadError(null)}
          className="shrink-0 rounded px-2 py-0.5 text-xs font-semibold hover:bg-amber-100"
          data-testid="btn-dismiss-download-error"
        >
          ×
        </button>
      </div>
    )}

    {sourceChoice && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSourceChoice(null)}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-100 rounded-xl">
              <FileText className="w-5 h-5 text-blue-700" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">
              {t('chat.openSourceTitle')}
            </h2>
            <button
              onClick={() => setSourceChoice(null)}
              className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
              data-testid="btn-source-choice-cancel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-gray-600 mb-1">
            {t('chat.openSourceQuestion')}
          </p>
          <p className="text-sm font-medium text-gray-800 mb-5 truncate" title={sourceChoice.title}>
            {sourceChoice.title}
          </p>

          <div className="flex flex-col gap-3">
            <button
              data-testid="btn-source-choice-view"
              onClick={handleViewChoice}
              className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-indigo-700 transition-all shadow-md"
            >
              <Eye className="w-4 h-4" />
              {t('chat.viewInChat')}
            </button>
            <button
              data-testid="btn-source-choice-download"
              onClick={handleDownloadChoice}
              className="flex items-center justify-center gap-2 w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all"
            >
              <Download className="w-4 h-4" />
              {t('chat.download')}
            </button>
          </div>
        </div>
      </div>
    )}

    {deleteDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-red-100 rounded-xl">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">{t('chat.deleteTitle')}</h2>
            <button
              onClick={() => !deleting && setDeleteDialog(null)}
              className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
              data-testid="btn-delete-cancel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-gray-600 mb-2">
            {t('chat.deleteClosingText').replace('{title}', deleteDialog.title)}
          </p>
          <p className="text-sm text-gray-600 mb-6">
            {t('chat.deleteAskSummary')}
          </p>

          <div className="flex flex-col gap-3">
            <button
              data-testid="btn-delete-with-summary"
              onClick={() => handleDelete(deleteDialog.conversationId, true)}
              disabled={deleting}
              className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
              {t('chat.deleteWithSummary')}
            </button>

            <button
              data-testid="btn-delete-without-summary"
              onClick={() => handleDelete(deleteDialog.conversationId, false)}
              disabled={deleting}
              className="w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('chat.deleteWithoutSummary')}
            </button>

            <button
              data-testid="btn-delete-dismiss"
              onClick={() => setDeleteDialog(null)}
              disabled={deleting}
              className="w-full px-4 py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              {t('chat.cancel')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
