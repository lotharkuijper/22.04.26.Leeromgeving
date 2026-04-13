import { supabase } from '../lib/supabase';

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

async function callChatAPI(body: object): Promise<any> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.error?.message || errorData.error || `API Error: ${response.status}`;
    throw new Error(errorMsg);
  }

  return response.json();
}

export async function sendChatMessage(
  messages: Message[],
  context?: string
): Promise<LLMResponse> {
  try {
    const activePrompt = await getActiveSystemPrompt();

    const systemMessage: Message = {
      role: 'system',
      content: context
        ? `${activePrompt}\n\nContext uit cursusmateriaal:\n${context}`
        : activePrompt
    };

    const data = await callChatAPI({
      model: 'llama-3.3-70b-versatile',
      messages: [systemMessage, ...messages],
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
      stream: false,
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

export async function evaluateExplanation(
  concept: string,
  explanation: string,
  definition: string,
  keyPoints: string[],
  ragContext?: string,
  retrievedSources?: Array<{ title: string; similarity: number }>
): Promise<LLMResponse> {
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
    const data = await callChatAPI({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: evaluationPrompt }],
      temperature: 0.3,
      max_tokens: 1500,
    });

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
  numQuestions: number = 5,
  ragContext?: string
): Promise<QuizQuestion[]> {
  const contextSection = ragContext
    ? `\n\nGebruik de volgende informatie uit het cursusmateriaal als basis voor de vragen:\n${ragContext}\n`
    : '';

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
    console.error('Error generating embeddings:', error);
    throw new Error(`Failed to generate embeddings: ${error.message}`);
  }
}
