/**
 * Mix-aware quizgeneratie (Task #57).
 *
 * Coördineert het samenstellen van een quiz uit drie bronnen:
 *  - 'rag'      : LLM met cursusmateriaal als bron
 *  - 'itembank' : meerkeuzevragen uit de ShareStats-itembank
 *  - 'llm'      : LLM zonder bron (creatief)
 *
 * De mix-percentages per cursus worden opgehaald van het server-endpoint
 * en gebruikt om een aantal vragen per bron te bepalen. Voor non-MCQ types
 * (open/casus) wordt de itembank-bron overgeslagen — die bevat alleen
 * meerkeuzevragen.
 */

import { supabase } from '../lib/supabase';
import {
  generateQuiz,
  type QuestionType,
  type QuizQuestion,
  type MCQQuestion,
  type OpenQuestion,
  type QuizSource,
} from './llm.service';

export interface SourceMix {
  pct_rag: number;
  pct_itembank: number;
  pct_llm: number;
}

export interface MixCounts {
  rag: number;
  itembank: number;
  llm: number;
}

export interface ItembankRawMcqQuestion {
  id: string;
  type: 'mcq';
  source: 'itembank';
  sharestats_id?: string;
  question: string;
  options: Record<string, string>;
  correctAnswer: string;
  explanation: string;
  exsection_path?: string[];
}

export interface ItembankRawOpenQuestion {
  id: string;
  type: 'open';
  source: 'itembank';
  sharestats_id?: string;
  question: string;
  modelAnswer: string;
  explanation?: string;
  exsection_path?: string[];
  // R/exams-meta voor type-specifieke beoordeling (Task #67):
  // - extype 'num' → numerieke tolerantie-check via extol
  // - extype 'string'/'cloze' → tekstuele vergelijking met modelantwoord
  extype?: string;
  numericExpected?: number;
  numericTolerance?: number;
}

export type ItembankRawQuestion = ItembankRawMcqQuestion | ItembankRawOpenQuestion;

export const DEFAULT_MIX: SourceMix = { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };

export async function fetchSourceMix(courseId: string | null): Promise<SourceMix> {
  if (!courseId) return DEFAULT_MIX;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`/api/quiz-sources-mix/${courseId}`, { headers });
    if (!res.ok) return DEFAULT_MIX;
    const data = await res.json();
    return data?.mix || DEFAULT_MIX;
  } catch {
    return DEFAULT_MIX;
  }
}

/**
 * Verdeelt `total` vragen pro rata over drie bronnen, met afronding op de
 * grootste bron zodat de som exact `total` is. Itembank-percentage wordt
 * voor non-MCQ types verplaatst naar LLM (itembank bevat alleen MCQ's).
 */
export function distributeMix(total: number, mix: SourceMix, questionType: QuestionType): MixCounts {
  let { pct_rag, pct_itembank, pct_llm } = mix;
  // ItemBank ondersteunt mcq + open. Voor casus is er geen itembank-bron;
  // dat percentage gaat naar de creatieve LLM-bron.
  if (questionType === 'casus') {
    pct_llm += pct_itembank;
    pct_itembank = 0;
  }
  const sum = pct_rag + pct_itembank + pct_llm;
  if (sum <= 0) return { rag: 0, itembank: 0, llm: total };
  const ragF = (pct_rag / sum) * total;
  const ibF = (pct_itembank / sum) * total;
  const llmF = (pct_llm / sum) * total;
  let rag = Math.floor(ragF);
  let ib = Math.floor(ibF);
  let llm = Math.floor(llmF);
  let used = rag + ib + llm;
  // Verdeel resterende vragen op basis van fractioneel deel.
  const fracs: Array<{ key: 'rag' | 'itembank' | 'llm'; frac: number }> = [
    { key: 'rag', frac: ragF - rag },
    { key: 'itembank', frac: ibF - ib },
    { key: 'llm', frac: llmF - llm },
  ].sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (used < total) {
    const k = fracs[i % fracs.length].key;
    if (k === 'rag') rag++;
    else if (k === 'itembank') ib++;
    else llm++;
    used++;
    i++;
  }
  return { rag, itembank: ib, llm };
}

