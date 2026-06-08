// Task #252: pure helpers voor het raadpleeglimiet-systeem per persona/groep.
// Een "raadpleging" = één heel gesprek (thread). De teller wordt verbruikt bij
// het OPENEN van een nieuwe thread. Limiet = persona.max_consultations + de per
// (project, groep) toegekende extra raadplegingen. null = onbeperkt.
//
// Deze module bevat uitsluitend zuivere functies zodat ze los getest kunnen
// worden (server/__tests__/consultationLimit.test.js). De DB-toegang en
// auto-close-orkestratie zitten in server/index.js.

const AUTO_CLOSE_MAX_HOURS = 24 * 365; // harde bovengrens (1 jaar) tegen onzin-invoer.
const MAX_CONSULTATIONS_CAP = 1000;

// Normaliseer de docent-invoer voor max_consultations.
// null/''/undefined/negatief/niet-numeriek → null (= onbeperkt).
// 0 betekent expliciet "geen nieuwe raadplegingen toegestaan".
function normalizeMaxConsultations(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_CONSULTATIONS_CAP);
}

// Normaliseer auto_close_hours. null/''/undefined/<=0/niet-numeriek → null (uit).
function normalizeAutoCloseHours(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, AUTO_CLOSE_MAX_HOURS);
}

// Normaliseer een extra-toekenning (per groep). Niet-numeriek/negatief → 0.
function normalizeExtraGrant(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_CONSULTATIONS_CAP);
}

// Effectieve limiet = basis (persona) + extra (groep). null basis ⇒ onbeperkt.
function computeEffectiveLimit(maxConsultations, extra) {
  const base = normalizeMaxConsultations(maxConsultations);
  if (base === null) return null; // onbeperkt
  return base + normalizeExtraGrant(extra);
}

// Resterende raadplegingen. null limiet ⇒ null (onbeperkt). Nooit negatief.
function computeRemaining(used, effectiveLimit) {
  if (effectiveLimit === null || effectiveLimit === undefined) return null;
  const u = Number.isFinite(Number(used)) ? Math.max(0, Math.floor(Number(used))) : 0;
  return Math.max(0, effectiveLimit - u);
}

// Mag er nog een NIEUWE raadpleging gestart worden? Geblokkeerd als limiet
// bereikt is. Onbeperkt ⇒ nooit geblokkeerd.
function isConsultationBlocked(used, effectiveLimit) {
  if (effectiveLimit === null || effectiveLimit === undefined) return false;
  const u = Number.isFinite(Number(used)) ? Math.max(0, Math.floor(Number(used))) : 0;
  return u >= effectiveLimit;
}

// Is een open thread "stil" lang genoeg om automatisch af te ronden?
// autoCloseHours null ⇒ nooit. lastActivityIso ontbreekt ⇒ niet stale.
function isThreadStale(lastActivityIso, autoCloseHours, now = Date.now()) {
  const hours = normalizeAutoCloseHours(autoCloseHours);
  if (hours === null) return false;
  if (!lastActivityIso) return false;
  const ts = new Date(lastActivityIso).getTime();
  if (!Number.isFinite(ts)) return false;
  return (now - ts) >= hours * 3600 * 1000;
}

// Bericht dat de student ziet wanneer de limiet bereikt is (mirror van het
// relationshipBlocked-patroon). Tweede persoon, NL/EN.
function consultationLimitMessage(lang, limit) {
  const n = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  if (lang === 'en') {
    return `You've reached the maximum number of consultations with this persona (${n}). Ask your teacher for extra consultations if you need to continue.`;
  }
  return `Je hebt het maximale aantal raadplegingen met deze persona bereikt (${n}). Vraag je docent om extra raadplegingen als je verder wilt.`;
}

export {
  normalizeMaxConsultations,
  normalizeAutoCloseHours,
  normalizeExtraGrant,
  computeEffectiveLimit,
  computeRemaining,
  isConsultationBlocked,
  isThreadStale,
  consultationLimitMessage,
  AUTO_CLOSE_MAX_HOURS,
  MAX_CONSULTATIONS_CAP,
};
