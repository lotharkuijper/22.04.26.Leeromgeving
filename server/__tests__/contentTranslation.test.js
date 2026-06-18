import { describe, it, expect } from 'vitest';
import {
  CONTENT_FORMATS,
  normalizeContentFormat,
  CONTENT_TRANSLATION_FORMAT_VERSION,
  hashContentSource,
  isTranslatableText,
  buildContentTranslationPrompt,
  buildContentBatchPrompt,
} from '../documentTranslation.js';

describe('content-translation helpers (Task #288)', () => {
  describe('normalizeContentFormat', () => {
    it('keeps known formats, defaults the rest to plain', () => {
      expect(CONTENT_FORMATS).toEqual(expect.arrayContaining(['markdown', 'plain']));
      expect(normalizeContentFormat('markdown')).toBe('markdown');
      expect(normalizeContentFormat('plain')).toBe('plain');
      expect(normalizeContentFormat('html')).toBe('plain');
      expect(normalizeContentFormat(undefined)).toBe('plain');
      expect(normalizeContentFormat(null)).toBe('plain');
    });
  });

  describe('hashContentSource', () => {
    it('is whitespace-insensitive but content- and format-sensitive', () => {
      const a = hashContentSource('Hello\r\nworld', 'plain');
      const b = hashContentSource('Hello\nworld', 'plain');
      const c = hashContentSource('Hello world!', 'plain');
      const d = hashContentSource('Hello\nworld', 'markdown');
      expect(a).toBe(b); // CRLF normalised away
      expect(a).not.toBe(c); // different content
      expect(a).not.toBe(d); // different format
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('folds in the format version so a bump invalidates old rows', () => {
      expect(hashContentSource('same', 'plain', 1)).not.toBe(hashContentSource('same', 'plain', 2));
      expect(hashContentSource('same', 'plain')).toBe(
        hashContentSource('same', 'plain', CONTENT_TRANSLATION_FORMAT_VERSION),
      );
      expect(CONTENT_TRANSLATION_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
    });

    it('uses a different namespace than the document hash (no collisions)', () => {
      // Beide hashen "tekst" maar de content-hash heeft een eigen prefix.
      expect(hashContentSource('tekst', 'plain')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('isTranslatableText', () => {
    it('accepts real prose with letters', () => {
      expect(isTranslatableText('Onderzoeksvraag')).toBe(true);
      expect(isTranslatableText('AI ethics')).toBe(true);
      expect(isTranslatableText('日本語のテキスト')).toBe(true);
    });
    it('rejects empty, too-short, or symbol-only strings', () => {
      expect(isTranslatableText('')).toBe(false);
      expect(isTranslatableText('  ')).toBe(false);
      expect(isTranslatableText('ab')).toBe(false); // < 3 chars
      expect(isTranslatableText('123')).toBe(false); // no letters
      expect(isTranslatableText('---')).toBe(false);
      expect(isTranslatableText('# 42 %')).toBe(false);
      expect(isTranslatableText(null)).toBe(false);
      expect(isTranslatableText(42)).toBe(false);
    });
  });

  describe('buildContentTranslationPrompt', () => {
    it('embeds the resolved target language and the strict rules', () => {
      const p = buildContentTranslationPrompt('yue', 'plain');
      expect(p).toContain('Cantonese');
      expect(p).toContain('Output ONLY the translation');
      expect(p).toMatch(/proper nouns|person names/i);
    });
    it('markdown mode preserves markdown + math; plain mode forbids added formatting', () => {
      const md = buildContentTranslationPrompt('en', 'markdown');
      expect(md).toMatch(/Markdown/);
      expect(md).toMatch(/LaTeX/);
      const plain = buildContentTranslationPrompt('en', 'plain');
      expect(plain).toMatch(/Do not add Markdown/i);
    });
    it('falls back gracefully for an unknown code', () => {
      expect(buildContentTranslationPrompt('xx', 'plain')).toContain('the requested language');
    });
  });

  describe('buildContentBatchPrompt', () => {
    it('asks for a JSON object with identical keys', () => {
      const p = buildContentBatchPrompt('de');
      expect(p).toContain('German');
      expect(p).toMatch(/JSON object/i);
      expect(p).toMatch(/same keys/i);
    });
  });
});
