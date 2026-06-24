// Pure helpers voor PDF-pagina-toewijzing aan chunks. Bewust géén pdfjs-import hier
// (document-processor.service.ts laadt pdfjs op moduleniveau, wat in een Node-/
// testomgeving crasht op ontbrekende DOM-globals zoals DOMMatrix). Door deze pure
// functies hier te isoleren blijven ze los testbaar.

export interface DocumentChunk {
  text: string;
  metadata: {
    pageNumber?: number;
    /** Eerste PDF-pagina (1-based) waar deze chunk op valt; afwezig als onbekend. */
    pageStart?: number;
    /** Laatste PDF-pagina; gelijk aan pageStart wanneer de chunk op één pagina valt. */
    pageEnd?: number;
    startPosition: number;
    endPosition: number;
  };
}

// Collapse alle witruimte tot enkele spaties + lowercase, zodat verschillen in
// regeleindes/spaties tussen de per-pagina-tekst en de (her)samengestelde
// chunk-tekst het terugvinden niet beïnvloeden.
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Minimale lengte (genormaliseerd) voor een kop/staart-signatuur in de fallback.
// Korter dan dit is te dubbelzinnig (bv. herhaalde kop-/voetteksten) → liever
// géén paginanummer dan een fout paginanummer.
const PAGE_SIGNATURE_MIN = 40;

/**
 * Bepaalt voor elke chunk welke PDF-pagina('s) hem bevatten en schrijft
 * pageStart/pageEnd (1-based) in de chunk-metadata.
 *
 * De char-posities die `chunkText` bijhoudt zijn onbetrouwbaar (paragrafen worden
 * op /\n\n+/ gesplitst, getrimd en posities incrementeel berekend → drift), dus we
 * mappen op tekst-inhoud i.p.v. char-offset: we bouwen één genormaliseerde
 * volledige tekst (pagina's met een spatie aaneen) en onthouden per pagina zijn
 * [start,end) in die tekst. Elke (genormaliseerde) chunk zoeken we daarin terug.
 * Bij twijfel laten we de paginavelden bewust weg (geen fout nummer).
 */
export function assignPdfPages(pageTexts: string[], chunks: DocumentChunk[]): void {
  const pageBounds: { page: number; start: number; end: number }[] = [];
  let normFull = '';
  pageTexts.forEach((pt, i) => {
    const norm = normalizeForMatch(pt);
    if (!norm) return; // lege pagina: paginanummer blijft i+1 voor latere pagina's
    const start = normFull.length ? normFull.length + 1 : 0; // +1 voor de scheidings-spatie
    normFull += (normFull ? ' ' : '') + norm;
    pageBounds.push({ page: i + 1, start, end: normFull.length });
  });
  if (!normFull || pageBounds.length === 0) return;

  const pageAt = (pos: number): number | null => {
    for (const b of pageBounds) {
      if (pos >= b.start && pos < b.end) return b.page;
    }
    return null;
  };

  let cursor = 0; // chunks komen op volgorde → vooruit zoeken voorkomt verkeerde herhaalde treffers
  for (const chunk of chunks) {
    const normChunk = normalizeForMatch(chunk.text);
    if (!normChunk) continue;

    let startPos = normFull.indexOf(normChunk, cursor);
    if (startPos === -1) startPos = normFull.indexOf(normChunk);
    let endPos: number;

    if (startPos !== -1) {
      endPos = startPos + normChunk.length;
    } else {
      // Volledige chunk niet teruggevonden (zeldzaam: overlap-naden). Probeer
      // kop- en staart-signaturen apart zodat we tóch een bereik kunnen bepalen.
      const head = normChunk.slice(0, Math.max(PAGE_SIGNATURE_MIN, 160));
      const tail = normChunk.slice(-Math.max(PAGE_SIGNATURE_MIN, 160));
      if (head.length < PAGE_SIGNATURE_MIN) continue; // te kort/dubbelzinnig
      let headPos = normFull.indexOf(head, cursor);
      if (headPos === -1) headPos = normFull.indexOf(head);
      if (headPos === -1) continue;
      let tailPos = normFull.indexOf(tail, headPos);
      if (tailPos === -1) tailPos = normFull.indexOf(tail);
      startPos = headPos;
      endPos = tailPos === -1 ? headPos + head.length : tailPos + tail.length;
    }

    const pageStart = pageAt(startPos);
    const pageEnd = pageAt(Math.max(startPos, endPos - 1));
    if (pageStart == null) continue;
    chunk.metadata.pageStart = pageStart;
    chunk.metadata.pageEnd = Math.max(pageStart, pageEnd ?? pageStart);
    chunk.metadata.pageNumber = pageStart; // back-compat veld
    cursor = startPos + 1;
  }
}
