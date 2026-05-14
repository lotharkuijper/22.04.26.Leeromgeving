/**
 * LAIR-VU Promo Video Assembler (fixed)
 * Outputs: lairvu_promo_nl.mp4 and lairvu_promo_en.mp4
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dirname, '../..');
const VIDEOS = join(ROOT, 'attached_assets/generated_videos');
const AUDIO  = join(ROOT, 'attached_assets/promo_audio');
const TMP    = join(ROOT, 'attached_assets/promo_tmp');
const OUT    = join(ROOT, 'attached_assets');

mkdirSync(TMP, { recursive: true });

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const errTxt = e.stderr?.toString() ?? '';
    // Show just last 600 chars of stderr
    console.error(`  ✗ ${cmd} error:\n${errTxt.slice(-600)}`);
    throw e;
  }
}

function ffmpeg(args) { run('ffmpeg', ['-y', ...args]); }

function probe(file) {
  return parseFloat(
    execFileSync('ffprobe', [
      '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
    ]).toString().trim()
  );
}

function escDt(s) {
  // Escape text for FFmpeg drawtext
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\u2019")   // replace smart apostrophe to avoid escaping issues
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/é/g, 'e')        // keep ASCII for drawtext compatibility
    .replace(/è/g, 'e')
    .replace(/ê/g, 'e')
    .replace(/ë/g, 'e')
    .replace(/à/g, 'a')
    .replace(/â/g, 'a')
    .replace(/ô/g, 'o')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u')
    .replace(/ü/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/ï/g, 'i')
    .replace(/—/g, '-')
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"');
}

// ─── Scene data ────────────────────────────────────────────────────────────
const TOTAL_DUR = 76.04;

const scenes = [
  { id:1,  video:'scene1_opening.mp4',          vidDur:8.00,
    nl:{ dur:3.91, lines:["Wat als je AI-assistent je",  "niet zomaar het antwoord geeft?"] },
    en:{ dur:3.60, lines:["What if your AI assistant",   "didn't just give you the answer?"] } },

  { id:2,  video:'scene2_socratic_dialogue.mp4', vidDur:8.00,
    nl:{ dur:6.67, lines:["LAIR-VU helpt je echt begrijpen -", "door te vragen, te redeneren,", "en stap voor stap samen te denken."] },
    en:{ dur:6.07, lines:["LAIR-VU helps you truly understand -", "by asking questions, reasoning together,", "step by step."] } },

  { id:3,  video:'scene3_learning_science.mp4',  vidDur:8.00,
    nl:{ dur:4.80, lines:["Gebouwd op hoe leren werkt:", "actief, sociaal, met ruimte voor fouten."] },
    en:{ dur:4.87, lines:["Built on learning science:", "active, social, with room to make mistakes."] } },

  { id:4,  video:'scene4_explain_concepts.mp4',  vidDur:8.00,
    nl:{ dur:7.08, lines:["Vraag uitleg over een begrip.", "Je krijgt hulp om het zelf te doorgronden.", "Geen kant-en-klaar antwoord."] },
    en:{ dur:7.18, lines:["Ask for an explanation.", "You get guidance to figure it out yourself.", "Not a copy-paste answer."] } },

  { id:5,  video:'scene5_course_material.mp4',   vidDur:8.00,
    nl:{ dur:3.94, lines:["Gebaseerd op jouw cursusmateriaal -", "niet op het internet."] },
    en:{ dur:4.51, lines:["Grounded in your own course material -", "not the internet."] } },

  { id:6,  video:'scene6_quiz.mp4',              vidDur:8.00,
    nl:{ dur:4.61, lines:["Oefen met slimme quizvragen", "die echt aansluiten op wat je studeert."] },
    en:{ dur:5.21, lines:["Practice with smart quiz questions", "that match exactly what you are studying."] } },

  { id:7,  video:'scene7_project_personas.mp4',  vidDur:8.00,
    nl:{ dur:6.26, lines:["In projecten chat je met AI-experts", "die vragen stellen die je", "aan het denken zetten."] },
    en:{ dur:5.66, lines:["In projects, you talk with AI experts", "who ask the questions", "that make you think."] } },

  { id:8,  video:'scene8_reflection.mp4',        vidDur:6.02,
    nl:{ dur:4.25, lines:["Daarna reflecteer je op wat je leerde.", "Zo beklijft het."] },
    en:{ dur:4.94, lines:["Afterwards, you reflect on what you learned.", "That's what makes it stick."] } },

  { id:9,  video:'scene9_generic_courses.mp4',   vidDur:6.02,
    nl:{ dur:2.86, lines:["Voor elke cursus,", "in het Nederlands en Engels."] },
    en:{ dur:2.45, lines:["For any course,", "in Dutch and English."] } },

  { id:10, video:'scene10_closing.mp4',          vidDur:8.00,
    nl:{ dur:2.38, lines:["LAIR-VU", "Leren zoals het bedoeld is."] },
    en:{ dur:3.02, lines:["LAIR-VU", "Learning the way it is meant to be."] } },
];

// ─── Step 1: Background music ──────────────────────────────────────────────
console.log('[1/4] Generating background music...');
const bgPath = join(TMP, 'bg.mp3');
const totalPlusFade = Math.ceil(TOTAL_DUR) + 6;

// 3 layered sine waves (A major triad), mixed and filtered
ffmpeg([
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${totalPlusFade}`,
  '-f', 'lavfi', '-i', `sine=frequency=277:duration=${totalPlusFade}`,
  '-f', 'lavfi', '-i', `sine=frequency=330:duration=${totalPlusFade}`,
  '-filter_complex',
  [
    '[0:a][1:a][2:a]amix=inputs=3:duration=first[mix]',
    `[mix]volume=0.07,aecho=0.5:0.5:80|120:0.25|0.15,lowpass=f=600,afade=t=out:st=${TOTAL_DUR - 1}:d=4[out]`
  ].join(';'),
  '-map', '[out]',
  '-c:a', 'libmp3lame', '-q:a', '4',
  bgPath
]);
console.log('  ✓ background music ready');

// ─── Step 2+3: Build per-language video ────────────────────────────────────
async function buildVideo(lang) {
  const stepNum = lang === 'nl' ? '2' : '3';
  console.log(`\n[${stepNum}/4] Building ${lang.toUpperCase()} video...`);

  // 2a. Process each clip: combine video + padded TTS
  const clipPaths = [];
  for (const sc of scenes) {
    const vidPath = join(VIDEOS, sc.video);
    const ttsPath = join(AUDIO, `scene${sc.id}_${lang}.mp3`);
    const clipOut = join(TMP, `c${sc.id}_${lang}.mp4`);
    const ttsDur  = sc[lang].dur;

    // Pad TTS with silence to match full video duration
    ffmpeg([
      '-i', vidPath,
      '-i', ttsPath,
      '-filter_complex',
      [
        `[0:v]scale=1280:720,fps=25,format=yuv420p[v]`,
        `[1:a]apad=whole_dur=${sc.vidDur}[a]`,
      ].join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', String(sc.vidDur),
      clipOut
    ]);
    clipPaths.push(clipOut);
    process.stdout.write(`  ✓ clip ${sc.id}/10\r`);
  }
  console.log('  ✓ all clips processed   ');

  // 2b. Concat list
  const concatTxt = join(TMP, `concat_${lang}.txt`);
  writeFileSync(concatTxt, clipPaths.map(p => `file '${p}'`).join('\n'));

  const concatRaw = join(TMP, `raw_${lang}.mp4`);
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', concatTxt,
    '-c', 'copy',
    concatRaw
  ]);
  console.log('  ✓ clips concatenated');

  // 2c. Build drawtext subtitle filter for each scene line
  // Each scene's lines appear from the start of that scene
  const DT_FONTSIZE = 28;
  const DT_FONTCOLOR = 'white@0.95';
  const DT_SHADOW    = '0x000000@0.8';
  const DT_MARGIN    = 50; // px from bottom per line

  let vChain = '[0:v]';
  const dtParts = [];
  let cumT = 0;

  for (const sc of scenes) {
    const langData = sc[lang];
    const lines = langData.lines;
    const showEnd = cumT + langData.dur + 0.2;
    const showStart = cumT + 0.15;

    const isClosing = sc.id === 10;
    const fontSize  = isClosing ? 42 : DT_FONTSIZE;

    // Lines stack from bottom up
    lines.forEach((line, li) => {
      const lineIdx  = lines.length - 1 - li; // 0 = bottom
      const yPos     = 720 - DT_MARGIN - lineIdx * (fontSize + 8);
      const txt      = escDt(line);
      const fs       = (isClosing && li === 0) ? 52 : fontSize; // first line of closing = big title
      dtParts.push(
        `drawtext=fontsize=${fs}:fontcolor=${DT_FONTCOLOR}` +
        `:shadowcolor=${DT_SHADOW}:shadowx=2:shadowy=2` +
        `:x=(w-text_w)/2:y=${yPos}` +
        `:text='${txt}'` +
        `:enable='between(t,${showStart.toFixed(2)},${showEnd.toFixed(2)})'`
      );
    });
    cumT += sc.vidDur;
  }

  const videoFilter = dtParts.join(',') + '[vout]';
  const fullFilter = `[0:v]${videoFilter}`;

  // 2d. Final render: video + subtitles + bg music
  const finalOut = join(OUT, `lairvu_promo_${lang}.mp4`);
  ffmpeg([
    '-i', concatRaw,
    '-i', bgPath,
    '-filter_complex',
    [
      fullFilter,
      '[0:a]volume=1.0[va]',
      `[1:a]volume=0.14,atrim=0:${TOTAL_DUR}[bga]`,
      '[va][bga]amix=inputs=2:duration=first[aout]',
    ].join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-t', String(TOTAL_DUR),
    finalOut
  ]);

  const actualDur = probe(finalOut);
  console.log(`  ✓ ${lang.toUpperCase()} → ${finalOut} (${actualDur.toFixed(1)}s)`);
  return finalOut;
}

const nlOut = await buildVideo('nl');
const enOut = await buildVideo('en');

// ─── Cleanup ───────────────────────────────────────────────────────────────
console.log('\n[4/4] Cleaning up temp files...');
try {
  for (const f of readdirSync(TMP)) unlinkSync(join(TMP, f));
} catch(_) {}

console.log('\n✓ DONE');
console.log(`  NL: ${nlOut}`);
console.log(`  EN: ${enOut}`);
