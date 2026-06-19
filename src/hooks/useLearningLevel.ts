import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

// Task #296: adaptief leerniveau per student, PER cursus. De student kiest zelf
// een niveau (1..5, beginner→expert); dat niveau wordt meegegeven aan de
// LLM-aanroepen (tutor-chat, "Ik leg uit", project-persona-chat) zodat de
// uitleg zich aanpast. De student blijft de baas: de bot adviseert alleen op
// aanvraag over een hoger niveau, maar verandert het niveau nooit zelf.

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 5;
// Standaard wanneer een student nog niets koos. Bewust laag-gemiddeld; spiegelt
// LEVEL_DEFAULT in server/learningLevel.js.
export const LEVEL_DEFAULT = 2;
export const LEVELS = [1, 2, 3, 4, 5] as const;

export function clampLevel(value: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return LEVEL_DEFAULT;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, n));
}

export interface UseLearningLevelResult {
  /** Huidig (zelfgekozen) niveau 1..5; LEVEL_DEFAULT zolang er niets geladen is. */
  level: number;
  /** Optimistisch bijwerken + upsert naar Supabase (eigen rij via RLS). */
  setLevel: (next: number) => void;
  /** Is de waarde uit de DB geladen (of bevestigd afwezig)? */
  loaded: boolean;
}

/**
 * Laadt en bewaart het leerniveau van de ingelogde student voor één cursus.
 * Zonder courseId/profiel valt de hook stil terug op het standaardniveau en
 * doet geen DB-calls. Schrijven gebeurt via een eigen-rij-upsert (RLS staat
 * alleen `auth.uid() = user_id` toe).
 */
export function useLearningLevel(courseId: string | null | undefined): UseLearningLevelResult {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const [level, setLevelState] = useState<number>(LEVEL_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    setLoaded(false);
    if (!courseId || !userId) {
      setLevelState(LEVEL_DEFAULT);
      setLoaded(true); // bevestigd afwezig: er valt niets te laden
      return;
    }
    const seq = ++seqRef.current;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('student_course_levels')
        .select('level')
        .eq('user_id', userId)
        .eq('course_id', courseId)
        .maybeSingle();
      if (cancelled || seq !== seqRef.current) return;
      if (!error && data?.level != null) {
        setLevelState(clampLevel(data.level));
      } else {
        setLevelState(LEVEL_DEFAULT);
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [courseId, userId]);

  const setLevel = useCallback((next: number) => {
    const clamped = clampLevel(next);
    setLevelState(clamped); // optimistisch
    if (!courseId || !userId) return;
    (async () => {
      const { error } = await supabase
        .from('student_course_levels')
        .upsert(
          { user_id: userId, course_id: courseId, level: clamped, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,course_id' }
        );
      if (error) console.warn('[useLearningLevel] niveau opslaan mislukt:', error.message);
    })();
  }, [courseId, userId]);

  return { level, setLevel, loaded };
}
