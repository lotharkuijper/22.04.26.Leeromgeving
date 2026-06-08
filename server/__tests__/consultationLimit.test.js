import { describe, it, expect } from 'vitest';
import {
  normalizeMaxConsultations,
  normalizeAutoCloseHours,
  normalizeExtraGrant,
  computeEffectiveLimit,
  computeRemaining,
  isConsultationBlocked,
  isThreadStale,
  consultationLimitMessage,
  AUTO_CLOSE_MAX_HOURS,
  MAX_CONSULTATIONS_CAP,
} from '../consultationLimit.js';

describe('normalizeMaxConsultations', () => {
  it('lege/null/undefined → null (onbeperkt)', () => {
    expect(normalizeMaxConsultations(null)).toBe(null);
    expect(normalizeMaxConsultations(undefined)).toBe(null);
    expect(normalizeMaxConsultations('')).toBe(null);
  });
  it('negatief/niet-numeriek → null', () => {
    expect(normalizeMaxConsultations(-3)).toBe(null);
    expect(normalizeMaxConsultations('foo')).toBe(null);
  });
  it('0 blijft 0 (geen nieuwe raadplegingen)', () => {
    expect(normalizeMaxConsultations(0)).toBe(0);
    expect(normalizeMaxConsultations('0')).toBe(0);
  });
  it('rondt naar beneden af en capt', () => {
    expect(normalizeMaxConsultations(3.9)).toBe(3);
    expect(normalizeMaxConsultations('5')).toBe(5);
    expect(normalizeMaxConsultations(99999)).toBe(MAX_CONSULTATIONS_CAP);
  });
});

describe('normalizeAutoCloseHours', () => {
  it('lege/null/<=0 → null (uit)', () => {
    expect(normalizeAutoCloseHours(null)).toBe(null);
    expect(normalizeAutoCloseHours('')).toBe(null);
    expect(normalizeAutoCloseHours(0)).toBe(null);
    expect(normalizeAutoCloseHours(-5)).toBe(null);
  });
  it('positief getal blijft', () => {
    expect(normalizeAutoCloseHours(24)).toBe(24);
    expect(normalizeAutoCloseHours('48')).toBe(48);
  });
  it('capt op AUTO_CLOSE_MAX_HOURS', () => {
    expect(normalizeAutoCloseHours(99999999)).toBe(AUTO_CLOSE_MAX_HOURS);
  });
});

describe('normalizeExtraGrant', () => {
  it('lege/negatief/niet-numeriek → 0', () => {
    expect(normalizeExtraGrant(null)).toBe(0);
    expect(normalizeExtraGrant('')).toBe(0);
    expect(normalizeExtraGrant(-2)).toBe(0);
    expect(normalizeExtraGrant('foo')).toBe(0);
  });
  it('positief blijft en capt', () => {
    expect(normalizeExtraGrant(3)).toBe(3);
    expect(normalizeExtraGrant(99999)).toBe(MAX_CONSULTATIONS_CAP);
  });
});

describe('computeEffectiveLimit', () => {
  it('null basis ⇒ onbeperkt ongeacht extra', () => {
    expect(computeEffectiveLimit(null, 5)).toBe(null);
    expect(computeEffectiveLimit(undefined, 0)).toBe(null);
  });
  it('basis + extra', () => {
    expect(computeEffectiveLimit(2, 0)).toBe(2);
    expect(computeEffectiveLimit(2, 3)).toBe(5);
    expect(computeEffectiveLimit(0, 1)).toBe(1);
  });
  it('negatieve extra telt als 0', () => {
    expect(computeEffectiveLimit(2, -4)).toBe(2);
  });
});

describe('computeRemaining', () => {
  it('onbeperkt ⇒ null', () => {
    expect(computeRemaining(10, null)).toBe(null);
  });
  it('rekent resterend, nooit negatief', () => {
    expect(computeRemaining(0, 2)).toBe(2);
    expect(computeRemaining(1, 2)).toBe(1);
    expect(computeRemaining(2, 2)).toBe(0);
    expect(computeRemaining(5, 2)).toBe(0);
  });
});

describe('isConsultationBlocked', () => {
  it('onbeperkt ⇒ nooit geblokkeerd', () => {
    expect(isConsultationBlocked(999, null)).toBe(false);
  });
  it('geblokkeerd zodra used >= limit', () => {
    expect(isConsultationBlocked(0, 2)).toBe(false);
    expect(isConsultationBlocked(1, 2)).toBe(false);
    expect(isConsultationBlocked(2, 2)).toBe(true);
    expect(isConsultationBlocked(3, 2)).toBe(true);
  });
  it('limiet 0 blokkeert direct', () => {
    expect(isConsultationBlocked(0, 0)).toBe(true);
  });
});

describe('isThreadStale', () => {
  const now = Date.parse('2026-06-08T12:00:00Z');
  it('autoCloseHours null ⇒ nooit stale', () => {
    expect(isThreadStale('2020-01-01T00:00:00Z', null, now)).toBe(false);
  });
  it('ontbrekende activiteit ⇒ niet stale', () => {
    expect(isThreadStale(null, 24, now)).toBe(false);
    expect(isThreadStale('niet-een-datum', 24, now)).toBe(false);
  });
  it('binnen venster ⇒ niet stale', () => {
    const oneHourAgo = new Date(now - 1 * 3600 * 1000).toISOString();
    expect(isThreadStale(oneHourAgo, 24, now)).toBe(false);
  });
  it('buiten venster ⇒ stale', () => {
    const twoDaysAgo = new Date(now - 48 * 3600 * 1000).toISOString();
    expect(isThreadStale(twoDaysAgo, 24, now)).toBe(true);
  });
  it('exact op de grens ⇒ stale', () => {
    const exactly = new Date(now - 24 * 3600 * 1000).toISOString();
    expect(isThreadStale(exactly, 24, now)).toBe(true);
  });
});

describe('consultationLimitMessage', () => {
  it('NL bevat het getal', () => {
    expect(consultationLimitMessage('nl', 3)).toContain('3');
    expect(consultationLimitMessage('nl', 3).toLowerCase()).toContain('raadpleging');
  });
  it('EN bevat het getal', () => {
    expect(consultationLimitMessage('en', 2)).toContain('2');
    expect(consultationLimitMessage('en', 2).toLowerCase()).toContain('consultation');
  });
});
