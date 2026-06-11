import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, KeyRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';

// Minimale wachtwoordsterkte: minstens 8 tekens, met ten minste één letter en
// één cijfer. Houdt het laagdrempelig maar weert triviale wachtwoorden.
function isStrongEnough(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

// Activatiepagina voor nieuw aangemaakte (uitgenodigde) accounts. De
// uitnodigingslink uit de e-mail bevat een token dat Supabase automatisch
// uit de URL verwerkt (detectSessionInUrl) en als SIGNED_IN-sessie zet. De
// gebruiker kiest hier een wachtwoord (2×) waarmee het account actief wordt.
export function ActivatePage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  // We wachten tot Supabase de uitnodigingssessie uit de URL heeft verwerkt.
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const navigate = useNavigate();
  const { t, lang, setLang } = useLanguage();

  useEffect(() => {
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY' || session) {
        setHasSession(true);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setHasSession((prev) => prev ?? !!session);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isStrongEnough(password)) {
      setError(t('activate.err.tooWeak'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('activate.err.mismatch'));
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
      setTimeout(() => navigate('/dashboard', { replace: true }), 1500);
    } catch (err: any) {
      console.error('Activate account error:', err);
      setError(err.message || t('login.err.generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
          <div className="flex flex-col items-center mb-8">
            <img src="/leap-vu-logo.png" alt="LEAP-VU logo" className="h-24 w-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
              {t('activate.title')}
            </h1>
            <p className="text-gray-600 text-center">{t('activate.subtitle')}</p>
            <button
              data-testid="button-lang-toggle-activate"
              onClick={() => setLang(lang === 'nl' ? 'en' : 'nl')}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
            >
              <span>{lang === 'nl' ? '🇳🇱 NL' : '🇬🇧 EN'}</span>
              <span>→</span>
              <span>{lang === 'nl' ? '🇬🇧 EN' : '🇳🇱 NL'}</span>
            </button>
          </div>

          {success ? (
            <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm" data-testid="text-activate-success">
              {t('activate.success')}
            </div>
          ) : hasSession === false ? (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm" data-testid="text-activate-no-session">
                {t('activate.noSession')}
              </div>
              <button
                onClick={() => navigate('/login', { replace: true })}
                className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg"
                data-testid="button-back-to-login"
              >
                {t('activate.backToLogin')}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="password" className="block text-sm font-semibold text-gray-700 mb-2">
                  {t('activate.newPassword')}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                    placeholder="••••••••"
                    required
                    minLength={8}
                    data-testid="input-new-password"
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-500" data-testid="text-password-hint">
                  {t('activate.passwordHint')}
                </p>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-semibold text-gray-700 mb-2">
                  {t('activate.confirmPassword')}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                    placeholder="••••••••"
                    required
                    minLength={8}
                    data-testid="input-confirm-password"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm" data-testid="text-activate-error">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                data-testid="button-submit-activate"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <KeyRound className="w-5 h-5" />
                    {t('activate.submitBtn')}
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
