/**
 * LAIR-VU Promo Video Assembler v2
 * - 1920×1080 output
 * - 2s held-last-frame pause after each scene → total ~97s (within 90-105s)
 * - SRT generation + libass subtitle burn-in
 * - Voice-over MP3 + background music mix (14%)
 * - drawtext title overlays on scenes 1 and 10
 * Outputs: lairvu_promo_nl.mp4 and lairvu_promo_en.mp4
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dirname, '../..');
const VIDEOS = join(ROOT, 'attached_assets/generated_videos');
const AUDIO  = join(ROOT, 'attached_assets/promo_audio');
const TMP    = join(ROOT, 'attached_assets/promo_tmp');
const OUT    = join(ROOT, 'attached_assets');

mkdirSync(TMP, { recursive: true });

function ffmpeg(args) {
  try {
    execFileSync('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('FFmpeg error:', e.stderr?.toString().slice(-800));
    throw e;
  }
}

function probe(file) {
  return parseFloat(
    execFileSync('ffprobe', [
      '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
    ]).toString().trim()
  );
}

function toSrtTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// ─── Scene data (exact approved copy) ─────────────────────────────────────
const HOLD = 2.0; // seconds of held last frame after each scene

const scenes = [
  { id:1,  video:'scene1_opening.mp4',
    nl:{ dur:3.864, lines:['Wat als je AI-assistent', 'je niet zomaar het antwoord geeft?'] },
    en:{ dur:4.008, lines:["What if your AI assistant", "didn't just give you the answer?"] } },

  { id:2,  video:'scene2_socratic_dialogue.mp4',
    nl:{ dur:6.480, lines:['LAIR-VU helpt je echt begrijpen,', 'door te vragen, te redeneren,', 'en stap voor stap samen te denken.'] },
    en:{ dur:6.000, lines:['LAIR-VU helps you truly understand,', 'by asking questions, reasoning together,', 'step by step.'] } },

  { id:3,  video:'scene3_learning_science.mp4',
    nl:{ dur:5.112, lines:['De tool is gebouwd op hoe leren werkt:', 'actief, sociaal, en met ruimte voor fouten.'] },
    en:{ dur:4.848, lines:['Built on learning science:', 'active, social, and with room to make mistakes.'] } },

  { id:4,  video:'scene4_explain_concepts.mp4',
    nl:{ dur:7.128, lines:['Vraag uitleg over een begrip.', 'Je krijgt geen kant-en-klaar antwoord,', 'maar hulp om het zelf te doorgronden.'] },
    en:{ dur:7.104, lines:["Ask for an explanation.", "You won't get a copy-paste answer.", "You'll get guidance to figure it out yourself."] } },

  { id:5,  video:'scene5_course_material.mp4',
    nl:{ dur:4.080, lines:['Alles gebaseerd op jouw cursusmateriaal,', 'niet op het internet.'] },
    en:{ dur:4.536, lines:['Everything grounded in your own course material,', 'not the internet.'] } },

  { id:6,  video:'scene6_quiz.mp4',
    nl:{ dur:4.560, lines:['Oefen met slimme quizvragen', 'die echt aansluiten op wat je studeert.'] },
    en:{ dur:5.184, lines:['Practice with smart quiz questions', 'that match exactly what you are studying.'] } },

  { id:7,  video:'scene7_project_personas.mp4',
    nl:{ dur:6.552, lines:['In projecten voer je gesprekken', 'met AI-experts die vragen stellen', 'die je aan het denken zetten.'] },
    en:{ dur:5.712, lines:["In projects, you'll talk with AI experts", "who ask the questions", "that make you think."] } },

  { id:8,  video:'scene8_reflection.mp4',
    nl:{ dur:4.440, lines:['En daarna reflecteer je op wat je leerde.', 'Zo beklijft het.'] },
    en:{ dur:5.040, lines:["Afterwards, you reflect on what you've learned.", "That's what makes it stick."] } },

  { id:9,  video:'scene9_generic_courses.mp4',
    nl:{ dur:3.120, lines:['Voor elke cursus,', 'in het Nederlands en Engels.'] },
    en:{ dur:2.472, lines:['For any course,', 'in Dutch and English.'] } },

  { id:10, video:'scene10_closing.mp4',
    nl:{ dur:2.448, lines:['LAIR-VU', 'Leren zoals het bedoeld is.'] },
    en:{ dur:2.976, lines:['LAIR-VU', 'Learning the way it is meant to be.'] } },
];

// Calculate actual video durations from files
for (const sc of scenes) {
  sc.vidDur = probe(join(VIDEOS, sc.video));
}

// Each processed scene duration = vidDur + HOLD (except last which gets +3)
scenes.forEach((sc, i) => {
  sc.holdDur = (i === scenes.length - 1) ? 3.0 : HOLD;
  sc.totalDur = sc.vidDur + sc.holdDur;
});
const TOTAL_DUR = scenes.reduce((s, sc) => s + sc.totalDur, 0);
console.log(`Total duration: ${TOTAL_DUR.toFixed(2)}s (target: 90-105s)`);

// Cumulative scene start times
let cumT = 0;
for (const sc of scenes) {
  sc.startT = cumT;
  cumT += sc.totalDur;
}

// ─── Step 1: Background music ──────────────────────────────────────────────
console.log('\n[1/5] Generating background music...');
const bgPath = join(TMP, 'bg.mp3');
const bgDurSec = Math.ceil(TOTAL_DUR) + 5;
ffmpeg([
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${bgDurSec}`,
  '-f', 'lavfi', '-i', `sine=frequency=277:duration=${bgDurSec}`,
  '-f', 'lavfi', '-i', `sine=frequency=330:duration=${bgDurSec}`,
  '-filter_complex',
  [
    '[0:a][1:a][2:a]amix=inputs=3:duration=first[mix]',
    `[mix]volume=0.065,aecho=0.5:0.5:100|150:0.2|0.12,lowpass=f=550,` +
    `afade=t=in:st=0:d=3,afade=t=out:st=${TOTAL_DUR - 2}:d=4[out]`
  ].join(';'),
  '-map', '[out]',
  '-c:a', 'libmp3lame', '-q:a', '3',
  bgPath
]);
console.log('  ✓ background music ready');

// ─── Steps 2-4: Build per-language video ──────────────────────────────────
async function buildVideo(lang) {
  console.log(`\n[${lang === 'nl' ? 2 : 3}/5] Building ${lang.toUpperCase()} video...`);

  // 2a. Build per-scene clips with 2s freeze-frame hold
  const clipPaths = [];
  for (const sc of scenes) {
    const vidPath = join(VIDEOS, sc.video);
    const ttsPath = join(AUDIO, `scene${sc.id}_${lang}.mp3`);
    const clipOut = join(TMP, `c${sc.id}_${lang}.mp4`);
    const sceneTotalDur = sc.totalDur;

    // Video: scale to 1920x1080, add hold (clone last frame), set fps
    // Audio: TTS padded with silence to sceneTotalDur
    ffmpeg([
      '-i', vidPath,
      '-i', ttsPath,
      '-filter_complex',
      [
        // Video: scale → 1080p, hold last frame for holdDur, set fps
        `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,` +
        `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,` +
        `fps=25,tpad=stop_duration=${sc.holdDur}:stop_mode=clone,` +
        `format=yuv420p[v]`,
        // Audio: pad TTS to full scene duration
        `[1:a]apad=whole_dur=${sceneTotalDur}[a]`,
      ].join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', String(sceneTotalDur),
      clipOut
    ]);
    clipPaths.push(clipOut);
    process.stdout.write(`  ✓ clip ${sc.id}/10\r`);
  }
  console.log('  ✓ all 10 clips processed   ');

  // 2b. Concatenate
  const concatTxt = join(TMP, `concat_${lang}.txt`);
  writeFileSync(concatTxt, clipPaths.map(p => `file '${p}'`).join('\n'));
  const concatRaw = join(TMP, `raw_${lang}.mp4`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', concatTxt, '-c', 'copy', concatRaw]);
  console.log('  ✓ clips concatenated');

  // 2c. Generate SRT subtitle file
  const srtLines = [];
  let idx = 1;
  for (const sc of scenes) {
    const ld = sc[lang];
    const subStart = sc.startT + 0.2;
    const subEnd   = sc.startT + ld.dur + 0.1;
    srtLines.push(`${idx}\n${toSrtTime(subStart)} --> ${toSrtTime(subEnd)}\n${ld.lines.join('\n')}\n`);
    idx++;
  }
  const srtPath = join(OUT, `lairvu_promo_${lang}.srt`);
  writeFileSync(srtPath, srtLines.join('\n'));
  console.log(`  ✓ SRT file: ${srtPath}`);

  // 2d. Build drawtext title cards for scene 1 (opening) and scene 10 (closing)
  // These are minimal overlays at specific moments
  const sc1 = scenes[0];
  const sc10 = scenes[9];

  // Scene 1: small "LAIR-VU" brand mark top-right, visible whole scene
  const sc1Start = sc1.startT;
  const sc1End   = sc1.startT + sc1.vidDur;

  // Scene 10: large centered brand name + tagline (first and second lines)
  const sc10Start = sc10.startT;
  const sc10End   = sc10.startT + sc10.vidDur;

  const sc10Lines = sc10[lang].lines;
  // Line 0 = large brand name, line 1 = tagline
  const brandName = sc10Lines[0];  // "LAIR-VU"
  const tagline   = sc10Lines[1];  // "Leren zoals..."

  function dtEsc(s) {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, '\u2019')
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/,/g, '\\,')
      .replace(/\u2014/g, '-');
  }

  const titleFilter = [
    // Scene 10: brand name big centered ~middle of screen
    `drawtext=fontsize=72:fontcolor=white@0.95:shadowcolor=0x000000@0.8:shadowx=3:shadowy=3` +
    `:x=(w-text_w)/2:y=h/2-60:text='${dtEsc(brandName)}'` +
    `:enable='between(t,${sc10Start.toFixed(2)},${sc10End.toFixed(2)})'`,
    // Scene 10: tagline below brand name
    `drawtext=fontsize=36:fontcolor=white@0.9:shadowcolor=0x000000@0.7:shadowx=2:shadowy=2` +
    `:x=(w-text_w)/2:y=h/2+30:text='${dtEsc(tagline)}'` +
    `:enable='between(t,${(sc10Start+0.5).toFixed(2)},${sc10End.toFixed(2)})'`,
  ].join(',');

  const srtPathEsc = srtPath.replace(/'/g, "\\'").replace(/:/g, '\\:');

  // 2e. Final render: raw video → subtitles (libass) → title overlays → bg music mix
  const finalOut = join(OUT, `lairvu_promo_${lang}.mp4`);
  ffmpeg([
    '-i', concatRaw,
    '-i', bgPath,
    '-filter_complex',
    [
      // Apply libass subtitles, then drawtext title cards
      `[0:v]subtitles=${srtPathEsc}:force_style='FontSize=28,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Shadow=1,Alignment=2,MarginV=45',${titleFilter}[vout]`,
      // Mix voice-over at full volume with gentle bg music
      `[0:a]volume=1.0[va]`,
      `[1:a]volume=0.14,atrim=0:${TOTAL_DUR}[bga]`,
      `[va][bga]amix=inputs=2:duration=first[aout]`,
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
  console.log(`  ✓ ${lang.toUpperCase()} → ${finalOut.split('/').slice(-1)[0]} (${actualDur.toFixed(1)}s, 1080p)`);
  return finalOut;
}

const nlOut = await buildVideo('nl');
const enOut = await buildVideo('en');

// ─── Step 5: Cleanup & summary ─────────────────────────────────────────────
console.log('\n[5/5] Cleaning up temp files...');
try { for (const f of readdirSync(TMP)) unlinkSync(join(TMP, f)); } catch(_){}

const nlDur = probe(nlOut);
const enDur = probe(enOut);
console.log('\n=== DONE ===');
console.log(`NL: ${nlOut}  (${nlDur.toFixed(1)}s, 1920x1080)`);
console.log(`EN: ${enOut}  (${enDur.toFixed(1)}s, 1920x1080)`);
console.log(`SRT: ${join(OUT, 'lairvu_promo_nl.srt')} + lairvu_promo_en.srt`);
