import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callChatAPI doet een dynamische import van '../lib/supabase' voor de
// auth-header; mock 'm zodat er geen env-vars/echte client nodig zijn.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import { sendChatMessage, evaluateExplanation } from '../llm.service';

const fetchMock = vi.fn();

function okChatResponse() {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'antwoord' } }] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(okChatResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody(): any {
  const calls = fetchMock.mock.calls;
  const call = calls[calls.length - 1];
  return JSON.parse(call[1].body);
}

describe('sendChatMessage learningLevel-bedrading', () => {
  it('stuurt het meegegeven learningLevel mee in de request-body', async () => {
    await sendChatMessage([{ role: 'user', content: 'hoi' }], undefined, false, undefined, 4);
    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.anything());
    expect(lastBody().learningLevel).toBe(4);
  });

  it('laat learningLevel undefined wanneer het niet wordt meegegeven', async () => {
    await sendChatMessage([{ role: 'user', content: 'hoi' }]);
    expect(lastBody()).not.toHaveProperty('learningLevel');
  });
});

describe('evaluateExplanation learningLevel-bedrading', () => {
  it('stuurt het meegegeven learningLevel mee in de request-body', async () => {
    await evaluateExplanation(
      'Begrip', 'Mijn uitleg', 'Definitie', ['kernpunt 1'],
      undefined, undefined, false, undefined, 5,
    );
    expect(lastBody().learningLevel).toBe(5);
  });

  it('laat learningLevel undefined wanneer het niet wordt meegegeven', async () => {
    await evaluateExplanation('Begrip', 'Mijn uitleg', 'Definitie', ['kernpunt 1']);
    expect(lastBody()).not.toHaveProperty('learningLevel');
  });
});
