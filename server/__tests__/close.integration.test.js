// Task #174 — Integratietest voor het samenspel van cues, oordelen en
// correcties in de close-flow. Verifieert end-to-end (met gestubde OpenAI
// en in-memory supabase) dat:
//   (a) een geldige cue-delta wordt toegepast op project_persona_relationships,
//   (b) replay van dezelfde refId 'thread_close:<id>' idempotent is,
//   (c) evaluator-persona's nooit een cue krijgen (gate + nul-delta).
// Geen netwerk-, OpenAI- of Supabase-call nodig.

import { describe, it, expect, vi } from 'vitest';
import {
  computeEmissionEnabled,
  callCloseLLM,
  parseCloseLLMOutput,
  applyRelationshipDeltaImpl,
} from '../threadClose.js';

// ───────────────────────────────────────────────────────────────────────────
// In-memory supabase-mock voor één tabel: project_persona_relationships.
// Implementeert alleen de chains die applyRelationshipDeltaImpl gebruikt in
// het pgPool=null pad: .from(t).select(...).eq().eq().eq().maybeSingle(),
// .update(p).eq(id).select(c).single() en .insert(row).select(c).single().
// ───────────────────────────────────────────────────────────────────────────
function makeFakeSupabase() {
  const rows = [];
  let nextId = 1;

  function fromRelationships() {
    return {
      select(_cols) {
        const filters = {};
        const chain = {
          eq(col, val) { filters[col] = val; return chain; },
          async maybeSingle() {
            const found = rows.find(r =>
              Object.entries(filters).every(([k, v]) => r[k] === v));
            return { data: found ? { ...found } : null, error: null };
          },
          async single() {
            const found = rows.find(r =>
              Object.entries(filters).every(([k, v]) => r[k] === v));
            return { data: found ? { ...found } : null, error: found ? null : { message: 'not found' } };
          },
        };
        return chain;
      },
      update(patch) {
        const filters = {};
        const chain = {
          eq(col, val) { filters[col] = val; return chain; },
          select(_cols) {
            return {
              async single() {
                const idx = rows.findIndex(r =>
                  Object.entries(filters).every(([k, v]) => r[k] === v));
                if (idx === -1) return { data: null, error: { message: 'not found' } };
                rows[idx] = { ...rows[idx], ...patch };
                return { data: { ...rows[idx] }, error: null };
              },
            };
          },
        };
        return chain;
      },
      insert(row) {
        return {
          select(_cols) {
            return {
              async single() {
                const newRow = { id: `rel-${nextId++}`, score: 0, history: [], ...row };
                rows.push(newRow);
                return { data: { ...newRow }, error: null };
              },
            };
          },
        };
      },
    };
  }

  return {
    rows,
    client: {
      from(t) {
        if (t === 'project_persona_relationships') return fromRelationships();
        throw new Error(`fake supabase: unsupported table ${t}`);
      },
    },
  };
}

// Bouwt een fake fetch die exact één OpenAI-stijl JSON-response teruggeeft.
function makeFakeFetch(jsonContent) {
  return vi.fn(async (_url, _opts) => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: JSON.stringify(jsonContent) } }] };
    },
  }));
}

const CONVERSATIONAL_PROMPT_WITH_CUE_TABLE = [
  'Je bent een coach.',
  '',
  'Cue-tabel:',
  '| Cue | Delta |',
  '|-----|-------|',
  '| Student stelt scherpe vraag | +1 |',
  '| Student is respectloos | -2 |',
].join('\n');

function makeConversationalPersona(overrides = {}) {
  return {
    id: 'persona-conv-1',
    project_id: 'proj-1',
    persona_type: 'conversational',
    cue_emission_enabled: true,
    system_prompt: CONVERSATIONAL_PROMPT_WITH_CUE_TABLE,
    ...overrides,
  };
}

function makeEvaluatorPersona(overrides = {}) {
  return {
    id: 'persona-eval-1',
    project_id: 'proj-1',
    persona_type: 'evaluator',
    cue_emission_enabled: false,
    system_prompt: 'Je bent een beoordelaar. Cue-tabel: ...',
    ...overrides,
  };
}

const sampleMsgs = [
  { role: 'user', content: 'Hoi, kun je me helpen met methodologie?' },
  { role: 'assistant', content: 'Natuurlijk, vertel meer.' },
  { role: 'user', content: 'Ik wil een correlationeel onderzoek doen.' },
];

