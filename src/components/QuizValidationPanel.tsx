import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Loader2, Play } from 'lucide-react';
import {
  validateAllQuizQuestions,
  getValidationStatistics,
  ValidationProgressCallback,
  ValidationProgress,
} from '../services/quiz-validation.service';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../i18n';

export function QuizValidationPanel() {
  const { profile } = useAuth();
  const { lang } = useLanguage();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [progress, setProgress] = useState<ValidationProgress | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    try {
      const data = await getValidationStatistics();
      setStats(data);
    } catch (error) {
      console.error('Error loading statistics:', error);
    }
    setLoading(false);
  };

  const handleValidateAll = async () => {
    if (!profile?.id) return;
    if (!confirm(lang === 'en'
      ? 'Validate all quiz questions against course material? This may take several minutes.'
      : 'Alle quiz vragen valideren tegen cursusmateriaal? Dit kan enkele minuten duren.')) {
      return;
    }

    setValidating(true);
    try {
      await validateAllQuizQuestions(profile.id, setProgress);
      await loadStats();
      alert(lang === 'en' ? 'Validation complete!' : 'Validatie voltooid!');
    } catch (error) {
      console.error('Error validating questions:', error);
      alert(lang === 'en' ? 'Error during validation' : 'Fout bij validatie');
    }
    setValidating(false);
    setProgress(null);
  };

  return (
    <div className="space-y-6">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">{lang === 'en' ? 'Quiz Validation' : 'Quiz Validatie'}</h3>
            <p className="text-sm text-gray-700">
              {lang === 'en'
                ? 'This system validates quiz questions against the course material to ensure students only receive questions about topics covered in the documents.'
                : 'Dit systeem valideert quiz vragen tegen het cursusmateriaal om ervoor te zorgen dat studenten alleen vragen krijgen over onderwerpen die in de documenten worden behandeld.'}
            </p>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      )}

      {!loading && stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{lang === 'en' ? 'Validated' : 'Gevalideerd'}</span>
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.validated}</p>
            <p className="text-xs text-gray-500 mt-1">
              {stats.total > 0 ? Math.round((stats.validated / stats.total) * 100) : 0}% {lang === 'en' ? 'of total' : 'van totaal'}
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{lang === 'en' ? 'Manual' : 'Handmatig'}</span>
              <CheckCircle className="w-5 h-5 text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.manuallyApproved}</p>
            <p className="text-xs text-gray-500 mt-1">{lang === 'en' ? 'Manually approved' : 'Handmatig goedgekeurd'}</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{lang === 'en' ? 'Not Validated' : 'Niet Gevalideerd'}</span>
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.notValidated}</p>
            <p className="text-xs text-gray-500 mt-1">{lang === 'en' ? 'Needs review' : 'Moet gereviewd worden'}</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{lang === 'en' ? 'Rejected' : 'Afgekeurd'}</span>
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.rejected}</p>
            <p className="text-xs text-gray-500 mt-1">{lang === 'en' ? 'Not relevant' : 'Niet relevant'}</p>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4">{lang === 'en' ? 'Bulk Validation' : 'Bulk Validatie'}</h3>
        <p className="text-sm text-gray-600 mb-4">
          {lang === 'en'
            ? 'Automatically validate all quiz questions against the uploaded course material documents. Questions with a similarity score above 0.75 are automatically approved.'
            : 'Valideer alle quiz vragen automatisch tegen de geüploade cursusmateriaal documenten. Vragen met een similarity score boven 0.75 worden automatisch goedgekeurd.'}
        </p>

        <button
          onClick={handleValidateAll}
          disabled={validating}
          className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Play className="w-5 h-5" />
          {lang === 'en' ? 'Validate All Quiz Questions' : 'Valideer Alle Quiz Vragen'}
        </button>

        {progress && (
          <div className="mt-6">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-700">{progress.message}</span>
              <span className="font-medium">{progress.progress}%</span>
            </div>
            <div className="w-full bg-blue-200 rounded-full h-3">
              <div
                className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            {progress.questionsValidated !== undefined && progress.totalQuestions !== undefined && (
              <p className="text-sm text-gray-600 mt-2">
                {progress.questionsValidated} {lang === 'en' ? 'of' : 'van'} {progress.totalQuestions} {lang === 'en' ? 'questions processed' : 'vragen verwerkt'}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-gray-900 mb-2">{lang === 'en' ? 'How does validation work?' : 'Hoe werkt validatie?'}</h4>
        <ul className="text-sm text-gray-700 space-y-2">
          {lang === 'en' ? (
            <>
              <li>1. An embedding is generated for each quiz question</li>
              <li>2. We search for matching document chunks using cosine similarity</li>
              <li>3. Questions with similarity ≥ 0.75 are automatically validated</li>
              <li>4. Questions with score 0.60–0.75 are flagged for manual review</li>
              <li>5. Questions with score &lt; 0.60 are likely not relevant to the course</li>
            </>
          ) : (
            <>
              <li>1. Voor elke quiz vraag wordt een embedding gegenereerd</li>
              <li>2. We zoeken naar matching document chunks met cosine similarity</li>
              <li>3. Vragen met similarity ≥ 0.75 worden automatisch gevalideerd</li>
              <li>4. Vragen met score 0.60-0.75 worden gemarkeerd voor handmatige review</li>
              <li>5. Vragen met score &lt; 0.60 zijn waarschijnlijk niet relevant voor de cursus</li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}
