// Task #174 — Extractie van de close-flow zodat we de integratie van
// LLM-response → cue-validatie → relationship-update kunnen testen zonder
// de hele Express-app op te tuigen. Deze module bevat puur (of bijna pure)
// orkestratie-bouwstenen die door `server/index.js` worden hergebruikt én
// door `server/__tests__/close.integration.test.js` rechtstreeks worden
// aangeroepen.

import {
  applyDelta as applyRelDelta,
  appendHistory as relAppendHistory,
  hasHistoryRef as relHasHistoryRef,
  validateCueResponse,
  buildCueInstructionBlock,
  cueJsonInstruction,
  hasCueTable,
} from './personaRelationship.js';

// Gate-logica voor cue-emissie. Spiegelt de checks in de close-handler:
// alleen `conversational` persona's, met `cue_emission_enabled !== false`
// (ontbrekend = true) én met een herkenbare cue-tabel in de system_prompt.
export function computeEmissionEnabled(persona) {
  if (!persona) return false;
  const conversational = (persona.persona_type || 'conversational') === 'conversational';
  const flagEnabled = persona.cue_emission_enabled !== false;
  return conversational && flagEnabled && hasCueTable(persona.system_prompt || '');
}

// Bouwt de exacte messages-array die we naar OpenAI sturen. Gespiegeld
// uit de oorspronkelijke handler zodat zowel productie als test 1 bron
// hebben. `lang` ∈ {'nl','en'}.
export function buildCloseMessages({ persona, allMsgs, lang, emissionEnabled }) {
  const conversationText = (allMsgs || [])
    .map(m => `${m.role === 'user' ? 'Student' : 'Persona'}: ${(m.content || '').slice(0, 2000)}`)
    .join('\n').slice(0, 12000);
  const msgCount = (allMsgs || []).filter(m => m.role === 'user').length;
  const topicsInstruction = lang === 'en'
    ? (msgCount <= 3 ? '2-3 short topics' : msgCount <= 8 ? '3-5 topics' : '5-8 topics')
    : (msgCount <= 3 ? '2-3 korte onderwerpen' : msgCount <= 8 ? '3-5 onderwerpen' : '5-8 onderwerpen');
  const langInstruction = lang === 'en' ? 'Write in English.' : 'Schrijf in het Nederlands.';
  const cueJson = emissionEnabled ? `\n${cueJsonInstruction(lang)}` : '';
  const cueSchemaSnippet = emissionEnabled
    ? ',\n  "relationship_delta": 0,\n  "relationship_reason": ""'
    : '';
  const userPrompt = lang === 'en'
    ? `You are a minute-taker. Analyse the following conversation between a student and an AI persona.\n\nRespond ONLY with valid JSON in this structure:\n{\n  "topics": [...],\n  "agreements": [...]${cueSchemaSnippet}\n}\n\n- "topics": array of ${topicsInstruction}. Each item is one discussed topic (concise, max 1 sentence).\n- "agreements": array of 0 or more strings. Only concrete agreements or commitments. Leave empty if none.${cueJson}\n\n${langInstruction} No markdown outside the JSON, no explanation.\n\nConversation:\n${conversationText}`
    : `Je bent een notulist. Analyseer het volgende gesprek tussen een student en een AI-persona.\n\nGeef je antwoord UITSLUITEND als geldige JSON met deze structuur:\n{\n  "topics": [...],\n  "agreements": [...]${cueSchemaSnippet}\n}\n\n- "topics": array van ${topicsInstruction}. Elk item is één besproken onderwerp (bondig, maximaal 1 zin).\n- "agreements": array van 0 of meer strings. Alleen concrete afspraken of toezeggingen. Laat leeg als er geen zijn.${cueJson}\n\n${langInstruction} Geen markdown buiten de JSON, geen uitleg.\n\nGesprek:\n${conversationText}`;
  const systemContent = emissionEnabled
    ? `${persona?.system_prompt || ''}${buildCueInstructionBlock(lang)}`
    : (persona?.system_prompt || '');
  const messages = systemContent
    ? [{ role: 'system', content: systemContent }, { role: 'user', content: userPrompt }]
    : [{ role: 'user', content: userPrompt }];
  return { messages, userPrompt, systemContent };
}

// Parseert het ruwe LLM-antwoord (string of object) tot {topics, agreements, cue}.
// Defensief: bij ongeldige JSON of ontbrekende velden valt alles terug op
// veilige defaults. Cue-validatie loopt door `validateCueResponse` zodat de
// emissie-gate (en de -2..+2 clamp) afdwingbaar blijft.
export function parseCloseLLMOutput(raw, { emissionEnabled }) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  let parsed;
  try { parsed = JSON.parse((text || '{}').trim()); } catch { parsed = {}; }
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.filter(t => typeof t === 'string' && t.trim())
    : [];
  const agreements = Array.isArray(parsed.agreements)
    ? parsed.agreements.filter(a => typeof a === 'string' && a.trim())
    : [];
  const cue = validateCueResponse(parsed, { emissionEnabled });
  return { topics, agreements, cue };
}

