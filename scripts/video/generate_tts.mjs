/**
 * LAIR-VU Promo — TTS generation via OpenAI
 * Generates NL + EN voice-over MP3s per scene using tts-1-hd
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../../attached_assets/promo_audio');
mkdirSync(OUT_DIR, { recursive: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

const NL_VOICE = 'nova';   // warm, natural
const EN_VOICE = 'shimmer'; // clear, friendly

const scenes = [
  {
    id: 1,
    nl: 'Wat als je AI-assistent je niet zomaar het antwoord geeft?',
    en: "What if your AI assistant didn't just give you the answer?",
  },
  {
    id: 2,
    nl: 'LAIR-VU helpt je écht begrijpen — door te vragen, te redeneren, en stap voor stap samen te denken.',
    en: 'LAIR-VU helps you truly understand — by asking questions, reasoning together, step by step.',
  },
  {
    id: 3,
    nl: 'De tool is gebouwd op hoe leren werkt: actief, sociaal, en met ruimte voor fouten.',
    en: 'Built on learning science: active, social, and with room to make mistakes.',
  },
  {
    id: 4,
    nl: 'Vraag uitleg over een begrip. Je krijgt geen kant-en-klaar antwoord, maar hulp om het zelf te doorgronden.',
    en: "Ask for an explanation. You won't get a copy-paste answer — you'll get guidance to figure it out yourself.",
  },
  {
    id: 5,
    nl: 'Alles gebaseerd op jouw cursusmateriaal — niet op het internet.',
    en: 'Everything grounded in your own course material — not the internet.',
  },
  {
    id: 6,
    nl: 'Oefen met slimme quizvragen die écht aansluiten op wat je studeert.',
    en: 'Practice with smart quiz questions that match exactly what you are studying.',
  },
  {
    id: 7,
    nl: 'In projecten voer je gesprekken met AI-experts die vragen stellen die je aan het denken zetten.',
    en: "In projects, you'll talk with AI experts who ask the questions that make you think.",
  },
  {
    id: 8,
    nl: 'En daarna reflecteer je op wat je hebt geleerd. Zo beklijft het.',
    en: "Afterwards, you reflect on what you've learned. That's what makes it stick.",
  },
  {
    id: 9,
    nl: 'Voor elke cursus, in het Nederlands en Engels.',
    en: 'For any course, in Dutch and English.',
  },
  {
    id: 10,
    nl: 'LAIR-VU — leren zoals het bedoeld is.',
    en: 'LAIR-VU — learning the way it is meant to be.',
  },
];

async function generateTTS(text, voice, outputPath) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      input: text,
      voice,
      response_format: 'mp3',
      speed: 0.92,  // slightly slower for clarity
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TTS failed for "${text.slice(0, 40)}...": ${err}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buf);
  console.log(`  ✓ ${outputPath.split('/').slice(-1)[0]}`);
}

console.log('Generating NL voice-overs...');
for (const s of scenes) {
  await generateTTS(s.nl, NL_VOICE, join(OUT_DIR, `scene${s.id}_nl.mp3`));
}

console.log('Generating EN voice-overs...');
for (const s of scenes) {
  await generateTTS(s.en, EN_VOICE, join(OUT_DIR, `scene${s.id}_en.mp3`));
}

console.log('\nDone! All TTS files saved to:', OUT_DIR);
