import { supabase } from '../lib/supabase';

// Eén ontdekte pagina van een webomgeving.
export interface DiscoveredPage {
  url: string;
  title: string;
}

export interface DiscoverResult {
  pages: DiscoveredPage[];
  method: 'sitemap' | 'crawl' | 'none';
  warnings: string[];
  baseUrl: string;
}

export type PageImportStatus = 'imported' | 'skipped' | 'error';

export interface PageImportResult {
  url: string;
  status: PageImportStatus;
  title?: string;
  chunks?: number;
  message?: string;
}

export interface WebImportResult {
  imported: number;
  skipped: number;
  errors: number;
  outOfScope?: number;
  totalChunks: number;
  folderId: string;
  courseName: string;
  results: PageImportResult[];
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Geen actieve sessie. Log opnieuw in.');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Ontdek de pagina's van een webomgeving op basis van een start-URL.
export async function discoverWebPages(url: string): Promise<DiscoverResult> {
  const res = await fetch('/api/admin/import-web/discover', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Live voortgang tijdens de import: welke pagina (1-based) van hoeveel, en de
// URL/titel die nu verwerkt wordt.
export interface WebImportProgress {
  current: number;
  total: number;
  url: string;
  title: string;
}

// Importeer de geselecteerde pagina's als RAG-bronnen in de gekozen cursus.
// De server streamt de voortgang als NDJSON; `onProgress` wordt per pagina
// aangeroepen voordat die verwerkt wordt. Het eindresultaat wordt geretourneerd.
export async function importWebPages(
  courseId: string,
  baseUrl: string,
  pages: DiscoveredPage[],
  onProgress?: (p: WebImportProgress) => void,
): Promise<WebImportResult> {
  const res = await fetch('/api/admin/import-web/import', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ courseId, baseUrl, pages }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  if (!res.body) throw new Error('Geen stream-antwoord van de server.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: WebImportResult | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === 'progress') {
      onProgress?.({ current: event.index, total: event.total, url: event.url, title: event.title || '' });
    } else if (event.type === 'done') {
      const { type, ...rest } = event;
      done = rest as WebImportResult;
    } else if (event.type === 'error') {
      streamError = event.error || 'Web-import mislukt.';
    }
  };

  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    if (streamDone) break;
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  if (streamError) throw new Error(streamError);
  if (!done) throw new Error('Onvolledig antwoord van de server.');
  return done;
}