// Volledige roep-de-LLM-en-parse-stap, met injecteerbare `fetchFn` zodat
// tests zonder netwerktoegang draaien.
export async function callCloseLLM({
  fetchFn,
  apiKey,
  url,
  model,
  maxTokensParam = 'max_tokens',
  persona,
  allMsgs,
  lang,
  emissionEnabled,
}) {
  const { messages } = buildCloseMessages({ persona, allMsgs, lang, emissionEnabled });
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      [maxTokensParam]: 700,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp || !resp.ok) {
    return { topics: [], agreements: [], cue: { delta: 0, reason: '' } };
  }
  const body = await resp.json();
  const raw = body?.choices?.[0]?.message?.content || '{}';
  return parseCloseLLMOutput(raw, { emissionEnabled });
}

// Pas een delta toe op de relatie en append history. Idempotent: als
// event.refId al in history zit (zelfde source+refId), wordt niets
// bijgewerkt. Race-safe wanneer `pgPool` aanwezig is via een atomic
// INSERT ... ON CONFLICT DO UPDATE met WHERE-clausule. Zonder pgPool
// (test/CI) valt het terug op de oudere select+update/insert-flow met
// best-effort idempotentie. Retourneert de bijgewerkte rij of null als
// de tabel nog niet bestaat.
export async function applyRelationshipDeltaImpl(
  { supabaseAdmin, pgPool },
  { projectId, groupId, personaId, delta, event },
) {
  if (!supabaseAdmin) return null;
  const evt = { ts: new Date().toISOString(), ...(event || {}) };
  const deltaInt = Number.isFinite(Number(delta)) ? Math.round(Number(delta)) : 0;
  const source = event?.source || '';
  const refId = event?.refId || '';

  if (!pgPool) {
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('project_persona_relationships')
      .select('id, score, history')
      .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
      .maybeSingle();
    if (selErr) {
      if (selErr.code === '42P01' || /project_persona_relationships/i.test(selErr.message || '')) return null;
      throw selErr;
    }
    const curScore = existing?.score ?? 0;
    const curHistory = Array.isArray(existing?.history) ? existing.history : [];
    if (refId && relHasHistoryRef(curHistory, source, refId)) return existing || null;
    const newScore = applyRelDelta(curScore, deltaInt);
    const newHistory = relAppendHistory(curHistory, evt);
    if (existing) {
      const { data: updated, error: upErr } = await supabaseAdmin
        .from('project_persona_relationships')
        .update({ score: newScore, history: newHistory, updated_at: new Date().toISOString() })
        .eq('id', existing.id).select('id, score, history, updated_at').single();
      if (upErr) throw upErr;
      return updated;
    }
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('project_persona_relationships')
      .insert({ project_id: projectId, group_id: groupId, persona_id: personaId, score: newScore, history: newHistory })
      .select('id, score, history, updated_at').single();
    if (insErr) throw insErr;
    return inserted;
  }

  try {
    const sql = `
      INSERT INTO project_persona_relationships
        (project_id, group_id, persona_id, score, history, updated_at)
      VALUES (
        $1, $2, $3,
        GREATEST(LEAST($4::int, 10), -10),
        jsonb_build_array($5::jsonb),
        now()
      )
      ON CONFLICT (project_id, group_id, persona_id) DO UPDATE
      SET score = GREATEST(LEAST(project_persona_relationships.score + $4::int, 10), -10),
          history = project_persona_relationships.history || jsonb_build_array($5::jsonb),
          updated_at = now()
      WHERE COALESCE($7::text, '') = ''
         OR NOT (project_persona_relationships.history @> jsonb_build_array(
              jsonb_build_object('source', $6::text, 'refId', $7::text)
            ))
      RETURNING id, score, history, updated_at`;
    const res = await pgPool.query(sql, [
      projectId, groupId, personaId,
      deltaInt, JSON.stringify(evt),
      source, refId,
    ]);
    if (res.rowCount > 0) return res.rows[0];
    const reread = await pgPool.query(
      `SELECT id, score, history, updated_at FROM project_persona_relationships
       WHERE project_id=$1 AND group_id=$2 AND persona_id=$3`,
      [projectId, groupId, personaId],
    );
    return reread.rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || /project_persona_relationships/i.test(e.message || '')) return null;
    throw e;
  }
}
