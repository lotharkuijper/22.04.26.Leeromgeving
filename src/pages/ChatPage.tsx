import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { sendChatMessage, type Message } from '../services/llm.service';
import { searchRelevantChunks, formatContextFromChunks } from '../services/rag.service';
import { SourceList } from '../components/SourceList';
import { Send, MessageSquare, Plus, AlertCircle, RefreshCw, LogOut, BookText, X, Loader2 } from 'lucide-react';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';


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
  explain: { similarity_threshold: 0.70, match_count: 5, rag_strict_mode: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true  },
  project: { similarity_threshold: 0.60, match_count: 7, rag_strict_mode: false },
};

export function ChatPage() {
  const { profile, signOut } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [profileTimeout, setProfileTimeout] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState<{ conversationId: string; title: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [ragSettings, setRagSettings] = useState<RagSettings>(RAG_DEFAULTS);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
  }, [profile]);

  useEffect(() => {
    if (currentConversationId) {
      loadMessages(currentConversationId);
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

    try {
      console.log('[CHAT] Loading conversations for user:', profile.id);

      const { data, error } = await supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('user_id', profile.id)
        .eq('status', 'active')
        .eq('module_type', 'general')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[CHAT] Error loading conversations:', error);
        alert('Kon conversaties niet laden. Probeer de pagina te vernieuwen.');
        return;
      }

      console.log('[CHAT] Loaded conversations:', data?.length || 0);
      setConversations(data || []);
      if (data && data.length > 0 && !currentConversationId) {
        setCurrentConversationId(data[0].id);
      }
    } catch (error) {
      console.error('[CHAT] Unexpected error loading conversations:', error);
      alert('Er is een onverwachte fout opgetreden bij het laden van conversaties.');
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
      alert('Je profiel is niet geladen. Probeer opnieuw in te loggen.');
      return;
    }

    console.log('Creating conversation for user:', profile.id, 'role:', profile.role);

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        user_id: profile.id,
        title: 'Nieuwe conversatie',
        module_type: 'general'
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating conversation:', error);
      alert(`Kon geen conversatie aanmaken: ${error.message}`);
      return;
    }

    console.log('Conversation created:', data);
    setConversations([data, ...conversations]);
    setCurrentConversationId(data.id);
    setMessages([]);
  };

  const handleArchive = async (conversationId: string, generateSummary: boolean) => {
    setArchiving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authHeader = session ? `Bearer ${session.access_token}` : '';

      const res = await fetch('/api/chat/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: JSON.stringify({ conversationId, generateSummary }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Archiveren mislukt (${res.status})`);
      }

      const result = await res.json();

      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (currentConversationId === conversationId) {
        const remaining = conversations.filter(c => c.id !== conversationId);
        setCurrentConversationId(remaining.length > 0 ? remaining[0].id : null);
        if (remaining.length === 0) setMessages([]);
      }
      setArchiveDialog(null);

      if (generateSummary && result.summaryFailed) {
        alert('Het gesprek is afgesloten, maar de samenvatting kon niet worden opgeslagen in je leerdagboek. Probeer het later opnieuw.');
      }
    } catch (err: any) {
      alert(`Fout bij archiveren: ${err.message}`);
    } finally {
      setArchiving(false);
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() || !currentConversationId || !profile) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      await supabase.from('messages').insert({
        conversation_id: currentConversationId,
        role: 'user',
        content: userMessage.content
      });

      console.log('[CHAT] Searching for relevant RAG chunks...');
      let chunks = [];
