import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Deze guard voorkomt dat een taal maar half wordt toegevoegd. Een ondersteunde
// taal moet in ELKE onafhankelijke registry staan (zie memory-topic
// `adding-a-language.md`). Ontbreekt hij ergens, dan werkt de taal stil half
// (staat in de picker maar laadt geen locale, of het opslaan faalt in de DB).
import { SUPPORTED_LANGUAGES, SUPPORTED_LANG_CODES, EAGER_LANGS, SOURCE_LANG } from '../i18n/languages';
import { TRANSLATION_LANGUAGE_CODES } from '../lib/translationLanguages';
import { LANG_ENGLISH_NAMES } from '../../server/languages.js';
import { LANGUAGE_CODES as DOC_TRANSLATION_LANGUAGE_CODES } from '../../server/documentTranslation.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSource(rel: string): string {
  return readFileSync(join(projectRoot, rel), 'utf8');
}

// Extraheer de taalcodes uit een niet-geëxporteerde bron (die we niet veilig
// kunnen importeren omdat het bestand bij import neveneffecten heeft of de
// waarde niet exporteert). We knippen het relevante blok eruit en lezen de codes.
function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `blok "${startMarker}" niet gevonden`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `einde "${endMarker}" niet gevonden na "${startMarker}"`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function sorted(codes: Iterable<string>): string[] {
  return Array.from(new Set(codes)).sort();
}

const canonical = sorted(SUPPORTED_LANG_CODES);

describe('taal-registry synchronisatie', () => {
  it('SUPPORTED_LANGUAGES bevat geen dubbele codes', () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes.length).toBe(new Set(codes).size);
  });

  it('TRANSLATION_LANGUAGES (document-vertaal-dropdown) dekt exact dezelfde talen', () => {
    expect(sorted(TRANSLATION_LANGUAGE_CODES)).toEqual(canonical);
  });

  it('LANG_ENGLISH_NAMES (server AI-instructie + allowlist) dekt exact dezelfde talen', () => {
    expect(sorted(Object.keys(LANG_ENGLISH_NAMES))).toEqual(canonical);
  });

  it('LANGUAGES (server document-vertaling allowlist) dekt exact dezelfde talen', () => {
    expect(sorted(DOC_TRANSLATION_LANGUAGE_CODES)).toEqual(canonical);
  });

  it('lazyLoaders (src/i18n/translations.ts) dekt alle niet-eager talen', () => {
    const block = extractBlock(
      readSource('src/i18n/translations.ts'),
      'const lazyLoaders',
      '\n};',
    );
    const codes = Array.from(block.matchAll(/(\w+):\s*\(\)\s*=>\s*import/g)).map((m) => m[1]);
    // Alleen nl + en worden eager gebundeld; alle overige talen MOETEN een lazy
    // dynamic-import hebben, anders wordt hun locale nooit geladen.
    const expected = sorted(canonical.filter((c) => !EAGER_LANGS.includes(c)));
    expect(sorted(codes)).toEqual(expected);
  });

  it('TARGET_LANGS (scripts/i18n-generate.mjs) dekt alle talen behalve de bron-taal', () => {
    const block = extractBlock(
      readSource('scripts/i18n-generate.mjs'),
      'const TARGET_LANGS',
      '\n];',
    );
    const codes = Array.from(block.matchAll(/code:\s*'([^']+)'/g)).map((m) => m[1]);
    // De generator vertaalt alle talen behalve de bron-taal (nl).
    const expected = sorted(canonical.filter((c) => c !== SOURCE_LANG));
    expect(sorted(codes)).toEqual(expected);
  });

  it('profiles.preferred_lang union (src/lib/database.types.ts) dekt exact dezelfde talen', () => {
    const source = readSource('src/lib/database.types.ts');
    const lines = source.split('\n').filter((l) => l.includes('preferred_lang'));
    expect(lines.length, 'verwacht Row/Insert/Update preferred_lang-regels').toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const codes = Array.from(line.matchAll(/'([a-z-]+)'/g)).map((m) => m[1]);
      expect(sorted(codes), `preferred_lang union mist een taal: ${line.trim()}`).toEqual(canonical);
    }
  });
});

describe('locale-JSON sleutelpariteit', () => {
  const localesDir = join(projectRoot, 'src', 'i18n', 'locales');
  const nlKeys = sorted(
    Object.keys(JSON.parse(readFileSync(join(localesDir, 'nl.json'), 'utf8'))),
  );

  const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json') && f !== 'nl.json');

  it('elke ondersteunde taal (behalve nl) heeft een locale-JSON', () => {
    const fileCodes = sorted(localeFiles.map((f) => f.replace(/\.json$/, '')));
    const expected = sorted(canonical.filter((c) => c !== 'nl'));
    expect(fileCodes).toEqual(expected);
  });

  it.each(localeFiles)('%s heeft exacte sleutelpariteit met nl.json', (file) => {
    const keys = sorted(
      Object.keys(JSON.parse(readFileSync(join(localesDir, file), 'utf8'))),
    );
    const missing = nlKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !nlKeys.includes(k));
    expect(missing, `${file} mist sleutels`).toEqual([]);
    expect(extra, `${file} heeft extra sleutels`).toEqual([]);
  });
});
