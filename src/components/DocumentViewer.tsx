import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from '../lib/supabase';
import { X, ChevronLeft, ChevronRight, Loader2, AlertCircle, Download, FileText } from 'lucide-react';
import { openRagDocument } from '../services/rag.service';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ViewerContext {
  documentId: string;
  title: string;
  sourceType: string;
  page: number;
  totalPages: number;
}

interface DocumentViewerProps {
  documentId: string;
  title: string;
  lang: 'nl' | 'en';
  onClose: () => void;
  onContextChange?: (ctx: ViewerContext | null) => void;
}

type ViewResponse =
  | { kind: 'pdf'; title: string; sourceType: string; url: string }
  | { kind: 'text'; title: string; sourceType: string; text: string }
  | { kind: 'url'; title: string; sourceType: string; url: string };

export function DocumentViewer({ documentId, title, lang, onClose, onContextChange }: DocumentViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ title: string; sourceType: string } | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const renderSeqRef = useRef(0);

  const isSlides = meta?.sourceType === 'pptx';
  const pageWord = isSlides
    ? (lang === 'en' ? 'Slide' : 'Dia')
    : (lang === 'en' ? 'Page' : 'Pagina');

  // Meld de actieve context (bron + pagina) terug aan de chat.
  useEffect(() => {
    if (!meta || totalPages === 0) return;
    onContextChange?.({
      documentId,
      title: meta.title || title,
      sourceType: meta.sourceType,
      page,
      totalPages,
    });
  }, [documentId, meta, page, totalPages, title, onContextChange]);

  // Wis de context wanneer de viewer verdwijnt.
  useEffect(() => {
    return () => onContextChange?.(null);
  }, [onContextChange]);

  // De afhandeling van goedaardige async pdf.js-ruis (RenderingCancelledException,
  // AbortException, "worker was destroyed") die GEEN echt Error-object is en de
  // Replit-overlay laat crashen, zit nu in één globaal vangnet in `main.tsx`
  // (zie de `async-guard`-handlers daar). Hier is geen viewer-scoped guard meer
  // nodig.

  const renderPage = useCallback(async (pageNum: number) => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!pdf || !canvas || !container) return;
    // Serialiseer renders: annuleer een lopende render en wacht tot die echt
    // klaar/afgebroken is voordat we opnieuw op hetzelfde canvas tekenen.
    // pdf.js gooit anders "Cannot use the same canvas during multiple render()".
    const seq = ++renderSeqRef.current;
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
      try { await renderTaskRef.current.promise; } catch { /* afgebroken render verwacht */ }
    }
    if (seq !== renderSeqRef.current) return; // door een nieuwere render ingehaald
    try {
      const pdfPage = await pdf.getPage(pageNum);
      if (seq !== renderSeqRef.current) return;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const available = Math.max(240, container.clientWidth - 24);
      const scale = available / unscaled.width;
      const viewport = pdfPage.getViewport({ scale });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const task = pdfPage.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      await task.promise;
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return;
      setError(lang === 'en' ? 'Could not render this page.' : 'Kon deze pagina niet weergeven.');
    }
  }, [lang]);

  // Laad het document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTextContent(null);
    setMeta(null);
    setPage(1);
    setTotalPages(0);
    // Wis directe context bij een documentwissel zodat de chat nooit de vorige
    // bron/pagina meestuurt terwijl de nieuwe bron nog laadt.
    onContextChange?.(null);
    pdfRef.current = null;

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = {};
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
        const res = await fetch(`/api/rag/documents/${encodeURIComponent(documentId)}/view`, { headers });
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
          throw new Error(detail || (lang === 'en' ? `Could not open document (${res.status}).` : `Kon document niet openen (${res.status}).`));
        }
        const data = (await res.json()) as ViewResponse;
        if (cancelled) return;
        setMeta({ title: data.title || title, sourceType: data.sourceType });

        if (data.kind === 'text') {
          setTextContent(data.text);
          setTotalPages(1);
          setLoading(false);
          return;
        }

        // Webbron: er is geen lokaal bestand om te renderen. Open de originele
        // pagina in een nieuw tabblad en sluit de viewer weer.
        if (data.kind === 'url') {
          window.open(data.url, '_blank', 'noopener,noreferrer');
          setLoading(false);
          onClose();
          return;
        }

        const pdfRes = await fetch(data.url);
        if (!pdfRes.ok) throw new Error(lang === 'en' ? 'Could not download the document.' : 'Kon het document niet ophalen.');
        const buffer = await pdfRes.arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        setLoading(false);
        // De [page, loading]-effect verzorgt de eerste render zodra loading
        // op false staat; geen aparte render hier (voorkomt dubbele render).
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || (lang === 'en' ? 'Could not open document.' : 'Kon document niet openen.'));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
      }
      const pdf = pdfRef.current;
      pdfRef.current = null;
      // destroy() levert een promise; vang een eventuele rejection af zodat er
      // geen unhandled rejection ontstaat die de iframe-foutmelding triggert.
      if (pdf) { Promise.resolve(pdf.destroy()).catch(() => {}); }
    };
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Herrender bij paginawissel of breedteveranderingen.
  useEffect(() => {
    if (!loading && pdfRef.current) renderPage(page);
  }, [page, loading, renderPage]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let rafId: number | null = null;
    // Init op de huidige breedte zodat de directe observe-callback (die altijd
    // 1× meteen vuurt) niet onnodig herrendert.
    let lastWidth = Math.round(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      // Defer naar de volgende frame: renderPage resized de canvas, en dat
      // synchroon binnen de observer-callback doen triggert "ResizeObserver loop
      // completed with undelivered notifications" — een waarde (string) die GEEN
      // echt Error-object is en de Replit-preview-overlay laat crashen.
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const width = Math.round(entries[0]?.contentRect.width ?? el.clientWidth);
        // Alleen herrenderen bij een echte breedteverandering — voorkomt de
        // feedback-lus en overbodige renders.
        if (width === lastWidth) return;
        lastWidth = width;
        if (pdfRef.current && !loading) renderPage(page);
      });
    });
    ro.observe(el);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [page, loading, renderPage]);

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages || 1, p + 1));

  return (
    <div className="flex h-full flex-col" data-testid="document-viewer">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-blue-600" />
        <span className="flex-1 truncate text-sm font-semibold text-gray-800" title={meta?.title || title} data-testid="text-viewer-title">
          {meta?.title || title}
        </span>
        <button
          type="button"
          onClick={() => openRagDocument(documentId).catch(() => {})}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          title={lang === 'en' ? 'Download' : 'Downloaden'}
          data-testid="btn-viewer-download"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          title={lang === 'en' ? 'Close viewer' : 'Viewer sluiten'}
          data-testid="btn-viewer-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={containerRef} className="relative flex-1 overflow-auto bg-gray-50 p-3">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500" data-testid="status-viewer-loading">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">{lang === 'en' ? 'Preparing document…' : 'Document wordt voorbereid…'}</p>
          </div>
        )}
        {error && !loading && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="status-viewer-error">
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-gray-700">{error}</p>
            <button
              type="button"
              onClick={() => openRagDocument(documentId).catch(() => {})}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="btn-viewer-download-fallback"
            >
              <Download className="h-4 w-4" />
              {lang === 'en' ? 'Download instead' : 'In plaats daarvan downloaden'}
            </button>
          </div>
        )}
        {!loading && !error && textContent !== null && (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-white p-4 font-mono text-sm text-gray-800 shadow-sm" data-testid="text-viewer-content">
            {textContent}
          </pre>
        )}
        {!loading && !error && textContent === null && (
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded-lg bg-white shadow-sm" data-testid="canvas-viewer-page" />
          </div>
        )}
      </div>

      {!error && textContent === null && totalPages > 0 && (
        <div className="flex items-center justify-center gap-3 border-t border-gray-200 px-3 py-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={page <= 1}
            className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            data-testid="btn-viewer-prev"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-[7rem] text-center text-sm text-gray-700" data-testid="text-viewer-page">
            {pageWord} {page} / {totalPages}
          </span>
          <button
            type="button"
            onClick={goNext}
            disabled={page >= totalPages}
            className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            data-testid="btn-viewer-next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
