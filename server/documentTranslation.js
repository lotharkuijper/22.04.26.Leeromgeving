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

// Deterministische SHA-256 over de genormaliseerde bron-tekst. Bij een
// gewijzigde bron verandert de hash, dus de cache invalideert vanzelf.
export function hashSource(text) {
  return createHash('sha256').update(normalizeSourceText(text), 'utf8').digest('hex');
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
    '- Keep proper nouns, author names, citations, formulas, code, units and numbers unchanged.',
    '- Preserve line breaks, bullet/list structure and paragraph boundaries where possible.',
    '- Leave URLs and email addresses untouched.',
    '- If a fragment is already in the target language, keep it as-is.',
  ].join('\n');
}
