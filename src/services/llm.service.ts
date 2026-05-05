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

export function llmErrorToDutch(err: unknown): { title: string; detail?: string } {
  if (err instanceof LLMError) {
    const code = err.code ?? '';
    const raw = (err.rawMessage || err.message || '').toLowerCase();
    if (code === 'context_length_exceeded' || raw.includes('context') && raw.includes('length')) {
      return {
        title: 'De prompt is te lang geworden voor het taalmodel.',
        detail: 'Probeer de RAG-drempel iets hoger te zetten of het aantal passages (match_count) te verlagen, zodat er minder cursusmateriaal wordt meegestuurd.',
      };
    }
    if (code === 'rate_limit_exceeded' || err.status === 429 || raw.includes('rate limit')) {
      return {
        title: 'Het taalmodel staat tijdelijk onder druk (rate limit).',
        detail: 'Wacht een halve minuut en probeer het opnieuw.',
      };
    }
    if (err.status === 503) {
      return {
        title: 'De chatbot is niet (volledig) geconfigureerd.',
        detail: err.rawMessage || 'Controleer of de GROQ_API_KEY beschikbaar is.',
      };
    }
    if (err.status >= 500) {
      return {
        title: 'Het taalmodel reageert niet (serverfout).',
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    if (code === 'invalid_request_error' || (err.status >= 400 && err.status < 500)) {
      return {
        title: 'Het taalmodel weigerde het verzoek.',
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    return { title: 'Er ging iets mis bij het taalmodel.', detail: err.rawMessage };
  }
  if (err instanceof Error) {
    return { title: 'Er ging iets mis bij het taalmodel.', detail: err.message };
  }
  return { title: 'Er ging iets mis bij het taalmodel.' };
}

async function callChatAPI(body: object): Promise<any> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  ragStrictMode?: boolean
): Promise<LLMResponse> {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');

    const data = await callChatAPI({
      model: 'llama-3.3-70b-versatile',
      messages: userMessages,
      context,
      temperature: 0.7,
      top_p: 1,
      stream: false,
      ragStrictMode: ragStrictMode ?? false,
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
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: evaluationPrompt }],
    temperature: 0.3,
    max_tokens: 1500,
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

const difficultyLabel = (d: 'easy' | 'medium' | 'hard') =>
  d === 'easy' ? 'makkelijke' : d === 'medium' ? 'gemiddelde' : 'moeilijke';

const SECOND_PERSON_RULE = `Aanspraakvorm (volg STRIKT): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT "de student", "deze student" of "de student heeft" — schrijf alsof je het één-op-één tegen de student zegt.`;

function buildContextSection(ragContext?: string, ragStrictMode?: boolean): string {
  if (ragContext) {
    const strictNote = ragStrictMode ? RAG_STRICT_INSTRUCTION_LLM : '';
    return `\n\nGebruik de volgende informatie uit het cursusmateriaal als basis voor de vragen:\n${ragContext}${strictNote}\n`;
  }
  if (ragStrictMode) {
    return `\n\n${RAG_STRICT_INSTRUCTION_LLM}\n\nEr zijn geen relevante cursusteksten beschikbaar. Geef dit aan in de vragen of genereer geen vragen.\n`;
  }
  return '';
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

let quizPromptCache: Record<QuizPromptName, string> | null = null;
let quizPromptInflight: Promise<Record<QuizPromptName, string>> | null = null;

export async function fetchQuizPrompts(): Promise<Record<QuizPromptName, string>> {
  if (quizPromptCache) return quizPromptCache;
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
      return fallback;
    } finally {
      quizPromptInflight = null;
    }
  })();
  return quizPromptInflight;
}

export function clearQuizPromptCache() {
  quizPromptCache = null;
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
  const contextSection = buildContextSection(ragContext, ragStrictMode);
  const topicsLabel = topics.length === 1 ? `het onderwerp "${topics[0]}"` : `de onderwerpen ${topics.map(t => `"${t}"`).join(', ')}`;
  const diff = difficultyLabel(difficulty);

  let promptCore: string;
  let exampleJson: string;
  let maxTokens = 2048;

  if (questionType === 'mcq') {
    promptCore = `Genereer ${numQuestions} ${diff} meerkeuzevragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke vraag:
- Maak een duidelijke, specifieke vraag.
- Geef exact 4 antwoordopties (A, B, C, D).
- Geef aan welk antwoord correct is (0, 1, 2 of 3).
- Geef een korte uitleg waarom dit antwoord correct is. Schrijf de uitleg in tweede persoon ("je"/"jij") gericht aan de student.`;
    exampleJson = `[
  {
    "type": "mcq",
    "question": "De vraag hier",
    "options": ["Optie A", "Optie B", "Optie C", "Optie D"],
    "correctAnswer": 0,
    "explanation": "Uitleg waarom dit correct is, gericht aan jou"
  }
]`;
  } else if (questionType === 'open') {
    promptCore = `Genereer ${numQuestions} ${diff} open vragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke vraag:
- Stel een open vraag (geen meerkeuze) waarop de student in 3–8 zinnen een inhoudelijk antwoord kan geven.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 4–8 zinnen dat de kernpunten bevat.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines) waarmee een beoordelaar later het studentantwoord kan scoren.`;
    exampleJson = `[
  {
    "type": "open",
    "question": "De open vraag hier",
    "modelAnswer": "Een uitgewerkt voorbeeldantwoord van enkele zinnen.",
    "rubric": "- Noemt definitie X\\n- Verwijst naar mechanisme Y\\n- Geeft een voorbeeld"
  }
]`;
  } else {
    promptCore = `Genereer ${numQuestions} ${diff} casusvragen over ${topicsLabel} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke casus:
- Schrijf eerst een korte, realistische probleemschets ("context") van 3–6 zinnen waarin een onderzoeks- of praktijksituatie wordt geschetst die past bij ${topicsLabel}.
- Stel daarna één duidelijke vraag ("question") die de student dwingt het probleem analytisch te benaderen.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 5–8 zinnen.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines).`;
    exampleJson = `[
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

${SECOND_PERSON_RULE}

Formatteer je antwoord als een JSON array met deze structuur:
${exampleJson}

BELANGRIJK: Geef ALLEEN de JSON array terug, geen extra tekst, geen markdown-codeblok.`;

  try {
    const data = await callChatAPI({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: quizPrompt }],
      temperature: 0.7,
      max_tokens: maxTokens,
      skipSystemPrompt: true,
      ...(systemPromptOverride && systemPromptOverride.trim().length > 0
        ? { systemPromptOverride }
        : {}),
    });

    const content = data.choices[0]?.message?.content || '';
    const parsed = extractJSON<QuizQuestion[]>(content, 'array');
    // Defensief: zorg dat elk vraag-object het type heeft (sommige modellen
    // vergeten dat veld bij MCQ omdat dat de oude default was).
    return parsed.map((q: any) => ({ ...q, type: q.type || questionType })) as QuizQuestion[];
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

${SECOND_PERSON_RULE}

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
    model: 'llama-3.3-70b-versatile',
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

export async function evaluateOpenAnswer(
  question: OpenQuestion,
  studentAnswer: string,
  systemPromptOverride?: string,
): Promise<AnswerEvaluation> {
  return evaluateFreeTextAnswer({
    systemPersona: `Je bent een ervaren docent epidemiologie/biostatistiek aan de VU Amsterdam en beoordeelt jouw antwoord op een open vraag.`,
    questionBlock: `Open vraag:\n${question.question}`,
    modelAnswer: question.modelAnswer,
    rubric: question.rubric,
    studentAnswer,
    systemPromptOverride,
  });
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
