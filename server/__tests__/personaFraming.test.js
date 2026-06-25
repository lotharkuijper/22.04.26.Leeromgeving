import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Task #387: AI-prompts mogen het model niet langer als een vaste
// "epidemiologie en biostatistiek"-expert framen. Deze regressietest scant de
// prompt-dragende bronbestanden op de vakspecifieke persona-tekst, zodat een
// nieuwe hardcoded verwijzing meteen opvalt.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const FORBIDDEN = /epidemiolog|biostatist/i;

// De enige toegestane overblijvers zijn de legacy-default-constanten in
// server/index.js: hun letterlijke tekst is nodig om eerder geseede
// uitleg-prompts in de database automatisch te migreren naar de neutrale
// versie. Die regels bevatten allemaal "OLD_DEFAULT_EXPLAIN_PROMPT".
const LEGACY_LINE = /OLD_DEFAULT_EXPLAIN_PROMPT/;

const TARGETS = [
  'server/index.js',
  'src/services/llm.service.ts',
  'src/services/concept-extraction.service.ts',
];

describe('persona framing is course-agnostic (Task #387)', () => {
  for (const rel of TARGETS) {
    it(`${rel} bevat geen hardcoded epidemiologie/biostatistiek-persona`, () => {
      const text = readFileSync(join(root, rel), 'utf8');
      const offenders = text
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => FORBIDDEN.test(line) && !LEGACY_LINE.test(line));
      expect(offenders.map((o) => o.n)).toEqual([]);
    });
  }
});
