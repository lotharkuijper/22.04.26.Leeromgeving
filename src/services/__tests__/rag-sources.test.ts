import { describe, it, expect } from 'vitest';
import {
  slideRangeFromMetadata,
  chunkToDisplaySource,
  dedupeSourcesByDocument,
} from '../rag.service';
import { slideLabel } from '../../components/SourceList';

describe('slideRangeFromMetadata', () => {
  it('geeft null voor niet-pptx of lege metadata', () => {
    expect(slideRangeFromMetadata(null)).toBeNull();
    expect(slideRangeFromMetadata(undefined)).toBeNull();
    expect(slideRangeFromMetadata({})).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pdf', slideStart: 2 })).toBeNull();
    expect(slideRangeFromMetadata({ source: 'pptx' })).toBeNull();
  });

  it('leest dia-reeks uit pptx-metadata, met fallback naar één dia', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 4, slideEnd: 6 })).toEqual({ start: 4, end: 6 });
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 3 })).toEqual({ start: 3, end: 3 });
  });

  it('corrigeert omgedraaide grenzen', () => {
    expect(slideRangeFromMetadata({ source: 'pptx', slideStart: 8, slideEnd: 5 })).toEqual({ start: 8, end: 8 });
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

  it('laat dia-velden weg voor niet-pptx bronnen', () => {
    const src = chunkToDisplaySource({
      documentTitle: 'reader.pdf',
      similarity: 0.7,
      documentId: 'doc-2',
      metadata: { source: 'pdf' },
    });
    expect(src).not.toHaveProperty('slideStart');
    expect(src).not.toHaveProperty('slideEnd');
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
