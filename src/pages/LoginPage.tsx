import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { GraduationCap, Mail, Lock, LogIn } from 'lucide-react';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn, signUp } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSignUp) {
        if (!fullName.trim()) {
          setError('Naam is verplicht');
          setLoading(false);
          return;
        }
        if (password.length < 6) {
          setError('Wachtwoord moet minimaal 6 tekens bevatten');
          setLoading(false);
          return;
        }
        await signUp(email, password, fullName);
      } else {
        await signIn(email, password);
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      const errorMessage = err.message || 'Er is een fout opgetreden';

      // Provide more helpful error messages
      if (errorMessage.includes('Invalid login credentials')) {
        setError('Ongeldige inloggegevens. Controleer je email en wachtwoord.');
      } else if (errorMessage.includes('User already registered')) {
        setError('Dit email adres is al geregistreerd. Probeer in te loggen.');
      } else if (errorMessage.includes('Email not confirmed')) {
        setError('Email nog niet bevestigd. Check je inbox.');
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
          <div className="flex flex-col items-center mb-8">
            <div className="bg-white p-4 rounded-2xl mb-4 border-2 border-blue-600">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">VU</div>
                <div className="text-xs text-gray-600">Amsterdam</div>
              </div>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
              Vrije Universiteit leeromgeving<br/>Epidemiologie en Biostatistiek
            </h1>
            <p className="text-gray-600 text-center">
              {isSignUp ? 'Maak een nieuw account aan' : 'Log in op je account'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {isSignUp && (
              <div>
                <label htmlFor="fullName" className="block text-sm font-semibold text-gray-700 mb-2">
                  Volledige naam
                </label>
                <input
                  id="fullName"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  placeholder="Jan de Vries"
                  required={isSignUp}
                />
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-2">
                E-mailadres
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  placeholder="jouw@email.nl"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-gray-700 mb-2">
                Wachtwoord
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
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  {isSignUp ? 'Account aanmaken' : 'Inloggen'}
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError('');
              }}
              className="text-blue-600 hover:text-blue-700 font-medium transition-colors"
            >
              {isSignUp ? 'Al een account? Log in' : 'Nog geen account? Registreer nu'}
            </button>
          </div>

          {isSignUp && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <p className="text-xs text-gray-500 text-center leading-relaxed">
                De <strong>eerste gebruiker</strong> wordt automatisch <strong>admin</strong>.
                Alle andere registraties worden aangemeld als <strong>student</strong>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
