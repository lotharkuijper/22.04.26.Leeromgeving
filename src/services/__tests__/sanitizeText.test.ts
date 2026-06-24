import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeMetadata } from '../../lib/sanitizeText';

describe('sanitizeText', () => {
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

  it('verwijdert opeenvolgende losse surrogaten (lookbehind-vrij)', () => {
    expect(sanitizeText('a\uD800\uD800b')).toBe('ab');
    expect(sanitizeText('a\uDC00\uDC00b')).toBe('ab');
  });

  it('behoudt een geldig paar naast een losse surrogate', () => {
    const emoji = '\uD83D\uDE00';
    expect(sanitizeText(`\uD800${emoji}`)).toBe(emoji);
    expect(sanitizeText(`${emoji}\uDC00`)).toBe(emoji);
  });

  it('verwijdert losse surrogaten aan het begin en einde', () => {
    expect(sanitizeText('\uDC00abc\uD800')).toBe('abc');
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

describe('sanitizeMetadata', () => {
  it('saneert string-waarden in een geneste structuur', () => {
    const input = {
      sectionTitle: 'Hoofd\u0000stuk',
      nested: { note: 'a\uD800b' },
      list: ['ok', 'x\u0000y'],
      pageNumber: 3,
      flag: true,
    };
    expect(sanitizeMetadata(input)).toEqual({
      sectionTitle: 'Hoofdstuk',
      nested: { note: 'ab' },
      list: ['ok', 'xy'],
      pageNumber: 3,
      flag: true,
    });
  });

  it('laat niet-string primitieven ongemoeid', () => {
    expect(sanitizeMetadata(5)).toBe(5);
    expect(sanitizeMetadata(null)).toBe(null);
  });
});
