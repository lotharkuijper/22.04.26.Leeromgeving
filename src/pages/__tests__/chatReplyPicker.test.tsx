// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Net als studiecafeHandoffComposer.test.tsx: stabiele referenties voor auth +
// cursus en een nep-supabase (alleen auth.getSession is nodig voor de token).
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' } }),
}));

vi.mock('../../contexts/ActiveCourseContext', () => ({
  useActiveCourse: () => ({ activeCourseId: 'course-1', activeCourse: { name: 'Statistiek' } }),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}));

// rag.service wordt door ChatPage geïmporteerd; in deze test renderen we alleen
// AssistantMessageBody zonder retrievedContext, dus de helpers worden niet
// aangeroepen — we stubben ze toch zodat de module-import licht blijft.
vi.mock('../../services/rag.service', () => ({
  searchRelevantChunksWithStats: vi.fn(),
  buildContextWithCap: vi.fn(),
  dedupeSourcesByDocument: vi.fn(() => []),
  chunkToDisplaySource: vi.fn(),
  ragDocumentDownloadUrl: vi.fn(() => '#'),
  openRagDocument: vi.fn(),
  chunkToSourceItem: vi.fn(),
}));

// DocumentViewer trekt pdfjs-dist mee (DOMMatrix bestaat niet in jsdom); we
// renderen AssistantMessageBody zonder viewer, dus een lege stub volstaat.
vi.mock('../../components/DocumentViewer', () => ({
  DocumentViewer: () => null,
}));

// react-router-dom: alleen useNavigate is nodig in AssistantMessageBody.
const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

import { AssistantMessageBody } from '../ChatPage';
import { LanguageProvider } from '../../i18n';

function jsonRes(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
}

const OPEN_THREAD = {
  id: 'thread-1',
  title: 'Vraag over de t-toets',
  category: 'check-llm',
  isLocked: false,
  replyCount: 2,
};

function threadsResponse(threads: unknown[]) {
  return jsonRes({ threads, isStaff: false, reads: {}, manualUnread: [], lastSeenAt: '2026-06-20T00:00:00.000Z' });
}

function renderBody() {
  return render(
    <LanguageProvider>
      <AssistantMessageBody
        messageId="msg-1"
        content="Het gemiddelde is de som gedeeld door het aantal waarnemingen."
        onRequestSource={vi.fn()}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
    localStorage.setItem('lair-vu-lang', 'nl');
    sessionStorage.clear();
  } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssistantMessageBody — reply-topic-kiezer', () => {
  it('plaatst het AI-antwoord direct als reactie in het gekozen topic (succes)', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/threads') && method === 'GET') return threadsResponse([OPEN_THREAD]);
      if (url.includes('/threads/thread-1/replies') && method === 'POST') return jsonRes({ ok: true });
      return jsonRes({}, true);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderBody();

    // Open de kiezer.
    await user.click(screen.getByTestId('button-check-llm-reply-msg-1'));
    // Het open topic verschijnt.
    await waitFor(() => expect(screen.getByTestId('button-pick-thread-thread-1')).toBeInTheDocument());

    // Plaats direct als reactie.
    await user.click(screen.getByTestId('button-pick-thread-thread-1'));

    // Succes-melding + de POST is met bijlage verstuurd.
    await waitFor(() => expect(screen.getByTestId('reply-post-success-msg-1')).toBeInTheDocument());
    const postCall = fetchMock.mock.calls.find(
      ([u, init]) => String(u).includes('/threads/thread-1/replies') && (init as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments[0]).toMatchObject({ type: 'chat_excerpt' });
    // Geen "topic verdwenen"-melding bij succes.
    expect(screen.queryByTestId('reply-target-gone-msg-1')).not.toBeInTheDocument();
  });

  it('toont de "topic verdwenen"-melding en ververst de lijst bij een 404/403 (Task #361)', async () => {
    const user = userEvent.setup();
    let threadsCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/threads') && method === 'GET') {
        threadsCalls += 1;
        // Eerste keer (kiezer openen): het topic bestaat nog. Daarna (refresh na
        // de 404): het topic is weg.
        return threadsResponse(threadsCalls === 1 ? [OPEN_THREAD] : []);
      }
      if (url.includes('/threads/thread-1/replies') && method === 'POST') return jsonRes({}, false, 404);
      return jsonRes({}, true);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderBody();

    await user.click(screen.getByTestId('button-check-llm-reply-msg-1'));
    await waitFor(() => expect(screen.getByTestId('button-pick-thread-thread-1')).toBeInTheDocument());

    await user.click(screen.getByTestId('button-pick-thread-thread-1'));

    // De inline "topic verdwenen"-melding verschijnt.
    await waitFor(() => expect(screen.getByTestId('reply-target-gone-msg-1')).toBeInTheDocument());
    // De lijst is ververs: GET /threads is minstens twee keer aangeroepen.
    expect(threadsCalls).toBeGreaterThanOrEqual(2);
    // Geen valse succes-melding.
    expect(screen.queryByTestId('reply-post-success-msg-1')).not.toBeInTheDocument();
  });

  it('valideert en stalt de overdracht bij "kies op de Studiecafé-pagina" (handlePickThread)', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/threads') && method === 'GET') return threadsResponse([OPEN_THREAD]);
      return jsonRes({}, true);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderBody();

    await user.click(screen.getByTestId('button-check-llm-reply-msg-1'));
    await waitFor(() => expect(screen.getByTestId('button-pick-in-studiecafe-msg-1')).toBeInTheDocument());

    await user.click(screen.getByTestId('button-pick-in-studiecafe-msg-1'));

    // De overdracht is in sessionStorage gestald in reply-modus zonder
    // targetThreadId (de student kiest het topic alsnog op de pagina).
    await waitFor(() => expect(sessionStorage.getItem('leapvu:studiecafe-handoff')).not.toBeNull());
    const stash = JSON.parse(sessionStorage.getItem('leapvu:studiecafe-handoff') as string);
    expect(stash).toMatchObject({ v: 1, courseId: 'course-1', category: 'check-llm', mode: 'reply' });
    expect(stash.targetThreadId).toBeUndefined();
    expect(stash.attachment).toMatchObject({ type: 'chat_excerpt' });
    // En de navigatie naar het Studiecafé.
    expect(navigateMock).toHaveBeenCalledWith('/studiecafe');
  });
});
