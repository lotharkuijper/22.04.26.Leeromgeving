// Opt-in, handmatige evaluatie voor Task #303: passen de AI-tutors IN DE
// PROJECTRUIMTE (persona-chat) zich ook merkbaar aan op het leerniveau van de
// student aan? Dit is de zustervariant van scripts/eval-learning-levels.js, dat
// alleen het hoofd-tutorpad (/api/chat, óók "Ik leg uit") afdekt.
//
// Waarom een apart script: de project-persona-chat
// (/api/projects/:projectId/persona-chat) injecteert HETZELFDE leerniveau-blok
// (buildLevelInstructionBlock), maar via een volledig aparte code-route en met
// een ANDERE systeemprompt-opbouw — niet FALLBACK_SYSTEM_PROMPT maar de
// persona.system_prompt, gevolgd door relatie-/afspraken-/RAG-/documentblokken,
// dán het leerniveau-blok en als laatste de taal-instructie. Een prompt-tuning-
// regressie in dat pad zou door de bestaande eval onopgemerkt blijven.
//
// BEWUST GEEN onderdeel van de altijd-draaiende unit-suite: het vereist een
// live LLM (kost tokens, niet-deterministisch). Draai handmatig/incidenteel:
//
//   node scripts/eval-learning-levels-persona.js
//   EVAL_LANG=en node scripts/eval-learning-levels-persona.js
//   LEVELS=1,3,5 QUESTION="Wat is een confounder?" node scripts/eval-learning-levels-persona.js
//
// Twee modi:
//   1) Direct via Azure (standaard). Gebruikt dezelfde env-config als
//      server/index.js (AZURE_OPENAI_*). Spiegelt de prompt-opbouw van
//      /api/projects/persona-chat: persona.system_prompt + leerniveau-blok +
//      taal-instructie. De persona-prompt is instelbaar via PERSONA_PROMPT;
//      standaard de "__default__" consultant-prompt uit server/index.js, zodat
//      het script zonder DB/echte persona draait. Relatie-/RAG-/documentblokken
//      zitten hier bewust niet in — die zijn voor deze niveau-test niet relevant.
//   2) Via de live HTTP-endpoint /api/projects/persona-chat. Dit loopt écht door
//      de server-route (incl. echte persona, RAG, relatie). Vereist een geldig
//      project/groep/persona + auth-token. Zet:
//        PERSONA_EVAL_BASE_URL   (bijv. http://localhost:3001)
//        PERSONA_EVAL_TOKEN      (een geldig Supabase-JWT van een groepslid)
//        PERSONA_EVAL_GROUP_ID   (uuid van een project_groups-rij)
//        PERSONA_EVAL_PERSONA_ID (uuid van een conversational project_persona,
//                                 of "__default__")

import { buildLevelInstructionBlock, LEVEL_LABELS, clampLevel } from '../server/learningLevel.js';
import { buildLanguageInstruction } from '../server/languages.js';

// Standaard-persona = de "__default__" consultant uit /api/projects/persona-chat
// (server/index.js). Overschrijf met PERSONA_PROMPT om een eigen persona te
// spiegelen.
const DEFAULT_PERSONA_PROMPT = process.env.PERSONA_PROMPT
  || 'Je bent een rustige onderzoeks-consultant voor een groep VU-studenten epi/biostat. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".';

// Bewust EVAL_LANG (niet LANG): de OS-locale zet LANG vaak op "en_US.UTF-8",
// wat anders ten onrechte Engels zou forceren in dit Nederlandstalige project.
const LANG = (process.env.EVAL_LANG || 'nl').toLowerCase().startsWith('en') ? 'en' : 'nl';
const QUESTION = process.env.QUESTION || (LANG === 'en'
  ? 'Can you explain what a confounder is?'
  : 'Kun je uitleggen wat een confounder is?');
const LEVELS = (process.env.LEVELS || '1,5')
  .split(',')
  .map((s) => clampLevel(s.trim()))
  .filter((n) => n != null);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 700);

// Domeinjargon (epidemiologie/biostatistiek). Een hogere dichtheid duidt op een
// technischer antwoord. Bewust een vaste, leesbare lijst — geen exacte maat,
// maar een bruikbaar relatief signaal tussen niveau 1 en niveau 5.
const JARGON_TERMS = [
  'confounder', 'confounding', 'covariate', 'covariaat', 'covariaten',
  'bias', 'selectiebias', 'informatiebias', 'verstoring', 'verstorende',
  'odds ratio', 'relatief risico', 'relatieve risico', 'risk ratio',
  'incidentie', 'prevalentie', 'incidence', 'prevalence', 'hazard ratio',
  'stratificatie', 'stratification', 'stratify', 'stratificeren',
  'regressie', 'regression', 'multivariabele', 'multivariate', 'multivariabel',
  'causaal', 'causale', 'causaliteit', 'causal', 'causality', 'causation',
  'associatie', 'association', 'correlatie', 'correlation',
  'cohort', 'case-control', 'case control', 'randomisatie', 'randomization', 'rct',
  'effectmodificatie', 'effect modification', 'interactie', 'interaction',
  'mediator', 'mediation', 'collider', 'directed acyclic graph', 'dag',
  'betrouwbaarheidsinterval', 'confidence interval', 'p-waarde', 'p-value',
  'significantie', 'significance', 'estimand', 'estimate', 'schatter', 'schatting',
  'exposure', 'blootstelling', 'outcome', 'uitkomst', 'variabele', 'variable',
];

