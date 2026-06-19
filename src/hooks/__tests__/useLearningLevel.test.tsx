// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock de Supabase-client: de hook leest/upsert via .from('student_course_levels').
// vi.hoisted zodat de mock-factory (die naar boven wordt gehesen) de fns kan
// bereiken zonder "Cannot access before initialization".
const { maybeSingleMock, upsertMock, fromMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const upsertMock = vi.fn();
  const fromMock = vi.fn((_table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
    upsert: upsertMock,
  }));
  return { maybeSingleMock, upsertMock, fromMock };
});
vi.mock('../../lib/supabase', () => ({
  supabase: { from: fromMock },
}));

// useAuth levert het profiel (user_id). Per test te sturen.
let mockProfile: { id: string } | null = { id: 'user-1' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: mockProfile }),
}));

import {
  useLearningLevel,
  clampLevel,
  LEVEL_DEFAULT,
  LEVEL_MIN,
  LEVEL_MAX,
} from '../useLearningLevel';

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile = { id: 'user-1' };
  upsertMock.mockResolvedValue({ error: null });
  maybeSingleMock.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clampLevel', () => {
  it('begrenst op 1..5 en rondt af', () => {
    expect(clampLevel(0)).toBe(LEVEL_MIN);
    expect(clampLevel(-3)).toBe(LEVEL_MIN);
    expect(clampLevel(9)).toBe(LEVEL_MAX);
    expect(clampLevel(3.4)).toBe(3);
    expect(clampLevel(3.6)).toBe(4);
  });

  it('valt terug op het standaardniveau bij niet-eindige waarden', () => {
    expect(clampLevel(Number.NaN)).toBe(LEVEL_DEFAULT);
    expect(clampLevel(Number.POSITIVE_INFINITY)).toBe(LEVEL_DEFAULT);
  });
});

describe('useLearningLevel zonder courseId/profiel', () => {
  it('valt stil terug op het standaardniveau en doet geen DB-call', async () => {
    const { result } = renderHook(() => useLearningLevel(null));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.level).toBe(LEVEL_DEFAULT);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('doet geen DB-call wanneer er geen profiel is, ook met courseId', async () => {
    mockProfile = null;
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.level).toBe(LEVEL_DEFAULT);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('schrijft niet naar de DB bij setLevel zonder courseId', async () => {
    const { result } = renderHook(() => useLearningLevel(null));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setLevel(4));
    expect(result.current.level).toBe(4); // optimistisch lokaal
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('useLearningLevel laden', () => {
  it('laadt het bestaande (geclampte) niveau uit de DB', async () => {
    maybeSingleMock.mockResolvedValue({ data: { level: 9 }, error: null });
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.level).toBe(LEVEL_MAX); // 9 → geclampt naar 5
    expect(fromMock).toHaveBeenCalledWith('student_course_levels');
  });

  it('gebruikt het standaardniveau wanneer er geen rij is', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.level).toBe(LEVEL_DEFAULT);
  });

  it('valt terug op het standaardniveau bij een fout', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.level).toBe(LEVEL_DEFAULT);
  });
});

describe('useLearningLevel setLevel (optimistisch + upsert)', () => {
  it('werkt direct lokaal bij en upsert met de juiste sleutel', async () => {
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      result.current.setLevel(5);
    });

    expect(result.current.level).toBe(5);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [row, opts] = upsertMock.mock.calls[0];
    expect(row).toMatchObject({ user_id: 'user-1', course_id: 'course-1', level: 5 });
    expect(row.updated_at).toBeTypeOf('string');
    expect(opts).toEqual({ onConflict: 'user_id,course_id' });
  });

  it('clampt de gekozen waarde vóór de upsert', async () => {
    const { result } = renderHook(() => useLearningLevel('course-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      result.current.setLevel(42);
    });

    expect(result.current.level).toBe(LEVEL_MAX);
    expect(upsertMock.mock.calls[0][0].level).toBe(LEVEL_MAX);
  });
});

describe('useLearningLevel seq-guard', () => {
  it('negeert een verouderd (trage) antwoord van een vorige cursus', async () => {
    // Eerste cursus: antwoord blijft hangen totdat wij het handmatig oplossen.
    let resolveFirst: (v: unknown) => void = () => {};
    maybeSingleMock.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );
    // Tweede cursus: lost meteen op met niveau 4.
    maybeSingleMock.mockImplementationOnce(
      async () => ({ data: { level: 4 }, error: null }),
    );

    const { result, rerender } = renderHook(
      ({ courseId }) => useLearningLevel(courseId),
      { initialProps: { courseId: 'course-1' } },
    );

    // Wissel naar de tweede cursus vóórdat de eerste fetch oplost.
    rerender({ courseId: 'course-2' });
    await waitFor(() => expect(result.current.level).toBe(4));

    // Nu lost het verouderde eerste antwoord pas op — het mag niets overschrijven.
    await act(async () => {
      resolveFirst({ data: { level: 1 }, error: null });
    });
    expect(result.current.level).toBe(4);
  });
});
