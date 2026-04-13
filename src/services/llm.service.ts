import { supabase } from '../lib/supabase';

const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const HUGGINGFACE_API_KEY = import.meta.env.VITE_HUGGINGFACE_API_KEY;
const HUGGINGFACE_EMBEDDINGS_URL = 'https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
}

const SOCRATIC_SYSTEM_PROMPT = `Je bent een Socratische tutor voor epidemiologie en biostatistiek. Je doel is studenten te begeleiden door een balans tussen uitleg en uitdagende vragen.

Belangrijke regels:
1. Begin ALTIJD met 2-3 zinnen heldere, informatieve uitleg over het concept
2. Volg de uitleg op met een uitdagende vervolgvraag die aanzet tot kritisch denken
3. Geef studenten genoeg context om productief na te kunnen denken
4. Wees geduldig en ondersteunend, maar blijf studenten uitdagen
5. Gebruik voorbeelden en analogieën om begrip te versterken
6. Prijs deelantwoorden en moedig studenten aan dieper na te denken

STRUCTUUR VAN EEN GOEDE RESPONSE:
1. Korte, heldere uitleg (2-3 zinnen) met essentiële informatie
2. Optioneel: een voorbeeld of analogie
3. Uitdagende vervolgvraag die voortbouwt op de uitleg

Voorbeelden van GOEDE responses:

Student: "Hoe werkt een gemiddelde?"
Assistent: "Een gemiddelde bereken je door alle waarden op te tellen en dit totaal te delen door het aantal waarden. Als je bijvoorbeeld de cijfers 6, 8, en 10 hebt, reken je (6+8+10)/3 = 8. Het gemiddelde geeft je een centraal punt in je dataset.

Nu een vraag: waarom zou je in sommige situaties de mediaan verkiezen boven het gemiddelde?"

Student: "Wat is een p-waarde?"
Assistent: "Een p-waarde geeft de kans weer dat je de gevonden resultaten zou zien als er in werkelijkheid geen effect bestaat. Een lage p-waarde (bijvoorbeeld < 0.05) suggereert dat je resultaten waarschijnlijk niet op toeval berusten. Het is een maat voor de sterkte van je bewijs tegen de nulhypothese.

Kun je uitleggen wat het betekent als je een p-waarde van 0.03 vindt in je onderzoek?"

Voorbeelden van SLECHTE responses (VERMIJD DEZE):
- "Wat weet je zelf al over gemiddelden?" (zonder eerst uitleg te geven)
- "Interessante vraag! Kun je zelf nadenken over hoe dat werkt?" (te vaag en niet helpend)
- Lange theoretische uiteenzettingen zonder vervolgvragen

Blijf studenten helpen MET informatie én uitdagen MET vragen!`;

async function getActiveSystemPrompt(): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('chatbot_prompts')
      .select('content')
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.warn('Error fetching active prompt, using default:', error);
      return SOCRATIC_SYSTEM_PROMPT;
    }

    if (!data) {
      console.warn('No active prompt found, using default');
      return SOCRATIC_SYSTEM_PROMPT;
    }

    return data.content;
  } catch (error) {
    console.error('Error fetching active prompt:', error);
    return SOCRATIC_SYSTEM_PROMPT;
  }
}

export async function sendChatMessage(
  messages: Message[],
  context?: string
): Promise<LLMResponse> {
  if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') {
    return {
      content: 'Groq API key is niet geconfigureerd. Voeg je API key toe aan de .env file.',
      error: 'API key not configured'
    };
  }

  try {
    const activePrompt = await getActiveSystemPrompt();

    const systemMessage: Message = {
      role: 'system',
      content: context
        ? `${activePrompt}\n\nContext uit cursusmateriaal:\n${context}`
        : activePrompt
    };

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [systemMessage, ...messages],
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 1,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || `Groq API Error: ${response.status}`;
      console.error('[LLM] Groq API error:', errorMsg);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Geen antwoord ontvangen van Groq API');
    }

    return { content };
  } catch (error: any) {
    console.error('[LLM] Error calling Groq API:', error);
    throw new Error(`LLM fout: ${error.message}`);
  }
}

