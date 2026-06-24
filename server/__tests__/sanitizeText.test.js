import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeMetadata } from '../sanitizeText.js';

describe('sanitizeText (server)', () => {
  it('verwijdert een NUL-teken midden in de tekst', () => {
    expect(sanitizeText('hoofd\u0000stuk')).toBe('hoofdstuk');
  });

  it('verwijdert een ongepaarde high surrogate', () => {
    expect(sanitizeText('a\uD800b')).toBe('ab');
  });

  it('verwijdert een ongepaarde low surrogate', () => {
    expect(sanitizeText('a\uDC00b')).toBe('ab');
  });

  it('behoudt een geldig surrogaatpaar (emoji)', () => {
    const emoji = '\uD83D\uDE00';
    expect(sanitizeText(`x${emoji}y`)).toBe(`x${emoji}y`);
  });

  it('behoudt gewone witruimte (tab, newline, carriage return)', () => {
    expect(sanitizeText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('verwijdert overige niet-witruimte control-chars', () => {
    expect(sanitizeText('a\u0007b\u001Fc\u007Fd')).toBe('abcd');
  });

  it('laat normale tekst ongewijzigd', () => {
    const text = 'Dit is een gewone Nederlandse zin met accenten: café, naïef.';
    expect(sanitizeText(text)).toBe(text);
  });

  it('geeft een lege string terug voor niet-string input', () => {
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(42)).toBe('');
  });
});

describe('sanitizeMetadata (server)', () => {
  it('saneert string-waarden in een geneste structuur', () => {
    const input = {
      sectionTitle: 'Hoofd\u0000stuk',
      source: 'pptx',
      pageNumber: 3,
    };
    expect(sanitizeMetadata(input)).toEqual({
      sectionTitle: 'Hoofdstuk',
      source: 'pptx',
      pageNumber: 3,
    });
  });
});
