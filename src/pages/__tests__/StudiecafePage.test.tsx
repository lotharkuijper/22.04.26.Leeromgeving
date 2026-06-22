// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Auth + actieve cursus worden gemockt zodat de pagina rendert zonder echte
// Supabase-sessie of cursus-context. De realtime-client wordt vervangen door een
// nep-kanaal waarvan we de change-handlers vangen (om een refetch te simuleren).
// Belangrijk: geef STABIELE objectreferenties terug. De pagina leidt `apiFetch`/
// `loadThreads` af van `session`; een nieuw session-object per render zou hun
// identiteit elke render veranderen en het laad-effect oneindig laten herhalen.
vi.mock('../../contexts/AuthContext', () => {
  const session = { access_token: 'test-token' };
  return { useAuth: () => ({ session }) };
});

vi.mock('../../contexts/ActiveCourseContext', () => {
  const activeCourse = { name: 'Statistiek' };
  return { useActiveCourse: () => ({ activeCourseId: 'course-1', activeCourse }) };
});

const realtimeHandlers: Array<() => void> = [];
const channelObj: any = {
  on: vi.fn((..._args: any[]) => {
    const handler = _args[_args.length - 1];
    if (typeof handler === 'function') realtimeHandlers.push(handler as () => void);
    return channelObj;
  }),
  subscribe: vi.fn(() => channelObj),
};
vi.mock('../../lib/supabase', () => ({
  supabase: {
    channel: vi.fn(() => channelObj),
    removeChannel: vi.fn(),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}));

import { StudiecafePage } from '../StudiecafePage';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

const nl = translations.nl as Record<string, string>;

// ── Server-respons-fixtures ──────────────────────────────────────────────────
// Twee backlog-threads: hun laatste activiteit ligt vóór de bevroren vloer
// (lastSeenAt), dus ze zijn standaard NIET nieuw — perfect om de bewust-ongelezen
// markering te testen.
const LAST_SEEN = '2026-06-20T00:00:00.000Z';
function makeThread(id: string, title: string) {
  return {
    id,
    authorId: 'other-user',
    authorName: 'Ada',
    title,
    body: `body van ${id}`,
    category: 'vraag',
    isPinned: false,
    isLocked: false,
    isAnnouncement: false,
    isResolved: false,
    kudos: null,
    reactions: [],
    replyCount: 0,
    lastActivityAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    isMine: false,
  };
}

// Muteerbare threads-respons zodat een refetch een ander `manualUnread` kan teruggeven.
let threadsResponse: {
  threads: ReturnType<typeof makeThread>[];
  isStaff: boolean;
  reads: Record<string, string>;
  manualUnread: string[];
  lastSeenAt: string;
};

function resetThreadsResponse() {
  threadsResponse = {
    threads: [makeThread('thread-a', 'Backlog vraag A'), makeThread('thread-b', 'Backlog vraag B')],
    isStaff: false,
    reads: {},
    manualUnread: [],
    lastSeenAt: LAST_SEEN,
  };
}

function jsonRes(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

// Eenvoudige fetch-router voor de Studiecafé-endpoints die de pagina aanroept.
const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = (init?.method || 'GET').toUpperCase();

  if (url.includes('/notification-prefs')) {
    return jsonRes({ email_replies: true, email_announcements: true });
  }
  if (url.endsWith('/threads') && method === 'GET') {
    return jsonRes(threadsResponse);
  }
  if (url.includes('/replies') && method === 'GET') {
    return jsonRes({ replies: [] });
  }
  // POST-acties: read / unread / read-all / seen — geven een minimale respons.
  if (url.endsWith('/read-all') && method === 'POST') {
    return jsonRes({ threadIds: threadsResponse.threads.map((t) => t.id), readAt: new Date().toISOString() });
  }
  if (url.endsWith('/seen') && method === 'POST') {
    return jsonRes({ lastSeenAt: LAST_SEEN });
  }
  if ((url.endsWith('/read') || url.endsWith('/unread')) && method === 'POST') {
    return jsonRes({ ok: true });
  }
  return jsonRes({}, true);
});

