// Pure helpers voor Task #167 (persona-relaties). Geen DB-calls hier zodat
// vitest ze direct kan testen. Score wordt geclamped op -10..+10; labels
// zijn 5 buckets (NL+EN); history is een ring met maxItems-rotatie.

export const SCORE_MIN = -10;
export const SCORE_MAX = 10;
export const BLOCK_THRESHOLD = -8;
export const HISTORY_MAX_DEFAULT = 20;

export const RELATIONSHIP_LABELS = {
  nl: { cold: 'koud', strained: 'gespannen', neutral: 'neutraal', positive: 'welwillend', warm: 'warm' },
  en: { cold: 'cold', strained: 'strained', neutral: 'neutral', positive: 'positive', warm: 'warm' },
};

export function clampScore(score) {
  let n = Number(score);
  if (!Number.isFinite(n)) n = 0;
  n = Math.round(n);
  if (n > SCORE_MAX) n = SCORE_MAX;
  if (n < SCORE_MIN) n = SCORE_MIN;
  return n;
}

export function applyDelta(currentScore, delta) {
  const cur = clampScore(currentScore);
  let d = Number(delta);
  if (!Number.isFinite(d)) d = 0;
  d = Math.round(d);
  return clampScore(cur + d);
}

// Buckets: ≤−6 koud, −5..−2 gespannen, −1..1 neutraal, 2..5 welwillend, ≥6 warm.
export function scoreToBucket(score) {
  const s = clampScore(score);
  if (s <= -6) return 'cold';
  if (s <= -2) return 'strained';
  if (s <= 1)  return 'neutral';
  if (s <= 5)  return 'positive';
  return 'warm';
}

export function scoreToLabel(score, lang = 'nl') {
  const set = RELATIONSHIP_LABELS[lang] || RELATIONSHIP_LABELS.nl;
  return set[scoreToBucket(score)];
}

export function appendHistory(history, event, maxItems = HISTORY_MAX_DEFAULT) {
  const arr = Array.isArray(history) ? history.slice() : [];
  const safeEvent = { ts: new Date().toISOString(), ...(event || {}) };
  arr.push(safeEvent);
  if (arr.length > maxItems) return arr.slice(arr.length - maxItems);
  return arr;
}

// Idempotentie-check: is er al een history-event met dezelfde (source, refId)?
export function hasHistoryRef(history, source, refId) {
  if (!Array.isArray(history) || !source || !refId) return false;
  return history.some(e => e && e.source === source && e.refId === refId);
}

export function isBlocked(score) {
  return clampScore(score) <= BLOCK_THRESHOLD;
}

const BLOCK_MESSAGES = {
  nl: 'Deze persona wil eerst herstel zien — er is op dit moment te veel spanning om verder te praten. Plan eerst een correctie met je docent.',
  en: 'This persona wants to see things repaired first — there is too much tension to continue right now. Arrange a correction with your teacher first.',
};
export function blockedMessage(lang = 'nl') {
  return BLOCK_MESSAGES[lang] || BLOCK_MESSAGES.nl;
}

// Bouwt het systeemprompt-blok dat aan elke persona-chat wordt toegevoegd.
// Toont label + score + tot N recente aanleidingen.
export function buildRelationshipPromptBlock(score, history, lang = 'nl', maxRecent = 3) {
  const s = clampScore(score);
  const label = scoreToLabel(s, lang);
  const recent = Array.isArray(history) ? history.slice(-maxRecent).reverse() : [];
  if (lang === 'en') {
    const lines = [
      '',
      'Your current relationship with this group:',
      `- Label: ${label} (score ${s >= 0 ? '+' : ''}${s} on a scale of -10..+10)`,
      '- Adjust your tone and willingness to help to fit this relationship; do not pretend it does not exist.',
    ];
    if (recent.length > 0) {
      lines.push('- Recent causes:');
      for (const e of recent) lines.push(`  • ${formatEvent(e, 'en')}`);
    }
    return lines.join('\n');
  }
  const lines = [
    '',
    'Je huidige verstandhouding met deze groep:',
    `- Label: ${label} (score ${s >= 0 ? '+' : ''}${s} op een schaal van -10..+10)`,
    '- Pas je toon en bereidwilligheid hierop aan; doe niet alsof deze relatie er niet is.',
  ];
  if (recent.length > 0) {
    lines.push('- Recente aanleidingen:');
    for (const e of recent) lines.push(`  • ${formatEvent(e, 'nl')}`);
  }
  return lines.join('\n');
}

function formatEvent(e, lang) {
  const delta = Number(e?.delta);
  const deltaStr = Number.isFinite(delta) ? (delta >= 0 ? `+${delta}` : `${delta}`) : '0';
  const src = e?.source || (lang === 'en' ? 'unknown' : 'onbekend');
  const note = e?.note ? ` — ${e.note}` : '';
  return `${deltaStr} (${src})${note}`;
}
