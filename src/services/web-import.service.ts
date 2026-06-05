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

// Importeer de geselecteerde pagina's als RAG-bronnen in de gekozen cursus.
export async function importWebPages(
  courseId: string,
  baseUrl: string,
  pages: DiscoveredPage[],
): Promise<WebImportResult> {
  const res = await fetch('/api/admin/import-web/import', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ courseId, baseUrl, pages }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
