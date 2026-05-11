import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  ArrowLeft, Send, Users, MessageCircle, Bot, CheckCircle2,
  Flag, Clipboard, Copy, Loader2, BookOpen, Paperclip, Trash2, FileText, ShieldAlert, Download, Database, EyeOff,
} from 'lucide-react';

interface Persona {
  id: string;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  _source: 'project' | 'course' | 'default';
}
interface GroupMember {
  id: string;
  user_id: string;
  role: string;
  profiles: { id: string; full_name: string | null; email: string };
}
interface Project {
  id: string;
  title: string;
  briefing_markdown: string | null;
  rubric_criteria: any[];
  research_question: string;
}
interface ProjectGroup {
  id: string;
  name: string;
  invite_code: string;
  status: 'active' | 'finalized' | 'archived';
  finalized_at: string | null;
}
interface ChatMsg {
  id: string;
  group_id: string;
  user_id: string | null;
  body: string;
  reactions: Record<string, string[]>;
  created_at: string;
  profiles?: { full_name: string | null; email: string } | null;
}
interface PersonaMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  user_id: string | null;
}
interface Checkpoint {
  id: string;
  kind: 'checkpoint' | 'final';
  reflection: string;
  ai_summary: string | null;
  rubric_feedback: any;
  created_at: string;
}
interface PersonaDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  uploaded_by: string | null;
  created_at: string;
}
interface PreviewThread {
  threadId: string;
  personaId: string;
  personaName: string;
  avatarEmoji: string;
  studentSummary: string;
  personaSummary: string;
}

interface ProjectMaterialDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  mime_type?: string | null;
  document_ref_id?: string | null;
  is_visible_to_students: boolean;
  created_at: string;
}

const QUICK_REACTIONS = ['👍', '❤️', '🤔', '✅'];