export async function fetchItembankQuestions(
  courseId: string,
  conceptIds: string[],
  limit: number,
  questionType: QuestionType,
): Promise<Array<MCQQuestion | OpenQuestion>> {
  if (limit <= 0 || conceptIds.length === 0) return [];
  // ItemBank levert alleen mcq en open; casus wordt door de server geweigerd.
  if (questionType !== 'mcq' && questionType !== 'open') return [];
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch('/api/quiz/itembank-questions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ courseId, conceptIds, limit, questionType }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw: ItembankRawQuestion[] = Array.isArray(data?.questions) ? data.questions : [];
    return raw.map(q => q.type === 'open' ? convertItembankOpenQuestion(q) : convertItembankMcqQuestion(q));
  } catch (err) {
    console.warn('[quiz-mix] Itembank-vragen ophalen mislukt:', err);
    return [];
  }
}

/**
 * Converteert het ItemBank-formaat (letter-keys, string-correctAnswer) naar
 * het interne MCQQuestion-formaat (string[]-opties, integer-index).
 */
export function convertItembankMcqQuestion(q: ItembankRawMcqQuestion): MCQQuestion {
  const keys = Object.keys(q.options || {}).sort(); // 'A','B','C','D' alfabetisch
  const options = keys.map(k => q.options[k]);
  const correctIndex = Math.max(0, keys.indexOf(q.correctAnswer));
  return {
    type: 'mcq',
    question: q.question,
    options,
    correctAnswer: correctIndex,
    explanation: q.explanation || '',
    source: 'itembank' as QuizSource,
  };
}

/**
 * Backwards-compatible alias.
 */
export const convertItembankQuestion = convertItembankMcqQuestion;

export function convertItembankOpenQuestion(q: ItembankRawOpenQuestion): OpenQuestion {
  const extype = (q.extype || '').toLowerCase();
  // Type-specifieke rubriek (Task #67). Voor numerieke vragen verwijzen we
  // expliciet naar extol; voor tekst/cloze leggen we de nadruk op het
  // ShareStats-modelantwoord uit de Solution-sectie.
  let rubric: string;
  if (extype === 'num' && typeof q.numericExpected === 'number') {
    const tol = q.numericTolerance && q.numericTolerance > 0
      ? `binnen een tolerantie van ±${q.numericTolerance} (R/exams extol)`
      : 'strikt (geen extol-tolerantie opgegeven)';
    rubric = `- Numeriek antwoord: het verwachte getal is ${q.numericExpected}.\n`
      + `- Beoordeel ${tol}.\n`
      + `- Negeer eenheden, korte toelichting of komma vs. punt; vergelijk alleen het getal.`;
  } else if (extype === 'cloze') {
    rubric = `- Cloze-vraag uit de ItemBank: vergelijk elk deelantwoord met het ShareStats-modelantwoord hieronder.\n`
      + `- Geef alleen volle punten als alle deelantwoorden inhoudelijk kloppen; bij gedeeltelijk juiste invulling proportioneel scoren.\n`
      + `- Wees mild met spelling/notatie zolang de bedoelde term ondubbelzinnig is.`;
  } else if (extype === 'string') {
    rubric = `- Open ItemBank-tekstvraag: het ShareStats-modelantwoord (Solution) is leidend.\n`
      + `- Beoordeel of de kerntermen en kernredeneringen uit het modelantwoord aanwezig zijn.\n`
      + `- Accepteer synoniemen of een eigen verwoording, mits de vakinhoud klopt.`;
  } else if (q.explanation && q.explanation.trim().length > 0) {
    // Fallback: gebruik de Solution-tekst als rubriek wanneer extype onbekend
    // is, maar maak expliciet dat het uit de ItemBank komt.
    rubric = `Vergelijk het studentantwoord met het ShareStats-modelantwoord uit de ItemBank:\n${q.explanation.trim()}`;
  } else {
    rubric = 'Beoordeel of het antwoord van de student inhoudelijk overeenkomt met het modelantwoord uit de ItemBank.';
  }

  return {
    type: 'open',
    question: q.question,
    modelAnswer: q.modelAnswer || '',
    rubric,
    source: 'itembank' as QuizSource,
    extype: q.extype,
    numericExpected: q.numericExpected,
    numericTolerance: q.numericTolerance,
  };
}

