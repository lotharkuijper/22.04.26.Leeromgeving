import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Mail, Lock, LogIn, KeyRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';
import type { TranslationKey } from '../i18n/translations';

// Mapt een ruwe auth-foutmelding naar een i18n-sleutel met een nette,
// gebruikersvriendelijke melding. Geeft `null` terug als er geen specifieke
// vertaling is, zodat de aanroeper de ruwe melding kan tonen.
export function mapAuthErrorToKey(message: string): TranslationKey | null {
  if (message.includes('Invalid login credentials')) {
    return 'login.err.invalidCredentials';
  }
  if (message.includes('User already registered')) {
    return 'login.err.alreadyRegistered';
  }
  if (message.includes('Email not confirmed')) {
    return 'login.err.emailNotConfirmed';
  }
  return null;
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Wachtwoord-vergeten-modus: toont een apart e-mailformulier i.p.v. login.
  const [isForgot, setIsForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const { signIn } = useAuth();
  const { t, lang, setLang } = useLanguage();

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Stuur altijd een neutrale bevestiging, ongeacht of het adres bestaat,
      // zodat we niet onthullen welke e-mailadressen geregistreerd zijn.
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } catch (err) {
      console.error('Reset email error:', err);
    } finally {
      setForgotSent(true);
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password);
    } catch (err: any) {
      console.error('Auth error:', err);
      const errorMessage = err.message || t('login.err.generic');
      const mappedKey = mapAuthErrorToKey(errorMessage);
      setError(mappedKey ? t(mappedKey) : errorMessage);
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
              LEAP-VU
            </h1>
            <p className="text-gray-600 text-center">
              {isForgot ? t('login.forgotSubtitle') : t('login.signInSubtitle')}
            </p>
            {/* Language toggle on login page */}
            <button
              data-testid="button-lang-toggle-login"
              onClick={() => setLang(lang === 'nl' ? 'en' : 'nl')}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
            >
              <span>{lang === 'nl' ? '🇳🇱 NL' : '🇬🇧 EN'}</span>
              <span>→</span>
              <span>{lang === 'nl' ? '🇬🇧 EN' : '🇳🇱 NL'}</span>
            </button>
          </div>

          {isForgot ? (
            forgotSent ? (
              <div className="space-y-5">
                <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm" data-testid="text-forgot-sent">
                  {t('login.forgotSent')}
                </div>
                <button
                  onClick={() => { setIsForgot(false); setForgotSent(false); setError(''); }}
                  className="w-full text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-back-to-login"
                >
                  {t('login.backToLogin')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotSubmit} className="space-y-5">
                <div>
                  <label htmlFor="forgot-email" className="block text-sm font-semibold text-gray-700 mb-2">
                    {t('login.email')}
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      id="forgot-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                      placeholder={t('login.emailPlaceholder')}
                      required
                      data-testid="input-forgot-email"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  data-testid="button-send-reset"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <KeyRound className="w-5 h-5" />
                      {t('login.forgotSendBtn')}
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setIsForgot(false); setError(''); }}
                  className="w-full text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-cancel-forgot"
                >
                  {t('login.backToLogin')}
                </button>
              </form>
            )
          ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('login.email')}
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  placeholder={t('login.emailPlaceholder')}
                  required
                  data-testid="input-email"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('login.password')}
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
                  minLength={6}
                  data-testid="input-password"
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm" data-testid="text-login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              data-testid="button-login"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  {t('login.loginBtn')}
                </>
              )}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => { setIsForgot(true); setForgotSent(false); setError(''); }}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                data-testid="button-forgot-password"
              >
                {t('login.forgotLink')}
              </button>
            </div>
          </form>
          )}
        </div>
      </div>
    </div>
  );
}
