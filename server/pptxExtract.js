// PowerPoint (.pptx) RAG-extractie en semantische chunking.
//
// Dit module bevat pure helpers (geen netwerk) zodat ze los testbaar zijn,
// plus `extractPptxStructured` dat een .pptx-buffer (een zip) uitleest tot een
// geordende lijst dia's met titel, tekst en sprekersnotities.
//
// De LLM-chunkingstap zelf draait in server/index.js (heeft de OpenAI-plumbing);
// hier staan de deck-opbouw, validatie van het LLM-antwoord en het
// deterministische vangnet.

import { unzipSync, strFromU8 } from 'fflate';

const TARGET_TOKENS = 1000;

// Ruwe tokenschatting (zelfde heuristiek als de client-chunker).
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

// XML-entiteiten terug naar platte tekst.
export function decodeXmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// Alle paragrafen (<a:p>) uit een stuk slide-/notes-XML als regels.
// Runs (<a:t>) binnen een paragraaf worden samengevoegd; lege regels vallen weg.
export function paragraphsText(xml) {
  if (!xml) return [];
  const paras = [];
  for (const p of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    const runs = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => decodeXmlEntities(r[1]));
    const line = runs.join('').replace(/\s+/g, ' ').trim();
    if (line) paras.push(line);
  }
  return paras;
}

function parseShapes(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
}

function shapeIsTitle(shapeXml) {
  return /<p:ph\b[^>]*\btype="(title|ctrTitle)"/.test(shapeXml);
}

// Verwijder per element de eerste matchende voorkomst uit `arr`.
function subtractFirst(arr, toRemove) {
  const out = [...arr];
  for (const item of toRemove) {
    const idx = out.indexOf(item);
    if (idx !== -1) out.splice(idx, 1);
  }
  return out;
}

// Parse één slide-XML naar { title, body }.
export function parseSlideXml(slideXml) {
  const allParas = paragraphsText(slideXml);
  let titleParas = [];
  for (const sp of parseShapes(slideXml)) {
    if (shapeIsTitle(sp)) {
      const p = paragraphsText(sp);
      if (p.length) { titleParas = p; break; }
    }
  }
  const title = titleParas.join(' ').trim();
  const body = subtractFirst(allParas, titleParas).join('\n').trim();
  return { title, body };
}

// Parse notes-XML naar platte notitietekst; filtert losse paginanummers eruit.
export function parseNotesXml(notesXml) {
  return paragraphsText(notesXml)
    .filter((line) => !/^\d{1,4}$/.test(line.trim()))
    .join('\n')
    .trim();
}

function parseRels(relsXml) {
  const map = {};
  if (!relsXml) return map;
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) map[id] = target;
  }
  return map;
}

// Resolve een relatief relationship-pad (mogelijk met ../) t.o.v. een basismap.
function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = (baseDir + target).split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '..') stack.pop();
    else if (part === '.' || part === '') continue;
    else stack.push(part);
  }
  return stack.join('/');
}

// Lees een .pptx-buffer uit tot een geordende lijst dia's:
// [{ slide, title, body, notes }]. Volgorde volgt presentation.xml; valt
// terug op numerieke bestandsvolgorde als die niet te bepalen is.
export function extractPptxStructured(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const get = (path) => (files[path] ? strFromU8(files[path]) : null);

  let slidePaths = [];
  const presXml = get('ppt/presentation.xml');
  const presRels = parseRels(get('ppt/_rels/presentation.xml.rels'));
  if (presXml) {
    for (const m of presXml.matchAll(/<p:sldId\b[^>]*?\br:id="([^"]+)"/g)) {
      const target = presRels[m[1]];
      if (target) slidePaths.push(resolvePath('ppt/', target));
    }
  }
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)[1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)[1], 10);
        return na - nb;
      });
  }

  const slides = [];
  slidePaths.forEach((slidePath, idx) => {
    const slideXml = get(slidePath);
    if (slideXml == null) return;
    const { title, body } = parseSlideXml(slideXml);

    let notes = '';
    const dir = slidePath.replace(/[^/]+$/, '');
    const base = slidePath.slice(dir.length);
    const relsXml = get(`${dir}_rels/${base}.rels`);
    if (relsXml) {
      const rels = parseRels(relsXml);
      const notesTarget = Object.values(rels).find((t) => /notesSlide/i.test(t));
      if (notesTarget) notes = parseNotesXml(get(resolvePath(dir, notesTarget)));
    }

    slides.push({ slide: idx + 1, title, body, notes });
  });

  return slides;
}

