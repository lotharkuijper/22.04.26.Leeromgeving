import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIX,
  normalizeMixPreview,
  filterConceptsForCourse,
  loadConceptsForCourse,
  deriveMixState,
  type ConceptRow,
  type ConceptSupabaseLike,
} from '../quizSourcesLogic';
// De échte server-normalisatie, om te garanderen dat de client-preview en de
// server-persist identieke gehele uitkomsten geven. Het server-bestand is plain
// JS zonder type-declaraties; vandaar de ts-ignore.
// @ts-ignore
import { normalizeMix as serverNormalizeMix } from '../../../server/quizSourcesMix.js';

const COURSE = 'course-1';

// Bouwt een nep-Supabase-client die op de eerste select (mét course_id) een fout
// geeft en op de tweede (zonder course_id) de fallback-rijen teruggeeft. Houdt
// bij welke kolommen zijn opgevraagd, zodat we het fallback-pad kunnen bewijzen.
function makeFallbackSupabase(opts: {
  withColError?: { message: string } | null;
  withColData?: ConceptRow[];
  fallbackError?: { message: string } | null;
  fallbackData?: ConceptRow[];
}): { client: ConceptSupabaseLike; selects: string[] } {
  const selects: string[] = [];
  let call = 0;
  const client: ConceptSupabaseLike = {
    from() {
      return {
        select(cols: string) {
          selects.push(cols);
          const isFirst = call === 0;
          call++;
          return {
            order() {
              if (isFirst) {
                return Promise.resolve({
                  data: opts.withColData ?? null,
                  error: opts.withColError ?? null,
                });
              }
              return Promise.resolve({
                data: opts.fallbackData ?? null,
                error: opts.fallbackError ?? null,
              });
            },
          };
        },
      };
    },
  };
  return { client, selects };
}

describe('filterConceptsForCourse', () => {
  const rows: ConceptRow[] = [
    { id: '1', name: 'A', course_id: COURSE },
    { id: '2', name: 'B', course_id: 'other' },
    { id: '3', name: 'C', key_points: ['x', `course_id:${COURSE}`] },
    { id: '4', name: 'D', key_points: ['course_id:other'] },
    { id: '5', name: 'E', key_points: ['geen-marker'] },
    { id: '6', name: 'F' },
  ];

  it('matcht op course_id-kolom wanneer aanwezig', () => {
    const out = filterConceptsForCourse(rows, COURSE, true);
    const ids = out.map((c) => c.id);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
  });

  it('matcht op key_points-marker', () => {
    const out = filterConceptsForCourse(rows, COURSE, true);
    expect(out.map((c) => c.id)).toContain('3');
    expect(out.map((c) => c.id)).not.toContain('4');
  });

  it('behandelt begrippen zonder enige cursus-koppeling als globaal', () => {
    const out = filterConceptsForCourse(rows, COURSE, true);
    const ids = out.map((c) => c.id);
    expect(ids).toContain('5');
    expect(ids).toContain('6');
  });

  it('negeert course_id-kolom wanneer die niet bestaat (fallback-modus)', () => {
    // Zonder kolom valt rij 1 niet via course_id, maar wel via "geen koppeling"?
    // Nee: rij 1 heeft course_id gezet in het object maar hasCourseIdCol=false,
    // dus de course_id-regel telt niet; rij 1 heeft geen key_points-marker en
    // wél een course_id, dus valt buiten de "globaal"-regel -> niet getoond.
    const out = filterConceptsForCourse(rows, COURSE, false);
    expect(out.map((c) => c.id)).not.toContain('1');
    // key_points-marker werkt nog steeds.
    expect(out.map((c) => c.id)).toContain('3');
  });

  it('is bestand tegen null/undefined rijen', () => {
    expect(filterConceptsForCourse(null, COURSE, true)).toEqual([]);
    expect(filterConceptsForCourse(undefined, COURSE, true)).toEqual([]);
  });
});

