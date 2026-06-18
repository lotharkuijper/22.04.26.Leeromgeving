import { isSupportedLang, getLanguageMeta, type Lang } from '../i18n/languages';
import { tStatic } from '../i18n/translations';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
}

export class LLMError extends Error {
  status: number;
  code?: string;
  rawMessage: string;
  constructor(message: string, status: number, code?: string, rawMessage?: string) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.rawMessage = rawMessage ?? message;
  }
}

type LlmErrLang = string;

export function llmErrorToDutch(err: unknown, lang: LlmErrLang = 'nl'): { title: string; detail?: string } {
  const nl = lang !== 'en';
  if (err instanceof LLMError) {
    const code = err.code ?? '';
    const raw = (err.rawMessage || err.message || '').toLowerCase();
    if (code === 'context_length_exceeded' || raw.includes('context') && raw.includes('length')) {
      return {
        title: nl
          ? 'De prompt is te lang geworden voor het taalmodel.'
          : 'The prompt has become too long for the language model.',
        detail: nl
          ? 'Probeer de RAG-drempel iets hoger te zetten of het aantal passages (match_count) te verlagen, zodat er minder cursusmateriaal wordt meegestuurd.'
          : 'Try raising the RAG threshold or lowering the number of passages (match_count) to send less course material.',
      };
    }
    if (
      code === 'insufficient_quota' ||
      err.status === 402 ||
      raw.includes('quota') ||
      raw.includes('billing') ||
      raw.includes('exceeded your current quota')
    ) {
      return {
        title: nl
          ? 'Het tegoed of de uitgavenlimiet van de AI-dienst is bereikt.'
          : 'The AI service credit or spending limit has been reached.',
        detail: nl
          ? 'Opnieuw proberen helpt pas als er weer tegoed of limiet beschikbaar is. Vraag de beheerder om de facturering en limieten van de OpenAI-account te controleren.'
          : 'Retrying only helps once credit or limit is available again. Ask the administrator to check the billing and limits of the OpenAI account.',
      };
    }
    if (code === 'rate_limit_exceeded' || err.status === 429 || raw.includes('rate limit')) {
      return {
        title: nl
          ? 'Het taalmodel staat tijdelijk onder druk (rate limit).'
          : 'The language model is temporarily under pressure (rate limit).',
        detail: nl
          ? 'Wacht een halve minuut en probeer het opnieuw.'
          : 'Wait half a minute and try again.',
      };
    }
    if (err.status === 503) {
      return {
        title: nl
          ? 'De chatbot is niet (volledig) geconfigureerd.'
          : 'The chatbot is not (fully) configured.',
        detail: err.rawMessage || (nl ? 'Controleer of de VU Azure OpenAI-configuratie (chat én embeddings) compleet is.' : 'Check whether the VU Azure OpenAI configuration (chat and embeddings) is complete.'),
      };
    }
    if (code === 'upstream_unavailable') {
      return {
        title: nl
          ? 'De AI-dienst is tijdelijk niet bereikbaar.'
          : 'The AI service is temporarily unavailable.',
        detail: nl
          ? 'De dienst gaf een ongeldig of leeg antwoord terug. Wacht een halve minuut en probeer het opnieuw.'
          : 'The service returned an invalid or empty response. Wait half a minute and try again.',
      };
    }
    if (code === 'empty_response' || code === 'length' || raw.includes('lege reactie') || raw.includes('te weinig tokenruimte')) {
      return {
        title: nl
          ? 'Het antwoord paste niet in de beschikbare tokenruimte.'
          : 'The answer did not fit in the available token space.',
        detail: nl
          ? 'Het taalmodel had te weinig ruimte om volledige feedback te geven. Probeer het opnieuw, of stuur minder cursusmateriaal mee (verhoog de RAG-drempel of verlaag het aantal passages / match_count).'
          : 'The language model had too little room to give complete feedback. Try again, or send less course material (raise the RAG threshold or lower the number of passages / match_count).',
      };
    }
    if (err.status >= 500) {
      return {
        title: nl
          ? 'Het taalmodel reageert niet (serverfout).'
          : 'The language model is not responding (server error).',
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    if (err.status === 401 || err.status === 403 || code === 'invalid_api_key') {
      return {
        title: nl
          ? 'De AI-dienst weigerde de toegang (sleutel of rechten).'
          : 'The AI service denied access (key or permissions).',
        detail: nl
          ? 'Vraag de beheerder om te controleren of de Azure OpenAI-sleutel geldig is en toegang heeft tot het ingestelde model.'
          : 'Ask the administrator to verify the Azure OpenAI key is valid and has access to the configured model.',
      };
    }
    if (code === 'invalid_request_error' || (err.status >= 400 && err.status < 500)) {
      return {
        title: nl
          ? 'Het taalmodel weigerde het verzoek.'
          : 'The language model rejected the request.',
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    return {
      title: nl ? 'Er ging iets mis bij het taalmodel.' : 'Something went wrong with the language model.',
      detail: err.rawMessage,
    };
  }
  if (err instanceof Error) {
    return {
      title: nl ? 'Er ging iets mis bij het taalmodel.' : 'Something went wrong with the language model.',
      detail: err.message,
    };
  }
  return { title: nl ? 'Er ging iets mis bij het taalmodel.' : 'Something went wrong with the language model.' };
}

function _getLang(): Lang {
  try {
    const v = localStorage.getItem('lair-vu-lang');
    if (isSupportedLang(v)) return v;
  } catch {}
  return 'nl';
}

async function callChatAPI(body: object): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { supabase } = await import('../lib/supabase');
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  } catch {}
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ lang: _getLang(), ...body }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errObj = errorData?.error;
    const rawMsg = (errObj && (errObj.message || errObj)) || errorData?.message || `API Error: ${response.status}`;
    const code = errObj && typeof errObj === 'object' ? errObj.code : undefined;
    throw new LLMError(typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg), response.status, code, typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg));
  }

  return response.json();
}

