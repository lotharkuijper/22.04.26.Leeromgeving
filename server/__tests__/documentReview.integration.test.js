// Task #177 — Integratietest voor het oordelen-pad (document_review). Spiegelt
// close.integration.test.js maar voor de tweede relatie-bron: een evaluator-
// persona velt een oordeel op een documentupload en past daarmee de relatie-
// score aan. Verifieert end-to-end (met gestubde OpenAI en in-memory supabase):
//   (a) accepted / conditional / rejected → relationship_delta correct toegepast
//       op project_persona_relationships, idempotent op review.id als refId,
//   (b) replay met dezelfde review-id (refId) muteert niets,
//   (c) conversational persona's (geen evaluator) mogen géén oordeel aanvragen.
// Geen netwerk-, OpenAI- of Supabase-call nodig (in lijn met Task #174).

import { describe, it, expect, vi } from 'vitest';
import { validateReviewResponse, canRequestDocumentReview } from '../documentReview.js';
import { applyRelationshipDeltaImpl } from '../threadClose.js';

// ───────────────────────────────────────────────────────────────────────────
// In-memory supabase-mock voor één tabel: project_persona_relationships.
// Implementeert alleen de chains die applyRelationshipDeltaImpl gebruikt in
// het pgPool=null pad: .from(t).select(...).eq().eq().eq().maybeSingle(),
// .update(p).eq(id).select(c).single() en .insert(row).select(c).single().
// (Identiek aan close.integration.test.js zodat beide paden dezelfde wiring
// testen.)
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

function makeEvaluatorPersona(overrides = {}) {
  return {
    id: 'persona-eval-1',
    project_id: 'proj-1',
    name: 'Dr. Streng',
    persona_type: 'evaluator',
    system_prompt: 'Je bent een strenge beoordelaar.',
    ...overrides,
  };
}

