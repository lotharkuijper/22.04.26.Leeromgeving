// Regressie-vangnet voor de raadpleging-bevestigingspoort (Task #252/#296).
// De readiness-knop op ProjectRoomPage moet via requestSendPersona door deze
// poort lopen: zodra een persona een EINDIGE limiet heeft en er nog geen
// (open) thread is, moet eerst de bevestigingsdialoog verschijnen i.p.v. direct
// een nieuwe raadpleging te starten. Deze pure helper is de kern van die beslissing.

// ProjectRoomPage importeert de Supabase-client (module-load); mock 'm zodat de
// pure helper getest kan worden zonder env-vars/echte client.
import { vi, describe, it, expect } from 'vitest';

vi.mock('../../lib/supabase', () => ({
  supabase: { from: vi.fn(), auth: { getSession: vi.fn() } },
}));

import { startsNewConsultation } from '../ProjectRoomPage';

type Consult = Parameters<typeof startsNewConsultation>[0];

const base = {
  personaId: 'p1',
  used: 0,
  extra: 0,
  baseLimit: 3,
  limit: 3,
  remaining: 3,
  blocked: false,
  autoCloseHours: null,
} as const;

describe('startsNewConsultation', () => {
  it('vereist bevestiging bij een eindige limiet zonder open/actieve thread', () => {
    expect(startsNewConsultation({ ...base }, false)).toBe(true);
  });

  it('vereist geen bevestiging bij een onbeperkte limiet (limit === null)', () => {
    expect(startsNewConsultation({ ...base, limit: null }, false)).toBe(false);
  });

  it('vereist geen bevestiging wanneer er al een actieve thread is', () => {
    expect(startsNewConsultation({ ...base }, true)).toBe(false);
  });

  it('vereist geen bevestiging wanneer de persona al een open thread heeft', () => {
    expect(startsNewConsultation({ ...base, hasOpenThread: true }, false)).toBe(false);
  });

  it('vereist geen bevestiging zonder consult-info', () => {
    expect(startsNewConsultation(undefined, false)).toBe(false);
    expect(startsNewConsultation(null as unknown as Consult, false)).toBe(false);
  });
});