describe('loadConceptsForCourse — fallback-pad', () => {
  it('valt bij een fout op de course_id-query terug op de query zonder en vult begrippen', async () => {
    const fallbackData: ConceptRow[] = [
      { id: '1', name: 'A', key_points: [`course_id:${COURSE}`] },
      { id: '2', name: 'B', key_points: ['course_id:other'] },
      { id: '3', name: 'C' },
    ];
    const { client, selects } = makeFallbackSupabase({
      withColError: { message: 'column concepts.course_id does not exist' },
      fallbackData,
    });

    const result = await loadConceptsForCourse(client, COURSE);

    // Beide queries zijn geprobeerd: eerst mét course_id, daarna zonder.
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('course_id');
    expect(selects[1]).not.toContain('course_id');

    expect(result.hasCourseIdCol).toBe(false);
    expect(result.error).toBeNull();
    // Begrippen zijn gevuld via de fallback (marker + globaal), niet leeg.
    expect(result.concepts.map((c) => c.id)).toEqual(['1', '3']);
  });

  it('gebruikt de course_id-query wanneer die slaagt en probeert geen fallback', async () => {
    const withColData: ConceptRow[] = [
      { id: '1', name: 'A', course_id: COURSE },
      { id: '2', name: 'B', course_id: 'other' },
    ];
    const { client, selects } = makeFallbackSupabase({ withColData });

    const result = await loadConceptsForCourse(client, COURSE);

    expect(selects).toHaveLength(1);
    expect(result.hasCourseIdCol).toBe(true);
    expect(result.error).toBeNull();
    expect(result.concepts.map((c) => c.id)).toEqual(['1']);
  });

  it('rapporteert de fout wanneer ook de fallback faalt', async () => {
    const { client } = makeFallbackSupabase({
      withColError: { message: 'col missing' },
      fallbackError: { message: 'permission denied' },
    });

    const result = await loadConceptsForCourse(client, COURSE);

    expect(result.error).toEqual({ message: 'permission denied' });
    expect(result.concepts).toEqual([]);
  });
});

describe('deriveMixState — saved-vs-default badge', () => {
  it('toont default (niet geconfigureerd) zonder updated_at', () => {
    const out = deriveMixState({ mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 }, schema_ready: true });
    expect(out.mixConfigured).toBe(false);
    expect(out.schemaReady).toBe(true);
  });

  it('toont bewaard (geconfigureerd) met updated_at', () => {
    const out = deriveMixState({
      mix: { pct_rag: 70, pct_itembank: 20, pct_llm: 10 },
      updated_at: '2026-06-01T00:00:00Z',
    });
    expect(out.mixConfigured).toBe(true);
    expect(out.mix).toEqual({ pct_rag: 70, pct_itembank: 20, pct_llm: 10 });
  });

  it('valt terug op DEFAULT_MIX bij ontbrekende mix', () => {
    const out = deriveMixState({ updated_at: null });
    expect(out.mix).toEqual(DEFAULT_MIX);
    expect(out.mixConfigured).toBe(false);
  });

  it('reset naar default state bij leeg/null antwoord (cursus-wissel/mislukte load)', () => {
    const out = deriveMixState(null);
    expect(out.mix).toEqual(DEFAULT_MIX);
    expect(out.mixConfigured).toBe(false);
    expect(out.schemaReady).toBe(true);
  });

  it('markeert schema als niet-gereed wanneer de server schema_ready:false meldt', () => {
    const out = deriveMixState({ schema_ready: false });
    expect(out.schemaReady).toBe(false);
  });
});

describe('normalizeMixPreview komt overeen met server normalizeMix', () => {
  const cases = [
    { pct_rag: 10, pct_itembank: 10, pct_llm: 10 }, // som 30
    { pct_rag: 100, pct_itembank: 100, pct_llm: 100 }, // som 300
    { pct_rag: 7, pct_itembank: 11, pct_llm: 13 }, // som 31
    { pct_rag: 99, pct_itembank: 1, pct_llm: 1 }, // som 101
    { pct_rag: 1, pct_itembank: 1, pct_llm: 1 }, // som 3
    { pct_rag: 0, pct_itembank: 0, pct_llm: 0 }, // som 0 -> default
    { pct_rag: 60, pct_itembank: 30, pct_llm: 10 }, // som 100
  ];

  for (const c of cases) {
    it(`som ${c.pct_rag + c.pct_itembank + c.pct_llm}: client == server`, () => {
      const client = normalizeMixPreview(c);
      const server = serverNormalizeMix(c);
      expect(client).toEqual(server);
      expect(client.pct_rag + client.pct_itembank + client.pct_llm).toBe(100);
    });
  }
});