export async function sendChatMessage(
  messages: Message[],
  context?: string,
  ragStrictMode?: boolean,
  sources?: Array<{ title: string; similarity: number }>
): Promise<LLMResponse> {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');

    const data = await callChatAPI({
      model: undefined,
      messages: userMessages,
      context,
      temperature: 0.7,
      top_p: 1,
      stream: false,
      ragStrictMode: ragStrictMode ?? false,
      sources: sources && sources.length > 0 ? sources : undefined,
    });

    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new LLMError('Het taalmodel gaf een leeg antwoord terug.', 502, 'empty_response', 'empty content');
    }

    return { content };
  } catch (error: any) {
    console.error('[LLM] Error calling chat API:', error);
    // LLMError (afkomstig uit callChatAPI of het lege-antwoord-pad) ongewijzigd
    // doorgeven, zodat de UI status/code/rawMessage kan onderscheiden via
    // llmErrorToDutch (context_length_exceeded, rate_limit, 503, 5xx, ...).
    if (error instanceof LLMError) {
      throw error;
    }
    // Niet-HTTP fouten (bv. netwerkfout) als generieke LLMError doorgeven.
    const msg = error?.message || String(error);
    throw new LLMError(msg, 0, undefined, msg);
  }
}

const RAG_STRICT_INSTRUCTION_LLM = `\n\nSTRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."`;

