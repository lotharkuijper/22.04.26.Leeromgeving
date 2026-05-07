export interface RmdQuestion {
  question: string;
  answerOptions: Array<{ text: string; correct: boolean }>;
  solution: string;
  metaInformation: Record<string, string>;
}

export interface ParsedShareStatsItem {
  institution: string;
  subtopic: string;
  itemNumber: string;
  language: string;
  question: RmdQuestion;
}

export function parseFolderName(folderName: string): {
  institution: string;
  subtopic: string;
  itemNumber: string;
  language: string;
} | null {
  const segments = folderName.split('-');

  if (segments.length < 4) {
    console.warn(`Invalid folder name format: ${folderName}`);
    return null;
  }

  return {
    institution: segments[0],
    subtopic: segments[1],
    itemNumber: segments[2],
    language: segments[3],
  };
}

// Een R/exams .Rmd-sectie ziet er zo uit (zie ook fallbackExtractSection
// onderaan voor de hele-content-fallback):
//
//   Question
//   ========
//   ...inhoud...
//
//   Meta-information
//   ================
//   ...inhoud...
//
// Of, voor lager niveau (bv. Answerlist):
//
//   Answerlist
//   ----------
//   * optie a
//
// Splitter: een sectiekop is een regel met een woord (mag koppeltekens of
// cijfers bevatten) gevolgd door een regel met minimaal drie '=' of '-'.
// Dit pikt zowel `Question`, `Meta-information` als `Answerlist` op.
interface RawSection {
  name: string;
  body: string;
}

function splitIntoSections(content: string): RawSection[] {
  const lines = content.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    if (/^[A-Z][A-Za-z0-9_-]*\s*$/.test(line) && /^[=-]{3,}\s*$/.test(next)) {
      if (current) sections.push(current);
      current = { name: line.trim(), body: '' };
      i++; // sla de underline-regel over
      continue;
    }
    if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function parseAnswerList(content: string): string[] {
  const lines = content.split('\n');
  const answers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
      const answer = trimmed.substring(1).trim();
      if (answer) {
        answers.push(answer);
      }
    }
  }

  return answers;
}

function parseAnswerLabels(content: string): boolean[] {
  const lines = content.split('\n');
  const labels: boolean[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
      const label = trimmed.substring(1).trim().toLowerCase();
      if (label === 'true' || label === 'waar' || label === '1') {
        labels.push(true);
      } else if (label === 'false' || label === 'onwaar' || label === '0') {
        labels.push(false);
      }
    }
  }

  return labels;
}

function parseMetaInformation(content: string): Record<string, string> {
  const lines = content.split('\n');
  const meta: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(':')) {
      const [key, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();
      if (key && value) {
        meta[key.trim()] = value;
      }
    }
  }

  return meta;
}

export function parseRmdFile(content: string): RmdQuestion | null {
  try {
    const sections = splitIntoSections(content);

    let questionText = '';
    let solutionText = '';
    let metaInformationText = '';
    const answerlistBodies: string[] = [];

    for (const section of sections) {
      const name = section.name.toLowerCase();
      if (name === 'question') {
        questionText = section.body.trim();
      } else if (name === 'solution') {
        solutionText = section.body.trim();
      } else if (name === 'meta-information' || name === 'meta_information') {
        metaInformationText = section.body.trim();
      } else if (name === 'answerlist') {
        answerlistBodies.push(section.body);
      }
    }

    // Defensieve fallback: als de splitter een belangrijke sectie miste
    // (bijv. door een afwijkende underline of leestekens in de header),
    // probeer dan toch de inhoud te vinden via een directe regex op de
    // hele content. Zo blijft één rare item geen 700 anderen blokkeren.
    if (!metaInformationText) {
      metaInformationText = fallbackExtractSection(content, 'Meta-information');
    }
    if (!questionText) {
      questionText = fallbackExtractSection(content, 'Question');
    }
    if (!solutionText) {
      solutionText = fallbackExtractSection(content, 'Solution');
    }

    const metaInformation = parseMetaInformation(metaInformationText);

    // R/exams kent twee patronen voor het juiste antwoord van mchoice/schoice:
    //  (a) Tweede Answerlist-sectie met True/False per regel.
    //  (b) `exsolution` als binaire string in Meta-information, bv. `1000`
    //      = optie 1 is correct, `0110` = opties 2 en 3, etc.
    // ShareStats gebruikt overwegend variant (b). Hieronder ondersteunen we
    // beide; als er geen labels af te leiden zijn, blijven de opties leeg
    // en kan de import-laag de item afwijzen.
    const answerOptionsText = answerlistBodies[0] || '';
    const answerLabelsText = answerlistBodies[1] || '';
    const rawAnswers = parseAnswerList(answerOptionsText);

    let labels: boolean[] = [];
    if (answerLabelsText) {
      labels = parseAnswerLabels(answerLabelsText);
    }
    if (labels.length === 0 && rawAnswers.length > 0) {
      const exsolution = (metaInformation.exsolution || '').trim();
      if (/^[01]+$/.test(exsolution) && exsolution.length === rawAnswers.length) {
        labels = exsolution.split('').map((c) => c === '1');
      }
    }

    let answerOptions: Array<{ text: string; correct: boolean }> = [];
    if (rawAnswers.length > 0) {
      if (labels.length > 0 && labels.length !== rawAnswers.length) {
        // Antwoordopties zonder bijbehorende labels: corrupte mchoice.
        // Niet meer hard de hele item afkeuren — open-vragen hebben
        // helemaal geen answerlist en moeten gewoon doorlopen.
        console.warn('Mismatch tussen answer options en labels — opties genegeerd');
      } else {
        answerOptions = rawAnswers.map((text, index) => ({
          text,
          correct: labels[index] || false,
        }));
      }
    }

    return {
      question: questionText,
      answerOptions,
      solution: solutionText,
      metaInformation,
    };
  } catch (error) {
    console.error('Error parsing Rmd file:', error);
    return null;
  }
}

// Fallback: pak alles tussen `<Section>\n=====` en de volgende sectie of EOF.
// Werkt ook voor sectienamen met koppeltekens of cijfers.
function fallbackExtractSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `^${escaped}[ \\t]*\\r?\\n[=-]{3,}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n[A-Z][A-Za-z0-9_-]*[ \\t]*\\r?\\n[=-]{3,}|$)`,
    'im'
  );
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

export function parseShareStatsItem(
  folderName: string,
  rmdContent: string
): ParsedShareStatsItem | null {
  const folderInfo = parseFolderName(folderName);
  if (!folderInfo) {
    return null;
  }

  const question = parseRmdFile(rmdContent);
  if (!question) {
    return null;
  }

  return {
    ...folderInfo,
    question,
  };
}