/**
 * Genereer een quiz die de bronnen-mix respecteert. Vragen worden in een
 * willekeurige volgorde geretourneerd (gemixt over bronnen) en elk hebben
 * een `source`-tag.
 */
export async function generateMixedQuiz(args: {
  courseId: string | null;
  conceptIds: string[];
  topicNames: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  questionType: QuestionType;
  numQuestions: number;
  ragContext?: string;
  ragStrictMode?: boolean;
  mix?: SourceMix;
}): Promise<{ questions: QuizQuestion[]; counts: MixCounts; effectiveMix: SourceMix }> {
  const mix = args.mix || (await fetchSourceMix(args.courseId));
  const counts = distributeMix(args.numQuestions, mix, args.questionType);

  // Task #412: geef de beheerde quiz-prompt-NAAM per bron door aan generateQuiz;
  // de server resolvet die naam server-side naar de vertrouwde prompt (default +
  // actieve DB-override). Strict bij RAG met context + strict-mode, anders
  // blended bij RAG-bron, en creative bij de LLM-bron.
  const ragPersona = args.ragContext && args.ragStrictMode
    ? 'quiz_generate_strict'
    : 'quiz_generate_blended';
  const llmPersona = 'quiz_generate_creative';

  const out: QuizQuestion[] = [];

  // 1) ItemBank
  let itembankActual = 0;
  if (counts.itembank > 0 && args.courseId) {
    const ibQs = await fetchItembankQuestions(args.courseId, args.conceptIds, counts.itembank, args.questionType);
    itembankActual = ibQs.length;
    out.push(...ibQs);
  }

  // Bij tekort aan itembank-vragen: vul aan met LLM.
  const itembankShortfall = counts.itembank - itembankActual;
  const llmCount = counts.llm + itembankShortfall;

  // 2) RAG (LLM met context)
  // Sla de RAG-aanroep over als strict-mode aan staat maar er geen context
  // beschikbaar is — anders genereert het model een "weigerings-vraag".
  // De geplande RAG-vragen vallen dan terug naar de LLM-creatieve bron.
  const ragContextMissing = args.ragStrictMode && !args.ragContext;
  const llmCountWithRagFallback = llmCount + (ragContextMissing ? counts.rag : 0);

  let ragActual = 0;
  if (counts.rag > 0 && !ragContextMissing) {
    try {
      const ragQs = await generateQuiz(
        args.topicNames,
        args.difficulty,
        args.questionType,
        counts.rag,
        args.ragContext,
        args.ragStrictMode,
        ragPersona,
      );
      ragQs.forEach(q => { (q as MCQQuestion).source = 'rag'; });
      ragActual = ragQs.length;
      out.push(...ragQs);
    } catch (err) {
      console.warn('[quiz-mix] RAG-bron mislukt:', err);
    }
  }

  // 3) LLM-creatief (zonder context)
  let llmActual = 0;
  if (llmCountWithRagFallback > 0) {
    try {
      const llmQs = await generateQuiz(
        args.topicNames,
        args.difficulty,
        args.questionType,
        llmCountWithRagFallback,
        undefined,
        false,
        llmPersona,
      );
      llmQs.forEach(q => { (q as MCQQuestion).source = 'llm'; });
      llmActual = llmQs.length;
      out.push(...llmQs);
    } catch (err) {
      console.warn('[quiz-mix] LLM-creatieve bron mislukt:', err);
    }
  }

  // Shuffle voor afwisseling van bronnen tijdens de quiz.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  // Rapporteer de werkelijk geleverde aantallen per bron — niet de
  // geplande. Zo ziet de UI eerlijk dat ItemBank is aangevuld door LLM
  // en hoeveel RAG/LLM daadwerkelijk hebben opgeleverd.
  return {
    questions: out,
    counts: { rag: ragActual, itembank: itembankActual, llm: llmActual },
    effectiveMix: mix,
  };
}

export const SOURCE_LABELS: Record<QuizSource, string> = {
  rag: 'Cursusmateriaal',
  itembank: 'ItemBank',
  llm: 'LLM-creatief',
};

export const SOURCE_COLORS: Record<QuizSource, string> = {
  rag: 'bg-blue-50 text-blue-700 border-blue-200',
  itembank: 'bg-purple-50 text-purple-700 border-purple-200',
  llm: 'bg-amber-50 text-amber-700 border-amber-200',
};