// Spiegelt de systeemprompt-opbouw van /api/projects/persona-chat:
// persona.system_prompt + (relatie/afspraken/RAG/doc, hier weggelaten) +
// leerniveau-blok + taal-instructie. Belangrijk is dat het leerniveau-blok
// VLAK VOOR de taal-instructie komt, precies zoals de server het bouwt.
function buildSystemPrompt(level) {
  const levelBlock = buildLevelInstructionBlock(level, LANG);
  const langSuffix = buildLanguageInstruction(LANG);
  return `${DEFAULT_PERSONA_PROMPT}${levelBlock}${langSuffix}`;
}

// --- Heuristieken -----------------------------------------------------------

function analyze(text) {
  const trimmed = (text || '').trim();
  const words = trimmed.match(/\p{L}[\p{L}'-]*/gu) || [];
  const wordCount = words.length;
  const sentences = trimmed.split(/[.!?]+(?:\s|$)/u).map((s) => s.trim()).filter(Boolean);
  const sentenceCount = sentences.length || (wordCount ? 1 : 0);
  const lower = trimmed.toLowerCase();

  let jargonHits = 0;
  for (const term of JARGON_TERMS) {
    // Hele-woord/uitdrukking matchen; meerwoords-termen tellen elk voorkomen.
    const re = new RegExp(`(?<![\\p{L}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu');
    const matches = lower.match(re);
    if (matches) jargonHits += matches.length;
  }

  const charCount = trimmed.length;
  const avgWordLen = wordCount ? words.reduce((a, w) => a + w.length, 0) / wordCount : 0;
  const avgSentenceLen = sentenceCount ? wordCount / sentenceCount : 0;
  const jargonPer100 = wordCount ? (jargonHits / wordCount) * 100 : 0;
  const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
  const typeTokenRatio = wordCount ? uniqueWords / wordCount : 0;

  return {
    charCount,
    wordCount,
    sentenceCount,
    avgWordLen,
    avgSentenceLen,
    jargonHits,
    jargonPer100,
    typeTokenRatio,
  };
}

function fmt(n, digits = 1) {
  return Number(n).toFixed(digits);
}

// --- Modellen aanroepen -----------------------------------------------------

async function callViaEndpoint(baseUrl, token, groupId, personaId, level) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/projects/persona-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      groupId,
      personaId,
      message: QUESTION,
      lang: LANG,
      learningLevel: level,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`/api/projects/persona-chat gaf ${r.status}: ${text.slice(0, 500)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`/api/projects/persona-chat gaf geen geldige JSON: ${text.slice(0, 300)}`);
  }
  if (data.relationshipBlocked) {
    throw new Error('De relatie met deze persona is geblokkeerd (score ≤ -8); kies een andere persona/groep voor de niveau-test.');
  }
  return data.reply ?? data.message ?? data.content ?? '';
}

async function callViaAzure(level) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  if (!endpoint || !apiKey) {
    throw new Error('AZURE_OPENAI_ENDPOINT en/of AZURE_OPENAI_API_KEY ontbreken. Zet ze, of gebruik PERSONA_EVAL_BASE_URL + PERSONA_EVAL_TOKEN + PERSONA_EVAL_GROUP_ID + PERSONA_EVAL_PERSONA_ID voor de live endpoint-modus.');
  }
  const model = process.env.OPENAI_MODEL || 'gpt-5.5';
  const isReasoning = /^(gpt-5|o1|o3|o4)/i.test(model);
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;

  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(level) },
      { role: 'user', content: QUESTION },
    ],
    [isReasoning ? 'max_completion_tokens' : 'max_tokens']: MAX_TOKENS,
  };
  if (isReasoning) {
    body.reasoning_effort = process.env.REASONING_EFFORT || 'low';
  } else {
    body.temperature = 0.7;
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Azure gaf ${r.status}: ${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content || '';
}

// --- Hoofdflow --------------------------------------------------------------

async function run() {
  const baseUrl = process.env.PERSONA_EVAL_BASE_URL;
  const token = process.env.PERSONA_EVAL_TOKEN;
  const groupId = process.env.PERSONA_EVAL_GROUP_ID;
  const personaId = process.env.PERSONA_EVAL_PERSONA_ID;
  const useEndpoint = Boolean(baseUrl && token && groupId && personaId);

  // Half-geconfigureerde endpoint-modus is bijna altijd een vergissing: waarschuw
  // expliciet i.p.v. stil terug te vallen op de Azure-spiegel.
  if (!useEndpoint && (baseUrl || token || groupId || personaId)) {
    console.warn('⚠ Live endpoint-modus vereist ALLE vier: PERSONA_EVAL_BASE_URL, PERSONA_EVAL_TOKEN, PERSONA_EVAL_GROUP_ID, PERSONA_EVAL_PERSONA_ID. Eén of meer ontbreken — val terug op de Azure-spiegel.\n');
  }

  console.log('='.repeat(78));
  console.log('Leerniveau-evaluatie — PROJECT-PERSONA-CHAT (Task #303)');
  console.log('='.repeat(78));
  console.log(`Modus      : ${useEndpoint ? `live /api/projects/persona-chat (${baseUrl})` : 'direct via Azure (prompt gespiegeld uit /api/projects/persona-chat)'}`);
  console.log(`Taal       : ${LANG}`);
  console.log(`Vraag      : ${QUESTION}`);
  console.log(`Niveaus    : ${LEVELS.join(', ')}`);
  console.log(`max_tokens : ${MAX_TOKENS}`);
  if (useEndpoint) {
    console.log(`Groep      : ${groupId}`);
    console.log(`Persona    : ${personaId}`);
  }
  console.log('');

  const results = [];
  for (const level of LEVELS) {
    const label = LEVEL_LABELS[LANG === 'nl' ? 'nl' : 'en'][level];
    process.stdout.write(`→ Niveau ${level} (${label}) wordt opgevraagd ... `);
    let answer = '';
    try {
      answer = useEndpoint
        ? await callViaEndpoint(baseUrl, token, groupId, personaId, level)
        : await callViaAzure(level);
    } catch (err) {
      console.log('FOUT');
      console.error(`   ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log('klaar');
    results.push({ level, label, answer, stats: analyze(answer) });
  }

  console.log('');
  for (const { level, label, answer } of results) {
    console.log('-'.repeat(78));
    console.log(`NIVEAU ${level} — ${label}`);
    console.log('-'.repeat(78));
    console.log(answer.trim() || '(leeg antwoord)');
    console.log('');
  }

  if (results.length === 0) {
    console.error('Geen antwoorden ontvangen — kan niet vergelijken.');
    process.exitCode = 1;
    return;
  }

  console.log('='.repeat(78));
  console.log('HEURISTIEKEN (relatief signaal, geen absolute maat)');
  console.log('='.repeat(78));
  const header = ['niveau', 'woorden', 'zinnen', 'wrd/zin', 'wrd-len', 'jargon', 'jrg/100w', 'TTR'];
  console.log(header.map((h, i) => (i === 0 ? h.padEnd(8) : h.padStart(10))).join(''));
  for (const { level, stats } of results) {
    const row = [
      `lvl ${level}`.padEnd(8),
      String(stats.wordCount).padStart(10),
      String(stats.sentenceCount).padStart(10),
      fmt(stats.avgSentenceLen).padStart(10),
      fmt(stats.avgWordLen, 2).padStart(10),
      String(stats.jargonHits).padStart(10),
      fmt(stats.jargonPer100).padStart(10),
      fmt(stats.typeTokenRatio, 2).padStart(10),
    ];
    console.log(row.join(''));
  }
  console.log('');

  // Eenvoudige PASS/WARN-vergelijking tussen het laagste en hoogste niveau.
  const sorted = [...results].sort((a, b) => a.level - b.level);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  if (low.level !== high.level) {
    console.log('='.repeat(78));
    console.log(`VERGELIJKING niveau ${low.level} vs niveau ${high.level}`);
    console.log('='.repeat(78));
    const jargonUp = high.stats.jargonPer100 > low.stats.jargonPer100;
    const wordLenUp = high.stats.avgWordLen >= low.stats.avgWordLen;
    const identical = low.answer.trim() === high.answer.trim();

    const verdicts = [];
    verdicts.push([
      'Antwoorden verschillen',
      !identical,
      identical ? 'IDENTIEK — het niveau heeft geen effect!' : 'verschillend',
    ]);
    verdicts.push([
      'Jargon-dichtheid hoger op expert-niveau',
      jargonUp,
      `${fmt(low.stats.jargonPer100)} → ${fmt(high.stats.jargonPer100)} per 100 woorden`,
    ]);
    verdicts.push([
      'Gem. woordlengte ≥ op expert-niveau',
      wordLenUp,
      `${fmt(low.stats.avgWordLen, 2)} → ${fmt(high.stats.avgWordLen, 2)} tekens`,
    ]);

    for (const [name, ok, detail] of verdicts) {
      console.log(`  [${ok ? 'PASS' : 'WARN'}] ${name} (${detail})`);
    }
    console.log('');
    const overall = !identical && jargonUp;
    console.log(overall
      ? '✔ Het leerniveau heeft een merkbaar effect op het persona-antwoord.'
      : '⚠ Het niveau-effect is zwak of afwezig — controleer de descriptors in server/learningLevel.js en de prompt-opbouw in /api/projects/persona-chat.');
    console.log('');
    console.log('Let op: LLM-output is niet-deterministisch. Draai een paar keer of');
    console.log('met meerdere vragen (QUESTION=...) voordat je conclusies trekt.');
    process.exitCode = overall ? 0 : 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
