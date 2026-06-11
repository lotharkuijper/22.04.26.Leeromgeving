import { describe, it, expect } from 'vitest';
import { normalizeMix, DEFAULT_MIX } from '../quizSourcesMix.js';

describe('normalizeMix', () => {
  it('laat een mix die al optelt tot 100 ongewijzigd', () => {
    expect(normalizeMix({ pct_rag: 60, pct_itembank: 30, pct_llm: 10 })).toEqual({
      pct_rag: 60,
      pct_itembank: 30,
      pct_llm: 10,
    });
  });

  it('valt terug op DEFAULT_MIX bij som 0', () => {
    expect(normalizeMix({ pct_rag: 0, pct_itembank: 0, pct_llm: 0 })).toEqual(DEFAULT_MIX);
  });

  it('valt terug op DEFAULT_MIX bij ontbrekende invoer', () => {
    expect(normalizeMix(undefined)).toEqual(DEFAULT_MIX);
    expect(normalizeMix({})).toEqual(DEFAULT_MIX);
  });

  it('schaalt een som > 100 naar 100', () => {
    const out = normalizeMix({ pct_rag: 100, pct_itembank: 100, pct_llm: 100 });
    expect(out.pct_rag + out.pct_itembank + out.pct_llm).toBe(100);
    expect(out).toEqual({ pct_rag: 33, pct_itembank: 33, pct_llm: 34 });
  });

  it('schaalt een som < 100 naar 100', () => {
    const out = normalizeMix({ pct_rag: 10, pct_itembank: 10, pct_llm: 10 });
    expect(out.pct_rag + out.pct_itembank + out.pct_llm).toBe(100);
    expect(out).toEqual({ pct_rag: 33, pct_itembank: 33, pct_llm: 34 });
  });

  it('clampt negatieve en te grote waarden', () => {
    const out = normalizeMix({ pct_rag: -50, pct_itembank: 200, pct_llm: 50 });
    // -50 -> 0, 200 -> 100, 50 -> 50; som 150 -> schalen naar 100.
    expect(out.pct_rag + out.pct_itembank + out.pct_llm).toBe(100);
    expect(out).toEqual({ pct_rag: 0, pct_itembank: 67, pct_llm: 33 });
  });

  it('parset string-percentages', () => {
    expect(normalizeMix({ pct_rag: '50', pct_itembank: '30', pct_llm: '20' })).toEqual({
      pct_rag: 50,
      pct_itembank: 30,
      pct_llm: 20,
    });
  });

  it('garandeert altijd een som van exact 100 bij niet-triviale invoer', () => {
    const cases = [
      { pct_rag: 1, pct_itembank: 1, pct_llm: 1 },
      { pct_rag: 7, pct_itembank: 11, pct_llm: 13 },
      { pct_rag: 33, pct_itembank: 33, pct_llm: 33 },
      { pct_rag: 99, pct_itembank: 1, pct_llm: 1 },
    ];
    for (const c of cases) {
      const out = normalizeMix(c);
      expect(out.pct_rag + out.pct_itembank + out.pct_llm).toBe(100);
    }
  });
});
