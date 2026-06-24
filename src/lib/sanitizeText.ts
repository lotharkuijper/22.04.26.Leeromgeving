// Saneert geëxtraheerde tekst zodat PostgreSQL de insert in tekst-/jsonb-kolommen
// accepteert. PDF-/DOCX-/PPTX-extractie levert soms onzichtbare tekens op
// (NUL `\u0000`, ongepaarde UTF-16-surrogaten, niet-witruimte control-chars) die
// Postgres weigert met "unsupported Unicode escape sequence", waardoor één chunk
// de hele insert laat falen. Spiegel van server/sanitizeText.js — houd ze gelijk.

// Verwijder NUL en niet-witruimte C0/C1 control-chars. Behoud tab (\u0009),
// newline (\u000A) en carriage return (\u000D).
const CONTROL_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Ongepaarde UTF-16-surrogaten verwijderen ZONDER lookbehind/lookahead, zodat de
// regex in élke browser parseert. Oudere Safari (< 16.4) ondersteunt geen
// regex-lookbehind; een lookbehind-literal gooit dan al bij het laden van de
// module een SyntaxError, waardoor de sanitatie nooit draait. We matchen eerst
// een geldig surrogaatpaar (lengte 2 → behouden) en anders een losse surrogate
// (lengte 1 → verwijderen). Dit dekt elke surrogate-codepunt: een high zonder
// volgende low, een low zonder voorafgaande high, en reeksen daarvan.
const SURROGATE_PAIR_OR_LONE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

export function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  const out = input
    .replace(SURROGATE_PAIR_OR_LONE_RE, (m) => (m.length === 2 ? m : ''))
    .replace(CONTROL_CHARS_RE, '');
  // Slotgarantie, onafhankelijk van bovenstaande regexes: strip elke resterende
  // NUL. NUL is de enige tekst-codepunt die Postgres in een tekst-/jsonb-kolom
  // hard weigert ("unsupported Unicode escape sequence"), dus dit mag nooit
  // doorglippen.
  return out.indexOf('\u0000') === -1 ? out : out.split('\u0000').join('');
}

// Saneert recursief alle string-waarden in een metadata-object (jsonb-kolom),
// zodat ook string-velden in metadata Postgres niet laten klappen.
export function sanitizeMetadata<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeMetadata(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Saneer ook de sleutel: een jsonb-object-key met NUL/losse surrogaten laat
      // de insert net zo goed klappen als een waarde.
      out[sanitizeText(k)] = sanitizeMetadata(v);
    }
    return out as unknown as T;
  }
  return value;
}
