import { describe, it, expect } from 'vitest';
import {
  LANGUAGES,
  LANGUAGE_CODES,
  findLanguage,
  normalizeTargetLang,
  normalizePageKey,
  normalizeSourceText,
  hashSource,
  buildTranslationPrompt,
  MAX_SOURCE_CHARS,
} from '../documentTranslation.js';

describe('documentTranslation helpers', () => {
  describe('language allowlist', () => {
    it('exposes codes and includes Cantonese (the driving use-case)', () => {
      expect(LANGUAGE_CODES).toContain('yue');
      expect(LANGUAGE_CODES).toContain('nl');
      expect(LANGUAGE_CODES).toContain('en');
      expect(LANGUAGES.every((l) => l.code && l.native && l.promptName)).toBe(true);
    });

    it('findLanguage is case-insensitive and trims', () => {
      expect(findLanguage(' YUE ')?.code).toBe('yue');
      expect(findLanguage('EN')?.promptName).toBe('English');
      expect(findLanguage('klingon')).toBeNull();
      expect(findLanguage('')).toBeNull();
      expect(findLanguage(null)).toBeNull();
    });

    it('normalizeTargetLang returns the code or null', () => {
      expect(normalizeTargetLang('yue')).toBe('yue');
      expect(normalizeTargetLang('  Nl ')).toBe('nl');
      expect(normalizeTargetLang('xx')).toBeNull();
      expect(normalizeTargetLang(undefined)).toBeNull();
    });
  });

  describe('normalizePageKey', () => {
    it('accepts the safe patterns only', () => {
      expect(normalizePageKey('full')).toBe('full');
      expect(normalizePageKey('p:1')).toBe('p:1');
      expect(normalizePageKey('p:42')).toBe('p:42');
      expect(normalizePageKey('text:3')).toBe('text:3');
      expect(normalizePageKey(' p:7 ')).toBe('p:7');
    });
    it('rejects anything else', () => {
      expect(normalizePageKey('p:')).toBeNull();
      expect(normalizePageKey('p:abc')).toBeNull();
      expect(normalizePageKey('slide:1')).toBeNull();
      expect(normalizePageKey('p:1; drop table')).toBeNull();
      expect(normalizePageKey('p:123456')).toBeNull();
      expect(normalizePageKey(42)).toBeNull();
      expect(normalizePageKey('')).toBeNull();
    });
  });

  describe('normalizeSourceText + hashSource', () => {
    it('normalizes whitespace deterministically', () => {
      // CRLF→LF, 3+ lege regels → één lege regel, en de hele string getrimd.
      // Trailing spaces binnen een regel blijven (geen per-regel trim).
      expect(normalizeSourceText('  hello\r\nworld \n\n\n\nx ')).toBe('hello\nworld \n\nx');
      expect(normalizeSourceText(null)).toBe('');
    });

    it('hash is stable and whitespace-insensitive but content-sensitive', () => {
      const a = hashSource('Hello\r\nworld');
      const b = hashSource('Hello\nworld');
      const c = hashSource('Hello\n\n\n\nworld'); // collapses to \n\n => different from single \n
      const d = hashSource('Hello world!');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).not.toBe(d);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildTranslationPrompt', () => {
    it('embeds the resolved target promptName', () => {
      const p = buildTranslationPrompt('yue', 'pptx');
      expect(p).toContain('Cantonese');
      expect(p).toContain('lecture slide');
      expect(p).toContain('Output ONLY the translation');
    });
    it('uses document page wording for non-slide sources', () => {
      const p = buildTranslationPrompt('en', 'docx');
      expect(p).toContain('document page');
    });
    it('falls back gracefully for an unknown code', () => {
      const p = buildTranslationPrompt('xx', 'pdf');
      expect(p).toContain('the requested language');
    });
  });

  it('MAX_SOURCE_CHARS is a sane positive cap', () => {
    expect(MAX_SOURCE_CHARS).toBeGreaterThan(1000);
    expect(MAX_SOURCE_CHARS).toBeLessThanOrEqual(50000);
  });
});
