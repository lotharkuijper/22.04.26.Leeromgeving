import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseItembankCsv,
  normalizeCorrectLetter,
  csvRowToQuizQuestion,
} from '../itembankCsv.js';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with commas and newlines', () => {
    const csv = 'q,a\n"Hello, world","line1\nline2"';
    expect(parseCsv(csv)).toEqual([['q', 'a'], ['Hello, world', 'line1\nline2']]);
  });

  it('handles escaped double quotes', () => {
    expect(parseCsv('q\n"He said ""hi"""')).toEqual([['q'], ['He said "hi"']]);
  });

  it('drops fully empty rows', () => {
    expect(parseCsv('a\n\n1\n')).toEqual([['a'], ['1']]);
  });
});

describe('normalizeCorrectLetter', () => {
  const opts = { A: 'Nominaal', B: 'Ordinaal', C: 'Interval' };
  it('accepts a letter', () => expect(normalizeCorrectLetter('B', opts)).toBe('B'));
  it('accepts lowercase', () => expect(normalizeCorrectLetter('c', opts)).toBe('C'));
  it('accepts 1-based index', () => expect(normalizeCorrectLetter('1', opts)).toBe('A'));
  it('accepts literal option text', () => expect(normalizeCorrectLetter('interval', opts)).toBe('C'));
  it('returns null for unknown', () => expect(normalizeCorrectLetter('Z', opts)).toBeNull());
  it('returns null for empty', () => expect(normalizeCorrectLetter('', opts)).toBeNull());
});

describe('parseItembankCsv', () => {
  it('parses an mcq row with letter answer', () => {
    const csv = 'question,A,B,C,D,correct,topic\nWat is 2+2?,3,4,5,6,B,Rekenen';
    const { records, errors } = parseItembankCsv(csv);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'mcq',
      question: 'Wat is 2+2?',
      options: { A: '3', B: '4', C: '5', D: '6' },
      correct: 'B',
      topic: 'Rekenen',
    });
  });

  it('infers mcq when options present without type', () => {
    const csv = 'vraag,a,b,antwoord\nKies,X,Y,Y';
    const { records } = parseItembankCsv(csv);
    expect(records[0].type).toBe('mcq');
    expect(records[0].correct).toBe('B');
  });

  it('parses an open question', () => {
    const csv = 'question,type,correct,topic\nLeg uit X,open,Het antwoord,Theorie';
    const { records, errors } = parseItembankCsv(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({ type: 'open', correct: 'Het antwoord', options: {} });
  });

  it('reports missing question column', () => {
    const { errors } = parseItembankCsv('foo,bar\n1,2');
    expect(errors[0].reason).toBe('missing_question_column');
  });

  it('reports mcq missing correct answer', () => {
    const csv = 'question,A,B,correct\nVraag,X,Y,';
    const { records, errors } = parseItembankCsv(csv);
    expect(records).toHaveLength(0);
    expect(errors[0].reason).toBe('mcq_missing_correct');
  });

  it('reports mcq with fewer than two options', () => {
    const csv = 'question,type,A,correct\nVraag,mcq,X,A';
    const { errors } = parseItembankCsv(csv);
    expect(errors[0].reason).toBe('mcq_needs_two_options');
  });

  it('reports open question missing answer', () => {
    const csv = 'question,type,correct\nVraag,open,';
    const { errors } = parseItembankCsv(csv);
    expect(errors[0].reason).toBe('open_missing_answer');
  });

  it('skips blank questions but keeps valid ones', () => {
    const csv = 'question,type,correct\n,open,x\nEchte vraag,open,y';
    const { records, errors } = parseItembankCsv(csv);
    expect(records).toHaveLength(1);
    expect(records[0].question).toBe('Echte vraag');
    expect(errors.some(e => e.reason === 'missing_question')).toBe(true);
  });
});

describe('csvRowToQuizQuestion', () => {
  it('namespaces exsection_path with the course label', () => {
    const rec = { type: 'mcq', question: 'Q', options: { A: 'x', B: 'y' }, correct: 'A', explanation: '', topic: 'Stats', subtopic: 'Mean' };
    const row = csvRowToQuizQuestion(rec, { courseLabel: 'BK101', courseId: 'c-1', createdBy: 'u-1' });
    expect(row.exsection_path).toEqual(['BK101', 'Stats', 'Mean']);
    expect(row.source).toBe('csv_import');
    expect(row.item_type).toBe('mcq');
    expect(row.answer_options).toEqual({ A: 'x', B: 'y' });
    expect(row.correct_answer).toBe('A');
    expect(row.metadata).toMatchObject({ course_id: 'c-1', imported_via: 'csv' });
  });

  it('falls back to Algemeen when no topic/course', () => {
    const rec = { type: 'open', question: 'Q', options: {}, correct: 'a', explanation: '', topic: '', subtopic: '' };
    const row = csvRowToQuizQuestion(rec, {});
    expect(row.exsection_path).toEqual(['Algemeen']);
    expect(row.answer_options).toEqual({});
  });

  it('prefers an explicit exsection column with / sublevels over topic/subtopic', () => {
    const rec = { type: 'mcq', question: 'Q', options: { A: 'x', B: 'y' }, correct: 'A', explanation: '', topic: 'Ignored', subtopic: 'AlsoIgnored', exsection: 'Inferentie / Toetsen / t-toets' };
    const row = csvRowToQuizQuestion(rec, { courseLabel: 'BK101', courseId: 'c-1' });
    expect(row.exsection_path).toEqual(['BK101', 'Inferentie', 'Toetsen', 't-toets']);
  });

  it('trims and drops empty exsection segments', () => {
    const rec = { type: 'open', question: 'Q', options: {}, correct: 'a', explanation: '', topic: '', subtopic: '', exsection: ' A // B / ' };
    const row = csvRowToQuizQuestion(rec, { courseLabel: 'BK101' });
    expect(row.exsection_path).toEqual(['BK101', 'A', 'B']);
  });

  it('tags every row with its course_id so banks stay course-isolated', () => {
    const rec = { type: 'open', question: 'Q', options: {}, correct: 'a', explanation: '', topic: 'T', subtopic: '' };
    const row = csvRowToQuizQuestion(rec, { courseId: 'course-xyz' });
    expect(row.metadata.course_id).toBe('course-xyz');
  });
});

describe('parseItembankCsv exsection column', () => {
  it('maps the exsection header into the record', () => {
    const csv = 'question,a,b,correct,exsection\nWat is X?,één,twee,A,Hoofdstuk 1 / Sectie 2';
    const { records, errors } = parseItembankCsv(csv);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].exsection).toBe('Hoofdstuk 1 / Sectie 2');
  });
});
