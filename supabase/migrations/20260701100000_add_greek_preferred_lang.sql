-- Voegt Grieks ('el') toe aan de CHECK op profiles.preferred_lang. Zonder deze
-- verbreding weigert de database het opslaan van de Griekse taalvoorkeur (de
-- vorige CHECK dekte 19 talen zonder 'el'). Drop-and-recreate op de bestaande
-- constraint-naam profiles_preferred_lang_check.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_preferred_lang_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_preferred_lang_check
  CHECK (preferred_lang IN (
    'nl', 'en', 'yue', 'zh', 'de', 'fr', 'es', 'it', 'pt', 'pl',
    'uk', 'ro', 'tr', 'ar', 'hi', 'id', 'ja', 'ko', 'hr', 'el'
  ));