export function ProjectRoomPage() {
  const { projectId, groupId } = useParams<{ projectId: string; groupId: string }>();
  const { profile, session, isAdmin, isDocent } = useAuth();
  const navigate = useNavigate();
  const isStaff = isAdmin || isDocent;

  const [project, setProject] = useState<Project | null>(null);
  const [group, setGroup] = useState<ProjectGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [personaMessages, setPersonaMessages] = useState<PersonaMsg[]>([]);
  const [personaInput, setPersonaInput] = useState('');
  const [personaLoading, setPersonaLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [showCheckpointModal, setShowCheckpointModal] = useState<null | 'checkpoint' | 'final'>(null);
  const [reflection, setReflection] = useState('');
  const [submittingCheckpoint, setSubmittingCheckpoint] = useState(false);
  // Stabiele requestId per checkpoint-poging: pas resetten na succesvolle
  // submit, zodat netwerk-retries van dezelfde knopdruk dedupeer-baar blijven.
  const [checkpointRequestId, setCheckpointRequestId] = useState<string | null>(null);
  const [checkpointPreview, setCheckpointPreview] = useState<PreviewThread[] | null>(null);
  const [checkpointPreviewLoading, setCheckpointPreviewLoading] = useState(false);
  const [checkpointPreviewError, setCheckpointPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [personaDocs, setPersonaDocs] = useState<PersonaDoc[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [projectMaterials, setProjectMaterials] = useState<ProjectMaterialDoc[]>([]);
  const [bestandenOpen, setBestandenOpen] = useState(false);
  const [hasEvaluator, setHasEvaluator] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluateRequestId, setEvaluateRequestId] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const personaInputRef = useRef<HTMLTextAreaElement>(null);
  const personaScrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const token = session?.access_token;

  const loadRoom = useCallback(async () => {
    if (!token || !projectId || !groupId) return;
    setLoadingRoom(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/room?groupId=${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        setError((await r.json()).error || 'Kon projectruimte niet laden');
        return;
      }
      const data = await r.json();
      setProject(data.project);
      setGroup(data.group);
      setMembers(data.members || []);
      setPersonas(data.personas || []);
      setCheckpoints(data.checkpoints || []);
      setProjectMaterials(data.projectDocuments || []);
      setHasEvaluator(!!data.hasEvaluator);
      if (!activePersonaId && data.personas?.length > 0) {
        setActivePersonaId(data.personas[0].id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingRoom(false);
    }
  }, [token, projectId, groupId, activePersonaId]);

  useEffect(() => { loadRoom(); }, [loadRoom]);

  // Reset thread + active persona als groep wisselt — voorkomt dat berichten
  // van een vorige groep blijven hangen bij snel navigeren.
  useEffect(() => {
    setPersonaMessages([]);
    setActivePersonaId(null);
  }, [groupId]);

  // Load persona thread berichten als active persona verandert. Cancel-guard
  // tegen stale responses bij snelle persona-wissels.
  useEffect(() => {
    if (!token || !groupId || !activePersonaId) return;
    let cancelled = false;
    setPersonaMessages([]);
    fetch(`/api/projects/persona-thread?groupId=${groupId}&personaId=${activePersonaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) setPersonaMessages(d.messages || []); })
      .catch(() => { /* genegeerd — UI valt terug op leeg */ });
    return () => { cancelled = true; };
  }, [token, groupId, activePersonaId]);

  // Documenten van de actieve persona ophalen.
  const loadPersonaDocs = useCallback(async () => {
    if (!token || !projectId || !groupId || !activePersonaId || activePersonaId === '__default__') {
      setPersonaDocs([]); return;
    }
    try {
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents?groupId=${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (r.ok) setPersonaDocs(d.documents || []);
    } catch { /* stil */ }
  }, [token, projectId, groupId, activePersonaId]);
  useEffect(() => { loadPersonaDocs(); }, [loadPersonaDocs]);

  const uploadFile = async (file: File) => {
    if (!token || !projectId || !activePersonaId || activePersonaId === '__default__') {
      setError('Voeg eerst een echte persona toe in het beheerpaneel.');
      return;
    }
    const ALLOWED = /\.(txt|md|markdown|csv|tsv|json|log|pdf|docx|pptx|xlsx|odt|ods|odp)$/i;
    if (!ALLOWED.test(file.name)) {
      setError('Ondersteunde formaten: .txt, .md, .csv, .tsv, .json, .pdf, .docx, .pptx, .xlsx, .odt, .ods, .odp.');
      return;
    }
    if (file.size > 15_000_000) {
      setError('Bestand is groter dan 15 MB.');
      return;
    }
    setUploadingDoc(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('groupId', groupId!);
      fd.append('file', file, file.name);
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload mislukt');
      setPersonaDocs(prev => [d.document, ...prev]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploadingDoc(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteDoc = async (doc: PersonaDoc) => {
    if (!token || !projectId || !activePersonaId) return;
    if (!confirm(`Verwijder "${doc.filename}"?`)) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents/${doc.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Verwijderen mislukt');
      }
      setPersonaDocs(prev => prev.filter(d => d.id !== doc.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Initial load groepschat + realtime subscription.
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('group_chat_messages')
        .select('id, group_id, user_id, body, reactions, created_at, profiles(full_name, email)')
        .eq('group_id', groupId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (!cancelled) setChatMessages((data as any) || []);
    })();

    const channel = supabase
      .channel(`group-chat-${groupId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'group_chat_messages',
        filter: `group_id=eq.${groupId}`,
      }, async (payload) => {
        // Profielnaam erbij ophalen.
        const m = payload.new as any;
        let profileData = null;
        if (m.user_id) {
          const { data: p } = await supabase
            .from('profiles').select('full_name, email').eq('id', m.user_id).maybeSingle();
          profileData = p;
        }
        setChatMessages(prev => prev.find(x => x.id === m.id) ? prev : [...prev, { ...m, profiles: profileData }]);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'group_chat_messages',
        filter: `group_id=eq.${groupId}`,
      }, (payload) => {
        const m = payload.new as any;
        setChatMessages(prev => prev.map(x => x.id === m.id ? { ...x, reactions: m.reactions, body: m.body } : x));
      })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [groupId]);

  useEffect(() => {
    personaScrollRef.current?.scrollTo({ top: personaScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [personaMessages]);
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages]);

  const downloadMaterial = async (d: ProjectMaterialDoc) => {
    if (!projectId || !token) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/documents/${d.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Download mislukt');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e.message || 'Download mislukt');
    }
  };

  const sendPersona = async () => {
    if (!personaInput.trim() || !activePersonaId || !groupId || !token) return;
    const text = personaInput.trim();
    setPersonaInput('');
    const tempId = `local-${Date.now()}`;
    setPersonaMessages(prev => [...prev, {
      id: tempId, role: 'user', content: text,
      created_at: new Date().toISOString(), user_id: profile?.id || null,
    }]);
    setPersonaLoading(true);
    try {
      const r = await fetch('/api/projects/persona-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ groupId, personaId: activePersonaId, message: text }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Persona-chat mislukt');
      setPersonaMessages(prev => [...prev, {
        id: `reply-${Date.now()}`, role: 'assistant', content: data.reply,
        created_at: new Date().toISOString(), user_id: null,
      }]);
    } catch (e: any) {
      setPersonaMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant',
        content: `Fout: ${e.message}`, created_at: new Date().toISOString(), user_id: null,
      }]);
    } finally {
      setPersonaLoading(false);
    }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || !groupId || !profile?.id) return;
    const body = chatInput.trim();
    setChatInput('');
    const { error: insErr } = await supabase
      .from('group_chat_messages')
      .insert({ group_id: groupId, user_id: profile.id, body });
    if (insErr) setError(insErr.message);
  };

  const addReaction = async (msg: ChatMsg, emoji: string) => {
    if (!profile?.id) return;
    // Race-mitigatie: lees de huidige reactions uit de DB vlak voor de write
    // zodat parallelle reacties van groepsgenoten niet stiekem overschreven
    // worden. Dit is een best-effort patch (echte atomicity vereist een RPC).
    const { data: latest } = await supabase
      .from('group_chat_messages')
      .select('reactions').eq('id', msg.id).maybeSingle();
    const reactions: Record<string, string[]> = { ...((latest?.reactions as any) || msg.reactions || {}) };
    const list = new Set(reactions[emoji] || []);
    if (list.has(profile.id)) list.delete(profile.id); else list.add(profile.id);
    if (list.size === 0) delete reactions[emoji]; else reactions[emoji] = [...list];
    await supabase.from('group_chat_messages').update({ reactions }).eq('id', msg.id);
  };

  const openCheckpoint = async (kind: 'checkpoint' | 'final') => {
    setShowCheckpointModal(kind);
    setCheckpointPreviewError(null);
    if (kind === 'checkpoint') {
      setCheckpointPreview(null);
      setCheckpointPreviewLoading(true);
      try {
        const r = await fetch(`/api/projects/groups/${groupId}/checkpoint-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Preview ophalen mislukt');
        setCheckpointPreview(data.threads || []);
      } catch (e: any) {
        setCheckpointPreviewError(e.message);
      } finally {
        setCheckpointPreviewLoading(false);
      }
    }
  };

  const updatePreviewSummary = (threadId: string, field: 'studentSummary' | 'personaSummary', value: string) => {
    setCheckpointPreview(prev => prev ? prev.map(t => t.threadId === threadId ? { ...t, [field]: value } : t) : prev);
  };

  const submitCheckpoint = async () => {
    if (!showCheckpointModal || !groupId || !token) return;
    // kind='final' vereist handmatige reflectie; kind='checkpoint' gebruikt de preview.
    if (showCheckpointModal === 'final' && reflection.trim().length < 20) {
      setError('Schrijf een reflectie van minimaal 20 tekens.');
      return;
    }
    setSubmittingCheckpoint(true);
    setError(null);
    try {
      const requestId = checkpointRequestId || (
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      if (!checkpointRequestId) setCheckpointRequestId(requestId);

      const body: Record<string, unknown> = { kind: showCheckpointModal, requestId };
      if (showCheckpointModal === 'final') {
        body.reflection = reflection.trim();
      } else {
        // kind='checkpoint': altijd personaSummaries sturen; knop is verborgen als preview leeg is.
        if (!checkpointPreview || checkpointPreview.length === 0) {
          throw new Error('Geen gesprekken om op te slaan.');
        }
        body.personaSummaries = checkpointPreview;
      }

      const r = await fetch(`/api/projects/groups/${groupId}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Checkpoint mislukt');
      setCheckpoints(prev => [data.checkpoint, ...prev]);
      setShowCheckpointModal(null);
      setReflection('');
      setCheckpointPreview(null);
      setCheckpointRequestId(null);
      const added = Number(data.threadSummariesAdded || 0);
      if (added > 0) {
        const word = added === 1 ? 'gesprekssamenvatting' : 'gesprekssamenvattingen';
        setInfo(`Checkpoint opgeslagen — ${added} ${word} toegevoegd aan jullie leerdagboeken.`);
        setTimeout(() => setInfo(null), 6000);
      } else {
        setInfo('Checkpoint opgeslagen.');
        setTimeout(() => setInfo(null), 4000);
      }
      if (data.checkpoint?.kind === 'final') loadRoom();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmittingCheckpoint(false);
    }
  };

  const copyInvite = () => {
    if (!group) return;
    navigator.clipboard.writeText(group.invite_code);
  };

  const requestEvaluation = async () => {
    if (!groupId || !token) return;
    if (!confirm('Vraag je een formatieve beoordeling aan? De beoordelaar leest jullie gesprekken en zet feedback in elk leerdagboek.')) return;
    setEvaluating(true);
    setError(null);
    try {
      const requestId = evaluateRequestId || (
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      if (!evaluateRequestId) setEvaluateRequestId(requestId);
      const r = await fetch(`/api/projects/groups/${groupId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Beoordeling mislukt');
      const okCount = (data.results || []).filter((x: any) => x.ok).length;
      setInfo(okCount > 0
        ? `Beoordeling klaar — ${okCount} feedback-rapport(en) staan in jullie leerdagboeken.`
        : 'Beoordeling voltooid maar er kwam geen feedback terug.');
      setTimeout(() => setInfo(null), 7000);
      setEvaluateRequestId(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setEvaluating(false);
    }
  };

  // Auto-resize textarea: groei tot ~6 regels (≈ 144px), daarna scrollen.
  useEffect(() => {
    const ta = personaInputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = 144;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [personaInput]);

  const activePersona = personas.find(p => p.id === activePersonaId);
  const isFinalized = group?.status === 'finalized';

  if (loadingRoom && !project) {
    return <div className="p-12 text-center text-gray-500">Laden…</div>;
  }
  if (!project || !group) {
    return (
      <div className="p-12 text-center">
        <p className="text-red-600 mb-4">{error || 'Projectruimte niet gevonden'}</p>
        <Link to="/projects" className="text-blue-600 hover:underline">← Terug naar projecten</Link>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/projects')} className="p-2 hover:bg-gray-100 rounded-lg" data-testid="button-back-projects">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-bold text-gray-900 truncate" data-testid="text-project-title">{project.title}</h1>
            <p className="text-xs text-gray-500 truncate">{group.name}{isFinalized && ' · afgesloten'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={copyInvite} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 rounded-lg text-xs font-mono" title="Kopieer invite-code" data-testid="button-copy-invite">
            <Copy className="w-3.5 h-3.5" />
            {group.invite_code}
          </button>
          <span className="flex items-center gap-1 text-gray-600 text-xs">
            <Users className="w-4 h-4" />{members.length}
          </span>
          {!isFinalized && (
            <>
              <button
                onClick={() => openCheckpoint('checkpoint')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-xs font-medium"
                data-testid="button-open-checkpoint"
              >
                <CheckCircle2 className="w-4 h-4" /> Checkpoint
              </button>
              <button
                onClick={() => openCheckpoint('final')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white hover:bg-green-700 rounded-lg text-xs font-medium"
                data-testid="button-open-finalize"
              >
                <Flag className="w-4 h-4" /> Afronden
              </button>
            </>
          )}
          {hasEvaluator && (
            <button
              onClick={requestEvaluation}
              disabled={evaluating}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 rounded-lg text-xs font-medium"
              data-testid="button-request-evaluation"
              title="Vraag de beoordelaar om formatieve feedback op jullie gesprekken"
            >
              {evaluating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
              {evaluating ? 'Beoordeelt…' : 'Beoordeling opvragen'}
            </button>
          )}
        </div>
      </div>

      {/* 3-column body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0">
        {/* LEFT: persona-chat */}
        <div className="lg:col-span-7 flex flex-col bg-white rounded-xl border border-gray-200 min-h-0">
          <div className="border-b border-gray-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="persona-select" className="text-xs font-medium text-gray-600 flex items-center gap-1">
                <Bot className="w-4 h-4" /> Persona
              </label>
              <select
                id="persona-select"
                value={activePersonaId || ''}
                onChange={e => setActivePersonaId(e.target.value || null)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="select-persona"
              >
                {personas.length === 0 && <option value="">(geen persona's beschikbaar)</option>}
                {personas.map(p => (
                  <option key={p.id} value={p.id} data-testid={`option-persona-${p.id}`}>
                    {(p.avatar_emoji || '🤖')} {p.name}
                  </option>
                ))}
              </select>
            </div>
            {activePersona && activePersonaId !== '__default__' && (
              <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="text-gray-500">Documenten ({personaDocs.length}):</span>
                  {personaDocs.length === 0 && <span className="italic text-gray-400">geen</span>}
                  {personaDocs.map(d => (
                    <span key={d.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded" data-testid={`doc-${d.id}`}>
                      <FileText className="w-3 h-3" />
                      <span className="max-w-[120px] truncate" title={d.filename}>{d.filename}</span>
                      <button onClick={() => deleteDoc(d)} className="text-red-500 hover:text-red-700" title="Verwijder" data-testid={`button-delete-doc-${d.id}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <label className={`inline-flex items-center gap-1 px-2 py-1 rounded cursor-pointer ${uploadingDoc ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}>
                  {uploadingDoc ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
                  Upload
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.pdf,.docx,.pptx,.xlsx,.odt,.ods,.odp"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
                    disabled={uploadingDoc || isFinalized}
                    data-testid="input-upload-doc"
                  />
                </label>
              </div>
            )}
          </div>
          <div ref={personaScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {personaMessages.length === 0 && activePersona && (
              <div className="text-center text-gray-500 text-sm py-8">
                <Bot className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                Begin een gesprek met <strong>{activePersona.name}</strong>.
              </div>
            )}
            {personaMessages.map(m => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
                    m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
                  }`}
                  data-testid={`msg-persona-${m.id}`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {personaLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-4 py-2 rounded-2xl text-sm text-gray-500 flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> denkt na…
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-gray-200 p-3">
            <div className="flex gap-2 items-end">
              <textarea
                ref={personaInputRef}
                value={personaInput}
                onChange={e => setPersonaInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendPersona();
                  }
                }}
                placeholder={activePersona ? `Vraag iets aan ${activePersona.name}… (Shift+Enter = nieuwe regel)` : 'Kies eerst een persona'}
                disabled={!activePersona || personaLoading || isFinalized}
                rows={6}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50 resize-none leading-snug min-h-[150px] max-h-[300px]"
                data-testid="input-persona-message"
              />
              <button
                onClick={sendPersona}
                disabled={!personaInput.trim() || personaLoading || isFinalized}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40"
                data-testid="button-send-persona"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT col container: groepschat + briefing/checkpoints */}
        <div className="lg:col-span-5 flex flex-col gap-3 min-h-0">
          {/* Groepschat */}
          <div className="flex-1 flex flex-col bg-white rounded-xl border border-gray-200 min-h-0">
            <div className="border-b border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 flex items-center gap-2">
              <MessageCircle className="w-4 h-4" /> Groepschat
            </div>
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
              {chatMessages.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">Nog geen berichten — start het gesprek met je groep.</p>
              )}
              {chatMessages.map(m => {
                const isMe = m.user_id === profile?.id;
                const author = m.profiles?.full_name || m.profiles?.email?.split('@')[0] || 'iemand';
                return (
                  <div key={m.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <div className="text-[10px] text-gray-400 mb-0.5">{isMe ? 'jij' : author}</div>
                    <div className={`group max-w-[85%] px-3 py-2 rounded-2xl text-sm ${isMe ? 'bg-blue-100 text-blue-950' : 'bg-gray-100 text-gray-900'}`} data-testid={`msg-chat-${m.id}`}>
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      <div className="flex items-center gap-1 mt-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        {QUICK_REACTIONS.map(emoji => {
                          const reactors = m.reactions?.[emoji] || [];
                          const active = reactors.includes(profile?.id || '');
                          return (
                            <button
                              key={emoji}
                              onClick={() => addReaction(m, emoji)}
                              className={`text-xs px-1.5 py-0.5 rounded ${active ? 'bg-white shadow-sm' : 'hover:bg-white/50'}`}
                              data-testid={`button-react-${emoji}-${m.id}`}
                            >
                              {emoji}{reactors.length > 0 && <span className="ml-0.5 text-[10px]">{reactors.length}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-gray-200 p-2">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendChat())}
                  placeholder="Bericht aan je groep…"
                  disabled={isFinalized}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  data-testid="input-group-chat"
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim() || isFinalized}
                  className="px-3 py-2 bg-gray-900 text-white rounded-lg disabled:opacity-40"
                  data-testid="button-send-chat"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">Tip: gebruik je OS-emoji-picker (Win+. of Cmd+Ctrl+Space).</p>
            </div>
          </div>

          {/* Briefing + checkpoints */}
          <div className="bg-white rounded-xl border border-gray-200 p-3 max-h-[40%] overflow-y-auto">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2">
              <Clipboard className="w-4 h-4" /> Briefing
            </div>
            {project.briefing_markdown ? (
              <div className="text-xs text-gray-700 whitespace-pre-wrap" data-testid="text-briefing">
                {project.briefing_markdown}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">Geen briefing ingesteld.</p>
            )}
            {projectMaterials.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setBestandenOpen(v => !v)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-gray-700 hover:text-gray-900"
                  data-testid="button-toggle-bestanden"
                >
                  {(() => {
                    const visibleCount = projectMaterials.filter(d => d.is_visible_to_students).length;
                    const hiddenCount = projectMaterials.length - visibleCount;
                    return (
                      <span className="flex items-center gap-1">
                        <Download className="w-3 h-3" /> Bestanden van de docent ({visibleCount}{isStaff && hiddenCount > 0 ? ` + ${hiddenCount} verborgen` : ''})
                      </span>
                    );
                  })()}
                  <span className="text-gray-400">{bestandenOpen ? '▲' : '▼'}</span>
                </button>
                {bestandenOpen && (
                  <div className="mt-2">
                    <ul className="space-y-1">
                      {projectMaterials.map(d => (
                        <li
                          key={d.id}
                          className={`flex items-center gap-1.5 text-xs ${!d.is_visible_to_students ? 'opacity-60' : ''}`}
                          data-testid={`project-material-${d.id}`}
                        >
                          {/\.(omv|sav|jasp|rdata|rds|rda|dta|por|zsav|spv|jrp)$/i.test(d.filename || '')
                            ? <Database className="w-3 h-3 text-blue-400 shrink-0" />
                            : <FileText className="w-3 h-3 text-gray-400 shrink-0" />}
                          <button
                            type="button"
                            onClick={() => downloadMaterial(d)}
                            className="truncate text-left text-blue-700 hover:underline"
                            title={`Download ${d.filename}`}
                            data-testid={`button-download-material-${d.id}`}
                          >
                            {d.filename}
                          </button>
                          {d.byte_size ? (
                            <span className="text-[10px] text-gray-400 shrink-0">{Math.max(1, Math.round(d.byte_size / 1024))} KB</span>
                          ) : null}
                          {isStaff && !d.is_visible_to_students && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 shrink-0"
                              title="Verborgen voor studenten"
                              data-testid={`badge-hidden-${d.id}`}
                            >
                              <EyeOff className="w-2.5 h-2.5" /> verborgen
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[10px] text-gray-400 mt-1.5">Klik een bestand om te downloaden.</p>
                  </div>
                )}
              </div>
            )}
            {Array.isArray(project.rubric_criteria) && project.rubric_criteria.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="text-xs font-semibold text-gray-700 mb-1">Rubriek</div>
                <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                  {project.rubric_criteria.map((c, i) => (
                    <li key={i}>{typeof c === 'string' ? c : (c.title || c.name || JSON.stringify(c))}</li>
                  ))}
                </ul>
              </div>
            )}
            {checkpoints.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" /> Checkpoints ({checkpoints.length})
                </div>
                <ul className="space-y-1 text-xs">
                  {checkpoints.map(cp => (
                    <li key={cp.id} className="text-gray-600">
                      <span className={`inline-block px-1.5 rounded text-[10px] ${cp.kind === 'final' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {cp.kind === 'final' ? 'eind' : 'tussentijds'}
                      </span>{' '}
                      <span className="text-gray-400">{new Date(cp.created_at).toLocaleDateString('nl-NL')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="fixed bottom-4 right-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm" data-testid="text-error">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}
      {info && (
        <div className="fixed bottom-4 right-4 bg-green-50 border border-green-200 text-green-800 px-4 py-2 rounded-lg text-sm" data-testid="text-info">
          {info}
          <button onClick={() => setInfo(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* Checkpoint modal */}
      {showCheckpointModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {showCheckpointModal === 'final' ? 'Project afronden' : 'Tussentijdse checkpoint'}
            </h2>

            {/* ── kind='final': reflectie-textarea (ongewijzigd) ── */}
            {showCheckpointModal === 'final' && (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  Schrijf een gezamenlijke eindreflectie. De begeleider geeft per rubriekspunt feedback en zet die in ieders leerdagboek.
                </p>
                <textarea
                  value={reflection}
                  onChange={e => setReflection(e.target.value)}
                  rows={10}
                  placeholder="Wat hebben jullie gedaan? Wat snappen jullie nog niet? Wat is de volgende stap?"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  data-testid="textarea-reflection"
                />
                <div className="text-xs text-gray-400 mt-1">{reflection.trim().length} tekens · minimaal 20</div>
              </>
            )}

            {/* ── kind='checkpoint': AI-preview per gesprek ── */}
            {showCheckpointModal === 'checkpoint' && (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  Hieronder staan automatische samenvattingen van jullie gesprekken. Pas ze aan als je dat wilt en sla ze op in jullie leerdagboeken.
                </p>

                {checkpointPreviewLoading && (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-500" data-testid="checkpoint-preview-loading">
                    <Loader2 className="w-7 h-7 animate-spin text-blue-500" />
                    <span className="text-sm">Samenvattingen worden gemaakt…</span>
                  </div>
                )}

                {checkpointPreviewError && !checkpointPreviewLoading && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4" data-testid="checkpoint-preview-error">
                    {checkpointPreviewError}
                  </div>
                )}

                {!checkpointPreviewLoading && !checkpointPreviewError && checkpointPreview !== null && checkpointPreview.length === 0 && (
                  <p className="text-sm text-gray-500 italic py-4" data-testid="checkpoint-preview-empty">
                    Geen gesprekken gevonden om samen te vatten.
                  </p>
                )}

                {!checkpointPreviewLoading && checkpointPreview && checkpointPreview.length > 0 && (
                  <div className="space-y-5" data-testid="checkpoint-preview-threads">
                    {checkpointPreview.map(t => (
                      <div key={t.threadId} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-xl">{t.avatarEmoji}</span>
                          <span className="font-semibold text-gray-800 text-sm">{t.personaName}</span>
                        </div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Jouw vragen/input</label>
                        <textarea
                          value={t.studentSummary}
                          onChange={e => updatePreviewSummary(t.threadId, 'studentSummary', e.target.value)}
                          rows={3}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white mb-3 resize-none"
                          data-testid={`textarea-student-summary-${t.threadId}`}
                        />
                        <label className="block text-xs font-medium text-gray-500 mb-1">Reactie van {t.personaName}</label>
                        <textarea
                          value={t.personaSummary}
                          onChange={e => updatePreviewSummary(t.threadId, 'personaSummary', e.target.value)}
                          rows={5}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white resize-none"
                          data-testid={`textarea-persona-summary-${t.threadId}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2 mt-5 justify-end">
              <button
                onClick={() => { setShowCheckpointModal(null); setReflection(''); setCheckpointPreview(null); setCheckpointPreviewError(null); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm"
                data-testid="button-cancel-checkpoint"
              >
                Annuleren
              </button>
              {/* Sla-knop: verberg bij lege preview of preview-fout */}
              {!(showCheckpointModal === 'checkpoint' && (checkpointPreviewError !== null || (checkpointPreview !== null && checkpointPreview.length === 0))) && (
                <button
                  onClick={submitCheckpoint}
                  disabled={
                    submittingCheckpoint ||
                    checkpointPreviewLoading ||
                    (showCheckpointModal === 'final' && reflection.trim().length < 20)
                  }
                  className={`px-4 py-2 text-white rounded-lg text-sm disabled:opacity-40 ${showCheckpointModal === 'final' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                  data-testid="button-submit-checkpoint"
                >
                  {submittingCheckpoint ? 'Even geduld…' : (showCheckpointModal === 'final' ? 'Afronden + opslaan' : 'Opslaan in leerdagboek')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectRoomPage;
