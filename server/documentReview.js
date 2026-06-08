// Pure helpers voor Task #166 (document-reviews). Geen DB-calls hier zodat
// vitest ze direct kan testen zonder Supabase-mock.

export const VERDICTS = ['accepted', 'conditional', 'rejected'];

// Task #253: badge-drempels op basis van het cijfer (0–10). De bovengrens telt
// voor de hogere badge: 6,0 = brons, 7,0 = zilver, 8,0 = goud, 9,0 = platina.
// Onder 6,0 → geen badge (null).
export const BADGE_TIERS = [
  { min: 9, badge: 'platina' },
  { min: 8, badge: 'goud' },
  { min: 7, badge: 'zilver' },
  { min: 6, badge: 'brons' },
];

// Deterministische badge-bepaling uit een cijfer. Geen LLM-afhankelijkheid.
// Retourneert 'platina' | 'goud' | 'zilver' | 'brons' of null (< 6 / ongeldig).
export function badgeForGrade(grade) {
  const g = Number(grade);
  if (!Number.isFinite(g)) return null;
  for (const tier of BADGE_TIERS) {
    if (g >= tier.min) return tier.badge;
  }
  return null;
}

// Normaliseer de toekenningsmodus van een beoordelaar-persona. Alles behalve
// 'group' valt terug op 'individual' (veilige standaard).
export function normalizeBadgeAwardMode(mode) {
  return mode === 'group' ? 'group' : 'individual';
}

// Normaliseer/valideer wat de LLM teruggeeft. Verwacht {verdict, grade,
// reasoning, feed_forward?, relationship_delta?}. Geeft `{ ok, value, error }`.
// Ondersteunt JSON-string als input voor convenience.
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
  // Cijfer is verplicht en moet numeriek zijn. Clamp naar 0..10, afgerond op
  // één decimaal zodat de badge-drempels stabiel blijven.
  let grade = Number(obj.grade);
  if (!Number.isFinite(grade)) {
    return { ok: false, error: 'grade ontbreekt of is niet numeriek (verwacht 0–10)' };
  }
  if (grade < 0) grade = 0;
  if (grade > 10) grade = 10;
  grade = Math.round(grade * 10) / 10;
  // Feed-forward is optioneel; lege string als hij ontbreekt.
  const feedForward = typeof obj.feed_forward === 'string' ? obj.feed_forward.trim() : '';
  // Clamp delta naar -5..+5. Default 0. Niet-numeriek → 0.
  let delta = Number(obj.relationship_delta);
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.round(delta);
  if (delta > 5) delta = 5;
  if (delta < -5) delta = -5;
  return {
    ok: true,
    value: { verdict, grade, reasoning, feed_forward: feedForward, relationship_delta: delta },
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
