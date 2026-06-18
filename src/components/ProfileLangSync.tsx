import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { isSupportedLang } from '../i18n/languages';
import type { Lang } from '../i18n/translations';

export function ProfileLangSync() {
  const { profile, user } = useAuth();
  const { lang, setLang } = useLanguage();
  const initialSyncDone = useRef(false);

  useEffect(() => {
    if (!profile) {
      initialSyncDone.current = false;
      return;
    }
    if (initialSyncDone.current) return;

    const profileLang = profile.preferred_lang;
    if (isSupportedLang(profileLang)) {
      setLang(profileLang as Lang);
    }
    initialSyncDone.current = true;
  }, [profile, lang, setLang]);

  const prevLangRef = useRef<Lang | null>(null);

  useEffect(() => {
    if (!initialSyncDone.current || !user) return;
    if (prevLangRef.current === lang) return;
    if (prevLangRef.current === null) {
      prevLangRef.current = lang;
      return;
    }

    prevLangRef.current = lang;

    supabase
      .from('profiles')
      .update({ preferred_lang: lang })
      .eq('id', user.id)
      .then(({ error }) => {
        if (error) {
          console.error('[LANG] Taalvoorkeur opslaan mislukt:', error.message);
        }
      });
  }, [lang, user]);

  return null;
}
