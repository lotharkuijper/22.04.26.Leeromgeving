import { describe, it, expect } from 'vitest';
import {
  clampScore, applyDelta, scoreToBucket, scoreToLabel,
  appendHistory, hasHistoryRef, isBlocked, blockedMessage,
  buildRelationshipPromptBlock, BLOCK_THRESHOLD,
} from '../personaRelationship.js';

describe('clampScore / applyDelta', () => {
  it('clampt boven +10', () => expect(clampScore(42)).toBe(10));
  it('clampt onder -10', () => expect(clampScore(-99)).toBe(-10));
  it('rondt af', () => expect(clampScore(3.7)).toBe(4));
  it('valt terug op 0 bij non-numeric', () => expect(clampScore('foo')).toBe(0));
  it('past delta toe en clampt', () => {
    expect(applyDelta(0, 3)).toBe(3);
    expect(applyDelta(8, 5)).toBe(10);
    expect(applyDelta(-9, -5)).toBe(-10);
    expect(applyDelta(2, -7)).toBe(-5);
  });
  it('negeert non-numerieke delta', () => expect(applyDelta(4, 'nope')).toBe(4));
});

describe('scoreToBucket / scoreToLabel', () => {
  it('mapt de 5 buckets correct', () => {
    expect(scoreToBucket(-10)).toBe('cold');
    expect(scoreToBucket(-6)).toBe('cold');
    expect(scoreToBucket(-5)).toBe('strained');
    expect(scoreToBucket(-2)).toBe('strained');
    expect(scoreToBucket(-1)).toBe('neutral');
    expect(scoreToBucket(0)).toBe('neutral');
    expect(scoreToBucket(1)).toBe('neutral');
    expect(scoreToBucket(2)).toBe('positive');
    expect(scoreToBucket(5)).toBe('positive');
    expect(scoreToBucket(6)).toBe('warm');
    expect(scoreToBucket(10)).toBe('warm');
  });
  it('label NL', () => {
    expect(scoreToLabel(-7, 'nl')).toBe('koud');
    expect(scoreToLabel(0, 'nl')).toBe('neutraal');
    expect(scoreToLabel(8, 'nl')).toBe('warm');
  });
  it('label EN', () => {
    expect(scoreToLabel(-7, 'en')).toBe('cold');
    expect(scoreToLabel(3, 'en')).toBe('positive');
  });
  it('valt terug op NL bij onbekende lang', () => {
    expect(scoreToLabel(0, 'xx')).toBe('neutraal');
  });
});

describe('appendHistory', () => {
  it('voegt event toe met automatische ts', () => {
    const out = appendHistory([], { source: 'document_review', delta: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('document_review');
    expect(out[0].delta).toBe(2);
    expect(typeof out[0].ts).toBe('string');
  });
  it('rouleert bij maxItems', () => {
    let h = [];
    for (let i = 0; i < 25; i++) h = appendHistory(h, { source: 's', delta: i }, 20);
    expect(h).toHaveLength(20);
    expect(h[0].delta).toBe(5);
    expect(h[19].delta).toBe(24);
  });
  it('werkt met niet-array input', () => {
    expect(appendHistory(null, { source: 'x', delta: 1 })).toHaveLength(1);
  });
});

describe('hasHistoryRef', () => {
  it('vindt bestaande ref', () => {
    const h = [{ source: 'document_review', refId: 'abc', delta: 1 }];
    expect(hasHistoryRef(h, 'document_review', 'abc')).toBe(true);
  });
  it('weigert mismatch', () => {
    const h = [{ source: 'document_review', refId: 'abc' }];
    expect(hasHistoryRef(h, 'document_review', 'xyz')).toBe(false);
    expect(hasHistoryRef(h, 'staff_adjust', 'abc')).toBe(false);
  });
  it('beschermt tegen leeg/null', () => {
    expect(hasHistoryRef(null, 's', 'r')).toBe(false);
    expect(hasHistoryRef([], 's', 'r')).toBe(false);
    expect(hasHistoryRef([{source:'s',refId:'r'}], '', 'r')).toBe(false);
  });
});

describe('isBlocked / blockedMessage', () => {
  it('blokkeert ≤ -8', () => {
    expect(isBlocked(-8)).toBe(true);
    expect(isBlocked(-10)).toBe(true);
    expect(isBlocked(-7)).toBe(false);
    expect(isBlocked(0)).toBe(false);
    expect(BLOCK_THRESHOLD).toBe(-8);
  });
  it('geeft NL/EN melding', () => {
    expect(blockedMessage('nl')).toMatch(/herstel/i);
    expect(blockedMessage('en')).toMatch(/repair/i);
  });
});

describe('buildRelationshipPromptBlock', () => {
  it('bevat label en score (NL)', () => {
    const txt = buildRelationshipPromptBlock(3, [], 'nl');
    expect(txt).toMatch(/welwillend/);
    expect(txt).toMatch(/\+3/);
    expect(txt).toMatch(/verstandhouding/);
  });
  it('bevat negatieve score zonder + (NL)', () => {
    const txt = buildRelationshipPromptBlock(-4, [], 'nl');
    expect(txt).toMatch(/gespannen/);
    expect(txt).toMatch(/-4/);
  });
  it('toont max N recente events nieuwste eerst', () => {
    const h = [
      { ts: 't1', source: 'document_review', delta: -2, note: 'rejected' },
      { ts: 't2', source: 'document_review', delta:  1, note: 'conditional' },
      { ts: 't3', source: 'staff_adjust',    delta:  2, note: 'reset' },
      { ts: 't4', source: 'document_review', delta: -1, note: 'rejected' },
    ];
    const txt = buildRelationshipPromptBlock(0, h, 'nl', 3);
    // Laatste 3 events (t2,t3,t4) in reverse: t4 (rejected) → t3 (staff_adjust) → t2 (conditional).
    const idxRejected = txt.indexOf('rejected');
    const idxStaff = txt.indexOf('staff_adjust');
    const idxConditional = txt.indexOf('conditional');
    expect(idxRejected).toBeGreaterThan(-1);
    expect(idxStaff).toBeGreaterThan(idxRejected);
    expect(idxConditional).toBeGreaterThan(idxStaff);
    // Slechts één 'rejected' (t1 valt buiten window).
    expect(txt.match(/rejected/g)).toHaveLength(1);
  });
  it('werkt in EN', () => {
    const txt = buildRelationshipPromptBlock(7, [{source:'staff_adjust', delta: 4}], 'en');
    expect(txt).toMatch(/warm/);
    expect(txt).toMatch(/Recent causes/);
  });
});
