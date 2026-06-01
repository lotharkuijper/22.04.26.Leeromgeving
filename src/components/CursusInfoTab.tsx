import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Heading,
  List,
  ListOrdered,
  Link2,
  Save,
  Upload,
  FolderOpen,
  Trash2,
  Download,
  Loader2,
  FileText,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { MarkdownMessage } from './MarkdownMessage';
import { formatFileSize } from '../config/storage.config';

interface InfoDoc {
  id: string;
  title: string;
  filename: string;
  file_type: string;
  file_size: number;
}

interface AvailableFile extends InfoDoc {
  folderName: string | null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function downloadInfoFile(courseId: string, documentId: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(
    `/api/courses/${courseId}/info/documents/${documentId}/download`,
    { headers }
  );
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = `(${res.status})`;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
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
}

export default function CursusInfoTab() {
  const { t } = useLanguage();
  const { activeCourseId, activeCourse } = useActiveCourse();

  const [body, setBody] = useState('');
  const [docs, setDocs] = useState<InfoDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [picking, setPicking] = useState(false);
  const [available, setAvailable] = useState<AvailableFile[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadInfo = useCallback(async () => {
    if (!activeCourseId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/courses/${activeCourseId}/info`, { headers });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.loadError', { message: json.error || res.status }));
        return;
      }
      setBody(json.body || '');
      setDocs(json.documents || []);
    } catch (err) {
      setError(t('courseInfo.loadError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  }, [activeCourseId, t]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  async function saveBody() {
    if (!activeCourseId) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
      const res = await fetch(`/api/courses/${activeCourseId}/info`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.saveError', { message: json.error || res.status }));
        return;
      }
      setMessage(t('courseInfo.saved'));
    } catch (err) {
      setError(t('courseInfo.saveError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  }

  // Pas markdown-opmaak toe rondom de huidige selectie in de textarea.
  function applyFormat(kind: 'bold' | 'italic' | 'heading' | 'bullet' | 'numbered' | 'link') {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = body.slice(start, end);
    let replacement = selectedText;
    let cursorOffset = 0;

    if (kind === 'bold') {
      replacement = `**${selectedText || 'vetgedrukt'}**`;
      cursorOffset = selectedText ? replacement.length : replacement.length - 2;
    } else if (kind === 'italic') {
      replacement = `*${selectedText || 'cursief'}*`;
      cursorOffset = selectedText ? replacement.length : replacement.length - 1;
    } else if (kind === 'heading') {
      const lineStart = body.lastIndexOf('\n', start - 1) + 1;
      const before = body.slice(0, lineStart);
      const after = body.slice(lineStart);
      const next = `${before}## ${after}`;
      setBody(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + 3, end + 3);
      });
      return;
    } else if (kind === 'bullet' || kind === 'numbered') {
      const block = selectedText || 'lijstitem';
      const prefix = kind === 'bullet' ? '- ' : '1. ';
      replacement = block
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');
      cursorOffset = replacement.length;
    } else if (kind === 'link') {
      const url = window.prompt(t('courseInfo.linkUrlPrompt'), 'https://');
      if (!url) return;
      replacement = `[${selectedText || t('courseInfo.linkTextDefault')}](${url})`;
      cursorOffset = replacement.length;
    }

    const next = body.slice(0, start) + replacement + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + cursorOffset;
      el.setSelectionRange(pos, pos);
    });
  }

  async function openPicker() {
    setPicking(true);
    setSelected(new Set());
    setAvailableLoading(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/courses/${activeCourseId}/info/available-files`, { headers });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.linkError', { message: json.error || res.status }));
        return;
      }
      setAvailable(json.files || []);
    } catch (err) {
      setError(t('courseInfo.linkError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setAvailableLoading(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function linkSelected() {
    if (!activeCourseId || selected.size === 0) return;
    setError(null);
    try {
      const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
      const res = await fetch(`/api/courses/${activeCourseId}/info/documents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ documentIds: [...selected] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.linkError', { message: json.error || res.status }));
        return;
      }
      setDocs(json.documents || []);
      setPicking(false);
    } catch (err) {
      setError(t('courseInfo.linkError', { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activeCourseId) return;
    setUploading(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/courses/${activeCourseId}/info/documents/upload`, {
        method: 'POST',
        headers,
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.uploadError', { message: json.error || res.status }));
        return;
      }
      setDocs(json.documents || []);
    } catch (err) {
      setError(t('courseInfo.uploadError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removeDoc(documentId: string) {
    if (!activeCourseId) return;
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(
        `/api/courses/${activeCourseId}/info/documents/${documentId}`,
        { method: 'DELETE', headers }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t('courseInfo.removeError', { message: json.error || res.status }));
        return;
      }
      setDocs((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      setError(t('courseInfo.removeError', { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  async function onDownload(documentId: string) {
    if (!activeCourseId) return;
    try {
      await downloadInfoFile(activeCourseId, documentId);
    } catch (err) {
      setError(t('courseInfo.downloadError', { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (!activeCourseId) {
    return (
      <div className="p-4 text-sm text-slate-600" data-testid="text-courseinfo-nocourse">
        {t('courseInfo.noCourse')}
      </div>
    );
  }

  const toolbarBtn =
    'inline-flex items-center justify-center h-8 w-8 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50';

  return (
    <div className="space-y-6" data-testid="tab-courseinfo">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t('courseInfo.title')}</h2>
        <p className="text-sm text-slate-600">
          {t('courseInfo.intro', { course: activeCourse?.name || '' })}
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="text-courseinfo-error">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="text-courseinfo-message">
          {message}
        </div>
      )}

      {/* Editor + preview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {t('courseInfo.editorLabel')}
          </label>
          <div className="flex flex-wrap gap-1 mb-2" role="toolbar" aria-label={t('courseInfo.title')}>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.bold')} aria-label={t('courseInfo.toolbar.bold')} onClick={() => applyFormat('bold')} data-testid="button-format-bold">
              <Bold className="h-4 w-4" />
            </button>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.italic')} aria-label={t('courseInfo.toolbar.italic')} onClick={() => applyFormat('italic')} data-testid="button-format-italic">
              <Italic className="h-4 w-4" />
            </button>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.heading')} aria-label={t('courseInfo.toolbar.heading')} onClick={() => applyFormat('heading')} data-testid="button-format-heading">
              <Heading className="h-4 w-4" />
            </button>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.bullet')} aria-label={t('courseInfo.toolbar.bullet')} onClick={() => applyFormat('bullet')} data-testid="button-format-bullet">
              <List className="h-4 w-4" />
            </button>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.numbered')} aria-label={t('courseInfo.toolbar.numbered')} onClick={() => applyFormat('numbered')} data-testid="button-format-numbered">
              <ListOrdered className="h-4 w-4" />
            </button>
            <button type="button" className={toolbarBtn} title={t('courseInfo.toolbar.link')} aria-label={t('courseInfo.toolbar.link')} onClick={() => applyFormat('link')} data-testid="button-format-link">
              <Link2 className="h-4 w-4" />
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
            placeholder={t('courseInfo.placeholder')}
            data-testid="input-courseinfo-body"
          />
          <button
            type="button"
            onClick={saveBody}
            disabled={saving || loading}
            className="mt-3 inline-flex items-center gap-2 rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            data-testid="button-save-courseinfo"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('courseInfo.saving') : t('courseInfo.save')}
          </button>
        </div>

        <div>
          <span className="block text-sm font-medium text-slate-700 mb-1">{t('courseInfo.preview')}</span>
          <div className="rounded border border-slate-200 bg-white p-4 min-h-[20rem]" data-testid="preview-courseinfo">
            {body.trim() ? (
              <MarkdownMessage content={body} />
            ) : (
              <p className="text-sm text-slate-400">{t('courseInfo.previewEmpty')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Gekoppelde bestanden */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">{t('courseInfo.linkedFiles')}</h3>
        {docs.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="text-no-linked-files">{t('courseInfo.noLinkedFiles')}</p>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-2"
                data-testid={`row-linked-file-${d.id}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
                  <span className="truncate text-sm text-slate-800">{d.title || d.filename}</span>
                  <span className="text-xs text-slate-400 flex-shrink-0">{formatFileSize(d.file_size || 0)}</span>
                </span>
                <span className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => onDownload(d.id)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-sky-700 hover:bg-sky-50"
                    data-testid={`button-download-linked-${d.id}`}
                  >
                    <Download className="h-3.5 w-3.5" /> {t('resources.download')}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeDoc(d.id)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    data-testid={`button-remove-linked-${d.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {t('courseInfo.removeFile')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openPicker}
            className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="button-open-filepicker"
          >
            <FolderOpen className="h-4 w-4" /> {t('courseInfo.addFromCourse')}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            data-testid="button-upload-courseinfo"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? t('courseInfo.uploading') : t('courseInfo.uploadFile')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleUpload}
            data-testid="input-file-courseinfo"
          />
        </div>
      </div>

      {/* Bestandskiezer cursusmap */}
      {picking && (
        <div className="rounded border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-900">{t('courseInfo.availableFiles')}</h3>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="text-sm text-slate-500 hover:text-slate-700"
              data-testid="button-close-filepicker"
            >
              ✕
            </button>
          </div>
          {availableLoading ? (
            <p className="text-sm text-slate-500"><Loader2 className="inline h-4 w-4 animate-spin" /></p>
          ) : available.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-available-files">{t('courseInfo.noAvailableFiles')}</p>
          ) : (
            <ul className="max-h-72 overflow-auto space-y-1">
              {available.map((f) => (
                <li key={f.id}>
                  <label className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white cursor-pointer" data-testid={`row-available-file-${f.id}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggleSelected(f.id)}
                      data-testid={`checkbox-available-${f.id}`}
                    />
                    <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
                    <span className="truncate text-sm text-slate-800">{f.title || f.filename}</span>
                    {f.folderName && (
                      <span className="text-xs text-slate-400 flex-shrink-0">· {f.folderName}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={linkSelected}
            disabled={selected.size === 0}
            className="mt-3 inline-flex items-center gap-2 rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            data-testid="button-link-selected"
          >
            {t('courseInfo.linkSelected')}
          </button>
        </div>
      )}
    </div>
  );
}
