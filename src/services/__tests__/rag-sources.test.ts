import { describe, it, expect } from 'vitest';
import {
  slideRangeFromMetadata,
  pageRangeFromMetadata,
  chunkToDisplaySource,
  dedupeSourcesByDocument,
} from '../rag.service';
import { slideLabel, pageLabel, locationLabel } from '../../components/SourceList';

describe('slideRangeFromMetadata', () => {
  it('geeft null voor niet-pptx of lege metadata', () => {
    expect(slideRangeFromMetadata(null)).toBeNull();
    expect(slideRangeFromMetadata(undefined)).toBeNull();
    expect(slideRangeFromMetadata({})).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pdf', slideStart: 2 })).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pptx' })).toBeNull();
  });

  it('geeft null voor niet-object metadata (string/number/boolean)', () => {
    expect(slideRangeFromMetadata('pptx')).toBeNull();
    expect(slideRangeFromMetadata(42)).toBeNull();
    expect(slideRangeFromMetadata(true)).toBeNull();
  });

  it('geeft null wanneer slideStart geen geldig getal is (NaN)', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 'abc' })).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: NaN })).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: undefined })).toBeNull();
  });

  it('valt terug op slideStart wanneer slideEnd geen geldig getal is (NaN)', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 5, slideEnd: 'x' })).toEqual({ start: 5, end: 5 });
  });

  it('leest dia-reeks uit pptx-metadata, met fallback naar één dia', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 4, slideEnd: 6 })).toEqual({ start: 4, end: 6 });
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 3 })).toEqual({ start: 3, end: 3 });
  });

  it('corrigeert omgedraaide grenzen', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 8, slideEnd: 5 })).toEqual({ start: 8, end: 8 });
  });
});

describe('pageRangeFromMetadata', () => {
  it('geeft null voor pptx of lege/ongeldige metadata', () => {
    expect(pageRangeFromMetadata(null)).toBeNull();
    expect(pageRangeFromMetadata({})).toBeNull();
    expect(pageRangeFromMetadata({ source: 'pptx', pageStart: 3 })).toBeNull();
    expect(pageRangeFromMetadata({ pageStart: 'x' })).toBeNull();
    expect(pageRangeFromMetadata({ pageStart: 0 })).toBeNull();
  });

  it('leest pagina-reeks uit pdf-metadata, met fallback naar één pagina', () => {
    expect(pageRangeFromMetadata({ pageStart: 12, pageEnd: 13 })).toEqual({ start: 12, end: 13 });
    expect(pageRangeFromMetadata({ pageStart: 5 })).toEqual({ start: 5, end: 5 });
    expect(pageRangeFromMetadata({ source: 'pdf', pageStart: 7, pageEnd: 4 })).toEqual({ start: 7, end: 7 });
  });
});

describe('chunkToDisplaySource', () => {
  it('neemt dia-reeks mee voor pptx-chunks', () => {
    const src = chunkToDisplaySource({
      documentTitle: 'College 3.pptx',
      similarity: 0.8,
      documentId: 'doc-1',
      metadata: { source: 'pptx', slideStart: 4, slideEnd: 6 },
    });
    expect(src).toMatchObject({ title: 'College 3.pptx', documentId: 'doc-1', slideStart: 4, slideEnd: 6 });
  });

  it('neemt pagina-reeks mee voor pdf-chunks', () => {
    const src = chunkToDisplaySource({
      documentTitle: 'Hoofdstuk 1.pdf',
      similarity: 0.7,
      documentId: 'doc-2',
      metadata: { source: 'pdf', pageStart: 12, pageEnd: 13 },
    });
    expect(src).toMatchObject({ title: 'Hoofdstuk 1.pdf', documentId: 'doc-2', pageStart: 12, pageEnd: 13 });
    expect(src).not.toHaveProperty('slideStart');
  });

  it('laat vindplaats-velden weg voor bronnen zonder pagina/dia-info', () => {
    const src = chunkToDisplaySource({
      documentTitle: 'aantekeningen.txt',
      similarity: 0.7,
      documentId: 'doc-3',
      metadata: { source: 'text' },
    });
    expect(src).not.toHaveProperty('slideStart');
    expect(src).not.toHaveProperty('pageStart');
  });
});

