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

// Ongepaarde UTF-16-surrogaten: een high surrogate (D800–DBFF) zonder volgende
// low surrogate, of een low surrogate (DC00–DFFF) zonder voorafgaande high.
const LONE_SURROGATES_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(LONE_SURROGATES_RE, '').replace(CONTROL_CHARS_RE, '');
}

// Saneert recursief alle string-waarden in een metadata-object (jsonb-kolom),
// zodat ook string-velden in metadata Postgres niet laten klappen.
export function sanitizeMetadata<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeMetadata(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeMetadata(v);
    }
    return out as unknown as T;
  }
  return value;
}
