import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

// Task #307: ongelezen-indicator voor het Studiecafé in de navigatie. Pollt de
// ongelezen-samenvatting van de ACTIEVE cursus (toegang is daar al gecontroleerd)
// en herlaadt bij navigatie + venster-focus + realtime forum-wijzigingen. Houdt
// het bewust licht: één korte call, geen react-query (zit niet in dit project).

const POLL_MS = 60_000;

export interface StudiecafeUnread {
  count: number;
  announcementCount: number;
}

export function useStudiecafeUnread(courseId: string | null | undefined): StudiecafeUnread {
  const { session } = useAuth();
  const [unread, setUnread] = useState<StudiecafeUnread>({ count: 0, announcementCount: 0 });
  const seqRef = useRef(0);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (session?.access_token) return session.access_token;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [session]);

  const refresh = useCallback(async () => {
    if (!courseId) {
      setUnread({ count: 0, announcementCount: 0 });
      return;
    }
    const seq = ++seqRef.current;
    try {
      const token = await getToken();
      if (!token) return;
      const r = await fetch(`/api/studiecafe/${courseId}/unread`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (!d || seq !== seqRef.current) return;
      setUnread({
        count: Number(d.count) || 0,
        announcementCount: Number(d.announcementCount) || 0,
      });
    } catch {
      /* stil: een ontbrekende badge is niet kritisch */
    }
  }, [courseId, getToken]);

  useEffect(() => {
    refresh();
    if (!courseId) return;
    const interval = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    // Task #312: bij het openen van een thread (per-thread gelezen-markering) nudge
    // de pagina de badge via dit event zodat hij meteen meedaalt, niet pas bij de
    // volgende poll/focus.
    const onReadRefresh = () => refresh();
    window.addEventListener('studiecafe-unread-refresh', onReadRefresh);

    // Realtime: nieuwe/aangepaste threads of replies → direct herladen.
    const channel = supabase
      .channel(`studiecafe-unread-${courseId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studiecafe_threads', filter: `course_id=eq.${courseId}` }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studiecafe_replies', filter: `course_id=eq.${courseId}` }, () => refresh())
      .subscribe();

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('studiecafe-unread-refresh', onReadRefresh);
      supabase.removeChannel(channel);
    };
  }, [courseId, refresh]);

  return unread;
}