try {
  chunks = await searchRelevantChunks(
    userMessage.content,
    ragSettings.chat.similarity_threshold,
    ragSettings.chat.match_count,
    'general',
    profile?.role || 'student',
    activeCourse
  );

  if (chunks.length === 0) {
    console.log('[CHAT] No RAG documents available, using LLM without context');
    if (typeof setRagAvailable === "function") {
      setRagAvailable(false);
    }
  } else {
    console.log(`[CHAT] Found ${chunks.length} relevant chunks from RAG`);
    if (typeof setRagAvailable === "function") {
      setRagAvailable(true);
    }
  }

} catch (ragError) {
  console.warn('[CHAT] RAG search failed, continuing without context:', ragError);
  if (typeof setRagAvailable === "function") {
    setRagAvailable(false);
  }
}

      const context = chunks.length > 0 ? formatContextFromChunks(chunks) : undefined;

      const conversationHistory: Message[] = messages
        .slice(-10)
        .map(msg => ({ role: msg.role, content: msg.content }));

      console.log('[CHAT] Sending message to LLM...');
      const response = await sendChatMessage(
        [...conversationHistory, { role: 'user', content: userMessage.content }],
        context,
        ragSettings.chat.rag_strict_mode
      );

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.content,
        timestamp: new Date().toISOString(),
        retrievedContext: chunks.length > 0 ? { chunks } : undefined
      };

      setMessages(prev => [...prev, assistantMessage]);

      await supabase.from('messages').insert({
        conversation_id: currentConversationId,
        role: 'assistant',
        content: assistantMessage.content,
        retrieved_context: assistantMessage.retrievedContext || {}
      });

      if (messages.length === 0) {
        const title = userMessage.content.slice(0, 50) + (userMessage.content.length > 50 ? '...' : '');
        await supabase
          .from('conversations')
          .update({ title })
          .eq('id', currentConversationId);
        await loadConversations();
      }
    } catch (error: any) {
      console.error('[CHAT] Error sending message:', error);
      const errorMessage = error?.message || 'Onbekende fout';
      console.error('[CHAT] Error details:', errorMessage);
      alert(`Er is een fout opgetreden bij het versturen van het bericht.\n\nDetails: ${errorMessage}\n\nProbeer het opnieuw.`);
    } finally {
      setLoading(false);
    }
  };

  if (!profile) {
    if (profileTimeout) {
      return (
        <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
          <div className="text-center max-w-md mx-auto px-4">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Profiel kon niet worden geladen</h2>
            <p className="text-gray-600 mb-6">
              Er is iets misgegaan bij het laden van je profiel. Dit kan komen door een verbindingsprobleem of een technisch probleem.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => window.location.reload()}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg"
              >
                <RefreshCw className="w-5 h-5" />
                Vernieuw pagina
              </button>
              <button
                onClick={() => signOut()}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all"
              >
                <LogOut className="w-5 h-5" />
                Uitloggen
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
          <p className="text-gray-600 font-medium">Je profiel wordt geladen...</p>
          <p className="text-sm text-gray-500 mt-2">Een moment geduld</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="h-[calc(100vh-8rem)] flex gap-4">
      <div className="w-64 bg-white rounded-2xl border border-gray-200 p-4 flex flex-col">
        <button
          onClick={createNewConversation}
          disabled={!profile}
          className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg mb-4 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-5 h-5" />
          Nieuwe Chat
        </button>

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
                data-testid={`btn-archive-${conv.id}`}
                onClick={(e) => { e.stopPropagation(); setArchiveDialog({ conversationId: conv.id, title: conv.title }); }}
                title="Verplaats naar leerdagboek"
                className="absolute right-2 top-2.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-green-200 text-green-700"
              >
                <BookText className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 bg-white rounded-2xl border border-gray-200 flex flex-col">
        {!currentConversationId ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-semibold mb-2">Geen conversatie geselecteerd</p>
              <p className="text-sm">Start een nieuwe chat om te beginnen</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-gray-500 mt-8">
                  <p className="text-lg font-semibold mb-2">Start een gesprek</p>
                  <p className="text-sm">Stel een vraag over epidemiologie of biostatistiek</p>
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
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    {msg.retrievedContext?.chunks && msg.retrievedContext.chunks.length > 0 && (
                      <SourceList
                        sources={msg.retrievedContext.chunks.map((c: any) => ({ title: c.documentTitle, similarity: c.similarity }))}
                        label="Bronnen uit cursusmateriaal"
                      />
                    )}
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

              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-gray-200 p-4">
              <div className="mb-3">
                <RAGStatusIndicator />
              </div>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && !loading && handleSendMessage()}
                  placeholder="Stel een vraag..."
                  className="flex-1 px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none"
                  disabled={loading}
                />
                <button
                  onClick={handleSendMessage}
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
    </div>

    {archiveDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-100 rounded-xl">
              <BookText className="w-5 h-5 text-green-700" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">Verplaats naar leerdagboek</h2>
            <button
              onClick={() => !archiving && setArchiveDialog(null)}
              className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500"
              data-testid="btn-archive-cancel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-gray-600 mb-2">
            Je staat op het punt het gesprek <strong>"{archiveDialog.title}"</strong> af te sluiten.
          </p>
          <p className="text-sm text-gray-600 mb-6">
            Wil je dat de leerassistent een formatieve samenvatting van dit gesprek opslaat in je leerdagboek? Die samenvatting kun je later bekijken om op te reflecteren.
          </p>

          <div className="flex flex-col gap-3">
            <button
              data-testid="btn-archive-with-summary"
              onClick={() => handleArchive(archiveDialog.conversationId, true)}
              disabled={archiving}
              className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
              Samenvatting opslaan en gesprek afsluiten
            </button>

            <button
              data-testid="btn-archive-without-summary"
              onClick={() => handleArchive(archiveDialog.conversationId, false)}
              disabled={archiving}
              className="w-full px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Alleen afsluiten (geen dagboekvermelding)
            </button>

            <button
              data-testid="btn-archive-dismiss"
              onClick={() => setArchiveDialog(null)}
              disabled={archiving}
              className="w-full px-4 py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              Annuleren
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
