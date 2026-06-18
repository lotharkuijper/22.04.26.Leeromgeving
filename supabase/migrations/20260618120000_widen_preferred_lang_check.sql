-- Verbreedt de CHECK op profiles.preferred_lang van {nl,en} naar de volledige
-- set van 19 ondersteunde talen (Task #287 — meertaligheid). De oude inline
-- CHECK kreeg de auto-naam profiles_preferred_lang_check; die droppen we eerst.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_preferred_lang_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_preferred_lang_check
  CHECK (preferred_lang IN (
    'nl', 'en', 'yue', 'zh', 'de', 'fr', 'es', 'it', 'pt', 'pl',
    'uk', 'ro', 'tr', 'ar', 'hi', 'id', 'ja', 'ko', 'hr'
  ));