// Tekstweergave van één dia (voor zowel de LLM-prompt als fallback-chunks).
export function slideToText(slide) {
  let out = `Dia ${slide.slide}`;
  if (slide.title) out += `: ${slide.title}`;
  const lines = [out];
  if (slide.body) lines.push(slide.body);
  if (slide.notes) lines.push(`Notities: ${slide.notes}`);
  return lines.join('\n');
}

// Bouw de volledige deck-weergave die naar het taalmodel gaat.
export function buildDeckText(slides) {
  return slides.map(slideToText).join('\n\n');
}

// Valideer + normaliseer het LLM-antwoord tot bruikbare secties.
// `minSlide`/`maxSlide` begrenzen de toegestane dia-nummers (bij windowing
// zijn dat absolute nummers, bijv. 13..24). Retourneert een array secties, of
// null als er niks bruikbaars in zit.
export function validateSections(parsed, minSlide = 1, maxSlide = Number.MAX_SAFE_INTEGER) {
  const raw = Array.isArray(parsed) ? parsed : parsed?.sections;
  if (!Array.isArray(raw)) return null;
  const lo = Math.min(minSlide, maxSlide);
  const hi = Math.max(minSlide, maxSlide);
  const sections = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const content = typeof s.content === 'string' ? s.content.trim() : '';
    if (!content) continue;
    let start = parseInt(s.slideStart, 10);
    let end = parseInt(s.slideEnd, 10);
    if (!Number.isFinite(start)) start = lo;
    if (!Number.isFinite(end)) end = hi;
    start = Math.max(lo, Math.min(hi, start));
    end = Math.max(lo, Math.min(hi, end));
    if (start > end) [start, end] = [end, start];
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 200) : '';
    sections.push({ title, slideStart: start, slideEnd: end, content });
  }
  return sections.length ? sections : null;
}

// Deterministisch vangnet: voeg opeenvolgende dia's samen tot chunks van
// ~targetTokens. Gebruikt wanneer de LLM-stap faalt of uitvalt.
export function fallbackChunks(slides, targetTokens = TARGET_TOKENS) {
  const sections = [];
  let buf = [];
  let bufText = '';

  const flush = () => {
    if (!buf.length) return;
    sections.push({
      title: buf[0].title || `Dia ${buf[0].slide}`,
      slideStart: buf[0].slide,
      slideEnd: buf[buf.length - 1].slide,
      content: buf.map(slideToText).join('\n\n'),
    });
    buf = [];
    bufText = '';
  };

  for (const slide of slides) {
    const text = slideToText(slide);
    const candidate = bufText ? `${bufText}\n\n${text}` : text;
    if (buf.length && estimateTokens(candidate) > targetTokens) {
      flush();
      bufText = text;
      buf = [slide];
    } else {
      bufText = candidate;
      buf.push(slide);
    }
  }
  flush();
  return sections;
}

// Splits één te lange alinea op woordgrenzen in stukken van ~maxTokens.
function splitParagraphByWords(para, maxTokens) {
  const words = para.split(/\s+/).filter(Boolean);
  const pieces = [];
  let buf = '';
  for (const w of words) {
    const candidate = buf ? `${buf} ${w}` : w;
    if (buf && estimateTokens(candidate) > maxTokens) {
      pieces.push(buf);
      buf = w;
    } else {
      buf = candidate;
    }
  }
  if (buf) pieces.push(buf);
  return pieces.length ? pieces : [para];
}

// Knip een te lange sectie-inhoud op in stukken van ~maxTokens (op
// alineagrenzen; valt terug op woordgrenzen voor extreem lange alinea's).
// Behoudt de dia-metadata van de sectie.
export function splitLongSections(sections, maxTokens = 1200) {
  const out = [];
  for (const s of sections) {
    if (estimateTokens(s.content) <= maxTokens) {
      out.push(s);
      continue;
    }
    // Splits eerst op alinea's; alinea's die zelf nog te groot zijn worden
    // verder op woordgrenzen opgeknipt zodat geen enkele chunk de limiet
    // (en daarmee het embedding-token-budget) overschrijdt.
    const paras = s.content.split(/\n\n+/).flatMap((p) =>
      estimateTokens(p) > maxTokens ? splitParagraphByWords(p, maxTokens) : [p]
    );
    let buf = '';
    for (const p of paras) {
      const candidate = buf ? `${buf}\n\n${p}` : p;
      if (buf && estimateTokens(candidate) > maxTokens) {
        out.push({ ...s, content: buf });
        buf = p;
      } else {
        buf = candidate;
      }
    }
    if (buf) out.push({ ...s, content: buf });
  }
  return out;
}

export { TARGET_TOKENS };
