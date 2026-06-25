import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  sofficeInputName,
  sofficePdfOutputName,
  buildSofficeArgs,
  renditionCachePath,
  renditionSourceType,
  normalizeExt,
  CONVERT_TO_PDF_EXT,
} from '../documentRender.js';

// Lichte regressienet voor de docx/pptx → PDF-conversie en de rendition-cache.
// Doel: de command-bedrading en cache-sleutel blijven intact na een refactor of
// dependency-bump — ZONDER een echte (trage) headless LibreOffice-conversie.

describe('sofficeInputName', () => {
  it('bouwt de invoernaam uit de genormaliseerde extensie', () => {
    expect(sofficeInputName('pptx')).toBe('input.pptx');
    expect(sofficeInputName('DOCX')).toBe('input.docx');
    expect(sofficeInputName('.odp')).toBe('input.odp');
  });
});

describe('sofficePdfOutputName', () => {
  it('leidt de PDF-uitvoernaam af van de invoernaam (basis + .pdf)', () => {
    expect(sofficePdfOutputName('input.pptx')).toBe('input.pdf');
    expect(sofficePdfOutputName('input.docx')).toBe('input.pdf');
    expect(sofficePdfOutputName('input.odt')).toBe('input.pdf');
  });

  it('blijft in sync met sofficeInputName voor alle ondersteunde formaten', () => {
    // Dit is de kern van de garantie: LibreOffice schrijft <basis>.pdf, dus het
    // pad waarop de server de output verwacht moet daaruit afgeleid blijven.
    for (const ext of CONVERT_TO_PDF_EXT) {
      const inputName = sofficeInputName(ext);
      expect(sofficePdfOutputName(inputName)).toBe('input.pdf');
    }
  });

  it('negeert mappen in het pad en houdt alleen de basisnaam', () => {
    expect(sofficePdfOutputName(path.join('/tmp', 'leapvu-render-x', 'input.pptx'))).toBe('input.pdf');
  });
});

describe('buildSofficeArgs', () => {
  const args = buildSofficeArgs({
    profileDir: '/tmp/profile',
    outDir: '/tmp/work',
    inputPath: '/tmp/work/input.pptx',
  });

  it('draait headless en zonder herstel/lock-checks', () => {
    expect(args).toContain('--headless');
    expect(args).toContain('--norestore');
    expect(args).toContain('--nolockcheck');
  });

  it('converteert naar pdf met de juiste uitvoermap', () => {
    const i = args.indexOf('--convert-to');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('pdf');
    const o = args.indexOf('--outdir');
    expect(o).toBeGreaterThanOrEqual(0);
    expect(args[o + 1]).toBe('/tmp/work');
  });

  it('geeft elk proces een eigen UserInstallation-profiel (geen gedeeld profiel)', () => {
    expect(args).toContain('-env:UserInstallation=file:///tmp/profile');
  });

  it('zet het invoerbestand als laatste argument', () => {
    expect(args[args.length - 1]).toBe('/tmp/work/input.pptx');
  });
});

describe('renditionCachePath', () => {
  it('plaatst renditions onder __renditions__ als PDF', () => {
    const p = renditionCachePath('doc-123', null);
    expect(p).toBe('__renditions__/doc-123.pdf');
  });

  it('verwerkt updated_at als cache-buster in de sleutel', () => {
    const iso = '2026-06-24T10:00:00.000Z';
    const stamp = Date.parse(iso);
    expect(renditionCachePath('doc-123', iso)).toBe(`__renditions__/doc-123-${stamp}.pdf`);
  });

  it('geeft een verse sleutel wanneer de bron wordt vervangen (andere updated_at)', () => {
    const a = renditionCachePath('doc-123', '2026-06-24T10:00:00.000Z');
    const b = renditionCachePath('doc-123', '2026-06-25T10:00:00.000Z');
    expect(a).not.toBe(b);
  });

  it('valt terug op een stabiele sleutel zonder updated_at en bij onparseerbare datum', () => {
    expect(renditionCachePath('doc-123', '')).toBe('__renditions__/doc-123.pdf');
    expect(renditionCachePath('doc-123', 'niet-een-datum')).toBe('__renditions__/doc-123.pdf');
  });
});

describe('renditionSourceType', () => {
  it('labelt presentaties als pptx', () => {
    expect(renditionSourceType('pptx')).toBe('pptx');
    expect(renditionSourceType('ppt')).toBe('pptx');
    expect(renditionSourceType('odp')).toBe('pptx');
  });

  it('labelt tekstdocumenten als docx', () => {
    expect(renditionSourceType('docx')).toBe('docx');
    expect(renditionSourceType('doc')).toBe('docx');
    expect(renditionSourceType('odt')).toBe('docx');
  });

  it('dekt elke conversie-extensie af met een geldig viewer-label', () => {
    for (const ext of CONVERT_TO_PDF_EXT) {
      expect(['pptx', 'docx']).toContain(renditionSourceType(ext));
    }
  });
});

describe('normalizeExt', () => {
  it('lowercased en strikt de leidende punt', () => {
    expect(normalizeExt('.PPTX')).toBe('pptx');
    expect(normalizeExt('Docx')).toBe('docx');
  });
});