export async function evaluateExplanation(
  concept: string,
  explanation: string,
  definition: string,
  keyPoints: string[],
  ragContext?: string,
  retrievedSources?: Array<{ title: string; similarity: number }>,
  ragStrictMode?: boolean,
  systemPrompt?: string
): Promise<LLMResponse> {
  let evaluationPrompt: string;

  // Bouw bron-instructie blok: genummerde lijst met vast verwijsformaat
  // [1]/[2]/[3] én een marker voor info buiten cursusmateriaal. Wordt ALTIJD
  // toegevoegd, ook bij 0 bronnen — juist dan is het URL-verbod en de marker
  // het belangrijkst om hallucinatie te beteugelen.
  const buildSourcesBlock = (srcs: Array<{ title: string; similarity: number }>): string => {
    if (!srcs || srcs.length === 0) {
      return `\n\nBronnen uit het cursusmateriaal die je tot je beschikking hebt:
(geen relevante cursusbronnen gevonden voor dit begrip)

Verwijsregels (volg deze STRIKT):
- Er zijn geen cursusbronnen waarnaar je kunt verwijzen — gebruik daarom GEEN [1], [2] of soortgelijke nummers.
- Gebruik in je feedback géén URL's, weblinks, DOI's of verwijzingen naar externe boeken/artikelen.
- Omdat je geen cursusmateriaal hebt, bestaat je feedback per definitie uit algemene kennis. Markeer iedere zin die op zo'n algemene kennis steunt met "(buiten cursusmateriaal)" aan het einde van die zin.`;
    }
    const numbered = srcs.map((s, i) => `[${i + 1}] ${s.title}`).join('\n');
    return `\n\nBronnen uit het cursusmateriaal die je tot je beschikking hebt:
${numbered}

Verwijsregels (volg deze STRIKT):
- Verwijs in je feedback naar een bron met exact de notatie [1], [2] of [3] direct na de zin waar je die bron gebruikt.
- Gebruik géén andere verwijsvormen (geen titels, geen URL's, geen voetnoten, geen DOI's).
- Als je in je feedback informatie noemt die NIET uit deze bronnen komt maar uit algemene kennis, markeer die zin dan met "(buiten cursusmateriaal)" aan het einde van die zin.`;
  };

  const sourcesBlock = buildSourcesBlock(retrievedSources ?? []);

  if (systemPrompt) {
    evaluationPrompt = `Begrip: "${concept}"

Officiële definitie:
${definition}

Kernpunten die beoordeeld worden:
${keyPoints.map((point, i) => `${i + 1}. ${point}`).join('\n')}`;

    if (ragContext) {
      evaluationPrompt += `\n\nRelevante informatie uit cursusmateriaal:\n${ragContext}`;
      if (ragStrictMode) evaluationPrompt += RAG_STRICT_INSTRUCTION_LLM;
    } else if (ragStrictMode) {
      evaluationPrompt += `\n\n${RAG_STRICT_INSTRUCTION_LLM}\n\nEr zijn geen relevante cursusteksten gevonden voor dit begrip. Geef dit duidelijk aan in je feedback.`;
    }

    evaluationPrompt += `\n\nUitleg van de student:\n${explanation}`;
    evaluationPrompt += sourcesBlock;
    evaluationPrompt += `\n\nAanspraakvorm (volg STRIKT in jouw feedback): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT formuleringen als "de student", "deze student" of "de student heeft" — schrijf alsof je de feedback één-op-één tegen de student geeft.`;
  } else {
    evaluationPrompt = `Evalueer de volgende uitleg van een student voor het begrip "${concept}".

Officiële definitie:
${definition}

Kernpunten die genoemd zouden moeten worden:
${keyPoints.map((point, i) => `${i + 1}. ${point}`).join('\n')}`;

    if (ragContext) {
      evaluationPrompt += `\n\nRelevante informatie uit cursusmateriaal:\n${ragContext}`;
    }
    if (ragStrictMode) {
      if (ragContext) {
        evaluationPrompt += RAG_STRICT_INSTRUCTION_LLM;
      } else {
        evaluationPrompt += `\n\n${RAG_STRICT_INSTRUCTION_LLM}\n\nEr zijn geen relevante cursusteksten gevonden voor dit begrip. Geef dit duidelijk aan in je feedback.`;
      }
    }

    evaluationPrompt += `\n\nUitleg van de student:\n${explanation}

Aanspraakvorm (volg STRIKT in jouw feedback): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT formuleringen als "de student", "deze student" of "de student heeft" — schrijf alsof je de feedback één-op-één tegen de student geeft.

Geef gestructureerde feedback met:
1. Wat je goed hebt gedaan (specifieke punten in jouw uitleg)
2. Wat ontbreekt of onduidelijk is in jouw uitleg
3. Eventuele misconcepties bij jou die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering`;

    evaluationPrompt += sourcesBlock;
    evaluationPrompt += `\n\nWees constructief en moedigend, maar ook specifiek en nuttig.`;
  }

  const data = await callChatAPI({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: evaluationPrompt }],
    temperature: 0.3,
    // Ruim budget: reasoning-modellen (bv. gpt-5.2) verbruiken een deel van het
    // tokenbudget aan 'reasoning'. Met een krap budget bleef er geen ruimte over
    // voor de 4-delige gestructureerde feedback (lege/afgekapte respons).
    max_tokens: 4000,
    skipSystemPrompt: true,
    ...(systemPrompt ? { systemPromptOverride: systemPrompt } : {}),
  });

  const content = data.choices[0]?.message?.content;
  if (!content) {
    throw new LLMError('Het taalmodel gaf een lege reactie terug.', 502, 'empty_response', 'empty content');
  }
  return { content };
}

export type QuestionType = 'mcq' | 'open' | 'casus';

// Bron-tag op een quizvraag, gebruikt door de mix-aware generator om aan
// studenten te tonen waar elke vraag vandaan komt.
export type QuizSource = 'rag' | 'itembank' | 'llm';

export interface MCQQuestion {
  type: 'mcq';
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  source?: QuizSource;
}

export interface OpenQuestion {
  type: 'open';
  question: string;
  modelAnswer: string;
  rubric: string;
  source?: QuizSource;
  // Optionele meta-data voor ItemBank-vragen, zodat de evaluator de juiste
  // beoordelingsmethode kan kiezen (numeriek vs tekst/cloze) en in de feedback
  // kan vermelden welke methode is gebruikt (Task #67).
  extype?: 'num' | 'string' | 'cloze' | string;
  numericExpected?: number;
  numericTolerance?: number;
}

