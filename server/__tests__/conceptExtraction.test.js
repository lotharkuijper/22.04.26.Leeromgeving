import { describe, it, expect } from 'vitest';
import {
  planConceptReplace,
  planConceptWrites,
  courseMarkerFor,
  RAG_MARKER,
} from '../conceptExtraction.js';

const COURSE = '9485d5c9-e0b8-47b1-9d13-452e8518f5ad';
const OTHER = 'dbb59936-d4cc-43ce-b1cc-15afa963930d';
const marker = courseMarkerFor(COURSE);
const otherMarker = courseMarkerFor(OTHER);

describe('planConceptReplace', () => {
  it('verwijdert verouderde RAG-begrippen die alleen bij deze cursus horen', () => {
    const tagged = [
      { id: 'a', name: 'Oud A', key_points: [marker, RAG_MARKER] },
      { id: 'b', name: 'Oud B', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual(['a', 'b']);
    expect(toUntag).toEqual([]);
  });

  it('behoudt begrippen waarvan de naam in keepNames staat (net geschreven of opnieuw voorgesteld)', () => {
    const tagged = [
      { id: 'a', name: 'Behoud Mij', key_points: [marker, RAG_MARKER] },
      { id: 'b', name: 'Verouderd', key_points: [marker, RAG_MARKER] },
    ];
    const keepNames = new Set(['behoud mij']);
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual(['b']);
    expect(toUntag).toEqual([]);
  });

  it('laat gedeelde begrippen staan en verwijdert alleen de markering van deze cursus', () => {
    const tagged = [
      { id: 'shared', name: 'Gedeeld', key_points: [marker, otherMarker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toHaveLength(1);
    expect(toUntag[0].id).toBe('shared');
    expect(toUntag[0].key_points).toContain(otherMarker);
    expect(toUntag[0].key_points).not.toContain(marker);
    expect(toUntag[0].key_points).toContain(RAG_MARKER);
  });

  it('laat handmatige begrippen (zonder RAG-markering) volledig ongemoeid', () => {
    const tagged = [{ id: 'manual', name: 'Handmatig', key_points: [marker] }];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });
});

describe('planConceptWrites', () => {
  it('voegt nieuwe begrippen in met cursus- en RAG-markering', () => {
    const valid = [
      { name: 'Type I-fout', category: 'statistiek', definition: 'def1' },
      { name: 'Type II-fout', category: 'statistiek', definition: 'def2' },
    ];
    const { toInsert, toUpdate, skipped } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toBe(0);
    expect(toInsert[0].key_points).toEqual([marker, RAG_MARKER]);
  });

  it('slaat begrippen over die al voor deze cursus gemarkeerd zijn (handmatig behouden)', () => {
    const existing = [{ id: 'm', name: 'Gemiddelde', key_points: [marker] }];
    const valid = [{ name: 'Gemiddelde', category: 'c', definition: 'd' }];
    const { toInsert, toUpdate, skipped } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('deelt een bestaand RAG-begrip van een andere cursus door beide markeringen toe te voegen', () => {
    const existing = [{ id: 'x', name: 'Variantie', key_points: [otherMarker, RAG_MARKER] }];
    const valid = [{ name: 'variantie', category: 'c', definition: 'd' }];
    const { toInsert, toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].id).toBe('x');
    expect(toUpdate[0].key_points).toContain(otherMarker);
    expect(toUpdate[0].key_points).toContain(marker);
    expect(toUpdate[0].key_points).toContain(RAG_MARKER);
  });

  it('een bestaand HANDMATIG begrip (andere cursus) blijft handmatig: GEEN RAG-markering toevoegen', () => {
    const existing = [{ id: 'man', name: 'Steekproef', key_points: [otherMarker] }];
    const valid = [{ name: 'Steekproef', category: 'c', definition: 'd' }];
    const { toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].key_points).toContain(otherMarker);
    expect(toUpdate[0].key_points).toContain(marker);
    expect(toUpdate[0].key_points).not.toContain(RAG_MARKER);
  });

  it('ontdubbelt herhaalde namen binnen één batch', () => {
    const valid = [
      { name: 'Mediaan', category: 'c', definition: 'd' },
      { name: 'mediaan', category: 'c', definition: 'd' },
    ];
    const { toInsert, skipped } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

describe('extractie-flow (schrijven-eerst, daarna keep-aware opruimen)', () => {
  it('REGRESSIE: nieuwe extractie persisteert — opruimen verwijdert de net geschreven begrippen niet', () => {
    // Begin: cursus leeg. Extractie levert 2 begrippen → beide ingevoegd.
    const valid = [
      { name: 'Begrip A', category: 'c', definition: 'd' },
      { name: 'Begrip B', category: 'c', definition: 'd' },
    ];
    const { toInsert } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(2);

    // Na de insert staan ze in de DB en zitten in keepNames. De opruimstap mag
    // ze NIET verwijderen.
    const keepNames = new Set(valid.map((c) => c.name.toLowerCase().trim()));
    const taggedAfterInsert = [
      { id: 'newA', name: 'Begrip A', key_points: [marker, RAG_MARKER] },
      { id: 'newB', name: 'Begrip B', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(taggedAfterInsert, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });

  it('REGRESSIE: hergenereren behoudt opnieuw voorgestelde begrippen en wist alleen verouderde', () => {
    // Bestaand (RAG, deze cursus): "Begrip A" + "Begrip Oud".
    const existing = [
      { id: 'A', name: 'Begrip A', key_points: [marker, RAG_MARKER] },
      { id: 'OUD', name: 'Begrip Oud', key_points: [marker, RAG_MARKER] },
    ];
    // Nieuwe extractie stelt "Begrip A" (opnieuw) + "Begrip C" (nieuw) voor.
    const valid = [
      { name: 'Begrip A', category: 'c', definition: 'd' },
      { name: 'Begrip C', category: 'c', definition: 'd' },
    ];
    const { toInsert, skipped } = planConceptWrites(valid, existing, { courseMarker: marker });
    // "Begrip A" al getagd → overgeslagen (behouden); "Begrip C" → nieuw.
    expect(toInsert.map((c) => c.name)).toEqual(['Begrip C']);
    expect(skipped).toBe(1);

    // Opruimen: keepNames = {begrip a, begrip c}. "Begrip Oud" is niet meer
    // voorgesteld → verwijderd; "Begrip A" behouden.
    const keepNames = new Set(valid.map((c) => c.name.toLowerCase().trim()));
    const taggedAfter = [
      ...existing,
      { id: 'C', name: 'Begrip C', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds } = planConceptReplace(taggedAfter, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual(['OUD']);
  });

  it('REGRESSIE: een handmatig begrip dat per cursus gedeeld wordt, overleeft een latere replace', () => {
    // Stap 1: handmatig begrip uit andere cursus wordt voor deze cursus gedeeld.
    const existing = [{ id: 'man', name: 'Hypothese', key_points: [otherMarker] }];
    const valid = [{ name: 'Hypothese', category: 'c', definition: 'd' }];
    const { toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    const updatedKeyPoints = toUpdate[0].key_points; // [otherMarker, marker], GEEN RAG
    expect(updatedKeyPoints).not.toContain(RAG_MARKER);

    // Stap 2: latere replace waarbij "Hypothese" NIET meer voorgesteld wordt.
    const tagged = [{ id: 'man', name: 'Hypothese', key_points: updatedKeyPoints }];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker, keepNames: new Set() });
    // Handmatig (geen RAG-markering) → blijft volledig ongemoeid.
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });
});
