import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRmdFile, parseShareStatsItem } from '../rmd-parser.service';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sharestats');

interface FixtureExpectation {
  file: string;
  folder: string;
  extype: string;
  exsolution?: string;
  answerOptionCount?: number;
  correctIndices?: number[];
  solutionContains?: string;
  questionContains?: string;
  exclozetype?: string;
}

const cases: FixtureExpectation[] = [
  {
    file: 'eur-assumptions-101-nl.Rmd',
    folder: 'eur-assumptions-101-nl',
    extype: 'num',
    exsolution: '.291',
    answerOptionCount: 0,
    solutionContains: '.291',
    questionContains: 'testing effect',
  },
  {
    file: 'eur-descriptive-101-en.Rmd',
    folder: 'eur-descriptive-101-en',
    extype: 'num',
    exsolution: '7.20',
    answerOptionCount: 0,
    solutionContains: '7.20',
  },
  {
    file: 'eur-distributions-201-en.Rmd',
    folder: 'eur-distributions-201-en',
    extype: 'schoice',
    exsolution: '0100',
    answerOptionCount: 4,
    correctIndices: [1],
  },
  {
    file: 'eur-factor-101-en.Rmd',
    folder: 'eur-factor-101-en',
    extype: 'num',
    exsolution: '.6',
    answerOptionCount: 0,
  },
  {
    file: 'eur-inferential_statistics-101-en.Rmd',
    folder: 'eur-inferential_statistics-101-en',
    extype: 'string',
    exsolution: '""',
    answerOptionCount: 0,
    solutionContains: 'regression',
  },
  {
    file: 'eur-reliability-101-en.Rmd',
    folder: 'eur-reliability-101-en',
    extype: 'num',
    exsolution: '.920',
    answerOptionCount: 0,
  },
  {
    file: 'uu-Continuous-variable-001-en.Rmd',
    folder: 'uu-Continuous-variable-001-en',
    extype: 'schoice',
    exsolution: '0001',
    answerOptionCount: 4,
    correctIndices: [3],
  },
  {
    file: 'uu-Interval-002-en.Rmd',
    folder: 'uu-Interval-002-en',
    extype: 'schoice',
    exsolution: '0010',
    answerOptionCount: 4,
    correctIndices: [2],
  },
  {
    file: 'uu-General-Rules-005-en.Rmd',
    folder: 'uu-General-Rules-005-en',
    extype: 'string',
    exsolution: '2, 4 and 5',
    answerOptionCount: 0,
    solutionContains: 'Student 2',
  },
  {
    file: 'uu-Descriptive-statistics-618-nl.Rmd',
    folder: 'uu-Descriptive-statistics-618-nl',
    extype: 'cloze',
    exsolution: '197|50.90|76.00|64',
    exclozetype: 'num|num|num|num',
    answerOptionCount: 4,
  },
];

describe('parseRmdFile met echte ShareStats-fixtures', () => {
  it('alle fixtures uit fixtures/sharestats/ zijn ingedekt door een testcase', () => {
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.Rmd'))
      .sort();
    const inCases = cases.map((c) => c.file).sort();
    expect(onDisk).toEqual(inCases);
    expect(onDisk.length).toBeGreaterThanOrEqual(5);
    expect(onDisk.length).toBeLessThanOrEqual(15);
  });

  for (const c of cases) {
    it(`parseert ${c.file} (${c.extype})`, () => {
      const content = readFileSync(join(FIXTURE_DIR, c.file), 'utf-8');
      const parsed = parseRmdFile(content);
      expect(parsed, `parseRmdFile gaf null voor ${c.file}`).not.toBeNull();
      const result = parsed!;

      expect(result.metaInformation.extype).toBe(c.extype);
      if (c.exsolution !== undefined) {
        expect(result.metaInformation.exsolution).toBe(c.exsolution);
      }
      if (c.exclozetype !== undefined) {
        expect((result.metaInformation.exclozetype || '').trim()).toBe(c.exclozetype);
      }
      if (c.answerOptionCount !== undefined) {
        expect(result.answerOptions).toHaveLength(c.answerOptionCount);
      }
      if (c.correctIndices !== undefined) {
        const got = result.answerOptions
          .map((o, i) => (o.correct ? i : -1))
          .filter((i) => i >= 0);
        expect(got).toEqual(c.correctIndices);
      }
      if (c.solutionContains !== undefined) {
        expect(result.solution).toContain(c.solutionContains);
      }
      if (c.questionContains !== undefined) {
        expect(result.question).toContain(c.questionContains);
      }
    });

    it(`parseShareStatsItem combineert mapnaam en inhoud voor ${c.file}`, () => {
      const content = readFileSync(join(FIXTURE_DIR, c.file), 'utf-8');
      const item = parseShareStatsItem(c.folder, content);
      expect(item, `parseShareStatsItem gaf null voor ${c.folder}`).not.toBeNull();
      expect(item!.question.metaInformation.extype).toBe(c.extype);
    });
  }
});