export async function evaluateExplanation(
  concept: string,
  explanation: string,
  definition: string,
  keyPoints: string[],
  ragContext?: string,
  retrievedSources?: Array<{ title: string; similarity: number }>
): Promise<LLMResponse> {
  if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') {
    return {
      content: 'Groq API key is niet geconfigureerd.',
      error: 'API key not configured'
    };
  }

  let evaluationPrompt = `Evalueer de volgende uitleg van een student voor het begrip "${concept}".

Officiële definitie:
${definition}

Kernpunten die genoemd zouden moeten worden:
${keyPoints.map((point, i) => `${i + 1}. ${point}`).join('\n')}`;

  if (ragContext) {
    evaluationPrompt += `\n\nRelevante informatie uit cursusmateriaal:\n${ragContext}`;
  }

  evaluationPrompt += `\n\nUitleg van de student:
${explanation}

Geef gestructureerde feedback met:
1. Wat de student goed heeft gedaan (specifieke punten)
2. Wat ontbreekt of onduidelijk is
3. Eventuele misconcepties die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering`;

  if (retrievedSources && retrievedSources.length > 0) {
    evaluationPrompt += `\n\nJe hebt toegang tot de volgende bronnen uit het cursusmateriaal: ${retrievedSources.map(s => s.title).join(', ')}. Verwijs naar deze bronnen als dat relevant is.`;
  }

  evaluationPrompt += `\n\nWees constructief en moedigend, maar ook specifiek en nuttig.`;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: evaluationPrompt }],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0]?.message?.content || 'Geen feedback gegenereerd',
    };
  } catch (error: any) {
    console.error('Error evaluating explanation:', error);
    return {
      content: 'Er is een fout opgetreden bij het evalueren van je uitleg.',
      error: error.message,
    };
  }
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
  numQuestions: number = 5
): Promise<QuizQuestion[]> {
  if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') {
    throw new Error('Groq API key is niet geconfigureerd.');
  }

  const quizPrompt = `Genereer ${numQuestions} ${difficulty === 'easy' ? 'makkelijke' : difficulty === 'medium' ? 'gemiddelde' : 'moeilijke'} meerkeuzevragen over ${topic} in het domein van epidemiologie en biostatistiek.

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
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: quizPrompt }],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
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

async function generateEmbeddingsWithHuggingFace(texts: string[]): Promise<number[][]> {
  if (!HUGGINGFACE_API_KEY || HUGGINGFACE_API_KEY === 'your_huggingface_api_key_here') {
    throw new Error('Hugging Face API key is not configured');
  }

  const embeddings: number[][] = [];

  for (const text of texts) {
    try {
      const response = await fetch(HUGGINGFACE_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: text,
          options: {
            wait_for_model: true,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API Error: ${response.status}`);
      }

      const embedding = await response.json();

      if (Array.isArray(embedding) && embedding.length === 384) {
        embeddings.push(embedding);
      } else {
        throw new Error('Invalid embedding format from Hugging Face API');
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error: any) {
      console.error('Error generating embedding with Hugging Face:', error);
      throw error;
    }
  }

  return embeddings;
}

async function generateEmbeddingsWithOpenAI(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'your_openai_api_key_here') {
    throw new Error('OpenAI API key is not configured');
  }

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
        dimensions: 384,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API Error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.map((item: any) => item.embedding);
  } catch (error: any) {
    console.error('Error generating embeddings with OpenAI:', error);
    throw error;
  }
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    console.log('Attempting to generate embeddings with Hugging Face (free)...');
    return await generateEmbeddingsWithHuggingFace(texts);
  } catch (hfError: any) {
    console.warn('Hugging Face embeddings failed, falling back to OpenAI:', hfError.message);

    try {
      return await generateEmbeddingsWithOpenAI(texts);
    } catch (openaiError: any) {
      console.error('Both embedding services failed');
      throw new Error(
        `Failed to generate embeddings. Hugging Face: ${hfError.message}. OpenAI: ${openaiError.message}. ` +
        'Configureer minimaal één API key in de .env file.'
      );
    }
  }
}
