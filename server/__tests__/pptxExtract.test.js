import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  decodeXmlEntities,
  paragraphsText,
  parseSlideXml,
  parseNotesXml,
  extractPptxStructured,
  slideToText,
  buildDeckText,
  validateSections,
  fallbackChunks,
  splitLongSections,
  estimateTokens,
} from '../pptxExtract.js';

describe('decodeXmlEntities', () => {
  it('decodeert standaard-entiteiten', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe('a & b <c> "d" \'e\'');
  });
  it('decodeert numerieke en hex entiteiten', () => {
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
  });
  it('verwerkt &amp; als laatste zodat dubbel-encoding klopt', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('paragraphsText', () => {
  it('voegt runs binnen een paragraaf samen en splitst paragrafen', () => {
    const xml = '<a:p><a:r><a:t>Hallo </a:t></a:r><a:r><a:t>wereld</a:t></a:r></a:p><a:p><a:r><a:t>Tweede</a:t></a:r></a:p>';
    expect(paragraphsText(xml)).toEqual(['Hallo wereld', 'Tweede']);
  });
  it('negeert lege paragrafen', () => {
    expect(paragraphsText('<a:p></a:p><a:p><a:t>  </a:t></a:p>')).toEqual([]);
  });
});

describe('parseSlideXml', () => {
  it('haalt titel uit title-placeholder en de rest als body', () => {
    const slide = `
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:t>Mijn titel</a:t></a:p></p:txBody></p:sp>
      <p:sp><p:txBody><a:p><a:t>Punt een</a:t></a:p><a:p><a:t>Punt twee</a:t></a:p></p:txBody></p:sp>`;
    const { title, body } = parseSlideXml(slide);
    expect(title).toBe('Mijn titel');
    expect(body).toBe('Punt een\nPunt twee');
  });
  it('valt zonder title-placeholder terug op alle tekst als body', () => {
    const slide = '<p:sp><p:txBody><a:p><a:t>Alleen body</a:t></a:p></p:txBody></p:sp>';
    const { title, body } = parseSlideXml(slide);
    expect(title).toBe('');
    expect(body).toBe('Alleen body');
  });
});

describe('parseNotesXml', () => {
  it('extraheert notities en filtert losse paginanummers', () => {
    const notes = '<a:p><a:t>Vertel iets</a:t></a:p><a:p><a:t>12</a:t></a:p><a:p><a:t>over de stof</a:t></a:p>';
    expect(parseNotesXml(notes)).toBe('Vertel iets\nover de stof');
  });
});

describe('validateSections', () => {
  it('normaliseert en clampt dia-nummers binnen het bereik', () => {
    const parsed = { sections: [
      { title: 'A', slideStart: 0, slideEnd: 99, content: 'tekst' },
      { title: 'B', slideStart: 3, slideEnd: 2, content: 'meer' },
    ] };
    const out = validateSections(parsed, 1, 5);
    expect(out).toEqual([
      { title: 'A', slideStart: 1, slideEnd: 5, content: 'tekst' },
      { title: 'B', slideStart: 2, slideEnd: 3, content: 'meer' },
    ]);
  });
  it('verwijdert secties zonder inhoud', () => {
    expect(validateSections({ sections: [{ content: '   ' }] }, 1, 3)).toBeNull();
  });
  it('geeft null bij ongeldige vorm', () => {
    expect(validateSections({ foo: 1 }, 1, 3)).toBeNull();
    expect(validateSections('nope', 1, 3)).toBeNull();
  });
  it('respecteert absolute dia-nummers bij windowing', () => {
    const out = validateSections({ sections: [{ slideStart: 13, slideEnd: 18, content: 'x' }] }, 13, 24);
    expect(out[0]).toMatchObject({ slideStart: 13, slideEnd: 18 });
  });
});

describe('fallbackChunks / splitLongSections', () => {
  const slides = [
    { slide: 1, title: 'T1', body: 'korte tekst', notes: '' },
    { slide: 2, title: 'T2', body: 'nog wat', notes: 'notitie' },
    { slide: 3, title: 'T3', body: 'meer', notes: '' },
  ];
  it('groepeert dia\'s tot chunks en behoudt dia-bereik', () => {
    const out = fallbackChunks(slides, 1000);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ slideStart: 1, slideEnd: 3 });
    expect(out[0].content).toContain('Notities: notitie');
  });
  it('splitst per dia bij een zeer kleine token-budget', () => {
    const out = fallbackChunks(slides, 1);
    expect(out.length).toBe(3);
    expect(out.map((s) => s.slideStart)).toEqual([1, 2, 3]);
  });
  it('splitLongSections laat korte secties ongemoeid', () => {
    const sections = [{ title: 'x', slideStart: 1, slideEnd: 1, content: 'kort' }];
    expect(splitLongSections(sections, 1200)).toEqual(sections);
  });
  it('splitLongSections knipt lange secties op alineagrenzen', () => {
    const longPara = Array.from({ length: 50 }, () => 'woord').join(' ');
    const content = [longPara, longPara, longPara].join('\n\n');
    const out = splitLongSections([{ title: 't', slideStart: 1, slideEnd: 2, content }], 80);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((s) => expect(s.slideStart).toBe(1));
  });
});

