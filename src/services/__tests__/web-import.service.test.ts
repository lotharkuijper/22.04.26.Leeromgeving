import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// importWebPages haalt via authHeaders() een sessie op uit '../lib/supabase';
// mock 'm zodat er geen env-vars/echte client nodig zijn.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

import { importWebPages, WebImportInterruptedError, type DiscoveredPage } from '../web-import.service';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGES: DiscoveredPage[] = [
  { url: 'https://x/1', title: 'Pagina 1' },
  { url: 'https://x/2', title: 'Pagina 2' },
  { url: 'https://x/3', title: 'Pagina 3' },
];

// Bouwt een Response-achtig object met een ReadableStream-body die de
// meegegeven NDJSON-regels uitstuurt. `cut` (default false) breekt de stream
// af zónder een 'done'-event (afgekapte stream). `failAfter` laat de read zelf
// abrupt rejecten na het uitsturen van n chunks (TCP/proxy-reset).
function streamResponse(
  lines: string[],
  opts: { failAfter?: number } = {},
): Response {
  const encoder = new TextEncoder();
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && emitted >= opts.failAfter) {
        controller.error(new Error('stream reset'));
        return;
      }
      if (emitted >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(lines[emitted] + '\n'));
      emitted += 1;
    },
  });
  return {
    ok: true,
    body: stream,
  } as unknown as Response;
}

function startLine(total: number): string {
  return JSON.stringify({ type: 'start', total });
}
function progressLine(index: number, total: number, page: DiscoveredPage): string {
  return JSON.stringify({ type: 'progress', index, total, url: page.url, title: page.title });
}
function pageDoneLine(total: number): string {
  return JSON.stringify({ type: 'page_done', total });
}

describe('importWebPages', () => {
  it('resolt naar het resultaat bij een normale stream met een done-event', async () => {
    const result = {
      imported: 3,
      skipped: 0,
      errors: 0,
      totalChunks: 9,
      folderId: 'folder-1',
      courseName: 'Cursus',
      results: [],
    };
    const lines = [
      startLine(3),
      progressLine(1, 3, PAGES[0]),
      pageDoneLine(3),
      progressLine(2, 3, PAGES[1]),
      pageDoneLine(3),
      progressLine(3, 3, PAGES[2]),
      pageDoneLine(3),
      JSON.stringify({ type: 'done', ...result }),
    ];
    fetchMock.mockResolvedValue(streamResponse(lines));

    const out = await importWebPages('course-1', 'https://x', PAGES);
    expect(out).toEqual(result);
  });

  it('gooit WebImportInterruptedError als de stream eindigt zonder done-event', async () => {
    const lines = [
      startLine(3),
      progressLine(1, 3, PAGES[0]),
      pageDoneLine(3),
      progressLine(2, 3, PAGES[1]),
      pageDoneLine(3),
      // geen 'done': stream sluit na 2 verwerkte pagina's
    ];
    fetchMock.mockResolvedValue(streamResponse(lines));

    const err = await importWebPages('course-1', 'https://x', PAGES).catch((e) => e);
    expect(err).toBeInstanceOf(WebImportInterruptedError);
    expect(err.processed).toBe(2);
    expect(err.total).toBe(3);
  });

  it('gooit WebImportInterruptedError als de stream-read abrupt rejecteert na de headers', async () => {
    const lines = [
      startLine(3),
      progressLine(1, 3, PAGES[0]),
      pageDoneLine(3),
    ];
    // read faalt na het uitsturen van de 3 regels (1 pagina klaar)
    fetchMock.mockResolvedValue(streamResponse(lines, { failAfter: lines.length }));

    const err = await importWebPages('course-1', 'https://x', PAGES).catch((e) => e);
    expect(err).toBeInstanceOf(WebImportInterruptedError);
    expect(err.processed).toBe(1);
    expect(err.total).toBe(3);
  });

  it('gooit WebImportInterruptedError bij een heartbeat-only (ping) stream', async () => {
    const lines = [
      startLine(3),
      JSON.stringify({ type: 'ping' }),
      JSON.stringify({ type: 'ping' }),
      // alleen heartbeats, nooit een 'done' of 'page_done'
    ];
    fetchMock.mockResolvedValue(streamResponse(lines));

    const err = await importWebPages('course-1', 'https://x', PAGES).catch((e) => e);
    expect(err).toBeInstanceOf(WebImportInterruptedError);
    expect(err.processed).toBe(0);
    expect(err.total).toBe(3);
  });
});