export interface CasusQuestion {
  type: 'casus';
  context: string;
  question: string;
  modelAnswer: string;
  rubric: string;
  source?: QuizSource;
}

export type QuizQuestion = MCQQuestion | OpenQuestion | CasusQuestion;

export interface AnswerEvaluation {
  feedback: string;
  feedforward: string;
  score: number; // 0–100
}

const difficultyLabel = (d: 'easy' | 'medium' | 'hard', lang: string = 'nl') =>
  lang !== 'nl'
    ? (d === 'easy' ? 'easy' : d === 'medium' ? 'medium' : 'hard')
    : (d === 'easy' ? 'makkelijke' : d === 'medium' ? 'gemiddelde' : 'moeilijke');

const SECOND_PERSON_RULE_NL = `Aanspraakvorm (volg STRIKT): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT "de student", "deze student" of "de student heeft" — schrijf alsof je het één-op-één tegen de student zegt.`;
const SECOND_PERSON_RULE_EN = `Addressing rule (follow STRICTLY): address the student directly using "you" / "your". NEVER use "the student", "this student" or "the student has" — write as if giving feedback one-on-one.`;
const getSecondPersonRule = () => _getLang() !== 'nl' ? SECOND_PERSON_RULE_EN : SECOND_PERSON_RULE_NL;

// Voor talen anders dan NL/EN: instrueer het model expliciet in welke taal het
// de (AI-gegenereerde) uitvoer moet schrijven. NL en EN hebben al een eigen
// volledige prompt, dus daar is geen extra instructie nodig. Wordt o.a. gebruikt
// bij quizgeneratie, die de systeemprompt overslaat (skipSystemPrompt) en dus
// niet automatisch de server-taalinstructie meekrijgt.
function outputLanguageDirective(lang: Lang): string {
  if (lang === 'nl' || lang === 'en') return '';
  const name = getLanguageMeta(lang)?.english;
  if (!name) return '';
  return `\n\nLANGUAGE REQUIREMENT (follow strictly): Write all human-readable text — every question, every answer option, every explanation, model answer and rubric — in ${name}. Do not write in English or Dutch. Keep the JSON structure intact: do NOT translate or rename any JSON property names/keys (they must stay exactly as specified, in English), and keep fixed/structural values exactly as generated — in particular the \`type\` field (e.g. "mcq", "open", "casus") and any numeric fields or indices. Translate ONLY the human-readable text values.`;
}

function buildContextSection(ragContext?: string, ragStrictMode?: boolean): string {
  if (ragContext) {
    const strictNote = ragStrictMode ? RAG_STRICT_INSTRUCTION_LLM : '';
    return `\n\nGebruik de volgende informatie uit het cursusmateriaal als basis voor de vragen:\n${ragContext}${strictNote}\n`;
  }
  if (ragStrictMode) {
    // Geef geen dubbelzinnige opdracht — returneer een lege sectie zodat de
    // aanroeper de RAG-generatie al vóór de LLM-call kan overslaan wanneer er
    // geen context is. Dit voorkomt dat het model een weigering als quiz-vraag
    // opmaakt.
    return '';
  }
  return '';
}

/**
 * Detecteert of een vraag eigenlijk een LLM-weigering is die als quiz-vraag is
 * opgemaakt. Dit is een veiligheidsvangnet naast de fix in generateMixedQuiz.
 */
function isRefusalQuestion(q: QuizQuestion): boolean {
  const text = ('question' in q ? q.question : '') || '';
  const lower = text.toLowerCase();
  return (
    lower.includes('staat niet in het beschikbare') ||
    lower.includes('kan ik geen vraag') ||
    lower.includes('niet in het cursusmateriaal') ||
    lower.includes('geen relevante') ||
    lower.includes('not in the available') ||
    lower.includes('cannot generate') ||
    lower.includes('unable to generate') ||
    lower.includes('i cannot create')
  );
}

