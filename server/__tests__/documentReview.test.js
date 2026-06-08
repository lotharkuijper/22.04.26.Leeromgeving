import { describe, it, expect } from 'vitest';
import {
  validateReviewResponse,
  canRequestDocumentReview,
  badgeForGrade,
  normalizeBadgeAwardMode,
  VERDICTS,
  BADGE_TIERS,
} from '../documentReview.js';

describe('validateReviewResponse', () => {
  it('accepteert geldig object met alle velden', () => {
    const r = validateReviewResponse({ verdict: 'accepted', grade: 8.5, reasoning: 'Goed onderbouwd.', feed_forward: 'Werk aan de discussie.', relationship_delta: 2 });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ verdict: 'accepted', grade: 8.5, reasoning: 'Goed onderbouwd.', feed_forward: 'Werk aan de discussie.', relationship_delta: 2 });
  });

  it('accepteert JSON-string input', () => {
    const r = validateReviewResponse('{"verdict":"rejected","grade":4,"reasoning":"Onvoldoende"}');
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('rejected');
    expect(r.value.grade).toBe(4);
    expect(r.value.feed_forward).toBe('');
    expect(r.value.relationship_delta).toBe(0);
  });

  it('weigert ongeldige JSON-string', () => {
    const r = validateReviewResponse('{niet json}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Ongeldige JSON/);
  });

  it('normaliseert case en whitespace in verdict', () => {
    const r = validateReviewResponse({ verdict: '  CONDITIONAL ', grade: 6, reasoning: 'ok' });
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('conditional');
  });

  it('weigert onbekende verdict', () => {
    const r = validateReviewResponse({ verdict: 'maybe', grade: 6, reasoning: 'ok' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verdict/);
  });

  it('weigert lege reasoning', () => {
    const r = validateReviewResponse({ verdict: 'accepted', grade: 6, reasoning: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reasoning/i);
  });

  it('weigert ontbrekend/niet-numeriek cijfer', () => {
    expect(validateReviewResponse({ verdict: 'accepted', reasoning: 'ok' }).ok).toBe(false);
    const r = validateReviewResponse({ verdict: 'accepted', grade: 'acht', reasoning: 'ok' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/grade/i);
  });

  it('clamp cijfer naar 0..10', () => {
    expect(validateReviewResponse({ verdict: 'accepted', grade: 99, reasoning: 'ok' }).value.grade).toBe(10);
    expect(validateReviewResponse({ verdict: 'rejected', grade: -3, reasoning: 'ok' }).value.grade).toBe(0);
  });

  it('rondt cijfer af op één decimaal', () => {
    expect(validateReviewResponse({ verdict: 'conditional', grade: 7.349, reasoning: 'ok' }).value.grade).toBe(7.3);
  });

  it('clamp relationship_delta naar +5', () => {
    const r = validateReviewResponse({ verdict: 'accepted', grade: 9, reasoning: 'ok', relationship_delta: 99 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(5);
  });

  it('clamp relationship_delta naar -5', () => {
    const r = validateReviewResponse({ verdict: 'rejected', grade: 3, reasoning: 'ok', relationship_delta: -42 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(-5);
  });

  it('rondt niet-gehele delta af', () => {
    const r = validateReviewResponse({ verdict: 'conditional', grade: 6, reasoning: 'ok', relationship_delta: 1.7 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(2);
  });

  it('zet niet-numerieke delta op 0', () => {
    const r = validateReviewResponse({ verdict: 'accepted', grade: 7, reasoning: 'ok', relationship_delta: 'veel' });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(0);
  });

  it('weigert non-object input', () => {
    expect(validateReviewResponse(null).ok).toBe(false);
    expect(validateReviewResponse(42).ok).toBe(false);
    expect(validateReviewResponse([1, 2]).ok).toBe(false);
  });

  it('exporteert de drie toegestane verdicts', () => {
    expect(VERDICTS).toEqual(['accepted', 'conditional', 'rejected']);
  });
});

describe('badgeForGrade', () => {
  it('kent platina toe vanaf 9,0', () => {
    expect(badgeForGrade(9)).toBe('platina');
    expect(badgeForGrade(10)).toBe('platina');
  });
  it('kent goud toe vanaf 8,0 tot onder 9,0', () => {
    expect(badgeForGrade(8)).toBe('goud');
    expect(badgeForGrade(8.9)).toBe('goud');
  });
  it('kent zilver toe vanaf 7,0 tot onder 8,0', () => {
    expect(badgeForGrade(7)).toBe('zilver');
    expect(badgeForGrade(7.9)).toBe('zilver');
  });
  it('kent brons toe vanaf 6,0 tot onder 7,0', () => {
    expect(badgeForGrade(6)).toBe('brons');
    expect(badgeForGrade(6.9)).toBe('brons');
  });
  it('geeft geen badge onder 6,0', () => {
    expect(badgeForGrade(5.9)).toBe(null);
    expect(badgeForGrade(0)).toBe(null);
  });
  it('geeft null bij niet-numerieke input', () => {
    expect(badgeForGrade('acht')).toBe(null);
    expect(badgeForGrade(null)).toBe(null);
    expect(badgeForGrade(undefined)).toBe(null);
  });
  it('exporteert vier badge-drempels', () => {
    expect(BADGE_TIERS.map(t => t.badge)).toEqual(['platina', 'goud', 'zilver', 'brons']);
  });
});

describe('normalizeBadgeAwardMode', () => {
  it('houdt group als group', () => {
    expect(normalizeBadgeAwardMode('group')).toBe('group');
  });
  it('valt terug op individual', () => {
    expect(normalizeBadgeAwardMode('individual')).toBe('individual');
    expect(normalizeBadgeAwardMode('onzin')).toBe('individual');
    expect(normalizeBadgeAwardMode(null)).toBe('individual');
    expect(normalizeBadgeAwardMode(undefined)).toBe('individual');
  });
});

describe('canRequestDocumentReview', () => {
  it('staat staff toe ook zonder groepslidmaatschap', () => {
    expect(canRequestDocumentReview({ isStaff: true, isGroupMember: false })).toEqual({ allowed: true });
  });
  it('staat groepslid toe', () => {
    expect(canRequestDocumentReview({ isStaff: false, isGroupMember: true })).toEqual({ allowed: true });
  });
  it('weigert buiten-staander met 403', () => {
    const r = canRequestDocumentReview({ isStaff: false, isGroupMember: false });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/lid|staff/i);
  });
});
