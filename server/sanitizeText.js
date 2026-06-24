// Saneert geëxtraheerde tekst zodat PostgreSQL de insert in tekst-/jsonb-kolommen
// accepteert. PDF-/DOCX-/PPTX-extractie levert soms onzichtbare tekens op
// (NUL `\u0000`, ongepaarde UTF-16-surrogaten, niet-witruimte control-chars) die
// Postgres weigert met "unsupported Unicode escape sequence", waardoor één chunk
// de hele insert laat falen. Spiegel van src/lib/sanitizeText.ts — houd ze gelijk.

// Verwijder NUL en niet-witruimte C0/C1 control-chars. Behoud tab (\u0009),
// newline (\u000A) en carriage return (\u000D).
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Ongepaarde UTF-16-surrogaten verwijderen ZONDER lookbehind/lookahead, zodat de
// regex overal parseert (spiegel van de client; oudere JS-runtimes/browsers
// ondersteunen geen regex-lookbehind). We matchen eerst een geldig surrogaatpaar
// (lengte 2 → behouden) en anders een losse surrogate (lengte 1 → verwijderen).
const SURROGATE_PAIR_OR_LONE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

export function sanitizeText(input) {
  if (typeof input !== 'string') return '';
  const out = input
    .replace(SURROGATE_PAIR_OR_LONE_RE, (m) => (m.length === 2 ? m : ''))
    .replace(CONTROL_CHARS_RE, '');
  // Slotgarantie: strip elke resterende NUL — het enige teken dat Postgres in een
  // tekst-/jsonb-kolom hard weigert ("unsupported Unicode escape sequence").
  return out.indexOf('\u0000') === -1 ? out : out.split('\u0000').join('');
}

// Saneert recursief alle string-waarden in een metadata-object (jsonb-kolom),
// zodat ook string-velden in metadata Postgres niet laten klappen.
export function sanitizeMetadata(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeMetadata(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Saneer ook de sleutel: een jsonb-object-key met NUL/losse surrogaten laat
      // de insert net zo goed klappen als een waarde.
      out[sanitizeText(k)] = sanitizeMetadata(v);
    }
    return out;
  }
  return value;
}
