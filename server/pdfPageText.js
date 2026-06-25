// Server-side per-pagina tekstextractie uit een PDF-buffer via de pdfjs
// "legacy" build (werkt in Node zonder browser-DOM). Wordt gebruikt om een via
// LibreOffice naar PDF geconverteerd DOCX op te delen in paginatekst, zodat
// assignPdfPages elke chunk aan zijn paginanummer(s) kan koppelen.
//
// pdfjs wordt lui geïmporteerd (dynamic import in de functie) zodat de zware
// module alleen geladen wordt wanneer er daadwerkelijk een DOCX wordt verwerkt.

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

/**
 * Extraheert per pagina de tekst uit een PDF-buffer.
 * @param {Buffer|Uint8Array} pdfBuffer
 * @returns {Promise<string[]>} één string per pagina (1-based volgorde).
 */
export async function extractPdfPageTexts(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  // Eigen Uint8Array-kopie: pdfjs neemt de buffer in beheer (detach), dus geef
  // nooit de gedeelde Node-Buffer rechtstreeks mee.
  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    // Geen worker in Node: forceer de hoofd-thread.
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      pages.push(pageText);
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.destroy().catch(() => {});
  }
}
