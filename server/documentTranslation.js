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
  { code: 'ja', native: '日本語', promptName: 'Japanese' },
  { code: 'ko', native: '한국어', promptName: 'Korean' },
  { code: 'hr', native: 'Hrvatski', promptName: 'Croatian' },
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

// ───────────────────────────────────────────────────────────────────────────
// Generieke content-vertaling (Task #288) — dynamische, door docenten/admins
// geschreven, student-zichtbare DB-tekst (cursusinfo-body, projectbriefing,
// persona-namen, begrip-namen/categorieën). Aparte helpers van de bron-document-
// vertaling hierboven, zodat die ongewijzigd (en getest) blijft.
// ───────────────────────────────────────────────────────────────────────────

// Ondersteunde formaten van te vertalen content. 'markdown' = rich text
// (cursusinfo-body, via tiptap-markdown opgeslagen); 'plain' = platte tekst /
// korte labels (briefing, namen, categorieën).
export const CONTENT_FORMATS = ['markdown', 'plain'];
export function normalizeContentFormat(format) {
  return CONTENT_FORMATS.includes(format) ? format : 'plain';
}

// Versie van het content-vertaal-uitvoerformaat. Bump bij prompt-/formaat-
// wijzigingen zodat oude cache-rijen vervallen (de versie zit in de hash).
export const CONTENT_TRANSLATION_FORMAT_VERSION = 1;

// Deterministische SHA-256 over (formaatversie + formaat + genormaliseerde
// bron-tekst). Identieke tekst in hetzelfde formaat deelt zo één cache-rij over
// alle schermen; wijzigt de tekst of het formaat, dan invalideert de cache.
export function hashContentSource(text, format = 'plain', version = CONTENT_TRANSLATION_FORMAT_VERSION) {
  const fmt = normalizeContentFormat(format);
  return createHash('sha256')
    .update(`c${version}\n${fmt}\n${normalizeSourceText(text)}`, 'utf8')
    .digest('hex');
}

// Is deze tekst de moeite van vertalen waard? Sla puur-symbolische of zeer korte
// fragmenten over (geen letters, of ≤ 2 tekens): die zijn taal-onafhankelijk
// (getallen, losse symbolen) en zouden door een LLM alleen maar kunnen worden
// verminkt. \p{L} dekt alle Unicode-letters (ook niet-Latijnse scripts).
export function isTranslatableText(text) {
  if (typeof text !== 'string') return false;
  const t = normalizeSourceText(text);
  if (t.length < 3) return false;
  return /\p{L}/u.test(t);
}

// System-prompt voor één content-fragment. Strikt: alleen vertalen, eigennamen/
// vaktermen/formules/URLs behouden, opmaak behouden. Markdown-modus behoudt de
// Markdown-structuur; plain-modus voegt géén opmaak toe.
export function buildContentTranslationPrompt(targetCode, format) {
  const lang = findLanguage(targetCode);
  const target = lang ? lang.promptName : 'the requested language';
  const fmt = normalizeContentFormat(format);
  const lines = [
    `You are a professional translator for an academic learning platform. Translate the text into ${target}.`,
    'Rules:',
    `- Output ONLY the translation in ${target}. No preamble, no notes, no quotation marks around the result, no original text.`,
    '- Translate faithfully; do not summarize, add, or omit content.',
    '- Keep proper nouns, person names, brand names, acronyms, technical terms, code, units and numbers unchanged.',
    '- Leave URLs and email addresses untouched.',
    '- If the text is already in the target language, return it unchanged.',
  ];
  if (fmt === 'markdown') {
    lines.push(
      '- The text is Markdown. Preserve ALL Markdown formatting exactly: headings (#), bold/italic markers, bullet/numbered lists, links [text](url), tables, blockquotes and line breaks. Translate only the human-readable text; never translate or alter link URLs or the markup characters themselves.',
      '- Render any mathematical expression as KaTeX-compatible LaTeX ($...$ inline, $$...$$ display) and never translate the mathematical content.',
    );
  } else {
    lines.push(
      '- Preserve line breaks and the overall structure. Do not add Markdown or other formatting that is not present in the source.',
    );
  }
  return lines.join('\n');
}

// System-prompt voor een GEBUNDELDE vertaling van meerdere korte platte-tekst-
// fragmenten in één JSON-call (kostenbesparend). Het model krijgt een JSON-object
// {id: tekst} en moet exact dezelfde sleutels teruggeven met vertaalde waarden.
export function buildContentBatchPrompt(targetCode) {
  const lang = findLanguage(targetCode);
  const target = lang ? lang.promptName : 'the requested language';
  return [
    `You are a professional translator for an academic learning platform. Translate each string value into ${target}.`,
    'You receive a JSON object whose values are short UI texts (titles, names, labels, categories, single sentences or short paragraphs).',
    'Rules:',
    `- Return ONLY a JSON object with EXACTLY the same keys. Each value must be the ${target} translation of the corresponding input value.`,
    '- Do not add, remove, reorder or rename keys. No commentary, no extra fields.',
    '- Keep proper nouns, person names, brand names, acronyms, technical terms, code, units and numbers unchanged.',
    '- Leave URLs and email addresses untouched.',
    '- If a value is already in the target language, return it unchanged.',
    '- Preserve any line breaks inside a value.',
  ].join('\n');
}
