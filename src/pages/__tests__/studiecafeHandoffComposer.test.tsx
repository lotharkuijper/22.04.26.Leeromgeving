// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Net als StudiecafePage.test.tsx: stabiele referenties voor auth + cursus zodat
// het laad-effect niet oneindig herhaalt, en een nep-realtime-kanaal.
vi.mock('../../contexts/AuthContext', () => {
  const session = { access_token: 'test-token' };
  return { useAuth: () => ({ session }) };
});

vi.mock('../../contexts/ActiveCourseContext', () => {
  const activeCourse = { name: 'Statistiek' };
  return { useActiveCourse: () => ({ activeCourseId: 'course-1', activeCourse }) };
});

const channelObj: any = {
  on: vi.fn(() => channelObj),
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

// ChatExcerptCard opent bronnen via een geauthenticeerde fetch; in de test is
// dat niet nodig.
vi.mock('../../services/rag.service', () => ({ openRagDocument: vi.fn() }));

import { StudiecafePage } from '../StudiecafePage';
import { LanguageProvider } from '../../i18n';
import { stashStudiecafeHandoff } from '../../lib/studiecafeHandoff';
import { type ChatExcerptAttachment } from '../../components/ChatExcerptCard';

function jsonRes(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

// Lege threads-respons: we testen alleen de composer-voorvulling.
const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = (init?.method || 'GET').toUpperCase();
  if (url.includes('/notification-prefs')) return jsonRes({ email_replies: true, email_announcements: true });
  if (url.endsWith('/threads') && method === 'GET') {
    return jsonRes({ threads: [], isStaff: false, reads: {}, manualUnread: [], lastSeenAt: '2026-06-20T00:00:00.000Z' });
  }
  if (url.endsWith('/seen') && method === 'POST') return jsonRes({ lastSeenAt: '2026-06-20T00:00:00.000Z' });
  return jsonRes({}, true);
});

const ATTACHMENT: ChatExcerptAttachment = {
  type: 'chat_excerpt',
  content: 'Het gemiddelde wordt berekend met $\\bar{x}$ over alle waarnemingen.',
  sources: [{ index: 1, title: 'Statistiek hoofdstuk 2', documentId: 'doc-2' }],
  meta: { module: 'chat', courseId: 'course-1' },
};

function renderPage() {
  return render(
    <LanguageProvider>
      <StudiecafePage />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
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

describe('StudiecafePage — overdracht vanuit de chat', () => {
  it('opent de composer met categorie check-llm en het citaat bij een overdracht', async () => {
    stashStudiecafeHandoff({ v: 1, courseId: 'course-1', category: 'check-llm', attachment: ATTACHMENT });
    renderPage();

    // De composer staat open (titelveld zichtbaar) zonder klik op "open composer".
    await waitFor(() => expect(screen.getByTestId('input-thread-title')).toBeInTheDocument());

    // De categorie check-llm is voorgeselecteerd (ring-2 = actieve chip).
    expect(screen.getByTestId('select-category-check-llm').className).toContain('ring-2');
    expect(screen.getByTestId('select-category-vraag').className).not.toContain('ring-2');

    // De citaat-kaart staat in de composer, mét de inhoud van het AI-antwoord.
    const card = screen.getByTestId('card-chat-excerpt');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Het gemiddelde wordt berekend');
    // En een verwijder-knop (alleen in de composer).
    expect(screen.getByTestId('button-remove-attachment')).toBeInTheDocument();

    // De overdracht is eenmalig: sessionStorage is geleegd.
    expect(sessionStorage.getItem('leapvu:studiecafe-handoff')).toBeNull();
  });

  it('verwijdert de citaat-kaart wanneer de gebruiker op verwijderen klikt', async () => {
    const user = userEvent.setup();
    stashStudiecafeHandoff({ v: 1, courseId: 'course-1', category: 'check-llm', attachment: ATTACHMENT });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('card-chat-excerpt')).toBeInTheDocument());
    await user.click(screen.getByTestId('button-remove-attachment'));
    expect(screen.queryByTestId('card-chat-excerpt')).not.toBeInTheDocument();
  });

  it('opent de composer NIET wanneer er geen overdracht is', async () => {
    renderPage();
    // Wacht tot het laden klaar is (de "begin een gesprek"-knop verschijnt).
    await waitFor(() => expect(screen.getByTestId('button-open-composer')).toBeInTheDocument());
    expect(screen.queryByTestId('input-thread-title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-chat-excerpt')).not.toBeInTheDocument();
  });
});
