// Idempotente, hervatbare vertaal-generator voor de locale-JSON-bestanden.
// Vertaalt src/i18n/locales/nl.json (bron van waarheid) naar alle overige
// ondersteunde talen via de VU Azure OpenAI-resource (api-key-header,
// deployment-in-URL, reasoning_effort, response_format json_object) — GEEN
// publieke OpenAI, conform de projectregels.
//
// Hervatbaar: per taal worden alleen ONTBREKENDE sleutels vertaald, en na elke
// "wave" wordt het bestand weggeschreven. Self-time-limit (~110s) zodat het
// binnen de shell-timeout blijft; gewoon opnieuw aanroepen tot 0 resterend.
//
// Env-knoppen:
//   LANGS=fr,de         -> beperk tot deze doeltalen (default: alle behalve nl)
//   BATCH=30            -> sleutels per LLM-call
//   CONCURRENCY=8       -> parallelle LLM-calls per wave
//   TIME_BUDGET_MS=110000
//   MAX_TOKENS=8000

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeChatConfig } from '../server/chatConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '../src/i18n/locales');
const SOURCE_LANG = 'nl';

// Mirror van src/i18n/languages.ts (code -> Engelse + native naam). Bewust
// gedupliceerd zodat dit build-script geen TS hoeft te importeren.
const TARGET_LANGS = [
  { code: 'en', english: 'English', native: 'English' },
  { code: 'yue', english: 'Cantonese (written in Traditional Chinese characters)', native: '粵語（廣東話）' },
  { code: 'zh', english: 'Mandarin Chinese (written in Simplified Chinese characters)', native: '简体中文' },
  { code: 'de', english: 'German', native: 'Deutsch' },
  { code: 'fr', english: 'French', native: 'Français' },
  { code: 'es', english: 'Spanish', native: 'Español' },
  { code: 'it', english: 'Italian', native: 'Italiano' },
  { code: 'pt', english: 'Portuguese', native: 'Português' },
  { code: 'pl', english: 'Polish', native: 'Polski' },
  { code: 'uk', english: 'Ukrainian', native: 'Українська' },
  { code: 'ro', english: 'Romanian', native: 'Română' },
  { code: 'tr', english: 'Turkish', native: 'Türkçe' },
  { code: 'ar', english: 'Arabic', native: 'العربية' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी' },
  { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ja', english: 'Japanese', native: '日本語' },
  { code: 'ko', english: 'Korean', native: '한국어' },
  { code: 'hr', english: 'Croatian', native: 'Hrvatski' },
];

const BATCH = parseInt(process.env.BATCH || '20', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MS || '85000', 10);
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '5000', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '60000', 10);
const START = Date.now();
const timeLeft = () => TIME_BUDGET_MS - (Date.now() - START);

const cfg = computeChatConfig(process.env);
if (!cfg.azureChatReady) {
  console.error('[i18n-gen] Azure chat NIET geconfigureerd (AZURE_OPENAI_ENDPOINT/API_KEY). Stop.');
  process.exit(1);
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || cfg.deployment || 'gpt-5.5';
const IS_REASONING = /^(gpt-5|o1|o3|o4)/i.test(OPENAI_MODEL);
console.log(`[i18n-gen] deployment=${cfg.deployment} reasoning=${IS_REASONING} batch=${BATCH} concurrency=${CONCURRENCY}`);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function writeLocale(code, sourceKeys, dict) {
  // Schrijf in bron-sleutelvolgorde; alleen aanwezige (vertaalde) sleutels.
  // Atomisch (tmp + rename) zodat een SIGKILL midden in het schrijven het
  // bestand niet corrumpeert.
  const out = {};
  for (const k of sourceKeys) if (k in dict) out[k] = dict[k];
  const dest = path.join(LOCALES_DIR, `${code}.json`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);
}

function chunk(arr, n) {
  const res = [];
  for (let i = 0; i < arr.length; i += n) res.push(arr.slice(i, i + n));
  return res;
}

function systemPrompt(meta) {
  return [
    `You are a professional UI localization translator for a Dutch university learning platform called LEAP-VU.`,
    `Translate the given user-interface strings from Dutch into ${meta.english} (${meta.native}).`,
    `Rules:`,
    `- Return ONLY a JSON object mapping each input key to its translated string value.`,
    `- Keep EXACTLY the same keys as the input; never add, remove, or rename keys.`,
    `- Preserve placeholder tokens wrapped in curly braces exactly, e.g. {count}, {name}, {course}. Never translate or alter the text inside { }.`,
    `- Preserve HTML tags, markdown, newline characters (\\n), and any leading/trailing spaces.`,
    `- Keep the brand name "LEAP-VU" and other proper nouns unchanged.`,
    `- Where the target language distinguishes formality, use the informal second person (matching Dutch je/jij), suitable for addressing students.`,
    `- Translate naturally and concisely as UI microcopy; do not add explanations or extra text.`,
  ].join('\n');
}

async function callAzure(messages, attempt = 0) {
  const body = {
    messages,
    response_format: { type: 'json_object' },
    [IS_REASONING ? 'max_completion_tokens' : 'max_tokens']: MAX_TOKENS,
  };
  if (IS_REASONING) body.reasoning_effort = 'low';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (attempt < 4) {
      const wait = Math.min(2000 * (attempt + 1), 8000);
      await new Promise((r) => setTimeout(r, wait));
      return callAzure(messages, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Math.min(2000 * (attempt + 1), 8000);
      await new Promise((r) => setTimeout(r, wait));
      return callAzure(messages, attempt + 1);
    }
    throw new Error(`Azure ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function translateBatch(meta, batchKeys, source) {
  const input = {};
  for (const k of batchKeys) input[k] = source[k];
  const messages = [
    { role: 'system', content: systemPrompt(meta) },
    { role: 'user', content: JSON.stringify(input) },
  ];
  let content = await callAzure(messages);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 1 retry met strengere instructie.
    const retryMsgs = [
      { role: 'system', content: systemPrompt(meta) + '\nReturn STRICTLY valid JSON, nothing else.' },
      { role: 'user', content: JSON.stringify(input) },
    ];
    content = await callAzure(retryMsgs);
    try { parsed = JSON.parse(content); } catch { return {}; }
  }
  const result = {};
  for (const k of batchKeys) {
    const v = parsed?.[k];
    if (typeof v === 'string' && v.trim() !== '') result[k] = v;
  }
  return result;
}

async function runPool(tasks, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const source = readJson(path.join(LOCALES_DIR, `${SOURCE_LANG}.json`));
  const sourceKeys = Object.keys(source);
  const onlyLangs = (process.env.LANGS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const targets = onlyLangs.length
    ? TARGET_LANGS.filter((t) => onlyLangs.includes(t.code))
    : TARGET_LANGS;

  let totalRemaining = 0;
  for (const meta of targets) {
    const file = path.join(LOCALES_DIR, `${meta.code}.json`);
    const dict = readJson(file);
    const missing = sourceKeys.filter((k) => {
      const v = dict[k];
      return !(typeof v === 'string' && v.trim() !== '');
    });
    if (missing.length === 0) continue;

    const batches = chunk(missing, BATCH);
    let done = 0;
    console.log(`[i18n-gen] ${meta.code}: ${missing.length} missing in ${batches.length} batches`);
    // Verwerk in waves van CONCURRENCY; flush na elke wave.
    for (let w = 0; w < batches.length; w += CONCURRENCY) {
      if (timeLeft() < 8000) {
        console.log(`[i18n-gen] tijdsbudget bijna op — stop bij ${meta.code} (na ${done}/${missing.length})`);
        totalRemaining += missing.length - done;
        writeLocale(meta.code, sourceKeys, dict);
        printRemaining(targets, sourceKeys);
        return;
      }
      const wave = batches.slice(w, w + CONCURRENCY);
      const tasks = wave.map((bk) => async () => {
        try { return await translateBatch(meta, bk, source); }
        catch (e) { console.warn(`[i18n-gen] batch fout (${meta.code}): ${e.message}`); return {}; }
      });
      const waveResults = await runPool(tasks, CONCURRENCY);
      for (let j = 0; j < wave.length; j++) {
        Object.assign(dict, waveResults[j]);
        done += wave[j].length;
      }
      writeLocale(meta.code, sourceKeys, dict);
      process.stdout.write(`  ${meta.code} ${done}/${missing.length}\r`);
    }
    console.log(`\n[i18n-gen] ${meta.code}: klaar`);
  }
  printRemaining(targets, sourceKeys);
}

function printRemaining(targets, sourceKeys) {
  let total = 0;
  const lines = [];
  for (const meta of targets) {
    const dict = readJson(path.join(LOCALES_DIR, `${meta.code}.json`));
    const miss = sourceKeys.filter((k) => !(typeof dict[k] === 'string' && dict[k].trim() !== '')).length;
    total += miss;
    if (miss > 0) lines.push(`  ${meta.code}: ${miss} resterend`);
  }
  console.log(`[i18n-gen] RESTEREND totaal: ${total}${total ? '\n' + lines.join('\n') : ' (alle talen compleet)'}`);
}

main().catch((e) => { console.error('[i18n-gen] FOUT:', e); process.exit(1); });
