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
      throw new Error('Geen antwoord ontvangen van Groq API');
    }

    return { content };
  } catch (error: any) {
    console.error('[LLM] Error calling chat API:', error);
    if (error.message?.includes('503') || error.message?.includes('not configured')) {
      return {
        content: 'De chatbot is nog niet geconfigureerd. Voeg een GROQ_API_KEY toe in de Replit Secrets.',
        error: 'API key not configured'
      };
    }
    throw new Error(`LLM fout: ${error.message}`);
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

    if (retrievedSources && retrievedSources.length > 0) {
      evaluationPrompt += `\n\nBeschikbare bronnen uit cursusmateriaal: ${retrievedSources.map(s => s.title).join(', ')}. Verwijs ernaar als dat relevant is.`;
    }
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

Geef gestructureerde feedback met:
1. Wat de student goed heeft gedaan (specifieke punten)
2. Wat ontbreekt of onduidelijk is
3. Eventuele misconcepties die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering`;

    if (retrievedSources && retrievedSources.length > 0) {
      evaluationPrompt += `\n\nJe hebt toegang tot de volgende bronnen uit het cursusmateriaal: ${retrievedSources.map(s => s.title).join(', ')}. Verwijs naar deze bronnen als dat relevant is.`;
    }

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

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

export async function generateQuiz(
  topic: string,
  difficulty: 'easy' | 'medium' | 'hard',
  numQuestions: number = 5,
  ragContext?: string,
  ragStrictMode?: boolean
): Promise<QuizQuestion[]> {
  let contextSection = '';
  if (ragContext) {
    const strictNote = ragStrictMode ? RAG_STRICT_INSTRUCTION_LLM : '';
    contextSection = `\n\nGebruik de volgende informatie uit het cursusmateriaal als basis voor de vragen:\n${ragContext}${strictNote}\n`;
  } else if (ragStrictMode) {
    contextSection = `\n\n${RAG_STRICT_INSTRUCTION_LLM}\n\nEr zijn geen relevante cursusteksten beschikbaar. Geef dit aan in de vragen of genereer geen vragen.\n`;
  }

  const quizPrompt = `Genereer ${numQuestions} ${difficulty === 'easy' ? 'makkelijke' : difficulty === 'medium' ? 'gemiddelde' : 'moeilijke'} meerkeuzevragen over ${topic} in het domein van epidemiologie en biostatistiek.${contextSection}

Voor elke vraag:
- Maak een duidelijke, specifieke vraag
- Geef exact 4 antwoordopties (A, B, C, D)
- Geef aan welk antwoord correct is (0, 1, 2, of 3)
- Geef een korte uitleg waarom dit antwoord correct is

Formatteer je antwoord als een JSON array met deze structuur:
[
  {
    "question": "De vraag hier",
    "options": ["Optie A", "Optie B", "Optie C", "Optie D"],
    "correctAnswer": 0,
    "explanation": "Uitleg waarom dit correct is"
  }
]

BELANGRIJK: Geef ALLEEN de JSON array terug, geen extra tekst.`;

  try {
    const data = await callChatAPI({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: quizPrompt }],
      temperature: 0.7,
      max_tokens: 2048,
      skipSystemPrompt: true,
    });

    const content = data.choices[0]?.message?.content || '';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Invalid response format');
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error: any) {
    console.error('Error generating quiz:', error);
    throw new Error(`Failed to generate quiz: ${error.message}`);
  }
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
