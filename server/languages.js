// Server-side spiegel van de talen-registry (src/i18n/languages.ts).
// De server kan de TS-bron niet importeren, dus de Engelse namen — die in de
// AI-instructie "respond in <english>" gaan — staan hier los gespiegeld.
// Houd deze lijst in sync met src/i18n/languages.ts.

export const LANG_ENGLISH_NAMES = {
  nl: 'Dutch',
  en: 'English',
  yue: 'Cantonese (written in Traditional Chinese characters)',
  zh: 'Mandarin Chinese (written in Simplified Chinese characters)',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  uk: 'Ukrainian',
  ro: 'Romanian',
  tr: 'Turkish',
  ar: 'Arabic',
  hi: 'Hindi',
  id: 'Indonesian',
  ja: 'Japanese',
  ko: 'Korean',
  hr: 'Croatian',
  el: 'Greek',
};

export const SUPPORTED_LANG_CODES = Object.keys(LANG_ENGLISH_NAMES);

export function isSupportedLang(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LANG_ENGLISH_NAMES, code);
}

// Normaliseer een binnenkomende taalcode; val terug op Nederlands (bron-taal).
export function normalizeLang(code) {
  return isSupportedLang(code) ? code : 'nl';
}

export function languageEnglishName(lang) {
  return LANG_ENGLISH_NAMES[normalizeLang(lang)];
}

// Sterke, autoritaire instructie die aan een prompt wordt geplakt zodat de AI
// in de taal van de gebruiker antwoordt — ongeacht de taal van de vraag, het
// cursusmateriaal of eventuele eerdere taal-aanwijzingen in de basisprompt.
// Voor Nederlands (de bron-/defaulttaal) is dit standaard leeg, omdat de
// basisprompts al in het Nederlands staan; met { force: true } forceer je het.
export function buildLanguageInstruction(lang, { force = false, json = false } = {}) {
  const code = normalizeLang(lang);
  if (code === 'nl' && !force) return '';
  const name = LANG_ENGLISH_NAMES[code];
  const base = `\n\nIMPORTANT — OUTPUT LANGUAGE: Disregard any other language mentioned in the instructions above. Always respond in ${name}. Write your entire answer — all feedback, explanations, titles and labels — in ${name}, regardless of the language of the question or the course material.`;
  // Voor JSON-antwoorden die per vaste sleutel/enum worden geparset: houd de
  // structuur intact zodat een vertaalde sleutel of enum-waarde de parsing niet
  // breekt. Alleen de tekstwaarden gaan in de doeltaal.
  const jsonClause = json
    ? ` Your response is JSON: keep every JSON property name/key and any fixed enum or structural value EXACTLY as written in the instructions above (do not translate or rename them); write only the human-readable string values in ${name}.`
    : '';
  return `${base}${jsonClause}`;
}

// Kies een basisprompt en plak de taal-instructie eraan vast. Nederlands krijgt
// de NL-variant; elke andere taal krijgt de Engelse basis (betrouwbaarste
// meta-instructietaal) + een dwingende "respond in <taal>"-instructie.
export function localizePrompt(lang, { nl, en }) {
  const code = normalizeLang(lang);
  const base = code === 'nl' ? nl : en;
  return `${base}${buildLanguageInstruction(code)}`;
}
