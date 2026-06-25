import { describe, it, expect } from 'vitest';
import { assignPdfPages, normalizeForMatch } from '../pdfPages.js';

// Minimale chunk; assignPdfPages mapt op tekst-inhoud, niet op offset.
function mk(text) {
  return { text, metadata: {} };
}

describe('normalizeForMatch (server)', () => {
  it('collapst witruimte en lowercased', () => {
    expect(normalizeForMatch('  Alpha   Beta\n\nGamma\t')).toBe('alpha beta gamma');
  });
});

describe('assignPdfPages (server)', () => {
  it('koppelt een chunk binnen één pagina aan die pagina', () => {
    const pages = ['Alpha beta gamma delta.', 'Epsilon zeta eta theta.'];
    const chunks = [mk('beta gamma')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBe(1);
    expect(chunks[0].metadata.pageEnd).toBe(1);
    expect(chunks[0].metadata.pageNumber).toBe(1);
  });

  it('geeft een paginabereik voor een chunk die over een paginagrens loopt', () => {
    const pages = ['Alpha beta gamma delta.', 'Epsilon zeta eta theta.'];
    const chunks = [mk('delta. Epsilon zeta')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBe(1);
    expect(chunks[0].metadata.pageEnd).toBe(2);
  });

  it('negeert verschillen in witruimte/hoofdletters bij het terugvinden', () => {
    const pages = ['Alpha beta gamma delta.', 'Epsilon zeta eta theta.'];
    const chunks = [mk('BETA   gamma\n\nDELTA.')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBe(1);
    expect(chunks[0].metadata.pageEnd).toBe(1);
  });

  it('mapt herhaalde signaturen op volgorde naar de juiste pagina (vooruit-cursor)', () => {
    const pages = [
      'Intro een. Gedeelde zin. Slot een.',
      'Intro twee. Gedeelde zin. Slot twee.',
    ];
    const chunks = [mk('Gedeelde zin'), mk('Gedeelde zin')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBe(1);
    expect(chunks[1].metadata.pageStart).toBe(2);
  });

  it('telt lege pagina’s mee in de nummering', () => {
    const pages = ['Pagina een inhoud.', '', 'Pagina drie inhoud.'];
    const chunks = [mk('Pagina drie inhoud')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBe(3);
    expect(chunks[0].metadata.pageEnd).toBe(3);
  });

  it('laat paginavelden weg wanneer de chunk niet betrouwbaar terug te vinden is', () => {
    const pages = ['Alpha beta gamma delta.', 'Epsilon zeta eta theta.'];
    const chunks = [mk('Deze passage komt nergens in het brondocument voor en is dus niet te koppelen.')];
    assignPdfPages(pages, chunks);
    expect(chunks[0].metadata.pageStart).toBeUndefined();
    expect(chunks[0].metadata.pageEnd).toBeUndefined();
  });

  it('verandert niets wanneer er geen pagina-tekst is', () => {
    const chunks = [mk('Iets')];
    assignPdfPages([], chunks);
    expect(chunks[0].metadata.pageStart).toBeUndefined();
  });
});