function extractJSON<T>(content: string, kind: 'array' | 'object'): T {
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = content.match(re);
  if (!match) {
    throw new LLMError(
      'Het taalmodel gaf geen geldige JSON terug.',
      502,
      'invalid_response_format',
      content.slice(0, 400),
    );
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch (parseErr: any) {
    throw new LLMError(
      'Het taalmodel gaf geen geldige JSON terug.',
      502,
      'invalid_response_format',
      parseErr?.message || 'JSON parse error',
    );
  }
}

// Cache voor quiz-prompts uit chatbot_prompts (Task #57). Wordt geladen bij
// het eerste gebruik en behouden voor de duur van de pagina; admins moeten de
// pagina vernieuwen na een prompt-wijziging.
export type QuizPromptName =
  | 'quiz_generate_strict'
  | 'quiz_generate_blended'
  | 'quiz_generate_creative'
  | 'quiz_evaluate_open';

// Cache met TTL: succesvolle ophaal blijft 5 min geldig zodat we niet bij elke
// vraag opnieuw naar de DB gaan, terwijl een transiënte fout (HTTP 5xx, offline
// even) niet voor de hele sessie de fallback vastpint. Bij een fout cachen we
// ALLEEN kortstondig (10s) zodat een storm aan calls geen request-storm geeft,
// maar de volgende generatie het opnieuw probeert.
let quizPromptCache: Record<QuizPromptName, string> | null = null;
let quizPromptCacheExpiry = 0;
let quizPromptCacheIsFallback = false;
let quizPromptInflight: Promise<Record<QuizPromptName, string>> | null = null;
const QUIZ_PROMPT_TTL_OK_MS = 5 * 60 * 1000;
const QUIZ_PROMPT_TTL_ERR_MS = 10 * 1000;

export async function fetchQuizPrompts(): Promise<Record<QuizPromptName, string>> {
  const now = Date.now();
  if (quizPromptCache && now < quizPromptCacheExpiry) return quizPromptCache;
  if (quizPromptInflight) return quizPromptInflight;
  quizPromptInflight = (async () => {
    try {
      const { supabase } = await import('../lib/supabase');
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const res = await fetch('/api/quiz/prompts', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prompts = (data?.prompts || {}) as Record<QuizPromptName, string>;
      quizPromptCache = prompts;
      quizPromptCacheExpiry = Date.now() + QUIZ_PROMPT_TTL_OK_MS;
      quizPromptCacheIsFallback = false;
      return prompts;
    } catch (err) {
      console.warn('[llm] fetchQuizPrompts mislukt — fallback op hardcoded persona:', err);
      // Fallback: lege strings → caller gebruikt zijn eigen hardcoded persona.
      const fallback = {
        quiz_generate_strict: '',
        quiz_generate_blended: '',
        quiz_generate_creative: '',
        quiz_evaluate_open: '',
      } as Record<QuizPromptName, string>;
      quizPromptCache = fallback;
      // Korte TTL bij fallback zodat de volgende generatie opnieuw probeert.
      quizPromptCacheExpiry = Date.now() + QUIZ_PROMPT_TTL_ERR_MS;
      quizPromptCacheIsFallback = true;
      return fallback;
    } finally {
      quizPromptInflight = null;
    }
  })();
  return quizPromptInflight;
}

export function clearQuizPromptCache() {
  quizPromptCache = null;
  quizPromptCacheExpiry = 0;
  quizPromptCacheIsFallback = false;
}

export function isQuizPromptCacheFallback(): boolean {
  return quizPromptCacheIsFallback;
}

export async function generateQuiz(
  topics: string[],
  difficulty: 'easy' | 'medium' | 'hard',
  questionType: QuestionType,
  numQuestions: number = 5,
  ragContext?: string,
  ragStrictMode?: boolean,
  systemPromptOverride?: string,
): Promise<QuizQuestion[]> {
  const lang = _getLang();
  const en = lang !== 'nl';
  const contextSection = buildContextSection(ragContext, ragStrictMode);
  const topicsLabel = en
    ? (topics.length === 1 ? `the topic "${topics[0]}"` : `the topics ${topics.map(t => `"${t}"`).join(', ')}`)
    : (topics.length === 1 ? `het onderwerp "${topics[0]}"` : `de onderwerpen ${topics.map(t => `"${t}"`).join(', ')}`);
  const diff = difficultyLabel(difficulty, lang);

  let promptCore: string;
  let exampleJson: string;
  let maxTokens = 2048;

  if (questionType === 'mcq') {
    promptCore = en
      ? `Generate ${numQuestions} ${diff} multiple-choice questions about ${topicsLabel} in the domain of epidemiology and biostatistics.${contextSection}

For each question:
- Write a clear, specific question.
- Provide exactly 4 answer options (A, B, C, D).
- Indicate which answer is correct (0, 1, 2 or 3).
- Provide a brief explanation of why this answer is correct. Write the explanation in second person ("you"/"your") addressing the student.`
      : `Genereer ${numQuestions} ${diff} meerkeuzevragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke vraag:
- Maak een duidelijke, specifieke vraag.
- Geef exact 4 antwoordopties (A, B, C, D).
- Geef aan welk antwoord correct is (0, 1, 2 of 3).
- Geef een korte uitleg waarom dit antwoord correct is. Schrijf de uitleg in tweede persoon ("je"/"jij") gericht aan de student.`;
    exampleJson = en
      ? `[
  {
    "type": "mcq",
    "question": "The question here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "explanation": "Explanation of why this is correct, directed at you"
  }
]`
      : `[
  {
    "type": "mcq",
    "question": "De vraag hier",
    "options": ["Optie A", "Optie B", "Optie C", "Optie D"],
    "correctAnswer": 0,
    "explanation": "Uitleg waarom dit correct is, gericht aan jou"
  }
]`;
  } else if (questionType === 'open') {
    promptCore = en
      ? `Generate ${numQuestions} ${diff} open questions about ${topicsLabel} in the domain of epidemiology and biostatistics.${contextSection}

For each question:
- Ask an open question (not multiple choice) that the student can answer in 3–8 sentences.
- Provide a "modelAnswer": an ideal answer of approximately 4–8 sentences containing the key points.
- Provide a "rubric": brief assessment criteria (3–5 bullets, in one string with newlines) with which an evaluator can later score the student answer.`
      : `Genereer ${numQuestions} ${diff} open vragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke vraag:
- Stel een open vraag (geen meerkeuze) waarop de student in 3–8 zinnen een inhoudelijk antwoord kan geven.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 4–8 zinnen dat de kernpunten bevat.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines) waarmee een beoordelaar later het studentantwoord kan scoren.`;
    exampleJson = en
      ? `[
  {
    "type": "open",
    "question": "The open question here",
    "modelAnswer": "A worked-out example answer of a few sentences.",
    "rubric": "- Mentions definition X\\n- References mechanism Y\\n- Provides an example"
  }
]`
      : `[
  {
    "type": "open",
    "question": "De open vraag hier",
    "modelAnswer": "Een uitgewerkt voorbeeldantwoord van enkele zinnen.",
    "rubric": "- Noemt definitie X\\n- Verwijst naar mechanisme Y\\n- Geeft een voorbeeld"
  }
]`;
  } else {
    promptCore = en
      ? `Generate ${numQuestions} ${diff} case study questions about ${topicsLabel} in the domain of epidemiology and biostatistics.${contextSection}

For each case:
- Write a short, realistic problem sketch ("context") of 3–6 sentences describing a research or practical situation relevant to ${topicsLabel}.
- Then ask one clear question ("question") that forces the student to approach the problem analytically.
- Provide a "modelAnswer": an ideal answer of approximately 5–8 sentences.
- Provide a "rubric": brief assessment criteria (3–5 bullets, in one string with newlines).`
      : `Genereer ${numQuestions} ${diff} casusvragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke casus:
- Schrijf eerst een korte, realistische probleemschets ("context") van 3–6 zinnen waarin een onderzoeks- of praktijksituatie wordt geschetst die past bij ${topicsLabel}.
- Stel daarna één duidelijke vraag ("question") die de student dwingt het probleem analytisch te benaderen.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 5–8 zinnen.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines).`;
    exampleJson = en
      ? `[
  {
    "type": "casus",
    "context": "Short case description of a few sentences.",
    "question": "The question for this case",
    "modelAnswer": "A worked-out example answer of a few sentences.",
    "rubric": "- Identifies the study type\\n- Names possible confounders\\n- Gives a correct conclusion"
  }
]`
      : `[
  {
    "type": "casus",
    "context": "Korte casusbeschrijving van enkele zinnen.",
    "question": "De vraag bij deze casus",
    "modelAnswer": "Een uitgewerkt voorbeeldantwoord van enkele zinnen.",
    "rubric": "- Identificeert het type studie\\n- Benoemt mogelijke confounders\\n- Geeft een correcte conclusie"
  }
]`;
    maxTokens = 3000;
  }

  const quizPrompt = `${promptCore}

${getSecondPersonRule()}

${en
    ? `Format your answer as a JSON array with this structure:\n${exampleJson}\n\nIMPORTANT: Return ONLY the JSON array, no extra text, no markdown code block.`
    : `Formatteer je antwoord als een JSON array met deze structuur:\n${exampleJson}\n\nBELANGRIJK: Geef ALLEEN de JSON array terug, geen extra tekst, geen markdown-codeblok.`}`;

  try {
    const data = await callChatAPI({
      model: undefined,
      messages: [{ role: 'user', content: quizPrompt + outputLanguageDirective(lang) }],
      temperature: 0.7,
      max_tokens: maxTokens,
      skipSystemPrompt: true,
      ...(systemPromptOverride && systemPromptOverride.trim().length > 0
        ? { systemPromptOverride }
        : {}),
    });

    const content = data.choices[0]?.message?.content || '';
    const parsed = extractJSON<QuizQuestion[]>(content, 'array');
    // Defensief: zorg dat elk vraag-object een geldig type heeft. Sommige
    // modellen vergeten het veld (oude MCQ-default), en bij meertalige output
    // kan het model de enum-waarde vertalen ("mcq" -> "keuzevraag"); val in
    // beide gevallen terug op het gevraagde questionType i.p.v. een ongeldige
    // (vertaalde) waarde te accepteren.
    const VALID_QUESTION_TYPES = new Set<QuestionType>(['mcq', 'open', 'casus']);
    const typed = parsed.map((q: any) => ({
      ...q,
      type: VALID_QUESTION_TYPES.has(q?.type) ? q.type : questionType,
    })) as QuizQuestion[];
    // Veiligheidsfilter: gooi weigeringsvragen eruit die het model per ongeluk
    // als echte quiz-vraag heeft opgemaakt.
    return typed.filter(q => !isRefusalQuestion(q));
  } catch (error: any) {
    console.error('Error generating quiz:', error);
    if (error instanceof LLMError) {
      throw error;
    }
    const msg = error?.message || String(error);
    throw new LLMError(msg, 0, undefined, msg);
  }
}

async function evaluateFreeTextAnswer(args: {
  systemPersona: string;
  questionBlock: string;
  modelAnswer: string;
  rubric: string;
  studentAnswer: string;
  systemPromptOverride?: string;
}): Promise<AnswerEvaluation> {
  const { systemPersona, questionBlock, modelAnswer, rubric, studentAnswer, systemPromptOverride } = args;
  const prompt = `${systemPersona}

${questionBlock}

Modelantwoord (referentie, niet zichtbaar voor de student):
${modelAnswer}

Beoordelingscriteria (rubric):
${rubric}

Antwoord van jou (de student):
${studentAnswer}

${getSecondPersonRule()}

Schrijf een formatieve beoordeling met EXACT drie velden:
1. "feedback": 3–6 zinnen die concreet benoemen wat goed gaat en wat ontbreekt of onjuist is in jouw antwoord.
2. "feedforward": 2–4 zinnen die concreet beschrijven hoe jij je antwoord een volgende keer kan verbeteren (één concrete vervolgstap, niet vaag).
3. "score": een geheel getal tussen 0 en 100 dat aangeeft hoe volledig en correct jouw antwoord is, gewogen tegen het modelantwoord en de rubric. 0 = compleet onjuist of leeg, 100 = inhoudelijk volledig en correct.

Geef je antwoord UITSLUITEND als één JSON-object met deze structuur, zonder extra tekst en zonder markdown-codeblok:
{
  "feedback": "...",
  "feedforward": "...",
  "score": 75
}`;

  const data = await callChatAPI({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 1200,
    skipSystemPrompt: true,
    ...(systemPromptOverride && systemPromptOverride.trim().length > 0
      ? { systemPromptOverride }
      : {}),
  });

  const content = data.choices[0]?.message?.content || '';
  const parsed = extractJSON<{ feedback?: string; feedforward?: string; score?: number | string }>(content, 'object');

  const scoreNum = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  return {
    feedback: String(parsed.feedback || '').trim(),
    feedforward: String(parsed.feedforward || '').trim(),
    score: scoreNum,
  };
}

/**
 * Probeert een numeriek antwoord uit een vrij tekstantwoord te halen. Accepteert
 * komma als decimaalteken, optioneel teken, en negeert eenheden of toelichting.
 * Geeft `null` terug als er geen bruikbaar getal is.
 */
function parseNumericAnswer(text: string): number | null {
  if (!text) return null;
  const normalized = text.replace(/,/g, '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Numerieke beoordeling à la R/exams `extol`: het studentantwoord is correct
 * als |student − verwacht| ≤ tolerantie. Bij ontbrekende of nul-tolerantie
 * wordt strikt vergeleken (met een kleine epsilon voor afrondingsruis).
 */
function evaluateNumericAnswer(
  expected: number,
  toleranceRaw: number | undefined,
  studentAnswer: string,
  modelAnswer: string,
): AnswerEvaluation {
  const lang = _getLang();
  const tolerance = Number.isFinite(toleranceRaw as number) && (toleranceRaw as number) > 0
    ? (toleranceRaw as number)
    : 0;
  const student = parseNumericAnswer(studentAnswer);
  const formatExpected = () => {
    const t = tolerance > 0
      ? tStatic(lang, 'quiz.numericEval.toleranceSuffix', { tol: tolerance })
      : '';
    return `${expected}${t}`;
  };
  const methodNote = tolerance > 0
    ? tStatic(lang, 'quiz.numericEval.methodTolerance', { tol: tolerance })
    : tStatic(lang, 'quiz.numericEval.methodStrict');
  const modelNote = modelAnswer && modelAnswer.trim().length > 0
    ? tStatic(lang, 'quiz.numericEval.modelExplanation', { model: modelAnswer.trim() })
    : '';

  if (student === null) {
    return {
      feedback: tStatic(lang, 'quiz.numericEval.noNumberFeedback', {
        expected: formatExpected(),
        method: methodNote,
        model: modelNote,
      }),
      feedforward: tStatic(lang, 'quiz.numericEval.noNumberFeedforward', { expected }),
      score: 0,
    };
  }

  const diff = Math.abs(student - expected);
  const epsilon = tolerance > 0 ? tolerance : 1e-9;
  const correct = diff <= epsilon;

  if (correct) {
    return {
      feedback: tStatic(lang, 'quiz.numericEval.correctFeedback', {
        student,
        expected: formatExpected(),
        method: methodNote,
        model: modelNote,
      }),
      feedforward: tStatic(lang, 'quiz.numericEval.correctFeedforward'),
      score: 100,
    };
  }

  return {
    feedback: tStatic(lang, 'quiz.numericEval.wrongFeedback', {
      student,
      expected: formatExpected(),
      diff: Number(diff.toPrecision(4)),
      method: methodNote,
      model: modelNote,
    }),
    feedforward: tStatic(lang, 'quiz.numericEval.wrongFeedforward'),
    score: 0,
  };
}

export async function evaluateOpenAnswer(
  question: OpenQuestion,
  studentAnswer: string,
  systemPromptOverride?: string,
): Promise<AnswerEvaluation> {
  // Numerieke ItemBank-vragen (extype: num): lokale tolerantie-check is
  // eerlijker dan een LLM-vergelijking en vermeldt expliciet dat extol is
  // toegepast. Vereist een geldig verwacht getal; valt anders terug op LLM.
  if (
    question.extype === 'num'
    && typeof question.numericExpected === 'number'
    && Number.isFinite(question.numericExpected)
  ) {
    return evaluateNumericAnswer(
      question.numericExpected,
      question.numericTolerance,
      studentAnswer,
      question.modelAnswer,
    );
  }

  const evaluation = await evaluateFreeTextAnswer({
    systemPersona: `Je bent een ervaren docent epidemiologie/biostatistiek aan de VU Amsterdam en beoordeelt jouw antwoord op een open vraag.`,
    questionBlock: `Open vraag:\n${question.question}`,
    modelAnswer: question.modelAnswer,
    rubric: question.rubric,
    studentAnswer,
    systemPromptOverride,
  });

  // Vermeld in de feedback welke beoordelingsmethode is gebruikt zodat
  // studenten begrijpen waarom hun tekst- of cloze-antwoord is gescoord
  // tegen het ShareStats-modelantwoord (Task #67).
  if (question.source === 'itembank') {
    const lang = _getLang();
    const methodNote = question.extype === 'cloze'
      ? tStatic(lang, 'quiz.itembankEval.methodCloze')
      : tStatic(lang, 'quiz.itembankEval.methodOpen');
    return {
      ...evaluation,
      feedback: evaluation.feedback ? `${evaluation.feedback}\n\n${methodNote}` : methodNote,
    };
  }
  return evaluation;
}

export async function evaluateCasusAnswer(
  question: CasusQuestion,
  studentAnswer: string,
  systemPromptOverride?: string,
): Promise<AnswerEvaluation> {
  return evaluateFreeTextAnswer({
    systemPersona: `Je bent een ervaren docent epidemiologie/biostatistiek aan de VU Amsterdam en beoordeelt jouw antwoord op een casusvraag. Houd zowel de inhoudelijke juistheid als het correct toepassen op de geschetste casus mee in je oordeel.`,
    questionBlock: `Casusbeschrijving:\n${question.context}\n\nVraag bij de casus:\n${question.question}`,
    modelAnswer: question.modelAnswer,
    rubric: question.rubric,
    studentAnswer,
    systemPromptOverride,
  });
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const response = await fetch('/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Embeddings API error: ${response.status}`);
    }

    const data = await response.json();
    return data.embeddings;
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Error generating embeddings:', msg);
    throw new Error(`Failed to generate embeddings: ${msg}`);
  }
}
