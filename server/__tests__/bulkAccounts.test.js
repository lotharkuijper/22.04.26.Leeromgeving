import { describe, it, expect } from 'vitest';
import {
  validateEmail,
  extractEmails,
  dedupeEmails,
  normalizeEmailList,
  authorizeBulkProvision,
  validateBatchSize,
  buildActivationRedirect,
  MAX_BULK_BATCH,
} from '../bulkAccounts.js';

describe('validateEmail', () => {
  it('accepteert normale adressen', () => {
    expect(validateEmail('a@b.com')).toBe(true);
    expect(validateEmail('voornaam.achternaam@student.vu.nl')).toBe(true);
    expect(validateEmail('  spaties@trim.nl  ')).toBe(true);
  });
  it('weigert ongeldige tokens', () => {
    for (const v of ['', 'geen-email', 'a@b', 'a@@b.com', 'a b@c.com', '@nodomain.com', 'noat.com', null, undefined, 42]) {
      expect(validateEmail(v)).toBe(false);
    }
  });
  it('weigert extreem lange adressen', () => {
    expect(validateEmail('a'.repeat(250) + '@b.com')).toBe(false);
  });
});

describe('extractEmails', () => {
  it('vist adressen uit vrije tekst met diverse scheidingstekens', () => {
    const text = 'Jan <jan@vu.nl>, piet@vu.nl; klaas@vu.nl\nmarie@vu.nl\tjoop@vu.nl';
    expect(extractEmails(text)).toEqual(['jan@vu.nl', 'piet@vu.nl', 'klaas@vu.nl', 'marie@vu.nl', 'joop@vu.nl']);
  });
  it('vist adressen uit CSV-achtige inhoud', () => {
    const csv = 'naam,email\nJan,jan@vu.nl\nPiet,piet@vu.nl';
    expect(extractEmails(csv)).toEqual(['jan@vu.nl', 'piet@vu.nl']);
  });
  it('geeft lege array bij geen tekst of geen adressen', () => {
    expect(extractEmails('')).toEqual([]);
    expect(extractEmails('helemaal geen adressen hier')).toEqual([]);
    expect(extractEmails(null)).toEqual([]);
  });
});

describe('dedupeEmails', () => {
  it('ontdubbelt case-insensitief en normaliseert naar lowercase', () => {
    expect(dedupeEmails(['A@B.com', 'a@b.com', ' A@B.COM ', 'c@d.nl'])).toEqual(['a@b.com', 'c@d.nl']);
  });
  it('behoudt de eerste-voorkomen-volgorde', () => {
    expect(dedupeEmails(['z@x.nl', 'a@x.nl', 'z@x.nl'])).toEqual(['z@x.nl', 'a@x.nl']);
  });
});

describe('normalizeEmailList', () => {
  it('scheidt geldig/ongeldig en telt duplicaten', () => {
    const r = normalizeEmailList(['Jan@vu.nl', 'jan@vu.nl', 'kapot', 'piet@vu.nl', 'kapot']);
    expect(r.valid).toEqual(['jan@vu.nl', 'piet@vu.nl']);
    expect(r.invalid).toEqual(['kapot']);
    expect(r.duplicates).toBe(1);
  });
  it('gaat netjes om met lege/rommelige invoer', () => {
    const r = normalizeEmailList(['', '   ', null, 42, undefined]);
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.duplicates).toBe(0);
  });
});

describe('authorizeBulkProvision', () => {
  it('staat admin altijd toe', () => {
    expect(authorizeBulkProvision({ isAdmin: true, isCourseTeacher: false })).toEqual({ allowed: true });
  });
  it('staat docent van déze cursus toe', () => {
    expect(authorizeBulkProvision({ isAdmin: false, isCourseTeacher: true })).toEqual({ allowed: true });
  });
  it('weigert overige met 403', () => {
    const r = authorizeBulkProvision({ isAdmin: false, isCourseTeacher: false });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin of docent/i);
  });
});

describe('validateBatchSize', () => {
  it('weigert lege of niet-array invoer met 400', () => {
    expect(validateBatchSize([]).ok).toBe(false);
    expect(validateBatchSize(null).ok).toBe(false);
    expect(validateBatchSize('x').ok).toBe(false);
  });
  it('accepteert een batch tot en met het maximum', () => {
    expect(validateBatchSize(Array.from({ length: MAX_BULK_BATCH }, (_, i) => `u${i}@vu.nl`)).ok).toBe(true);
  });
  it('weigert te grote batches met 400', () => {
    const r = validateBatchSize(Array.from({ length: MAX_BULK_BATCH + 1 }, (_, i) => `u${i}@vu.nl`));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('buildActivationRedirect', () => {
  it('geeft de voorkeur aan een geldige body-basis', () => {
    expect(buildActivationRedirect({ bodyBase: 'https://app.example.com', originHeader: 'https://x.nl' }))
      .toBe('https://app.example.com/activate');
  });
  it('strip-t trailing slashes', () => {
    expect(buildActivationRedirect({ bodyBase: 'https://app.example.com///' })).toBe('https://app.example.com/activate');
  });
  it('valt terug op origin-header en daarna env', () => {
    expect(buildActivationRedirect({ originHeader: 'http://localhost:5173' })).toBe('http://localhost:5173/activate');
    expect(buildActivationRedirect({ envBase: 'https://prod.nl' })).toBe('https://prod.nl/activate');
  });
  it('negeert niet-http(s)-bases en geeft undefined als niets geldig is', () => {
    expect(buildActivationRedirect({ bodyBase: 'javascript:alert(1)', originHeader: 'ftp://x' })).toBeUndefined();
    expect(buildActivationRedirect({})).toBeUndefined();
  });
});
