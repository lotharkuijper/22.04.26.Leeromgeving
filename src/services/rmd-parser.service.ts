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

function extractSection(content: string, sectionName: string): string {
  const regex = new RegExp(`${sectionName}\\s*=+\\s*\\n([\\s\\S]*?)(?=\\n[A-Z][a-z]+\\s*=+|$)`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
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
    const sections = content.split(/\n(?=[A-Z][a-z]+\s*=+)/);

    let questionText = '';
    let answerOptionsText = '';
    let solutionText = '';
    let answerLabelsText = '';
    let metaInformationText = '';

    for (const section of sections) {
      const lines = section.split('\n');
      const header = lines[0].toLowerCase();

      if (header.includes('question')) {
        questionText = extractSection(content, 'Question');
      } else if (header.includes('solution')) {
        solutionText = extractSection(content, 'Solution');
      } else if (header.includes('meta-information')) {
        metaInformationText = extractSection(content, 'Meta-information');
      } else if (header.includes('answerlist')) {
        if (!answerOptionsText) {
          answerOptionsText = section.substring(lines[0].length).trim();
        } else if (!answerLabelsText) {
          answerLabelsText = section.substring(lines[0].length).trim();
        }
      }
    }

    const rawAnswers = parseAnswerList(answerOptionsText);
    const labels = parseAnswerLabels(answerLabelsText);

    if (rawAnswers.length !== labels.length) {
      console.warn('Mismatch between answer options and labels');
      return null;
    }

    const answerOptions = rawAnswers.map((text, index) => ({
      text,
      correct: labels[index] || false,
    }));

    const metaInformation = parseMetaInformation(metaInformationText);

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
