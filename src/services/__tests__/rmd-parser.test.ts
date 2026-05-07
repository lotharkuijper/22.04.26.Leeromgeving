import { describe, it, expect } from 'vitest';
import { parseRmdFile, parseShareStatsItem, parseFolderName } from '../rmd-parser.service';

const mchoiceWithExsolution = `Question
========
Wat is de hoofdstad van Frankrijk?

Answerlist
----------
* Parijs
* Berlijn
* Madrid
* Rome

Solution
========
Parijs is de hoofdstad van Frankrijk.

Meta-information
================
exname: capitals
extype: mchoice
exsolution: 1000
exshuffle: TRUE
`;

const schoiceWithLabelsAnswerlist = `Question
========
Welke is even?

Answerlist
----------
* 1
* 2
* 3

Answerlist
----------
* False
* True
* False

Solution
========
2 is even.

Meta-information
================
extype: schoice
`;

const numQuestion = `Question
========
Hoeveel is 2 + 2?

Solution
========
4

Meta-information
================
extype: num
exsolution: 4
extol: 0.01
`;

const stringQuestion = `Question
========
Wat is de hoofdletter van "amsterdam"?

Solution
========
Amsterdam

Meta-information
================
extype: string
exsolution: Amsterdam
`;

const clozeOpenQuestion = `Question
========
Vul aan: De ___ is rood.

Answerlist
----------
* roos

Solution
========
roos

Meta-information
================
extype: cloze
exclozetype: string
exsolution: roos
`;

const missingSolution = `Question
========
Vraag zonder uitleg?

Answerlist
----------
* a
* b

Meta-information
================
extype: mchoice
exsolution: 10
`;

const crlfFile = [
  'Question',
  '========',
  'Vraag met CRLF?',
  '',
  'Answerlist',
  '----------',
  '* eerste',
  '* tweede',
  '',
  'Solution',
  '========',
  'eerste',
  '',
  'Meta-information',
  '================',
  'extype: schoice',
  'exsolution: 10',
  '',
].join('\r\n');

const metaInfoWithHyphenOnly = `Question
========
Test van Meta-information met koppelteken.

Answerlist
----------
* a
* b

Solution
========
a

Meta-information
================
extype: schoice
exsolution: 10
exname: meta-with-hyphen
`;

describe('parseFolderName', () => {
  it('parseert standaard ShareStats-mapnaam', () => {
    const info = parseFolderName('VU-stat-001-nl');
    expect(info).toEqual({
      institution: 'VU',
      subtopic: 'stat',
      itemNumber: '001',
      language: 'nl',
    });
  });

  it('weigert mapnamen met te weinig segmenten', () => {
    expect(parseFolderName('foo-bar')).toBeNull();
  });
});

describe('parseRmdFile', () => {
  it('herkent Meta-information met koppelteken in de header', () => {
    const result = parseRmdFile(metaInfoWithHyphenOnly);
    expect(result).not.toBeNull();
    expect(result!.metaInformation.extype).toBe('schoice');
    expect(result!.metaInformation.exname).toBe('meta-with-hyphen');
  });

  it('herkent Answerlist met `-` underline', () => {
    const result = parseRmdFile(mchoiceWithExsolution);
    expect(result).not.toBeNull();
    expect(result!.answerOptions).toHaveLength(4);
    expect(result!.answerOptions[0]).toEqual({ text: 'Parijs', correct: true });
  });

  it('past exsolution-binaire-string toe wanneer er geen labels-Answerlist is', () => {
    const result = parseRmdFile(mchoiceWithExsolution);
    expect(result).not.toBeNull();
    const correct = result!.answerOptions.filter((o) => o.correct).map((o) => o.text);
    expect(correct).toEqual(['Parijs']);
  });

  it('gebruikt tweede Answerlist met True/False als labels', () => {
    const result = parseRmdFile(schoiceWithLabelsAnswerlist);
    expect(result).not.toBeNull();
    expect(result!.answerOptions).toHaveLength(3);
    expect(result!.answerOptions.map((o) => o.correct)).toEqual([false, true, false]);
  });

  it('parseert num-vraag (geen answerlist)', () => {
    const result = parseRmdFile(numQuestion);
    expect(result).not.toBeNull();
    expect(result!.answerOptions).toHaveLength(0);
    expect(result!.metaInformation.extype).toBe('num');
    expect(result!.metaInformation.exsolution).toBe('4');
    expect(result!.solution).toBe('4');
  });

  it('parseert string-vraag (geen answerlist)', () => {
    const result = parseRmdFile(stringQuestion);
    expect(result).not.toBeNull();
    expect(result!.answerOptions).toHaveLength(0);
    expect(result!.metaInformation.extype).toBe('string');
    expect(result!.metaInformation.exsolution).toBe('Amsterdam');
  });

  it('parseert cloze/open-vraag', () => {
    const result = parseRmdFile(clozeOpenQuestion);
    expect(result).not.toBeNull();
    expect(result!.metaInformation.extype).toBe('cloze');
    expect(result!.question).toContain('De ___');
  });

  it('staat ontbrekende Solution toe', () => {
    const result = parseRmdFile(missingSolution);
    expect(result).not.toBeNull();
    expect(result!.solution).toBe('');
    expect(result!.answerOptions).toHaveLength(2);
    expect(result!.answerOptions[0].correct).toBe(true);
    expect(result!.answerOptions[1].correct).toBe(false);
  });

  it('verwerkt CRLF-line-endings correct', () => {
    const result = parseRmdFile(crlfFile);
    expect(result).not.toBeNull();
    expect(result!.question).toContain('CRLF');
    expect(result!.answerOptions).toHaveLength(2);
    expect(result!.answerOptions[0]).toEqual({ text: 'eerste', correct: true });
    expect(result!.metaInformation.extype).toBe('schoice');
  });

  it('herstelt zonder hard te falen wanneer labels en opties niet matchen', () => {
    const broken = `Question
========
Kapotte vraag

Answerlist
----------
* a
* b
* c

Answerlist
----------
* True
* False

Meta-information
================
extype: mchoice
`;
    const result = parseRmdFile(broken);
    expect(result).not.toBeNull();
    expect(result!.answerOptions).toHaveLength(0);
  });
});

describe('parseShareStatsItem', () => {
  it('combineert mapnaam-info en Rmd-inhoud', () => {
    const item = parseShareStatsItem('VU-stat-042-nl', mchoiceWithExsolution);
    expect(item).not.toBeNull();
    expect(item!.institution).toBe('VU');
    expect(item!.subtopic).toBe('stat');
    expect(item!.itemNumber).toBe('042');
    expect(item!.language).toBe('nl');
    expect(item!.question.metaInformation.extype).toBe('mchoice');
  });
});
