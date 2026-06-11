// Pure beslis-/parse-helpers voor bulk-accounts (Task #271 — accounts in bulk
// aanmaken vanuit een e-maillijst). Door deze functies pure te houden (geen
// DB-calls, geen netwerk) zijn ze met vitest dekbaar zonder een lopende server.
// De route in server/index.js combineert ze met supabaseAdmin (service-role),
// isCourseTeacher en inviteUserByEmail.

// Strikte validator voor één los adres (geankerd).
const EMAIL_VALIDATE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Globale extractor om adressen uit vrije tekst / CSV / documenttekst te vissen.
const EMAIL_EXTRACT_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Maximale batchgrootte per provisioning-request. Supabase Auth verstuurt de
// activatie-e-mails en is (zeker op de standaard-SMTP) gerate-limit; daarnaast
// voorkomt een cap dat één request te lang loopt. Grotere lijsten moet de
// client in stukken opdelen.
export const MAX_BULK_BATCH = 50;

/**
 * Valideert één e-mailadres. Trimt eerst; weigert lege strings en adressen
 * langer dan 254 tekens (RFC-grens).
 * @param {unknown} email
 * @returns {boolean}
 */
export function validateEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (!e || e.length > 254) return false;
  return EMAIL_VALIDATE_RE.test(e);
}

/**
 * Vist alle e-mailadressen uit een stuk vrije tekst (bijv. CSV- of
 * document-inhoud). Geeft de ruwe (getrimde) matches terug, nog niet ontdubbeld.
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractEmails(text) {
  if (typeof text !== 'string' || !text) return [];
  const matches = text.match(EMAIL_EXTRACT_RE) || [];
  return matches.map((m) => m.trim());
}

/**
 * Ontdubbelt case-insensitief, behoudt het eerste voorkomen en levert
 * genormaliseerd (lowercase, getrimd) terug.
 * @param {string[]} list
 * @returns {string[]}
 */
export function dedupeEmails(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/**
 * Neemt een ruwe lijst kandidaat-strings (uit een tekstvak en/of een
 * geparseerd bestand) en classificeert ze. Geldige adressen worden
 * genormaliseerd (lowercase) en ontdubbeld; ongeldige tokens worden (ontdubbeld)
 * teruggegeven voor gebruikersfeedback.
 *
 * @param {unknown[]} candidates
 * @returns {{ valid: string[], invalid: string[], duplicates: number }}
 *   - valid       genormaliseerde, ontdubbelde geldige adressen
 *   - invalid     getrimde tokens die geen geldig adres zijn (ontdubbeld)
 *   - duplicates  aantal geldige adressen dat als duplicaat is verwijderd
 */
export function normalizeEmailList(candidates) {
  const validRaw = [];
  const invalidSeen = new Set();
  const invalid = [];
  for (const raw of candidates || []) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim();
    if (!token) continue;
    if (validateEmail(token)) {
      validRaw.push(token.toLowerCase());
    } else {
      const key = token.toLowerCase();
      if (!invalidSeen.has(key)) {
        invalidSeen.add(key);
        invalid.push(token);
      }
    }
  }
  const valid = dedupeEmails(validRaw);
  const duplicates = validRaw.length - valid.length;
  return { valid, invalid, duplicates };
}

/**
 * Bepaalt of de aanroeper in bulk accounts mag toevoegen aan een cursus.
 * Admins mogen elke cursus; per-cursus docenten alleen hun eigen cursus.
 * Spiegelt authorizeAvailabilityChange / authorizeMemberRoleChange.
 *
 * @param {object} ctx
 * @param {boolean} ctx.isAdmin
 * @param {boolean} ctx.isCourseTeacher — caller is course_members.member_role='teacher' in déze cursus
 * @returns {{ allowed: true } | { allowed: false, status: 403, body: { error: string } }}
 */
export function authorizeBulkProvision({ isAdmin, isCourseTeacher }) {
  if (isAdmin) return { allowed: true };
  if (isCourseTeacher) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    body: { error: 'Alleen admin of docent van deze cursus mag accounts toevoegen' },
  };
}

/**
 * Valideert de batchgrootte van een provisioning-request.
 * @param {unknown} emails
 * @returns {{ ok: true } | { ok: false, status: number, body: { error: string } }}
 */
export function validateBatchSize(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return { ok: false, status: 400, body: { error: 'Geen geldige e-mailadressen ontvangen' } };
  }
  if (emails.length > MAX_BULK_BATCH) {
    return {
      ok: false,
      status: 400,
      body: { error: `Maximaal ${MAX_BULK_BATCH} adressen per keer — splits de lijst in kleinere stukken.` },
    };
  }
  return { ok: true };
}

/**
 * Bouwt een veilige activatie-redirect-URL. Geeft de voorkeur aan een door de
 * client meegegeven, geldige http(s)-basis (window.location.origin), anders de
 * Origin-header, anders een env-fallback. Resultaat eindigt op `/activate`.
 * Een ongeldige/niet-http(s)-basis wordt genegeerd zodat er nooit een rare
 * redirect ontstaat (Supabase' redirect-allowlist is de uiteindelijke backstop).
 *
 * @param {object} sources
 * @param {string} [sources.bodyBase]   — client-opgegeven origin (req.body.redirectBase)
 * @param {string} [sources.originHeader] — req.headers.origin
 * @param {string} [sources.envBase]     — process.env.APP_PUBLIC_URL
 * @returns {string|undefined} volledige activatie-URL of undefined als geen basis bekend is
 */
export function buildActivationRedirect({ bodyBase, originHeader, envBase } = {}) {
  const candidates = [bodyBase, originHeader, envBase];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) {
      return `${c.trim().replace(/\/+$/, '')}/activate`;
    }
  }
  return undefined;
}
