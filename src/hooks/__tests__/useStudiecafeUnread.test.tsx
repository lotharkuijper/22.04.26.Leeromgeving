// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Auth levert een stabiele sessie (access_token). De realtime-client wordt
// vervangen door een nep-kanaal waarvan we de change-handlers vangen, zodat we
// een realtime-trigger (en daarmee een refetch) kunnen simuleren.
const session = { access_token: 'test-token' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session }),
}));

const { realtimeHandlers, channelObj, removeChannelMock } = vi.hoisted(() => {
  const realtimeHandlers: Array<() => void> = [];
  const channelObj: any = {
    on: (...args: any[]) => {
      const handler = args[args.length - 1];
      if (typeof handler === 'function') realtimeHandlers.push(handler as () => void);
      return channelObj;
    },
    subscribe: () => channelObj,
  };
  return { realtimeHandlers, channelObj, removeChannelMock: () => {} };
});
vi.mock('../../lib/supabase', () => ({
  supabase: {
    channel: () => channelObj,
    removeChannel: removeChannelMock,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}));

import { useStudiecafeUnread } from '../useStudiecafeUnread';

// ── fetch-router ─────────────────────────────────────────────────────────────
function jsonRes(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

// Muteerbare respons zodat een refetch een andere telling kan teruggeven.
let unreadResponse: { count: number; announcementCount: number };

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.includes('/unread')) return jsonRes(unreadResponse);
  return jsonRes({}, true);
});

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHandlers.length = 0;
  unreadResponse = { count: 3, announcementCount: 1 };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStudiecafeUnread', () => {
  it('laadt de initiële telling van de actieve cursus', async () => {
    const { result } = renderHook(() => useStudiecafeUnread('course-1'));

    await waitFor(() => expect(result.current.count).toBe(3));
    expect(result.current.announcementCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/studiecafe/course-1/unread',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }),
    );
  });

  it('herlaadt en werkt de telling bij na het studiecafe-unread-refresh event', async () => {
    const { result } = renderHook(() => useStudiecafeUnread('course-1'));
    await waitFor(() => expect(result.current.count).toBe(3));

    // De server geeft nu een hogere telling terug; het event nudge't een refetch.
    unreadResponse = { count: 5, announcementCount: 2 };
    await act(async () => {
      window.dispatchEvent(new Event('studiecafe-unread-refresh'));
    });

    await waitFor(() => expect(result.current.count).toBe(5));
    expect(result.current.announcementCount).toBe(2);
  });

  it('herlaadt na een realtime forum-wijziging', async () => {
    const { result } = renderHook(() => useStudiecafeUnread('course-1'));
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(realtimeHandlers.length).toBeGreaterThan(0);

    unreadResponse = { count: 7, announcementCount: 0 };
    await act(async () => {
      realtimeHandlers.forEach((h) => h());
    });

    await waitFor(() => expect(result.current.count).toBe(7));
  });

  it('negeert een verouderd (traag) antwoord via de seq-guard', async () => {
    // Eerste call blijft hangen tot wij hem handmatig oplossen; tweede lost meteen op.
    let resolveFirst: (v: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => jsonRes({ count: 9, announcementCount: 4 }));

    const { result } = renderHook(() => useStudiecafeUnread('course-1'));

    // Een tweede refresh (verser) lost als eerste op met telling 9.
    await act(async () => {
      window.dispatchEvent(new Event('studiecafe-unread-refresh'));
    });
    await waitFor(() => expect(result.current.count).toBe(9));

    // Nu lost de verouderde eerste call pas op — de seq-guard moet hem negeren.
    await act(async () => {
      resolveFirst({ ok: true, json: () => Promise.resolve({ count: 1, announcementCount: 1 }) } as Response);
    });
    expect(result.current.count).toBe(9);
    expect(result.current.announcementCount).toBe(4);
  });

  it('geeft {count:0, announcementCount:0} zonder courseId en doet geen fetch', async () => {
    const { result } = renderHook(() => useStudiecafeUnread(null));

    // Geen courseId → directe reset, geen netwerk-call.
    await waitFor(() => {
      expect(result.current.count).toBe(0);
      expect(result.current.announcementCount).toBe(0);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
