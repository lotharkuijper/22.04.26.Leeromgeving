// Pure helpers voor CSV-import van itembank-vragen. Bron-agnostisch: elke
// cursus kan een eigen vragenbank aanleveren als CSV. Geen I/O hier — puur
// parsen + mappen naar quiz_questions-rijen, zodat dit los te unit-testen is.

// RFC-4180-achtige CSV-parser: ondersteunt aanhalingstekens, ingesloten komma's,
// newlines binnen velden en dubbele-aanhalingsteken-escapes ("").
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // Laatste veld/rij (geen trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Verwijder volledig lege rijen (bijv. trailing newline).
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

// Map van genormaliseerde headernaam → canonieke veldnaam. Accepteert NL+EN
// varianten zodat docenten geen rigide kolomnamen hoeven te onthouden.
export const HEADER_ALIASES = {
  question: 'question',
  questiontext: 'question',
  vraag: 'question',
  type: 'type',
  itemtype: 'type',
  vraagtype: 'type',
  topic: 'topic',
  onderwerp: 'topic',
  sectie: 'topic',
  section: 'topic',
  exsection: 'exsection',
  exsectie: 'exsection',
  sectionpath: 'exsection',
  sectiepad: 'exsection',
  subtopic: 'subtopic',
  subonderwerp: 'subtopic',
  correct: 'correct',
  correctanswer: 'correct',
  answer: 'correct',
  antwoord: 'correct',
  juist: 'correct',
  explanation: 'explanation',
  uitleg: 'explanation',
  toelichting: 'explanation',
  feedback: 'explanation',
  optiona: 'optionA',
  a: 'optionA',
  optionb: 'optionB',
  b: 'optionB',
  optionc: 'optionC',
  c: 'optionC',
  optiond: 'optionD',
  d: 'optionD',
  optione: 'optionE',
  e: 'optionE',
  optionf: 'optionF',
  f: 'optionF',
};

export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Parseert een hele CSV-tekst naar genormaliseerde records + per-rij fouten.
// Retourneert { records, errors, totalRows }. Elke record bevat de canonieke
// velden; ongeldige rijen komen in errors met regelnummer + reden.
export function parseItembankCsv(text) {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { records: [], errors: [{ row: 0, reason: 'empty' }], totalRows: 0 };
  }
  const rawHeaders = grid[0].map(normHeader);
  const headerMap = rawHeaders.map(h => HEADER_ALIASES[h] || null);
  if (!headerMap.includes('question')) {
    return { records: [], errors: [{ row: 1, reason: 'missing_question_column' }], totalRows: 0 };
  }
  const records = [];
  const errors = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const obj = {};
    for (let c = 0; c < headerMap.length; c++) {
      const key = headerMap[c];
      if (!key) continue;
      const val = (cells[c] !== undefined ? String(cells[c]) : '').trim();
      obj[key] = val;
    }
    const lineNo = r + 1;
    const question = (obj.question || '').trim();
    if (!question) {
      errors.push({ row: lineNo, reason: 'missing_question' });
      continue;
    }
    // Type afleiden: expliciet veld, anders inferren uit aanwezige opties.
    const options = {};
    for (let i = 0; i < OPTION_LETTERS.length; i++) {
      const letter = OPTION_LETTERS[i];
      const v = (obj[`option${letter}`] || '').trim();
      if (v) options[letter] = v;
    }
    const hasOptions = Object.keys(options).length > 0;
    let type = (obj.type || '').trim().toLowerCase();
    if (type === 'mc' || type === 'multiplechoice' || type === 'meerkeuze' || type === 'mchoice' || type === 'schoice') type = 'mcq';
    if (type === 'opn' || type === 'text' || type === 'tekst' || type === 'numeriek' || type === 'num') type = 'open';
    if (type !== 'mcq' && type !== 'open') {
      type = hasOptions ? 'mcq' : 'open';
    }
    const correctRaw = (obj.correct || '').trim();

    if (type === 'mcq') {
      if (Object.keys(options).length < 2) {
        errors.push({ row: lineNo, reason: 'mcq_needs_two_options' });
        continue;
      }
      const correctLetter = normalizeCorrectLetter(correctRaw, options);
      if (!correctLetter) {
        errors.push({ row: lineNo, reason: 'mcq_missing_correct' });
        continue;
      }
      records.push({
        type: 'mcq',
        question,
        options,
        correct: correctLetter,
        explanation: (obj.explanation || '').trim(),
        topic: (obj.topic || '').trim(),
        subtopic: (obj.subtopic || '').trim(),
        exsection: (obj.exsection || '').trim(),
      });
    } else {
      if (!correctRaw) {
        errors.push({ row: lineNo, reason: 'open_missing_answer' });
        continue;
      }
      records.push({
        type: 'open',
        question,
        options: {},
        correct: correctRaw,
        explanation: (obj.explanation || '').trim(),
        topic: (obj.topic || '').trim(),
        subtopic: (obj.subtopic || '').trim(),
        exsection: (obj.exsection || '').trim(),
      });
    }
  }
  return { records, errors, totalRows: grid.length - 1 };
}

// Accepteert "A"/"a" (letter), "1"/"2" (1-based index), of de letterlijke
// optie-tekst. Retourneert de canonieke letter of null als onvindbaar.
export function normalizeCorrectLetter(correctRaw, options) {
  if (!correctRaw) return null;
  const raw = correctRaw.trim();
  const upper = raw.toUpperCase();
  if (OPTION_LETTERS.includes(upper) && options[upper]) return upper;
  // 1-based index.
  const asNum = parseInt(raw, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= OPTION_LETTERS.length) {
    const letter = OPTION_LETTERS[asNum - 1];
    if (options[letter]) return letter;
  }
  // Match op letterlijke optie-tekst (case-insensitief).
  for (const letter of OPTION_LETTERS) {
    if (options[letter] && options[letter].trim().toLowerCase() === raw.toLowerCase()) {
      return letter;
    }
  }
  return null;
}

// Bouwt een quiz_questions-insertrij uit een genormaliseerd record. Bron-label
// en cursus-namespacing worden hier toegepast zodat CSV-secties niet botsen met
// die van andere cursussen. courseLabel wordt het eerste exsection-segment.
export function csvRowToQuizQuestion(record, { sourceLabel = 'csv_import', courseLabel = null, courseId = null, createdBy = null } = {}) {
  const path = [];
  if (courseLabel && String(courseLabel).trim()) path.push(String(courseLabel).trim());
  // Een expliciete `exsection`-kolom (met `/`-sublevels) heeft voorrang en
  // bepaalt de volledige sectie-hiërarchie; anders vallen we terug op
  // topic/subtopic. Lege segmenten worden weggefilterd.
  const exSegments = record.exsection
    ? String(record.exsection).split('/').map(s => s.trim()).filter(Boolean)
    : [];
  if (exSegments.length > 0) {
    path.push(...exSegments);
  } else {
    if (record.topic) path.push(record.topic);
    if (record.subtopic) path.push(record.subtopic);
  }
  if (path.length === 0) path.push('Algemeen');
  return {
    question_text: record.question,
    answer_options: record.type === 'mcq' ? record.options : {},
    correct_answer: record.correct,
    explanation: record.explanation || null,
    source: sourceLabel,
    item_type: record.type,
    topic: record.topic || (courseLabel ? String(courseLabel).trim() : null),
    subtopic: record.subtopic || null,
    exsection_path: path,
    language: 'nl',
    created_by: createdBy,
    metadata: { course_id: courseId, imported_via: 'csv' },
  };
}
