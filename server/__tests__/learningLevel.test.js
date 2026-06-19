import { describe, it, expect } from 'vitest';
import {
  LEVEL_MIN, LEVEL_MAX, LEVEL_DEFAULT,
  LEVEL_LABELS,
  clampLevel, buildLevelInstructionBlock,
} from '../learningLevel.js';

describe('clampLevel', () => {
  it('houdt geldige niveaus 1..5', () => {
    expect(clampLevel(1)).toBe(1);
    expect(clampLevel(3)).toBe(3);
    expect(clampLevel(5)).toBe(5);
  });
  it('clampt buiten bereik', () => {
    expect(clampLevel(0)).toBe(LEVEL_MIN);
    expect(clampLevel(-4)).toBe(LEVEL_MIN);
    expect(clampLevel(9)).toBe(LEVEL_MAX);
  });
  it('rondt decimalen af', () => {
    expect(clampLevel(2.4)).toBe(2);
    expect(clampLevel(3.6)).toBe(4);
  });
  it('accepteert numerieke strings', () => {
    expect(clampLevel('4')).toBe(4);
  });
  it('geeft null bij ontbrekend/ongeldig', () => {
    expect(clampLevel(null)).toBeNull();
    expect(clampLevel(undefined)).toBeNull();
    expect(clampLevel('')).toBeNull();
    expect(clampLevel('abc')).toBeNull();
    expect(clampLevel(NaN)).toBeNull();
  });
});

describe('buildLevelInstructionBlock', () => {
  it('geeft lege string bij geen/ongeldig niveau (neutraal gedrag blijft)', () => {
    expect(buildLevelInstructionBlock(null, 'nl')).toBe('');
    expect(buildLevelInstructionBlock(undefined, 'en')).toBe('');
    expect(buildLevelInstructionBlock('foo', 'nl')).toBe('');
  });

  it('bouwt een NL-blok voor lang=nl met label + niveau', () => {
    const block = buildLevelInstructionBlock(1, 'nl');
    expect(block).toContain('LEERNIVEAU VAN DE STUDENT');
    expect(block).toContain(LEVEL_LABELS.nl[1]);
    expect(block).toContain(`niveau 1 van ${LEVEL_MAX}`);
    // readiness alleen op aanvraag
    expect(block).toContain('ALLEEN wanneer de student er expliciet naar vraagt');
    // bot mag niveau niet zelf wijzigen
    expect(block).toContain('Verlaag of verhoog het niveau NIET op eigen initiatief');
    expect(block.startsWith('\n\n')).toBe(true);
  });

  it('bouwt een EN-blok voor niet-nl talen', () => {
    const block = buildLevelInstructionBlock(5, 'en');
    expect(block).toContain("STUDENT'S LEARNING LEVEL");
    expect(block).toContain(LEVEL_LABELS.en[5]);
    expect(block).toContain(`level 5 of ${LEVEL_MAX}`);
    expect(block).toContain('ONLY when the student explicitly asks');
    expect(block).toContain('Do NOT lower or raise the level');
  });

  it('valt voor overige talen terug op EN', () => {
    const block = buildLevelInstructionBlock(3, 'fr');
    expect(block).toContain("STUDENT'S LEARNING LEVEL");
    expect(block).toContain(LEVEL_LABELS.en[3]);
  });

  it('clampt het niveau in het blok (out-of-range → grens)', () => {
    const high = buildLevelInstructionBlock(99, 'nl');
    expect(high).toContain(`niveau ${LEVEL_MAX} van ${LEVEL_MAX}`);
    const low = buildLevelInstructionBlock(0, 'en');
    expect(low).toContain(`level ${LEVEL_MIN} of ${LEVEL_MAX}`);
  });

  it('default-niveau levert een geldig blok op', () => {
    const block = buildLevelInstructionBlock(LEVEL_DEFAULT, 'nl');
    expect(block).toContain(LEVEL_LABELS.nl[LEVEL_DEFAULT]);
  });
});