function renderPage() {
  return render(
    <LanguageProvider>
      <StudiecafePage />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHandlers.length = 0;
  resetThreadsResponse();
  vi.stubGlobal('fetch', fetchMock);
  try {
    localStorage.clear();
    localStorage.setItem('lair-vu-lang', 'nl');
  } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function waitForLoaded() {
  await waitFor(() => expect(screen.getByTestId('thread-thread-a')).toBeInTheDocument());
}

describe('StudiecafePage — bewust ongelezen markeren', () => {
  it('toont backlog-threads standaard niet als nieuw', async () => {
    renderPage();
    await waitForLoaded();

    expect(screen.queryByTestId('badge-unread-thread-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('badge-unread-thread-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-unread')).not.toBeInTheDocument();
    // De markeer-ongelezen-knop is wél zichtbaar voor een gelezen thread.
    expect(screen.getByTestId('button-mark-unread-thread-a')).toBeInTheDocument();
  });

  it('markeert een backlog-thread als "Nieuw" en toont de ongelezen-banner', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByTestId('button-mark-unread-thread-a'));

    const badge = await screen.findByTestId('badge-unread-thread-a');
    expect(badge).toHaveTextContent(nl['studiecafe.unread.thread']);
    // De banner toont nu de telling (unreadStats) voor één gesprek.
    const banner = screen.getByTestId('banner-unread');
    expect(banner).toHaveTextContent(nl['studiecafe.unread.bannerOne']);
    // Een al-nieuwe thread biedt geen markeer-ongelezen-knop meer aan.
    expect(screen.queryByTestId('button-mark-unread-thread-a')).not.toBeInTheDocument();

    // De server-call voor "ongelezen" is verzonden.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/studiecafe/course-1/threads/thread-a/unread',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('wist de markering wanneer de thread wordt geopend', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByTestId('button-mark-unread-thread-a'));
    await screen.findByTestId('badge-unread-thread-a');

    // Openen = gelezen → de bewust-ongelezen markering verdwijnt weer.
    await user.click(screen.getByTestId('button-replies-thread-a'));

    await waitFor(() => {
      expect(screen.queryByTestId('badge-unread-thread-a')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('banner-unread')).not.toBeInTheDocument();
  });

  it('"alles gelezen" wist alle markeringen', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByTestId('button-mark-unread-thread-a'));
    await user.click(screen.getByTestId('button-mark-unread-thread-b'));
    await screen.findByTestId('badge-unread-thread-a');
    await screen.findByTestId('badge-unread-thread-b');

    // De banner telt nu twee gesprekken.
    expect(screen.getByTestId('banner-unread')).toBeInTheDocument();

    await user.click(screen.getByTestId('button-mark-all-read'));

    await waitFor(() => {
      expect(screen.queryByTestId('badge-unread-thread-a')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('badge-unread-thread-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-unread')).not.toBeInTheDocument();
  });

  it('verzoent manualUnread vanuit de server bij een refetch', async () => {
    renderPage();
    await waitForLoaded();
    expect(screen.queryByTestId('badge-unread-thread-a')).not.toBeInTheDocument();

    // De server geeft nu thread-a terug als bewust-ongelezen; een realtime-event
    // triggert een (gedebouncede) refetch die de markering moet overnemen.
    threadsResponse = { ...threadsResponse, manualUnread: ['thread-a'] };
    act(() => {
      realtimeHandlers.forEach((h) => h());
    });

    const badge = await screen.findByTestId('badge-unread-thread-a');
    expect(badge).toHaveTextContent(nl['studiecafe.unread.thread']);
    // unreadStats reflecteert de server-markering in de banner.
    expect(screen.getByTestId('banner-unread')).toHaveTextContent(nl['studiecafe.unread.bannerOne']);
    // thread-b blijft gelezen.
    expect(screen.queryByTestId('badge-unread-thread-b')).not.toBeInTheDocument();
  });
});
