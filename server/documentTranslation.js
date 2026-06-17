// Pure helpers voor de bron-document vertaalfunctie (translate-on-demand
// leesvenster). GEEN DB- of LLM-calls hier zodat vitest ze direct kan testen.
// De client spiegelt de talenlijst in src/lib/translationLanguages.ts.
import { createHash } from 'node:crypto';

// Allowlist van doeltalen. `promptName` is de Engelse beschrijving die in de
// system-prompt gaat (stuurt het model aan); `native` is het label in de UI.
export const LANGUAGES = [
  { code: 'nl', native: 'Nederlands', promptName: 'Dutch' },
  { code: 'en', native: 'English', promptName: 'English' },
  { code: 'yue', native: '粵語（廣東話）', promptName: 'Cantonese (written in Traditional Chinese characters)' },
  { code: 'zh', native: '简体中文', promptName: 'Mandarin Chinese (written in Simplified Chinese characters)' },
  { code: 'de', native: 'Deutsch', promptName: 'German' },
  { code: 'fr', native: 'Français', promptName: 'French' },
  { code: 'es', native: 'Español', promptName: 'Spanish' },
  { code: 'it', native: 'Italiano', promptName: 'Italian' },
  { code: 'pt', native: 'Português', promptName: 'Portuguese' },
  { code: 'pl', native: 'Polski', promptName: 'Polish' },
  { code: 'uk', native: 'Українська', promptName: 'Ukrainian' },
  { code: 'ro', native: 'Română', promptName: 'Romanian' },
  { code: 'tr', native: 'Türkçe', promptName: 'Turkish' },
  { code: 'ar', native: 'العربية', promptName: 'Arabic' },
  { code: 'hi', native: 'हिन्दी', promptName: 'Hindi' },
  { code: 'id', native: 'Bahasa Indonesia', promptName: 'Indonesian' },
];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

export function findLanguage(code) {
  if (!code || typeof code !== 'string') return null;
  const c = code.trim().toLowerCase();
  return LANGUAGES.find((l) => l.code === c) || null;
}

// Geeft de genormaliseerde taalcode terug, of null als de taal niet op de
// allowlist staat.
export function normalizeTargetLang(code) {
  return findLanguage(code)?.code || null;
}

// Maximale lengte van de bron-tekst per vertaalverzoek. Defensief tegen
// kosten/model-limieten; ~12k tekens ≈ enkele dichte pagina's of dia's.
export const MAX_SOURCE_CHARS = 12000;

// page_key beschrijft de vertaalde eenheid: 'full' (klein tekstbestand),
// 'p:<n>' (pdf/docx/pptx-pagina of dia) of 'text:<n>' (tekst-segment).
const PAGE_KEY_RE = /^(full|p:\d{1,5}|text:\d{1,5})$/;
export function normalizePageKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  return PAGE_KEY_RE.test(k) ? k : null;
}

// Normaliseer bron-tekst vóór hashing/caching: CRLF→LF, 3+ lege regels
// inklappen, trimmen. Zo geeft onbeduidende whitespace-ruis toch cache-hits.
export function normalizeSourceText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Deterministische SHA-256 over de genormaliseerde bron-tekst (+ formaatversie).
// Bij een gewijzigde bron óf een nieuwe formaatversie verandert de hash, dus de
// cache invalideert vanzelf.
// Versie van het vertaal-uitvoerformaat. Bump dit wanneer de prompt of het
// uitvoerformaat verandert: de versie wordt in de bron-hash gevouwen zodat oude
// cache-rijen (met een ander formaat) niet meer als geldige treffer gelden en de
// tekst opnieuw wordt vertaald. v1 = platte tekst (oorspronkelijk),
// v2 = Markdown + LaTeX-formules.
export const TRANSLATION_FORMAT_VERSION = 2;

export function hashSource(text, version = TRANSLATION_FORMAT_VERSION) {
  return createHash('sha256')
    .update(`v${version}\n${normalizeSourceText(text)}`, 'utf8')
    .digest('hex');
}

// Bouw de system-prompt voor de vertaling. Strikt: alleen vertalen, geen
// uitleg, eigennamen/formules/code/citaten/URLs behouden, opmaak behouden.
export function buildTranslationPrompt(targetCode, sourceType) {
  const lang = findLanguage(targetCode);
  const target = lang ? lang.promptName : 'the requested language';
  const unit = sourceType === 'pptx' ? 'lecture slide' : 'document page';
  return [
    `You are a professional academic translator. Translate the text from a ${unit} into ${target}.`,
    'Rules:',
    `- Output ONLY the translation in ${target}. No preamble, no notes, no explanations, no original text.`,
    '- Translate faithfully; do not summarize, add, or omit content.',
    '- Keep proper nouns, author names, citations, code, units and numbers unchanged.',
    '- Leave URLs and email addresses untouched.',
    '- If a fragment is already in the target language, keep it as-is.',
    '- Preserve line breaks, bullet/list structure and paragraph boundaries. You may use light Markdown (lists, tables, headings) to keep that structure.',
    'Mathematics and formulas:',
    '- Mathematics is universal: NEVER translate or change the mathematical content of a formula. Keep every symbol, operator, variable, Greek letter, function name (sin, cos, log, …), number and unit exactly as in the source.',
    '- Render every mathematical expression as LaTeX: use $...$ for inline math and $$...$$ for display (standalone) formulas. Wrap ALL math in these delimiters, even a single symbol or variable mentioned inside prose.',
    '- Use only standard KaTeX-compatible LaTeX (e.g. \\frac, ^, _, \\sqrt, \\sum, \\int, Greek letters). Do not use custom macros, packages or environments that KaTeX cannot render.',
    '- The source text is extracted from a PDF, so formulas may be garbled (broken spacing, lost super/subscripts, stray characters). Reconstruct the intended formula as correct LaTeX when you are confident; if unsure, keep the original characters verbatim inside the math delimiters rather than guessing.',
    '- You MAY translate descriptive, word-based subscripts or labels (e.g. a subscript spelled out as a real word) into the target language, but keep single-letter or symbolic indices (i, j, k, n, t, x, y, …) unchanged.',
  ].join('\n');
}