describe('dedupeSourcesByDocument met dia-reeksen', () => {
  it('houdt verschillende dia-reeksen uit hetzelfde document apart', () => {
    const out = dedupeSourcesByDocument(
      [
        { title: 'College.pptx', similarity: 0.9, documentId: 'd1', slideStart: 1, slideEnd: 3 },
        { title: 'College.pptx', similarity: 0.8, documentId: 'd1', slideStart: 7, slideEnd: 9 },
        { title: 'College.pptx', similarity: 0.5, documentId: 'd1', slideStart: 1, slideEnd: 3 },
      ],
      5
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => `${s.slideStart}-${s.slideEnd}`).sort()).toEqual(['1-3', '7-9']);
  });

  it('voegt niet-pptx documenten samen tot één bron', () => {
    const out = dedupeSourcesByDocument(
      [
        { title: 'reader.pdf', similarity: 0.6, documentId: 'd2' },
        { title: 'reader.pdf', similarity: 0.9, documentId: 'd2' },
      ],
      5
    );
    expect(out).toHaveLength(1);
    expect(out[0].similarity).toBe(0.9);
  });

  it('houdt verschillende paginabereiken uit hetzelfde PDF apart', () => {
    const out = dedupeSourcesByDocument(
      [
        { title: 'reader.pdf', similarity: 0.9, documentId: 'd3', pageStart: 12, pageEnd: 13 },
        { title: 'reader.pdf', similarity: 0.8, documentId: 'd3', pageStart: 40 },
        { title: 'reader.pdf', similarity: 0.5, documentId: 'd3', pageStart: 12, pageEnd: 13 },
      ],
      5
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => `${s.pageStart}-${s.pageEnd ?? s.pageStart}`).sort()).toEqual(['12-13', '40-40']);
  });
});

describe('slideLabel', () => {
  it('formatteert een dia-reeks en losse dia', () => {
    expect(slideLabel({ slideStart: 4, slideEnd: 6 })).toBe('dia 4–6');
    expect(slideLabel({ slideStart: 4, slideEnd: 4 })).toBe('dia 4');
    expect(slideLabel({ slideStart: 4 })).toBe('dia 4');
  });

  it('respecteert een ander woord (Engels)', () => {
    expect(slideLabel({ slideStart: 2, slideEnd: 5 }, 'slide')).toBe('slide 2–5');
  });

  it('geeft lege string voor bronnen zonder dia-info', () => {
    expect(slideLabel({})).toBe('');
  });
});

describe('pageLabel', () => {
  it('formatteert een paginabereik en losse pagina', () => {
    expect(pageLabel({ pageStart: 12, pageEnd: 13 })).toBe('p. 12–13');
    expect(pageLabel({ pageStart: 12, pageEnd: 12 })).toBe('p. 12');
    expect(pageLabel({ pageStart: 7 })).toBe('p. 7');
  });

  it('respecteert een ander woord', () => {
    expect(pageLabel({ pageStart: 3 }, 'pagina')).toBe('pagina 3');
  });

  it('geeft lege string voor bronnen zonder pagina-info', () => {
    expect(pageLabel({})).toBe('');
  });
});

describe('locationLabel', () => {
  it('geeft het dia-label voor PowerPoint-bronnen', () => {
    expect(locationLabel({ slideStart: 4, slideEnd: 6 }, 'dia', 'p.')).toBe('dia 4–6');
  });

  it('geeft het paginalabel voor PDF-bronnen', () => {
    expect(locationLabel({ pageStart: 12, pageEnd: 13 }, 'dia', 'p.')).toBe('p. 12–13');
  });

  it('geeft lege string zonder vindplaats', () => {
    expect(locationLabel({}, 'dia', 'p.')).toBe('');
  });
});

describe('student-zichtbare pptx-bron end-to-end', () => {
  it('verwijst naar de juiste PowerPoint met dia-aanduiding', () => {
    const chunks = [
      { documentTitle: 'Statistiek H2.pptx', similarity: 0.91, documentId: 'p1', metadata: { source: 'pptx', slideStart: 4, slideEnd: 6 } },
      { documentTitle: 'reader.pdf', similarity: 0.4, documentId: 'r1', metadata: { source: 'pdf' } },
    ];
    const sources = dedupeSourcesByDocument(chunks.map((c) => chunkToDisplaySource(c)), 5);
    const labels = sources.map((s) => `${s.title}${slideLabel(s) ? ` · ${slideLabel(s)}` : ''}`);
    expect(labels).toContain('Statistiek H2.pptx · dia 4–6');
    expect(labels).toContain('reader.pdf');
  });
});