describe('close-flow integratie: cue → applyRelationshipDelta', () => {
  it('(a) past een geldige cue-delta toe op een nieuwe relatie-rij', async () => {
    const persona = makeConversationalPersona();
    expect(computeEmissionEnabled(persona)).toBe(true);

    const fetchFn = makeFakeFetch({
      topics: ['methodologie'],
      agreements: [],
      relationship_delta: 2,
      relationship_reason: 'Scherpe vraag over design.',
    });

    const { topics, agreements, cue } = await callCloseLLM({
      fetchFn,
      apiKey: 'test',
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      persona,
      allMsgs: sampleMsgs,
      lang: 'nl',
      emissionEnabled: true,
    });
    expect(topics.length).toBeGreaterThan(0);
    expect(agreements).toEqual([]);
    expect(cue.delta).toBe(2);
    expect(cue.reason).toMatch(/scherpe vraag/i);

    const sb = makeFakeSupabase();
    const threadId = 'thread-abc';
    const result = await applyRelationshipDeltaImpl(
      { supabaseAdmin: sb.client, pgPool: null },
      {
        projectId: persona.project_id,
        groupId: 'group-1',
        personaId: persona.id,
        delta: cue.delta,
        event: {
          source: 'persona_chat_close',
          refId: `thread_close:${threadId}`,
          delta: cue.delta,
          note: cue.reason,
        },
      },
    );
    expect(result.score).toBe(2);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].source).toBe('persona_chat_close');
    expect(result.history[0].refId).toBe(`thread_close:${threadId}`);
    expect(sb.rows).toHaveLength(1);
  });

  it('(b) replay met dezelfde thread_close-refId is idempotent', async () => {
    const persona = makeConversationalPersona();
    const sb = makeFakeSupabase();
    const threadId = 'thread-xyz';
    const eventArgs = {
      projectId: persona.project_id,
      groupId: 'group-1',
      personaId: persona.id,
      delta: 1,
      event: {
        source: 'persona_chat_close',
        refId: `thread_close:${threadId}`,
        delta: 1,
        note: 'eerste keer',
      },
    };

    const first = await applyRelationshipDeltaImpl(
      { supabaseAdmin: sb.client, pgPool: null }, eventArgs);
    expect(first.score).toBe(1);
    expect(first.history).toHaveLength(1);

    // Replay: zelfde source + refId → mag score/history NIET muteren.
    const second = await applyRelationshipDeltaImpl(
      { supabaseAdmin: sb.client, pgPool: null },
      { ...eventArgs, delta: 1, event: { ...eventArgs.event, note: 'tweede keer' } });
    expect(second.score).toBe(1);
    expect(second.history).toHaveLength(1);
    expect(sb.rows).toHaveLength(1);
    expect(sb.rows[0].score).toBe(1);

    // Andere refId → wel toepassen.
    const third = await applyRelationshipDeltaImpl(
      { supabaseAdmin: sb.client, pgPool: null },
      {
        ...eventArgs,
        delta: -2,
        event: {
          source: 'persona_chat_close',
          refId: 'thread_close:thread-other',
          delta: -2,
          note: 'andere thread',
        },
      },
    );
    expect(third.score).toBe(-1);
    expect(third.history).toHaveLength(2);
  });

  it('(c) evaluator-persona krijgt nooit een cue (gate uit + nul-delta uit parser)', async () => {
    const evaluator = makeEvaluatorPersona();
    // Gate: false ongeacht of het LLM een delta verzint.
    expect(computeEmissionEnabled(evaluator)).toBe(false);

    // Zelfs als het LLM een non-zero delta hallucineert moet de parser
    // het op 0 forceren wanneer emissionEnabled=false.
    const malicious = parseCloseLLMOutput(
      JSON.stringify({
        topics: ['x'],
        agreements: [],
        relationship_delta: 2,
        relationship_reason: 'Probeer toch een punt te geven.',
      }),
      { emissionEnabled: false },
    );
    expect(malicious.cue.delta).toBe(0);
    expect(malicious.cue.reason).toBe('');

    // En de close-flow als geheel: callCloseLLM met emissionEnabled=false
    // levert eveneens 0-delta, dus applyRelationshipDelta wordt overgeslagen.
    const fetchFn = makeFakeFetch({
      topics: ['rubriek-feedback'],
      agreements: [],
      relationship_delta: -3,
      relationship_reason: 'verzonnen',
    });
    const out = await callCloseLLM({
      fetchFn,
      apiKey: 'test',
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      persona: evaluator,
      allMsgs: sampleMsgs,
      lang: 'nl',
      emissionEnabled: false,
    });
    expect(out.cue.delta).toBe(0);
    expect(out.cue.reason).toBe('');

    // Productiecode roept applyRelationshipDelta alleen aan bij delta !== 0;
    // we simuleren dat hier zodat een regressie (per ongeluk altijd aanroepen)
    // zichtbaar zou worden in de assertie hieronder.
    const sb = makeFakeSupabase();
    if (out.cue.delta !== 0) {
      await applyRelationshipDeltaImpl(
        { supabaseAdmin: sb.client, pgPool: null },
        {
          projectId: evaluator.project_id,
          groupId: 'group-1',
          personaId: evaluator.id,
          delta: out.cue.delta,
          event: {
            source: 'persona_chat_close',
            refId: 'thread_close:thread-eval',
            delta: out.cue.delta,
          },
        },
      );
    }
    expect(sb.rows).toHaveLength(0);
  });

  it('conversational persona zonder cue-tabel: gate=false, geen relationship-update', async () => {
    const persona = makeConversationalPersona({ system_prompt: 'Je bent een coach zonder tabel.' });
    expect(computeEmissionEnabled(persona)).toBe(false);

    const parsed = parseCloseLLMOutput(
      JSON.stringify({ topics: ['x'], agreements: [], relationship_delta: 2, relationship_reason: 'mooi' }),
      { emissionEnabled: false },
    );
    expect(parsed.cue.delta).toBe(0);
  });
});
