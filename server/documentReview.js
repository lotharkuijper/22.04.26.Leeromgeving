// Pure helpers voor Task #166 (document-reviews). Geen DB-calls hier zodat
// vitest ze direct kan testen zonder Supabase-mock.

export const VERDICTS = ['accepted', 'conditional', 'rejected'];

// Normaliseer/valideer wat de LLM teruggeeft. Verwacht {verdict, reasoning,
// relationship_delta?}. Geeft `{ ok, value, error }`. Ondersteunt JSON-string
// als input voor convenience.
export function validateReviewResponse(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch (e) { return { ok: false, error: `Ongeldige JSON: ${e.message}` }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Antwoord is geen object' };
  }
  const verdict = String(obj.verdict || '').toLowerCase().trim();
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, error: `verdict moet één van ${VERDICTS.join('/')} zijn (kreeg "${obj.verdict}")` };
  }
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  if (reasoning.length === 0) {
    return { ok: false, error: 'reasoning mag niet leeg zijn' };
  }
  // Clamp delta naar -5..+5. Default 0. Niet-numeriek → 0.
  let delta = Number(obj.relationship_delta);
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.round(delta);
  if (delta > 5) delta = 5;
  if (delta < -5) delta = -5;
  return {
    ok: true,
    value: { verdict, reasoning, relationship_delta: delta },
  };
}

// Autorisatie: wie mag een review op een document aanvragen.
// `isProjectMember` = lid van enige groep in dit project (gebruikt voor de
// "groep mag haar evaluator aanroepen" use-case). `isStaff` = admin/superuser
// of docent van de cursus.
export function canRequestDocumentReview({ isStaff, isGroupMember }) {
  if (isStaff) return { allowed: true };
  if (isGroupMember) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    error: 'Je moet lid zijn van deze groep of staff van de cursus om een oordeel aan te vragen',
  };
}
