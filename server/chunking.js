// Pure (side-effect-vrije) chunking-helpers voor RAG-ingestie. Losgekoppeld van
// server/index.js zodat zowel de Express-server als losse onderhoudsscripts
// (her-ingestie) exact dezelfde chunk- en embed-logica gebruiken — één bron van
// waarheid voorkomt dat her-ingestie afwijkt van de live-pijplijn.

// Verwijder terugkerende paginakoppen/-voeten (Task #394). Conservatief: alleen
// regels die uitsluitend uit een paginanummer bestaan worden verwijderd. We doen
// bewust GEEN agressieve inline-opschoning (losse cijfers midden in de tekst),
// omdat dat gemeten de embedding-kwaliteit eerder schaadde dan hielp — de winst
// komt vooral van kleinere chunks + titel-context, niet van het strippen zelf.
export function stripRunningHeaders(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cleaned = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true; // lege regels behouden (paragraafgrenzen)
    // Pure paginanummer-regel (1-4 cijfers) → kop/voet, weglaten.
    if (/^\d{1,4}$/.test(t)) return false;
    // "Pagina 12" / "Page 12 of 30"-achtige voetteksten.
    if (/^(pagina|page)\s+\d{1,4}(\s+(van|of)\s+\d{1,4})?$/i.test(t)) return false;
    return true;
  });
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function estimatePlainTokens(text) {
  return Math.ceil(String(text || '').split(/\s+/).filter(Boolean).length * 1.3);
}

// Splitst platte tekst in chunks rond paragraafgrenzen, met overlap en harde
// splitsing van te lange chunks. Standaard-doelgroottes zijn bewust klein
// (~280 tokens) zodat losse figuur-onderschriften, formules en kernzinnen niet
// verdrinken in een grote chunk: een caption als "The tetrahedron of life"
// scoorde in een grote chunk ~0.31 maar als korte chunk ~0.52 tegen dezelfde
// vraag (Task #394). Eerst worden terugkerende paginakoppen/-voeten gestript.
export function chunkPlainText(text, {
  targetTokens = 280,
  maxTokens = 380,
  overlapTokens = 60,
} = {}) {
  const paragraphs = stripRunningHeaders(text)
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    const test = current ? `${current}\n\n${para}` : para;
    if (estimatePlainTokens(test) > targetTokens && current) {
      chunks.push(current.trim());
      const words = current.split(/\s+/);
      const overlapWords = Math.max(0, Math.floor(overlapTokens / 1.3));
      const overlap = overlapWords > 0 ? words.slice(-overlapWords).join(' ') : '';
      current = overlap ? `${overlap}\n\n${para}` : para;
    } else {
      current = test;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Harde splitsing van chunks die alsnog te lang zijn.
  const result = [];
  const wordsPerChunk = Math.max(1, Math.floor(maxTokens / 1.3));
  for (const c of chunks) {
    if (estimatePlainTokens(c) <= maxTokens) {
      result.push(c);
      continue;
    }
    const words = c.split(/\s+/);
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const piece = words.slice(i, i + wordsPerChunk).join(' ').trim();
      if (piece) result.push(piece);
    }
  }
  return result.filter(Boolean);
}

// Bouw de tekst die we EMBEDDEN (niet de tekst die we opslaan/tonen). Door de
// documenttitel (en optioneel sectie) vooraan te zetten krijgt een zwakke chunk
// — bv. een figuuronderschrift vol formules — meer bron-signaal mee, wat de
// similarity tegen een schone vraag meetbaar verhoogt (Task #394). De opgeslagen
// `content` blijft de schone chunk-tekst, zodat de weergave onveranderd blijft.
export function buildEmbedInput(title, content) {
  const t = (title || '').trim();
  return t ? `Document: ${t}\n\n${content}` : content;
}
