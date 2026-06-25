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
  // True wanneer de pagina ongewijzigd was sinds de vorige import (content-hash
  // match) en daarom is overgeslagen zonder opnieuw te embedden.
  unchanged?: boolean;
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

// De stream is afgekapt (bijv. door een proxy-timeout bij een trage import)
// zónder een 'done'- of 'error'-event. De import is dan deels gelukt; de docent
// kan veilig opnieuw draaien (ongewijzigde pagina's worden overgeslagen).
export class WebImportInterruptedError extends Error {
  processed: number;
  total: number;
  constructor(processed: number, total: number) {
    super('Web-import onderbroken: de verbinding werd verbroken voordat de import klaar was.');
    this.name = 'WebImportInterruptedError';
    this.processed = processed;
    this.total = total;
  }
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
  // Voor een nette melding bij een afgekapte stream: hoeveel pagina's er
  // daadwerkelijk klaar waren ('page_done') van het totaal ('start'/'progress').
  let total = pages.length;
  let processed = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === 'start') {
      if (typeof event.total === 'number') total = event.total;
    } else if (event.type === 'progress') {
      if (typeof event.total === 'number') total = event.total;
      onProgress?.({ current: event.index, total: event.total, url: event.url, title: event.title || '' });
    } else if (event.type === 'page_done') {
      // page_done vuurt NÁ het verwerken van een pagina; dit is de betrouwbare
      // teller (progress vuurt juist vóór het werk).
      processed += 1;
      if (typeof event.total === 'number') total = event.total;
    } else if (event.type === 'done') {
      const { type, ...rest } = event;
      done = rest as WebImportResult;
    } else if (event.type === 'error') {
      streamError = event.error || 'Web-import mislukt.';
    }
    // 'ping' is een heartbeat om de verbinding open te houden; bewust genegeerd.
  };

  try {
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
  } catch {
    // De stream-read zelf faalde (abrupte TCP/proxy-reset ná de headers, bijv.
    // bij een trage import onder rate-limiting). Als de server al een expliciete
    // fout of eindresultaat had gestuurd, respecteren we die hieronder; anders
    // is dit een afgekapte import → nette waarschuwing i.p.v. een harde fout.
    if (!done && !streamError) {
      throw new WebImportInterruptedError(processed, total);
    }
  }

  if (streamError) throw new Error(streamError);
  // Geen 'done' ontvangen en geen expliciete fout ⇒ de stream is afgekapt
  // (proxy-timeout bij een trage import). Meld dit apart zodat de UI een
  // waarschuwing toont i.p.v. een harde fout — opnieuw draaien is veilig.
  if (!done) throw new WebImportInterruptedError(processed, total);
  return done;
}
