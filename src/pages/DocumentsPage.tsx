import { useEffect, useState, useCallback, useRef } from 'react';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileText,
  Download, Trash2, Upload, Loader2, FolderPlus, X,
} from 'lucide-react';
import { NoticeBanner, ConfirmDialog, useNotice } from '../components/Notice';
import { supabase } from '../lib/supabase';

// ── Types ────────────────────────────────────────────────────────────────────

interface FolderNode {
  id: string;
  name: string;
  parent_folder_id: string | null;
  folder_type: string;
  is_root: boolean;
  document_count: number;
  children: FolderNode[];
}

interface DocItem {
  id: string;
  title: string;
  filename: string;
  file_type: string;
  file_size: number;
  processing_status: string;
  created_at: string;
  bucket: string;
  file_path: string;
  mime_type: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatBytes(bytes: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('nl-NL', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function FolderTypeBadge({ type }: { type: string }) {
  if (type === 'rag_sources')
    return <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium shrink-0">RAG</span>;
  if (type === 'data')
    return <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium shrink-0">Data</span>;
  if (type === 'course')
    return <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium shrink-0">Cursus</span>;
  return null;
}

function StatusPill({ status }: { status: string }) {
  if (status === 'completed') return <span className="text-green-600 text-xs">✓ verwerkt</span>;
  if (status === 'failed')    return <span className="text-red-500 text-xs">⚠ fout</span>;
  if (status === 'processing') return <span className="text-amber-500 text-xs animate-pulse">⏳ verwerkt…</span>;
  return <span className="text-gray-400 text-xs">wachtend</span>;
}

function findNode(nodes: FolderNode[], id: string): FolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return null;
}

// ── TreeNode component ───────────────────────────────────────────────────────

function TreeNode({
  node, selectedId, expandedIds, onSelect, onToggle, depth,
}: {
  node: FolderNode;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  depth: number;
}) {
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        data-testid={`folder-node-${node.id}`}
        className={`flex items-center gap-1.5 rounded-md py-1.5 cursor-pointer select-none transition-colors ${
          isSelected ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-800'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '8px' }}
        onClick={() => onSelect(node.id)}
      >
        <button
          className="w-4 h-4 flex items-center justify-center shrink-0 rounded hover:bg-gray-200"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.id); }}
        >
          {hasChildren
            ? isExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
              : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
            : <span className="w-3.5 h-3.5" />}
        </button>

        {isSelected && isExpanded
          ? <FolderOpen className="w-4 h-4 shrink-0 text-amber-500" />
          : <Folder className="w-4 h-4 shrink-0 text-amber-500" />}

        <span className="truncate text-sm flex-1 min-w-0 leading-snug" title={node.name}>
          {node.name}
        </span>

        {node.document_count > 0 && (
          <span className="text-xs text-gray-400 shrink-0 tabular-nums">{node.document_count}</span>
        )}
      </div>

      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={onToggle}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── NewFolderModal ───────────────────────────────────────────────────────────

function NewFolderModal({
  parentName, open, busy, onConfirm, onCancel,
}: {
  parentName: string;
  open: boolean;
  busy: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-xl p-6 max-w-sm w-full shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Nieuwe map aanmaken</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-3">
          Map wordt aangemaakt in: <strong>{parentName}</strong>
        </p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onConfirm(name.trim()); setName(''); } }}
          placeholder="Mapnaam"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          data-testid="input-new-folder-name"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Annuleren
          </button>
          <button
            onClick={() => { if (name.trim()) { onConfirm(name.trim()); setName(''); } }}
            disabled={!name.trim() || busy}
            className="px-4 py-2 text-sm text-white font-medium bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
            data-testid="button-confirm-new-folder"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Aanmaken
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const { notice, setNotice, clearNotice } = useNotice();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const { folders } = await apiFetch('/api/admin/document-tree');
      setTree(folders || []);
      const toExpand = new Set<string>();
      function walk(nodes: FolderNode[]) {
        for (const n of nodes) {
          if (n.is_root || n.folder_type === 'root' || n.folder_type === 'course') {
            toExpand.add(n.id);
          }
          walk(n.children);
        }
      }
      walk(folders || []);
      setExpandedIds((prev) => new Set([...prev, ...toExpand]));
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    } finally {
      setLoadingTree(false);
    }
  }, [setNotice]);

  const loadDocuments = useCallback(async (folderId: string) => {
    setLoadingDocs(true);
    setDocuments([]);
    try {
      const { documents: docs } = await apiFetch(`/api/admin/folders/${folderId}/documents`);
      setDocuments(docs || []);
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    } finally {
      setLoadingDocs(false);
    }
  }, [setNotice]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // ── Interactions ───────────────────────────────────────────────────────────

  function selectFolder(id: string) {
    setSelectedId(id);
    loadDocuments(id);
  }

  function toggleFolder(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length || !selectedId) return;
    setUploading(true);
    clearNotice();
    try {
      for (const file of Array.from(files)) {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        await apiFetch(`/api/admin/folders/${selectedId}/upload`, {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, mimeType: file.type, data: base64 }),
        });
      }
      setNotice({ kind: 'success', message: `${files.length === 1 ? 'Bestand' : 'Bestanden'} geüpload.` });
      await Promise.all([loadDocuments(selectedId), loadTree()]);
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteDocument() {
    if (!deleteDocId || !selectedId) return;
    setConfirmBusy(true);
    try {
      await apiFetch(`/api/admin/documents/${deleteDocId}`, { method: 'DELETE' });
      setDeleteDocId(null);
      setNotice({ kind: 'success', message: 'Document verwijderd.' });
      await Promise.all([loadDocuments(selectedId), loadTree()]);
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleDeleteFolder() {
    if (!deleteFolderId) return;
    setConfirmBusy(true);
    try {
      await apiFetch(`/api/admin/folders/${deleteFolderId}`, { method: 'DELETE' });
      setDeleteFolderId(null);
      if (selectedId === deleteFolderId) {
        setSelectedId(null);
        setDocuments([]);
      }
      setNotice({ kind: 'success', message: 'Map verwijderd.' });
      await loadTree();
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
      setDeleteFolderId(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleCreateFolder(name: string) {
    if (!selectedId) return;
    setNewFolderBusy(true);
    try {
      await apiFetch('/api/admin/folders', {
        method: 'POST',
        body: JSON.stringify({ name, parent_folder_id: selectedId }),
      });
      setNewFolderOpen(false);
      setNotice({ kind: 'success', message: `Map "${name}" aangemaakt.` });
      await loadTree();
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    } finally {
      setNewFolderBusy(false);
    }
  }

  async function downloadDocument(doc: DocItem) {
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      // Server-endpoint: werkt voor zowel file_bytes (binair) als storage-bestanden
      const res = await fetch(`/api/admin/documents/${doc.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'follow',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNotice({ kind: 'error', message: body.error || 'Download mislukt.' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.filename || doc.title;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: unknown) {
      setNotice({ kind: 'error', message: (e as Error).message });
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const selectedFolder = selectedId ? findNode(tree, selectedId) : null;
  const canDeleteFolder =
    selectedFolder &&
    !selectedFolder.is_root &&
    selectedFolder.folder_type !== 'root' &&
    documents.length === 0 &&
    selectedFolder.children.length === 0;

  const deleteDocName = deleteDocId
    ? (documents.find((d) => d.id === deleteDocId)?.title || 'dit document')
    : '';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 overflow-hidden">

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 border-r border-gray-200 flex flex-col overflow-hidden bg-gray-50">
        <div className="px-3 py-2.5 border-b border-gray-200 shrink-0">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Mappen</p>
        </div>
        <div className="flex-1 overflow-y-auto py-1.5 px-1">
          {loadingTree ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : (
            tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onSelect={selectFolder}
                onToggle={toggleFolder}
                depth={0}
              />
            ))
          )}
        </div>
      </aside>

      {/* ── Main panel ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white">

        {/* Header */}
        <div className="border-b border-gray-200 px-5 py-3 flex items-center justify-between gap-4 shrink-0">
          {selectedFolder ? (
            <div className="flex items-center gap-2 min-w-0">
              <FolderOpen className="w-5 h-5 text-amber-500 shrink-0" />
              <span className="font-semibold text-gray-900 truncate" title={selectedFolder.name}>
                {selectedFolder.name}
              </span>
              <FolderTypeBadge type={selectedFolder.folder_type} />
            </div>
          ) : (
            <span className="text-sm text-gray-400 italic">
              Selecteer een map om de inhoud te bekijken
            </span>
          )}

          {selectedFolder && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setNewFolderOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                data-testid="button-new-folder"
              >
                <FolderPlus className="w-4 h-4" />
                Nieuwe map
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
                data-testid="button-upload"
              >
                {uploading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Upload className="w-4 h-4" />}
                {uploading ? 'Bezig…' : 'Uploaden'}
              </button>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleUpload}
                data-testid="input-file-upload"
              />

              {canDeleteFolder && (
                <button
                  onClick={() => setDeleteFolderId(selectedId)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                  data-testid="button-delete-folder"
                  title="Lege map verwijderen"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Notice banner */}
        {notice && (
          <div className="mx-5 mt-3 shrink-0">
            <NoticeBanner notice={notice} onDismiss={clearNotice} />
          </div>
        )}

        {/* Document list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!selectedFolder ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
              <Folder className="w-12 h-12 opacity-30" />
              <p className="text-sm">Klik op een map in de zijbalk om de inhoud te bekijken.</p>
            </div>

          ) : loadingDocs ? (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>

          ) : documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-gray-400 gap-2">
              <FileText className="w-10 h-10 opacity-30" />
              <p className="text-sm">Geen documenten in deze map.</p>
              <p className="text-xs opacity-70">
                Gebruik de knop 'Uploaden' om bestanden toe te voegen.
              </p>
            </div>

          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-5/12">Naam</th>
                  <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">Type</th>
                  <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Grootte</th>
                  <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">Datum</th>
                  <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Status</th>
                  <th className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right w-20">Acties</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className="group hover:bg-gray-50 transition-colors"
                    data-testid={`row-document-${doc.id}`}
                  >
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 shrink-0 text-gray-400" />
                        <span className="truncate text-gray-800" title={doc.title}>{doc.title}</span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="uppercase text-xs font-mono text-gray-400">
                        {doc.file_type || doc.mime_type?.split('/')[1] || '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-gray-500 text-sm whitespace-nowrap">
                      {formatBytes(doc.file_size)}
                    </td>
                    <td className="py-2.5 pr-4 text-gray-500 text-sm whitespace-nowrap">
                      {formatDate(doc.created_at)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill status={doc.processing_status} />
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => downloadDocument(doc)}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                          data-testid={`button-download-${doc.id}`}
                          title="Downloaden"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteDocId(doc.id)}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                          data-testid={`button-delete-doc-${doc.id}`}
                          title="Verwijderen"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────── */}

      <ConfirmDialog
        open={!!deleteDocId}
        title="Document verwijderen"
        description={`Weet je zeker dat je "${deleteDocName}" wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`}
        confirmLabel="Verwijderen"
        variant="danger"
        busy={confirmBusy}
        onConfirm={handleDeleteDocument}
        onCancel={() => setDeleteDocId(null)}
      />

      <ConfirmDialog
        open={!!deleteFolderId}
        title="Map verwijderen"
        description={`Weet je zeker dat je de map "${selectedFolder?.name}" wilt verwijderen?`}
        confirmLabel="Verwijderen"
        variant="danger"
        busy={confirmBusy}
        onConfirm={handleDeleteFolder}
        onCancel={() => setDeleteFolderId(null)}
      />

      <NewFolderModal
        open={newFolderOpen}
        parentName={selectedFolder?.name || ''}
        busy={newFolderBusy}
        onConfirm={handleCreateFolder}
        onCancel={() => setNewFolderOpen(false)}
      />
    </div>
  );
}
