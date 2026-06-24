// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Net als chatReplyPicker.test.tsx, maar nu mét retrievedContext.chunks zodat de
// bronnenlijst (SourceList) daadwerkelijk rendert.
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

// rag.service: in deze test rendert AssistantMessageBody mét chunks, dus de
// chunk→bron-helpers moeten realistische waarden teruggeven (de echte logica is
// elders getest; hier stubben we ze deterministisch).
vi.mock('../../services/rag.service', () => ({
  searchRelevantChunksWithStats: vi.fn(),
  buildContextWithCap: vi.fn(),
  dedupeSourcesByDocument: vi.fn((arr: any[]) =>
    [...arr].sort((a, b) => b.similarity - a.similarity),
  ),
  chunkToDisplaySource: vi.fn((c: any) => ({
    title: c.documentTitle,
    similarity: c.similarity,
    documentId: c.documentId,
    ...(c.slideStart != null ? { slideStart: c.slideStart } : {}),
    ...(c.slideEnd != null ? { slideEnd: c.slideEnd } : {}),
    ...(c.pageStart != null ? { pageStart: c.pageStart } : {}),
    ...(c.pageEnd != null ? { pageEnd: c.pageEnd } : {}),
  })),
  ragDocumentDownloadUrl: vi.fn((id?: string) =>
    id ? `/api/rag/documents/${id}/download` : undefined,
  ),
  openRagDocument: vi.fn(),
  chunkToSourceItem: vi.fn(),
}));

// DocumentViewer trekt pdfjs-dist mee (DOMMatrix bestaat niet in jsdom).
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

const RETRIEVED_CONTEXT = {
  chunks: [
    { documentTitle: 'Hoofdstuk 3 — t-toets', similarity: 0.82, documentId: 'doc-1' },
    { documentTitle: 'College 5 — variantie', similarity: 0.74, documentId: 'doc-2' },
  ],
};

function renderBody(
  onRequestSource = vi.fn(),
  content = 'Het gemiddelde is de som gedeeld door het aantal waarnemingen.',
) {
  render(
    <LanguageProvider>
      <AssistantMessageBody
        messageId="msg-1"
        content={content}
        retrievedContext={RETRIEVED_CONTEXT}
        onRequestSource={onRequestSource}
      />
    </LanguageProvider>,
  );
  return onRequestSource;
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

describe('AssistantMessageBody — broncitaties', () => {
  it('rendert de bronnenlijst wanneer retrievedContext chunks bevat', async () => {
    const user = userEvent.setup();
    renderBody();

    // De bronnenlijst-container rendert (ingeklapt: alleen de toggle-knop).
    expect(screen.getByTestId('source-list')).toBeInTheDocument();
    expect(screen.getByTestId('btn-toggle-sources')).toBeInTheDocument();
    // Ingeklapt → de items zijn nog niet zichtbaar.
    expect(screen.queryByTestId('link-source-1')).not.toBeInTheDocument();

    // Uitklappen toont de bron-items, gesorteerd op similarity (doc-1 eerst).
    await user.click(screen.getByTestId('btn-toggle-sources'));
    expect(screen.getByTestId('list-sources')).toBeInTheDocument();
    expect(screen.getByTestId('link-source-1')).toHaveTextContent('Hoofdstuk 3 — t-toets');
    expect(screen.getByTestId('link-source-2')).toHaveTextContent('College 5 — variantie');
  });

  it('klapt de bronnenlijst uit wanneer je op een in-tekst citatie klikt', async () => {
    const user = userEvent.setup();
    renderBody(
      vi.fn(),
      'De t-toets vergelijkt twee gemiddelden [1]. De variantie meet de spreiding [2].',
    );

    // Bronnenlijst staat ingeklapt: list-sources is nog niet zichtbaar.
    expect(screen.queryByTestId('list-sources')).not.toBeInTheDocument();

    // De in-tekst citatiemarkers renderen als klikbare superscripts.
    expect(screen.getByTestId('citation-1')).toBeInTheDocument();
    expect(screen.getByTestId('citation-2')).toBeInTheDocument();

    // Klik op citatie [1] → handleCitationClick opent de SourceList.
    await user.click(screen.getByTestId('citation-1'));

    expect(screen.getByTestId('list-sources')).toBeInTheDocument();
    // De bijbehorende bron is nu zichtbaar en scrollbaar (id source-msg-1-1).
    expect(document.getElementById('source-msg-1-1')).not.toBeNull();
    expect(screen.getByTestId('link-source-1')).toHaveTextContent('Hoofdstuk 3 — t-toets');
  });

  it('toont het dia-label voor PowerPoint-bronnen (enkele dia en dia-reeks)', async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <AssistantMessageBody
          messageId="msg-pptx"
          content="Antwoord met PowerPoint-bronnen."
          retrievedContext={{
            chunks: [
              { documentTitle: 'College 2 — verdelingen', similarity: 0.9, documentId: 'doc-a', slideStart: 4, slideEnd: 6 },
              { documentTitle: 'College 4 — toetsen', similarity: 0.8, documentId: 'doc-b', slideStart: 2 },
            ],
          }}
          onRequestSource={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByTestId('btn-toggle-sources'));

    // Eerste bron (hoogste similarity): dia-reeks 4–6.
    expect(screen.getByTestId('text-location-1')).toHaveTextContent('dia 4–6');
    // Tweede bron: enkele dia (slideEnd ontbreekt → gelijk aan slideStart).
    expect(screen.getByTestId('text-location-2')).toHaveTextContent('dia 2');
    expect(screen.getByTestId('text-location-2')).not.toHaveTextContent('–');
  });

  it('toont het paginalabel voor PDF-bronnen (losse pagina en paginabereik)', async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <AssistantMessageBody
          messageId="msg-pdf"
          content="Antwoord met PDF-bronnen."
          retrievedContext={{
            chunks: [
              { documentTitle: 'Hoofdstuk 1.pdf', similarity: 0.9, documentId: 'doc-c', pageStart: 12, pageEnd: 13 },
              { documentTitle: 'Hoofdstuk 2.pdf', similarity: 0.8, documentId: 'doc-d', pageStart: 5 },
            ],
          }}
          onRequestSource={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByTestId('btn-toggle-sources'));

    // Eerste bron: paginabereik 12–13.
    expect(screen.getByTestId('text-location-1')).toHaveTextContent('p. 12–13');
    // Tweede bron: losse pagina (pageEnd ontbreekt → gelijk aan pageStart).
    expect(screen.getByTestId('text-location-2')).toHaveTextContent('p. 5');
    expect(screen.getByTestId('text-location-2')).not.toHaveTextContent('–');
  });

  it('roept onRequestSource aan met de bron bij het klikken op een bron', async () => {
    const user = userEvent.setup();
    const onRequestSource = renderBody();

    await user.click(screen.getByTestId('btn-toggle-sources'));
    await user.click(screen.getByTestId('link-source-1'));

    expect(onRequestSource).toHaveBeenCalledTimes(1);
    expect(onRequestSource).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', title: 'Hoofdstuk 3 — t-toets' }),
    );
  });
});
