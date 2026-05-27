import { describe, it, expect } from 'vitest';
import { validateReviewResponse, canRequestDocumentReview, VERDICTS } from '../documentReview.js';

describe('validateReviewResponse', () => {
  it('accepteert geldig object met alle velden', () => {
    const r = validateReviewResponse({ verdict: 'accepted', reasoning: 'Goed onderbouwd.', relationship_delta: 2 });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ verdict: 'accepted', reasoning: 'Goed onderbouwd.', relationship_delta: 2 });
  });

  it('accepteert JSON-string input', () => {
    const r = validateReviewResponse('{"verdict":"rejected","reasoning":"Onvoldoende"}');
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('rejected');
    expect(r.value.relationship_delta).toBe(0);
  });

  it('weigert ongeldige JSON-string', () => {
    const r = validateReviewResponse('{niet json}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Ongeldige JSON/);
  });

  it('normaliseert case en whitespace in verdict', () => {
    const r = validateReviewResponse({ verdict: '  CONDITIONAL ', reasoning: 'ok' });
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('conditional');
  });

  it('weigert onbekende verdict', () => {
    const r = validateReviewResponse({ verdict: 'maybe', reasoning: 'ok' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verdict/);
  });

  it('weigert lege reasoning', () => {
    const r = validateReviewResponse({ verdict: 'accepted', reasoning: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reasoning/i);
  });

  it('clamp relationship_delta naar +5', () => {
    const r = validateReviewResponse({ verdict: 'accepted', reasoning: 'ok', relationship_delta: 99 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(5);
  });

  it('clamp relationship_delta naar -5', () => {
    const r = validateReviewResponse({ verdict: 'rejected', reasoning: 'ok', relationship_delta: -42 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(-5);
  });

  it('rondt niet-gehele delta af', () => {
    const r = validateReviewResponse({ verdict: 'conditional', reasoning: 'ok', relationship_delta: 1.7 });
    expect(r.ok).toBe(true);
    expect(r.value.relationship_delta).toBe(2);
  });

  it('zet niet-numerieke delta op 0', () => {
    const r = validateReviewResponse({ verdict: 'accepted', reasoning: 'ok', relationship_delta: 'veel' });
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
