// ───────────────────────────────────────────────────────────────────────────
// Cursus-banner — pure helpers (geen I/O), getest in __tests__/courseBanner.test.js.
// Een banner is een weergave-instelling op het course_info-blok: één afbeelding
// per cursus met positie, hoogte, doorzichtigheid (achtergrond-stand), uitsnede
// en alt-tekst. Deze helpers normaliseren docent-invoer defensief (clamp + enum)
// en valideren geüploade afbeeldingen (alleen rasterbeelden, geen SVG).
// ───────────────────────────────────────────────────────────────────────────

export const BANNER_POSITIONS = ['top', 'bottom', 'left', 'right', 'background'];
export const BANNER_FOCALS = ['top', 'center', 'bottom'];

export const BANNER_HEIGHT_MIN = 80;
export const BANNER_HEIGHT_MAX = 600;
export const BANNER_HEIGHT_DEFAULT = 220;

export const BANNER_OPACITY_MIN = 10;
export const BANNER_OPACITY_MAX = 100;
export const BANNER_OPACITY_DEFAULT = 100;

export const BANNER_ALT_MAX = 300;

// SVG bewust uitgesloten (kan scripts/externe verwijzingen bevatten).
export const ALLOWED_BANNER_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
]);
export const ALLOWED_BANNER_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);

function chooseEnum(inputVal, baseVal, set, dflt) {
  if (set.includes(inputVal)) return inputVal;
  if (set.includes(baseVal)) return baseVal;
  return dflt;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function chooseInt(inputVal, baseVal, min, max, dflt) {
  let n = toInt(inputVal);
  if (Number.isNaN(n)) n = toInt(baseVal);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeAlt(inputVal, baseVal) {
  const v = typeof inputVal === 'string'
    ? inputVal
    : (typeof baseVal === 'string' ? baseVal : '');
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, BANNER_ALT_MAX);
}

// Lees een veld uit een base-object dat óf platte sleutels (position) óf
// DB-kolomnamen (banner_position) kan hebben.
function baseVal(base, key) {
  if (!base || typeof base !== 'object') return undefined;
  return base[key] !== undefined ? base[key] : base[`banner_${key}`];
}

// Normaliseer (gedeeltelijke) docent-invoer tegen bestaande waarden (base).
// Ontbrekende/ongeldige velden vallen terug op base en daarna op de default.
export function normalizeBannerSettings(input = {}, base = {}) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    position: chooseEnum(i.position, baseVal(base, 'position'), BANNER_POSITIONS, 'top'),
    focal: chooseEnum(i.focal, baseVal(base, 'focal'), BANNER_FOCALS, 'center'),
    height: chooseInt(i.height, baseVal(base, 'height'), BANNER_HEIGHT_MIN, BANNER_HEIGHT_MAX, BANNER_HEIGHT_DEFAULT),
    opacity: chooseInt(i.opacity, baseVal(base, 'opacity'), BANNER_OPACITY_MIN, BANNER_OPACITY_MAX, BANNER_OPACITY_DEFAULT),
    alt: normalizeAlt(i.alt, baseVal(base, 'alt')),
  };
}

// Bestandsextensie (zonder punt, lowercase) uit een bestandsnaam.
export function bannerExtFromName(name) {
  const n = typeof name === 'string' ? name : '';
  const m = n.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Alleen toegestane rasterbeelden; SVG en onbekende types worden geweigerd.
export function isAllowedBannerImage(mime, ext) {
  const m = (typeof mime === 'string' ? mime : '').toLowerCase();
  const e = (typeof ext === 'string' ? ext : '').toLowerCase().replace(/^\./, '');
  if (m === 'image/svg+xml' || e === 'svg') return false;
  return ALLOWED_BANNER_MIME.has(m) && ALLOWED_BANNER_EXT.has(e);
}

// Inspecteer de eerste bytes om te bevestigen dat de inhoud écht een
// toegestaan rasterbeeld is (verdediging-in-de-diepte: client-MIME en
// bestandsnaam zijn vervalsbaar). Geeft het gedetecteerde formaat terug
// ('png'|'jpeg'|'gif'|'webp'|'avif') of null. SVG/tekst → null (geen magic).
export function sniffImageMagic(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 12) return null;
  const b = buf;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) return 'gif';
  // WebP: "RIFF"????"WEBP"
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  // AVIF: ISO-BMFF "ftyp"-box op offset 4 met een avif/avis-brand.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    let head = '';
    const end = Math.min(b.length, 32);
    for (let i = 8; i < end; i++) head += String.fromCharCode(b[i]);
    if (head.includes('avif') || head.includes('avis')) return 'avif';
  }
  return null;
}

// Combineert magic-byte-sniffing tot een booleaanse poort voor uploads.
export function isAllowedBannerBuffer(buf) {
  return sniffImageMagic(buf) !== null;
}