function makeConversationalPersona(overrides = {}) {
  return {
    id: 'persona-conv-1',
    project_id: 'proj-1',
    name: 'Coach Sam',
    persona_type: 'conversational',
    system_prompt: 'Je bent een vriendelijke coach.',
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Simuleert de kern-wiring van POST /api/projects/:projectId/documents/:docId/
// reviews zoals in server/index.js: autz-gate → persona moet evaluator zijn →
// LLM-call (gestubd) → validateReviewResponse → applyRelationshipDelta met
// source='document_review', refId=review.id. Geeft het resultaat terug zonder
// de echte HTTP-laag, zodat een regressie in de bedrading zichtbaar wordt.
// ───────────────────────────────────────────────────────────────────────────
async function simulateReviewEndpoint({
  persona, groupId, projectId, fetchFn, sb,
  authz = { isStaff: true, isGroupMember: true },
  reviewId,
}) {
  // 1) Autorisatie (staff of groepslid).
  const authzCheck = canRequestDocumentReview(authz);
  if (!authzCheck.allowed) {
    return { status: authzCheck.status, error: authzCheck.error };
  }
  // 2) Persona moet evaluator zijn (gate uit de echte endpoint).
  if (persona.persona_type !== 'evaluator') {
    return { status: 400, error: 'Alleen evaluator-persona\'s kunnen oordelen afgeven' };
  }
  // 3) LLM-call (gestubd) → ruwe respons.
  const r = await fetchFn('https://example/openai', { method: 'POST' });
  const j = await r.json();
  const rawResponse = (j.choices?.[0]?.message?.content || '').trim();
  // 4) Valideren.
  const validation = validateReviewResponse(rawResponse);
  if (!validation.ok) {
    return { status: 502, error: validation.error };
  }
  // 5) Persist review (gesimuleerd: gewoon een id toekennen).
  const inserted = { id: reviewId || 'review-1', ...validation.value };
  // 6) Relatie-delta toepassen met review-id als refId.
  const relationship = await applyRelationshipDeltaImpl(
    { supabaseAdmin: sb.client, pgPool: null },
    {
      projectId,
      groupId,
      personaId: persona.id,
      delta: validation.value.relationship_delta,
      event: {
        source: 'document_review',
        refId: inserted.id,
        delta: validation.value.relationship_delta,
        note: validation.value.verdict,
      },
    },
  );
  return { status: 200, review: inserted, relationship };
}

describe('document_review integratie: oordeel → applyRelationshipDelta', () => {
  it('(a) accepted: positieve delta wordt toegepast op een nieuwe relatie-rij', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();
    const fetchFn = makeFakeFetch({
      verdict: 'accepted',
      grade: 8.5,
      reasoning: 'Sterke onderbouwing en heldere methodologie.',
      relationship_delta: 3,
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-accepted',
    });

    expect(out.status).toBe(200);
    expect(out.review.verdict).toBe('accepted');
    expect(out.review.grade).toBe(8.5);
    expect(out.relationship.score).toBe(3);
    expect(out.relationship.history).toHaveLength(1);
    expect(out.relationship.history[0].source).toBe('document_review');
    expect(out.relationship.history[0].refId).toBe('review-accepted');
    expect(out.relationship.history[0].note).toBe('accepted');
    expect(sb.rows).toHaveLength(1);
  });

  it('(a) conditional: kleine delta op bestaande relatie wordt opgeteld', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();

    // Eerste oordeel zet de relatie op +3.
    await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1',
      fetchFn: makeFakeFetch({
        verdict: 'accepted', grade: 8, reasoning: 'Goed begin.', relationship_delta: 3,
      }),
      sb, reviewId: 'review-first',
    });

    // Tweede oordeel (conditional, +1) telt op tot +4.
    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1',
      fetchFn: makeFakeFetch({
        verdict: 'conditional', grade: 6.5,
        reasoning: 'Voldoende, mits de analyse wordt aangevuld.',
        relationship_delta: 1,
      }),
      sb, reviewId: 'review-conditional',
    });

    expect(out.status).toBe(200);
    expect(out.review.verdict).toBe('conditional');
    expect(out.relationship.score).toBe(4);
    expect(out.relationship.history).toHaveLength(2);
    expect(out.relationship.history[1].refId).toBe('review-conditional');
  });

  it('(a) rejected: negatieve delta verlaagt de relatie-score', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();

    // Begin op +2.
    await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1',
      fetchFn: makeFakeFetch({
        verdict: 'accepted', grade: 7, reasoning: 'Prima eerste versie.', relationship_delta: 2,
      }),
      sb, reviewId: 'review-pos',
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1',
      fetchFn: makeFakeFetch({
        verdict: 'rejected', grade: 3,
        reasoning: 'Onvoldoende onderbouwing en plagiaatzorgen.',
        relationship_delta: -4,
      }),
      sb, reviewId: 'review-rejected',
    });

    expect(out.status).toBe(200);
    expect(out.review.verdict).toBe('rejected');
    expect(out.relationship.score).toBe(-2);
    expect(out.relationship.history).toHaveLength(2);
    expect(out.relationship.history[1].note).toBe('rejected');
  });

  it('(b) replay met dezelfde review-id (refId) is idempotent', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();
    const fetchFn = makeFakeFetch({
      verdict: 'accepted', grade: 8, reasoning: 'Sterke inzending.', relationship_delta: 3,
    });

    const first = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-dup',
    });
    expect(first.relationship.score).toBe(3);
    expect(first.relationship.history).toHaveLength(1);

    // Replay: zelfde source + refId → score/history mogen NIET muteren.
    const second = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-dup',
    });
    expect(second.relationship.score).toBe(3);
    expect(second.relationship.history).toHaveLength(1);
    expect(sb.rows).toHaveLength(1);
    expect(sb.rows[0].score).toBe(3);

    // Andere review-id → wel toepassen.
    const third = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1',
      fetchFn: makeFakeFetch({
        verdict: 'conditional', grade: 6, reasoning: 'Aanvullingen nodig.', relationship_delta: 1,
      }),
      sb, reviewId: 'review-other',
    });
    expect(third.relationship.score).toBe(4);
    expect(third.relationship.history).toHaveLength(2);
  });

  it('(c) conversational persona mag geen oordeel aanvragen (geen relatie-update)', async () => {
    const persona = makeConversationalPersona();
    const sb = makeFakeSupabase();
    // Zelfs als het LLM een delta zou produceren, mag de gate dit weren.
    const fetchFn = makeFakeFetch({
      verdict: 'accepted', grade: 9, reasoning: 'Mooi werk.', relationship_delta: 4,
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-conv',
    });

    expect(out.status).toBe(400);
    expect(out.error).toMatch(/evaluator/i);
    // Geen LLM-call en geen relatie-update.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sb.rows).toHaveLength(0);
  });

  it('(c) niet-staff, niet-groepslid wordt door de autz-gate geweigerd', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();
    const fetchFn = makeFakeFetch({
      verdict: 'accepted', grade: 8, reasoning: 'ok', relationship_delta: 2,
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      authz: { isStaff: false, isGroupMember: false },
      reviewId: 'review-noauth',
    });

    expect(out.status).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sb.rows).toHaveLength(0);
  });

  it('ongeldig LLM-JSON (geen verdict) → 502, geen relatie-update', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();
    const fetchFn = makeFakeFetch({
      grade: 7, reasoning: 'mist verdict', relationship_delta: 2,
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-bad',
    });

    expect(out.status).toBe(502);
    expect(sb.rows).toHaveLength(0);
  });

  it('relationship_delta wordt geclampt naar het bereik -5..+5', async () => {
    const persona = makeEvaluatorPersona();
    const sb = makeFakeSupabase();
    const fetchFn = makeFakeFetch({
      verdict: 'accepted', grade: 10, reasoning: 'Uitmuntend.', relationship_delta: 99,
    });

    const out = await simulateReviewEndpoint({
      persona, groupId: 'group-1', projectId: 'proj-1', fetchFn, sb,
      reviewId: 'review-clamp',
    });

    expect(out.status).toBe(200);
    expect(out.review.relationship_delta).toBe(5);
    expect(out.relationship.score).toBe(5);
  });
});
