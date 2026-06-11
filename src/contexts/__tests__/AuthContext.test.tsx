import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock de Supabase-client zodat de tests geen echte client (en geen env-vars)
// nodig hebben. Alleen de auth-methodes die de auth-flow gebruikt.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
    from: vi.fn(),
  },
}));

import { supabase } from '../../lib/supabase';
import {
  signInWithSupabase,
  signUpWithSupabase,
  withTimeout,
} from '../AuthContext';
import { mapAuthErrorToKey } from '../../pages/LoginPage';

const signInMock = supabase.auth.signInWithPassword as unknown as ReturnType<typeof vi.fn>;
const signUpMock = supabase.auth.signUp as unknown as ReturnType<typeof vi.fn>;
const fromMock = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signInWithSupabase', () => {
  it('lost direct op zonder op de profiel-ophaling te wachten', async () => {
    signInMock.mockResolvedValue({ data: { session: {} }, error: null });
    // De profiel-ophaling hangt voor altijd; toch moet signIn promptu oplossen.
    fromMock.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }),
    }));

    await expect(signInWithSupabase('je@vu.nl', 'geheim')).resolves.toBeUndefined();

    // De inlogfunctie raakt de profiel-tabel niet aan: het profiel laadt los op
    // de achtergrond, dus de inlogknop kan nooit op de profiel-fetch blijven hangen.
    expect(fromMock).not.toHaveBeenCalled();
    expect(signInMock).toHaveBeenCalledWith({ email: 'je@vu.nl', password: 'geheim' });
  });

  it('gooit de Supabase-fout door bij ongeldige inloggegevens', async () => {
    signInMock.mockResolvedValue({
      data: {},
      error: new Error('Invalid login credentials'),
    });

    await expect(signInWithSupabase('je@vu.nl', 'fout')).rejects.toThrow(
      'Invalid login credentials',
    );
  });

  it('surfacet een time-outfout i.p.v. eindeloos te hangen als Supabase nooit antwoordt', async () => {
    vi.useFakeTimers();
    // signInWithPassword lost nooit op — het vangnet moet de race afwijzen.
    signInMock.mockReturnValue(new Promise(() => {}));

    const promise = signInWithSupabase('je@vu.nl', 'geheim');
    const assertion = expect(promise).rejects.toThrow(/duurde te lang/);

    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
  });
});

describe('withTimeout', () => {
  it('wijst af met een duidelijke melding wanneer de belofte nooit oplost', async () => {
    vi.useFakeTimers();
    const promise = withTimeout(new Promise(() => {}), 100, 'test');
    const assertion = expect(promise).rejects.toThrow('[AUTH] test duurde te lang (>100ms)');

    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it('lost op met de waarde wanneer de belofte op tijd klaar is', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok');
  });
});

describe('signUpWithSupabase', () => {
  it('gooit "User already registered" bij een verborgen bestaand account', async () => {
    // Supabase verbergt bestaande accounts: geen error, maar een user met een
    // lege identities-array. Dit mag nooit stil als "success" doorgaan.
    signUpMock.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });

    await expect(
      signUpWithSupabase('bestaat@vu.nl', 'geheim', 'Bestaande Gebruiker'),
    ).rejects.toThrow('User already registered');
  });

  it('slaagt voor een nieuw account met identities', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: 'u1', identities: [{ id: 'i1' }] } },
      error: null,
    });

    await expect(
      signUpWithSupabase('nieuw@vu.nl', 'geheim', 'Nieuwe Gebruiker'),
    ).resolves.toBeUndefined();
  });

  it('gooit de Supabase-foutmelding door', async () => {
    signUpMock.mockResolvedValue({
      data: {},
      error: new Error('Password should be at least 6 characters'),
    });

    await expect(
      signUpWithSupabase('nieuw@vu.nl', 'kort', 'Naam'),
    ).rejects.toThrow('Password should be at least 6 characters');
  });
});

describe('mapAuthErrorToKey', () => {
  it('mapt "User already registered" op de "account bestaat al"-melding', () => {
    expect(mapAuthErrorToKey('User already registered')).toBe('login.err.alreadyRegistered');
  });

  it('mapt bekende auth-fouten op hun i18n-sleutels', () => {
    expect(mapAuthErrorToKey('Invalid login credentials')).toBe('login.err.invalidCredentials');
    expect(mapAuthErrorToKey('Email not confirmed')).toBe('login.err.emailNotConfirmed');
  });

  it('geeft null voor onbekende fouten zodat de ruwe melding getoond wordt', () => {
    expect(mapAuthErrorToKey('Iets onverwachts ging mis')).toBeNull();
  });
});
