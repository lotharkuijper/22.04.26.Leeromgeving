import { useEffect, useRef, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from '../lib/supabase';
import { X, ChevronLeft, ChevronRight, Loader2, AlertCircle, Download, FileText, Languages, Maximize2, Minimize2 } from 'lucide-react';
import { openRagDocument } from '../services/rag.service';
import { TRANSLATION_LANGUAGES, TRANSLATION_LANGUAGE_CODES, nativeLangName } from '../lib/translationLanguages';
import { MarkdownMessage } from './MarkdownMessage';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Talen die rechts-naar-links gelezen worden (voor de juiste tekstrichting in
// het vertaalvenster).
const RTL_LANGS = new Set(['ar']);
const TRANSLATE_LANG_STORAGE_KEY = 'leap-vu-translate-lang';
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 2.2;
const FONT_SCALE_STEP = 0.15;

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

// Segmenteer een plat-tekstbestand in leesbare secties (≤ max tekens) zodat een
// vertaalverzoek per sectie begrensd blijft en lange tekstbestanden navigeerbaar
// worden. Splitst bij voorkeur op lege regels (alinea's).
function segmentText(text: string, max = 5000): string[] {
  const clean = text.replace(/\r\n?/g, '\n');
  const paras = clean.split(/\n{2,}/);
  const segs: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > max) { segs.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > max) { segs.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) segs.push(cur);
  return segs.length ? segs : [clean];
}

export function DocumentViewer({ documentId, title, lang, onClose, onContextChange }: DocumentViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ title: string; sourceType: string } | null>(null);
  const [textPages, setTextPages] = useState<string[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  // Vertaal-UI-state.
  const [translateOpen, setTranslateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'original' | 'translation'>('original');
  const [fullscreen, setFullscreen] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [fontScale, setFontScale] = useState(1);
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 900 : true));
  const [targetLang, setTargetLang] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(TRANSLATE_LANG_STORAGE_KEY);
      if (saved && TRANSLATION_LANGUAGE_CODES.includes(saved)) return saved;
    }
    return lang;
  });
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const renderSeqRef = useRef(0);
  const translateSeqRef = useRef(0);
  // Client-cache per document: sleutel `${page}|${targetLang}` → vertaling.
  const transCacheRef = useRef<Map<string, string>>(new Map());

  const isSlides = meta?.sourceType === 'pptx';
  const pageWord = textPages
    ? (lang === 'en' ? 'Section' : 'Sectie')
    : isSlides
      ? (lang === 'en' ? 'Slide' : 'Dia')
      : (lang === 'en' ? 'Page' : 'Pagina');

  // Layout-afgeleiden: side-by-side alleen in fullscreen op een breed scherm;
  // anders (smal paneel of niet-fullscreen) tabs.
  const sideBySide = translateOpen && fullscreen && wide;
  const tabsMode = translateOpen && !sideBySide;

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

  // Houd bij of het scherm breed genoeg is voor side-by-side.
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Escape verlaat de fullscreen-leesmodus.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // De afhandeling van goedaardige async pdf.js-ruis (RenderingCancelledException,
  // AbortException, "worker was destroyed") zit in één globaal vangnet in
  // `main.tsx`. Hier is geen viewer-scoped guard meer nodig.

  const renderPage = useCallback(async (pageNum: number) => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!pdf || !canvas || !container) return;
    // Verborgen origineel-paneel (display:none in tab-modus) heeft breedte 0;
    // niet renderen — de ResizeObserver triggert een render zodra het zichtbaar
    // wordt en er weer breedte is.
    if (!container.clientWidth) return;
    // Serialiseer renders: annuleer een lopende render en wacht tot die echt
    // klaar/afgebroken is voordat we opnieuw op hetzelfde canvas tekenen.
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

  // Haal de bron-tekst van de huidige pagina/sectie op (pdf.js getTextContent
  // sluit exact aan op de weergegeven pagina; voor tekstbestanden uit de
  // reeds-geladen segmenten).
  const getCurrentSourceText = useCallback(async (): Promise<string> => {
    if (textPages) return textPages[page - 1] || '';
    const pdf = pdfRef.current;
    if (!pdf) return '';
    try {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      let out = '';
      let prevEOL = true;
      for (const it of content.items as any[]) {
        const s = typeof it.str === 'string' ? it.str : '';
        if (!prevEOL && s && !/\s$/.test(out) && !/^\s/.test(s)) out += ' ';
        out += s;
        if (it.hasEOL) out += '\n';
        prevEOL = !!it.hasEOL;
      }
      return out.trim();
    } catch {
      return '';
    }
  }, [textPages, page]);

  // Laad het document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTextPages(null);
    setMeta(null);
    setPage(1);
    setTotalPages(0);
    setTranslatedText(null);
    setTranslateError(null);
    setTranslating(false);
    transCacheRef.current.clear();
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
          const segs = segmentText(data.text);
          setTextPages(segs);
          setTotalPages(segs.length);
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
    let lastWidth = Math.round(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      // Defer naar de volgende frame: renderPage resized de canvas, en dat
      // synchroon binnen de observer-callback doen triggert "ResizeObserver loop
      // completed with undelivered notifications".
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const width = Math.round(entries[0]?.contentRect.width ?? el.clientWidth);
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

  // Vertaal de huidige pagina/sectie wanneer het vertaalvenster open is.
  useEffect(() => {
    if (!translateOpen || loading || error) return;
    if (!textPages && !pdfRef.current) return;
    const seq = ++translateSeqRef.current;
    const key = `${page}|${targetLang}`;
    const cached = transCacheRef.current.get(key);
    if (cached !== undefined) {
      setTranslatedText(cached);
      setTranslating(false);
      setTranslateError(null);
      return;
    }
    (async () => {
      setTranslating(true);
      setTranslateError(null);
      setTranslatedText(null);
      try {
        const srcText = await getCurrentSourceText();
        if (seq !== translateSeqRef.current) return;
        if (!srcText.trim()) {
          transCacheRef.current.set(key, '');
          setTranslatedText('');
          return;
        }
        const pageKey = textPages ? `text:${page}` : `p:${page}`;
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
        const res = await fetch(`/api/rag/documents/${encodeURIComponent(documentId)}/translate`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: srcText, targetLang, pageKey, sourceType: meta?.sourceType || '' }),
        });
        if (seq !== translateSeqRef.current) return;
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
          throw new Error(detail || (lang === 'en' ? 'Translation failed.' : 'Vertalen mislukt.'));
        }
        const data = await res.json();
        if (seq !== translateSeqRef.current) return;
        const translated = typeof data.translated === 'string' ? data.translated : '';
        transCacheRef.current.set(key, translated);
        setTranslatedText(translated);
      } catch (err: any) {
        if (seq !== translateSeqRef.current) return;
        setTranslateError(err?.message || (lang === 'en' ? 'Translation failed.' : 'Vertalen mislukt.'));
      } finally {
        if (seq === translateSeqRef.current) setTranslating(false);
      }
    })();
  }, [translateOpen, page, targetLang, loading, error, textPages, documentId, meta, getCurrentSourceText, lang, retryNonce]);

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages || 1, p + 1));

  const toggleTranslate = () => {
    setTranslateOpen((o) => {
      const next = !o;
      if (next) setActiveTab('translation');
      return next;
    });
  };

  const onChangeLang = (code: string) => {
    setTargetLang(code);
    try { window.localStorage.setItem(TRANSLATE_LANG_STORAGE_KEY, code); } catch { /* ignore */ }
  };

  const retryTranslate = () => {
    transCacheRef.current.delete(`${page}|${targetLang}`);
    setRetryNonce((n) => n + 1);
  };

  const adjustFont = (delta: number) => {
    setFontScale((s) => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round((s + delta) * 100) / 100)));
  };

  // Sleepbare scheiding tussen origineel en vertaling (alleen side-by-side).
  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    const move = (ev: MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const r = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, r)));
    };
    const up = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const showNav = !error && (textPages ? totalPages > 1 : totalPages > 0);

  const originalHidden = tabsMode && activeTab !== 'original';
  const originalPaneStyle: CSSProperties = sideBySide
    ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 }
    : { flex: '1 1 0%', display: originalHidden ? 'none' : 'block' };
  const translationHidden = tabsMode && activeTab !== 'translation';
  // display:flex (met flex-col-className) zodat de body groeit en de voettekst
  // blijft staan; sideBySide is altijd zichtbaar, in tab-modus verborgen tenzij
  // de vertaling-tab actief is.
  const translationPaneStyle: CSSProperties = {
    flex: '1 1 0%',
    display: !sideBySide && translationHidden ? 'none' : 'flex',
  };

  const shellClass = fullscreen
    ? 'fixed inset-0 z-[60] flex flex-col bg-white'
    : 'flex h-full flex-col';

  return (
    <div className={shellClass} data-testid="document-viewer">
      {/* Titelbalk */}
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-blue-600" />
        <span className="flex-1 truncate text-sm font-semibold text-gray-800" title={meta?.title || title} data-testid="text-viewer-title">
          {meta?.title || title}
        </span>
        <button
          type="button"
          onClick={toggleTranslate}
          className={`rounded-md p-1.5 ${translateOpen ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'}`}
          title={lang === 'en' ? 'Translate' : 'Vertalen'}
          aria-pressed={translateOpen}
          data-testid="btn-viewer-translate"
        >
          <Languages className="h-4 w-4" />
        </button>
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

      {/* Vertaalwerkbalk */}
      {translateOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
          <label className="sr-only" htmlFor="select-translate-lang">
            {lang === 'en' ? 'Translation language' : 'Vertaaltaal'}
          </label>
          <select
            id="select-translate-lang"
            value={targetLang}
            onChange={(e) => onChangeLang(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
            data-testid="select-translate-lang"
          >
            {TRANSLATION_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.native}</option>
            ))}
          </select>
          <div className="flex items-center overflow-hidden rounded-md border border-gray-300 bg-white">
            <button
              type="button"
              onClick={() => adjustFont(-FONT_SCALE_STEP)}
              disabled={fontScale <= FONT_SCALE_MIN}
              className="px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
              title={lang === 'en' ? 'Smaller text' : 'Tekst kleiner'}
              data-testid="btn-translate-font-smaller"
            >
              A−
            </button>
            <span className="w-px self-stretch bg-gray-200" />
            <button
              type="button"
              onClick={() => adjustFont(FONT_SCALE_STEP)}
              disabled={fontScale >= FONT_SCALE_MAX}
              className="px-2 py-1 text-base font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-40"
              title={lang === 'en' ? 'Larger text' : 'Tekst groter'}
              data-testid="btn-translate-font-larger"
            >
              A+
            </button>
          </div>
          <span className="ml-auto inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" data-testid="label-machine-translated">
            {lang === 'en' ? 'Machine-translated' : 'Automatisch vertaald'}
          </span>
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            title={fullscreen ? (lang === 'en' ? 'Shrink' : 'Verkleinen') : (lang === 'en' ? 'Expand' : 'Vergroten')}
            data-testid="btn-translate-fullscreen"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* Tabs (smal paneel / niet-fullscreen) */}
      {tabsMode && (
        <div className="flex border-b border-gray-200 bg-white text-sm">
          <button
            type="button"
            onClick={() => setActiveTab('original')}
            className={`px-4 py-2 ${activeTab === 'original' ? 'border-b-2 border-blue-600 font-medium text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
            data-testid="tab-viewer-original"
          >
            {lang === 'en' ? 'Original' : 'Origineel'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('translation')}
            className={`px-4 py-2 ${activeTab === 'translation' ? 'border-b-2 border-blue-600 font-medium text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
            data-testid="tab-viewer-translation"
          >
            {lang === 'en' ? 'Translation' : 'Vertaling'}
          </button>
        </div>
      )}

      {/* Inhoud */}
      <div ref={splitRef} className="relative flex min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-gray-50 text-gray-500" data-testid="status-viewer-loading">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">{lang === 'en' ? 'Preparing document…' : 'Document wordt voorbereid…'}</p>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-gray-50 px-6 text-center" data-testid="status-viewer-error">
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

        {/* Origineel-paneel — altijd gemonteerd zodat het pdf-canvas nooit
            ontkoppeld wordt bij een layoutwissel. */}
        <div
          ref={containerRef}
          className="relative overflow-auto bg-gray-50 p-3"
          style={originalPaneStyle}
          data-testid="viewer-original-pane"
        >
          {!loading && !error && textPages !== null && (
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-white p-4 font-mono text-sm text-gray-800 shadow-sm" data-testid="text-viewer-content">
              {textPages[page - 1]}
            </pre>
          )}
          {!loading && !error && textPages === null && (
            <div className="flex justify-center">
              <canvas ref={canvasRef} className="rounded-lg bg-white shadow-sm" data-testid="canvas-viewer-page" />
            </div>
          )}
        </div>

        {/* Sleepbare scheiding (side-by-side) */}
        {sideBySide && (
          <div
            onMouseDown={onDividerDown}
            className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-400"
            role="separator"
            aria-orientation="vertical"
            data-testid="divider-translate"
          />
        )}

        {/* Vertaalvenster */}
        {translateOpen && (
          <div
            className="min-h-0 flex-col overflow-hidden border-l border-gray-200 bg-white"
            style={translationPaneStyle}
            data-testid="viewer-translation-pane"
          >
            <div className="flex-1 overflow-auto p-4">
              {translating && (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500" data-testid="status-translate-loading">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <p className="text-sm">{lang === 'en' ? 'Translating…' : 'Bezig met vertalen…'}</p>
                </div>
              )}
              {!translating && translateError && (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center" data-testid="status-translate-error">
                  <AlertCircle className="h-7 w-7 text-amber-500" />
                  <p className="text-sm text-gray-700">{translateError}</p>
                  <button
                    type="button"
                    onClick={retryTranslate}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    data-testid="btn-translate-retry"
                  >
                    {lang === 'en' ? 'Try again' : 'Opnieuw proberen'}
                  </button>
                </div>
              )}
              {!translating && !translateError && translatedText === '' && (
                <p className="py-10 text-center text-sm text-gray-500" data-testid="status-translate-empty">
                  {lang === 'en' ? 'No text on this page to translate.' : 'Geen tekst op deze pagina om te vertalen.'}
                </p>
              )}
              {!translating && !translateError && translatedText !== null && translatedText !== '' && (
                <div
                  className="break-words"
                  dir={RTL_LANGS.has(targetLang) ? 'rtl' : 'ltr'}
                  lang={targetLang}
                  data-testid="text-translation-content"
                >
                  {/* Render via de wiskunde-bewuste Markdown-renderer zodat $…$ en
                      $$…$$ als KaTeX-formules verschijnen. fontScale schaalt de
                      prose-root inline; de em-gebaseerde kinderen schalen mee. */}
                  <MarkdownMessage
                    content={translatedText}
                    style={{ fontSize: `${fontScale}rem` }}
                    hardBreaks
                  />
                </div>
              )}
            </div>
            <div className="border-t border-gray-100 px-4 py-1.5 text-[11px] text-gray-400" data-testid="text-translation-footer">
              {(lang === 'en' ? 'Machine-translated to ' : 'Automatisch vertaald naar ')}{nativeLangName(targetLang)}
            </div>
          </div>
        )}
      </div>

      {/* Pagina-navigatie */}
      {showNav && (
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
