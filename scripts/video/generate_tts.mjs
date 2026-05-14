/**
 * LAIR-VU Promo — TTS generation via OpenAI tts-1-hd
 * Generates NL + EN voice-overs as MP3 AND WAV per scene,
 * plus combined audio tracks per language.
 * Voice NL: nova (warm), EN: shimmer (clear)
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../../attached_assets/promo_audio');
mkdirSync(OUT_DIR, { recursive: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

const VOICES = { nl: 'nova', en: 'shimmer' };

// Exact approved copy from task #141
const scenes = [
  {
    id: 1,
    nl: 'Wat als je AI-assistent je niet zomaar het antwoord geeft?',
    en: "What if your AI assistant didn't just give you the answer?",
  },
  {
    id: 2,
    nl: 'LAIR-VU helpt je echt begrijpen, door te vragen, te redeneren, en stap voor stap samen te denken.',
    en: 'LAIR-VU helps you truly understand, by asking questions, reasoning together, step by step.',
  },
  {
    id: 3,
    nl: 'De tool is gebouwd op hoe leren werkt: actief, sociaal, en met ruimte voor fouten.',
    en: 'Built on learning science: active, social, and with room to make mistakes.',
  },
  {
    id: 4,
    nl: 'Vraag uitleg over een begrip. Je krijgt geen kant-en-klaar antwoord, maar hulp om het zelf te doorgronden.',
    en: "Ask for an explanation. You won't get a copy-paste answer. You'll get guidance to figure it out yourself.",
  },
  {
    id: 5,
    nl: 'Alles gebaseerd op jouw cursusmateriaal, niet op het internet.',
    en: 'Everything grounded in your own course material, not the internet.',
  },
  {
    id: 6,
    nl: 'Oefen met slimme quizvragen die echt aansluiten op wat je studeert.',
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
    nl: 'LAIR-VU. Leren zoals het bedoeld is.',
    en: 'LAIR-VU. Learning the way it is meant to be.',
  },
];

async function generateTTS(text, voice, mp3Path, wavPath) {
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
      speed: 0.92,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TTS failed: ${err}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(mp3Path, buf);

  // Convert MP3 → WAV via FFmpeg
  execFileSync('ffmpeg', ['-y', '-i', mp3Path, '-acodec', 'pcm_s16le', '-ar', '44100', wavPath],
    { stdio: 'pipe' });
  console.log(`  ✓ scene${mp3Path.match(/scene(\d+)/)[1]} (${mp3Path.split('/').pop().includes('_nl') ? 'NL' : 'EN'})`);
}

for (const lang of ['nl', 'en']) {
  console.log(`\nGenerating ${lang.toUpperCase()} voice-overs...`);
  for (const s of scenes) {
    const mp3Path = join(OUT_DIR, `scene${s.id}_${lang}.mp3`);
    const wavPath = join(OUT_DIR, `scene${s.id}_${lang}.wav`);
    await generateTTS(s[lang], VOICES[lang], mp3Path, wavPath);
  }

  // Create combined audio track for this language
  console.log(`  Creating combined ${lang.toUpperCase()} track...`);
  const concatList = join(OUT_DIR, `concat_${lang}.txt`);
  const wavFiles = scenes.map(s => `file '${join(OUT_DIR, `scene${s.id}_${lang}.wav`)}'`).join('\n');
  writeFileSync(concatList, wavFiles);
  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c', 'copy',
    join(OUT_DIR, `combined_${lang}.wav`)
  ], { stdio: 'pipe' });
  console.log(`  ✓ combined_${lang}.wav`);
}

console.log('\nAll TTS files saved to:', OUT_DIR);
