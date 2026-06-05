import { useState } from 'react';
import { Globe, Loader2, CheckCircle, AlertTriangle, XCircle, Info, X, Search, Download, Link2 } from 'lucide-react';
import {
  discoverWebPages,
  importWebPages,
  type DiscoveredPage,
  type WebImportResult,
} from '../services/web-import.service';
import { useActiveCourse } from '../contexts/ActiveCourseContext';

type NoticeKind = 'info' | 'warning' | 'error' | 'success';
interface Notice {
  kind: NoticeKind;
  message: string;
}

const NOTICE_STYLES: Record<NoticeKind, { box: string; icon: string }> = {
  info: { box: 'bg-blue-50 border-blue-200 text-blue-900', icon: 'text-blue-600' },
  warning: { box: 'bg-yellow-50 border-yellow-200 text-yellow-900', icon: 'text-yellow-600' },
  error: { box: 'bg-red-50 border-red-200 text-red-900', icon: 'text-red-600' },
  success: { box: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: 'text-emerald-600' },
};

export function WebImportPanel() {
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pages, setPages] = useState<DiscoveredPage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WebImportResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const handleDiscover = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setNotice({ kind: 'warning', message: 'Vul eerst een website-URL in.' });
      return;
    }
    setDiscovering(true);
    setResult(null);
    setPages([]);
    setSelected(new Set());
    setNotice({ kind: 'info', message: 'Pagina\'s van de webomgeving worden ontdekt — dit kan even duren.' });
    try {
      const res = await discoverWebPages(trimmed);
      setPages(res.pages);
      setBaseUrl(res.baseUrl);
      setSelected(new Set(res.pages.map((p) => p.url)));
      if (res.pages.length === 0) {
        setNotice({ kind: 'warning', message: 'Geen pagina\'s gevonden voor deze URL. Controleer of het adres klopt.' });
      } else {
        const via = res.method === 'sitemap' ? 'sitemap' : 'links';
        setNotice({
          kind: 'success',
          message: `${res.pages.length} pagina('s) gevonden via ${via}.${res.warnings.length ? ' ' + res.warnings.join(' ') : ''}`,
        });
      }
    } catch (err) {
      setNotice({ kind: 'error', message: 'Ontdekken mislukt: ' + (err instanceof Error ? err.message : 'Onbekende fout') });
    }
    setDiscovering(false);
  };

  const toggle = (pageUrl: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageUrl)) next.delete(pageUrl);
      else next.add(pageUrl);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === pages.length) setSelected(new Set());
    else setSelected(new Set(pages.map((p) => p.url)));
  };

  const handleImport = async () => {
    if (!activeCourseId) {
      setNotice({ kind: 'warning', message: 'Kies eerst een actieve cursus om de bronnen in op te slaan.' });
      return;
    }
    const chosen = pages.filter((p) => selected.has(p.url));
    if (chosen.length === 0) {
      setNotice({ kind: 'warning', message: 'Selecteer minimaal één pagina om te importeren.' });
      return;
    }
    setImporting(true);
    setResult(null);
    setNotice({ kind: 'info', message: `Import gestart voor ${chosen.length} pagina('s) — dit kan een paar minuten duren.` });
    try {
      const res = await importWebPages(activeCourseId, baseUrl, chosen);
      setResult(res);
      setNotice({
        kind: 'success',
        message: `Klaar — ${res.imported} geïmporteerd, ${res.skipped} overgeslagen, ${res.errors} fouten (${res.totalChunks} chunks).`,
      });
    } catch (err) {
      setNotice({ kind: 'error', message: 'Importeren mislukt: ' + (err instanceof Error ? err.message : 'Onbekende fout') });
    }
    setImporting(false);
  };

  const renderNoticeIcon = (kind: NoticeKind, className: string) => {
    if (kind === 'success') return <CheckCircle className={className} />;
    if (kind === 'warning') return <AlertTriangle className={className} />;
    if (kind === 'error') return <XCircle className={className} />;
    return <Info className={className} />;
  };

  return (
    <div className="space-y-6" data-testid="panel-web-import">
      {notice && (
        <div
          className={`flex items-start gap-3 border rounded-lg p-4 ${NOTICE_STYLES[notice.kind].box}`}
          role={notice.kind === 'error' || notice.kind === 'warning' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' || notice.kind === 'warning' ? 'assertive' : 'polite'}
          data-testid={`notice-web-${notice.kind}`}
        >
          {renderNoticeIcon(notice.kind, `w-5 h-5 mt-0.5 ${NOTICE_STYLES[notice.kind].icon}`)}
          <p className="flex-1 text-sm">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="opacity-70 hover:opacity-100"
            aria-label="Sluit melding"
            data-testid="button-dismiss-web-notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Globe className="w-5 h-5 text-blue-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">Website importeren</h3>
            <p className="text-sm text-gray-700">
              Plak het adres van een leeromgeving of documentatiesite. LEAP-VU ontdekt
              de onderliggende pagina's, haalt de leesbare tekst op en slaat die als
              doorzoekbare RAG-bronnen op in je actieve cursus. Je kiest zelf welke
              pagina's je meeneemt. Importeer alleen sites waarvan je het materiaal mag gebruiken.
            </p>
          </div>
        </div>
      </div>

      {/* Cursus-indicator */}
      <div className="flex items-start gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="text-web-active-course">
        <Link2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-blue-900">
          {activeCourseId && activeCourse ? (
            <>
              <strong>Doelcursus:</strong> de geïmporteerde pagina's komen in de RAG-map van
              cursus <strong>{activeCourse.name}</strong>.
            </>
          ) : (
            <>
              <strong>Geen actieve cursus:</strong> wissel naar een cursus voordat je importeert,
              zodat de bronnen op de juiste plek worden opgeslagen.
            </>
          )}
        </div>
      </div>

      {/* URL-invoer */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
        <h3 className="font-semibold text-gray-900">Website-URL</h3>
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !discovering) void handleDiscover(); }}
            placeholder="https://voorbeeld.nl/cursusboek/"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            data-testid="input-web-url"
          />
          <button
            onClick={handleDiscover}
            disabled={discovering || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            data-testid="button-discover-web"
          >
            {discovering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {discovering ? 'Ontdekken...' : 'Ontdek pagina\'s'}
          </button>
        </div>
      </div>

      {/* Gevonden pagina's */}
      {pages.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">
              Gevonden pagina's <span className="text-sm font-normal text-gray-500">({selected.size}/{pages.length} geselecteerd)</span>
            </h3>
            <button
              onClick={toggleAll}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
              data-testid="button-toggle-all-web-pages"
            >
              {selected.size === pages.length ? 'Deselecteer alles' : 'Selecteer alles'}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg mb-6">
            {pages.map((p) => (
              <label
                key={p.url}
                className="flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer transition-colors"
                data-testid={`label-web-page-${p.url}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.url)}
                  onChange={() => toggle(p.url)}
                  className="w-4 h-4 mt-0.5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  data-testid={`checkbox-web-page-${p.url}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate">{p.title || p.url}</p>
                  <p className="text-xs text-gray-400 truncate">{p.url}</p>
                </div>
              </label>
            ))}
          </div>

          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0 || !activeCourseId}
            className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            data-testid="button-import-web-pages"
          >
            {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
            {importing ? 'Importeren...' : `Importeer ${selected.size} pagina('s)`}
          </button>
        </div>
      )}

      {/* Resultaat */}
      {result && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3" data-testid="web-import-result">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4" data-testid="result-web-imported">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm font-medium text-green-900">Geïmporteerd</span>
              </div>
              <p className="text-2xl font-bold text-green-900">{result.imported}</p>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4" data-testid="result-web-skipped">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
                <span className="text-sm font-medium text-yellow-900">Overgeslagen</span>
              </div>
              <p className="text-2xl font-bold text-yellow-900">{result.skipped}</p>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4" data-testid="result-web-errors">
              <div className="flex items-center gap-2 mb-2">
                <XCircle className="w-5 h-5 text-red-600" />
                <span className="text-sm font-medium text-red-900">Fouten</span>
              </div>
              <p className="text-2xl font-bold text-red-900">{result.errors}</p>
            </div>
          </div>

          {result.results.some((r) => r.status !== 'imported') && (
            <div className="text-xs text-gray-600 bg-gray-50 rounded p-3 space-y-1" data-testid="text-web-import-details">
              {result.results.filter((r) => r.status !== 'imported').map((r) => (
                <div key={r.url} className="truncate">
                  <span className={r.status === 'error' ? 'text-red-600' : 'text-yellow-700'}>
                    {r.status === 'error' ? 'Fout' : 'Overgeslagen'}
                  </span>{' '}— {r.url}{r.message ? ` (${r.message})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