describe('slideToText / buildDeckText / estimateTokens', () => {
  it('bouwt dia-tekst met titel, body en notities', () => {
    const t = slideToText({ slide: 2, title: 'Kop', body: 'Inhoud', notes: 'Let op' });
    expect(t).toBe('Dia 2: Kop\nInhoud\nNotities: Let op');
  });
  it('buildDeckText scheidt dia\'s met lege regel', () => {
    const deck = buildDeckText([
      { slide: 1, title: 'A', body: '', notes: '' },
      { slide: 2, title: 'B', body: '', notes: '' },
    ]);
    expect(deck).toBe('Dia 1: A\n\nDia 2: B');
  });
  it('estimateTokens telt globaal woorden', () => {
    expect(estimateTokens('een twee drie')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('extractPptxStructured', () => {
  function buildPptx() {
    const slide1 = `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:txBody><a:p><a:t>Introductie</a:t></a:p></p:txBody></p:sp>
        <p:sp><p:txBody><a:p><a:t>Eerste punt</a:t></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`;
    const slide2 = `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:txBody><a:p><a:t>Tweede dia</a:t></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`;
    const notes1 = '<?xml version="1.0"?><p:notes xmlns:a="y"><a:p><a:t>Spreker zegt iets</a:t></a:p></p:notes>';
    const slide1Rels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="../notesSlides/notesSlide1.xml"/></Relationships>';
    const presentation = '<?xml version="1.0"?><p:presentation xmlns:p="x" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>';
    const presRels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="t" Target="slides/slide2.xml"/></Relationships>';
    return zipSync({
      'ppt/presentation.xml': strToU8(presentation),
      'ppt/_rels/presentation.xml.rels': strToU8(presRels),
      'ppt/slides/slide1.xml': strToU8(slide1),
      'ppt/slides/slide2.xml': strToU8(slide2),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(slide1Rels),
      'ppt/notesSlides/notesSlide1.xml': strToU8(notes1),
    });
  }

  it('leest dia\'s in presentatievolgorde met titel, body en notities', () => {
    const slides = extractPptxStructured(Buffer.from(buildPptx()));
    expect(slides.length).toBe(2);
    expect(slides[0]).toMatchObject({ slide: 1, title: 'Introductie', body: 'Eerste punt', notes: 'Spreker zegt iets' });
    expect(slides[1]).toMatchObject({ slide: 2, title: 'Tweede dia', notes: '' });
  });

  it('valt terug op numerieke bestandsvolgorde zonder presentation.xml', () => {
    const slide = '<p:sld><p:sp><p:txBody><a:p><a:t>Inhoud</a:t></a:p></p:txBody></p:sp></p:sld>';
    const zip = zipSync({
      'ppt/slides/slide2.xml': strToU8(slide.replace('Inhoud', 'Twee')),
      'ppt/slides/slide1.xml': strToU8(slide.replace('Inhoud', 'Een')),
    });
    const slides = extractPptxStructured(Buffer.from(zip));
    expect(slides.map((s) => s.body)).toEqual(['Een', 'Twee']);
  });
});
