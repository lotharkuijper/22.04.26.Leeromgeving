import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Loader2, Play } from 'lucide-react';
import {
  validateAllQuizQuestions,
  getValidationStatistics,
  ValidationProgressCallback,
  ValidationProgress,
} from '../services/quiz-validation.service';
import { useAuth } from '../contexts/AuthContext';

export function QuizValidationPanel() {
  const { profile } = useAuth();
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
    if (!confirm('Alle quiz vragen valideren tegen cursusmateriaal? Dit kan enkele minuten duren.')) {
      return;
    }

    setValidating(true);
    try {
      await validateAllQuizQuestions(profile.id, setProgress);
      await loadStats();
      alert('Validatie voltooid!');
    } catch (error) {
      console.error('Error validating questions:', error);
      alert('Fout bij validatie');
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
            <h3 className="font-semibold text-gray-900 mb-1">Quiz Validatie</h3>
            <p className="text-sm text-gray-700">
              Dit systeem valideert quiz vragen tegen het cursusmateriaal om ervoor te zorgen dat
              studenten alleen vragen krijgen over onderwerpen die in de documenten worden behandeld.
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
              <span className="text-sm font-medium text-gray-600">Gevalideerd</span>
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.validated}</p>
            <p className="text-xs text-gray-500 mt-1">
              {stats.total > 0 ? Math.round((stats.validated / stats.total) * 100) : 0}% van totaal
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">Handmatig</span>
              <CheckCircle className="w-5 h-5 text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.manuallyApproved}</p>
            <p className="text-xs text-gray-500 mt-1">Handmatig goedgekeurd</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">Niet Gevalideerd</span>
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.notValidated}</p>
            <p className="text-xs text-gray-500 mt-1">Moet gereviewd worden</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">Afgekeurd</span>
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.rejected}</p>
            <p className="text-xs text-gray-500 mt-1">Niet relevant</p>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Bulk Validatie</h3>
        <p className="text-sm text-gray-600 mb-4">
          Valideer alle quiz vragen automatisch tegen de geüploade cursusmateriaal documenten.
          Vragen met een similarity score boven 0.75 worden automatisch goedgekeurd.
        </p>

        <button
          onClick={handleValidateAll}
          disabled={validating}
          className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Play className="w-5 h-5" />
          Valideer Alle Quiz Vragen
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
                {progress.questionsValidated} van {progress.totalQuestions} vragen verwerkt
              </p>
            )}
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-gray-900 mb-2">Hoe werkt validatie?</h4>
        <ul className="text-sm text-gray-700 space-y-2">
          <li>1. Voor elke quiz vraag wordt een embedding gegenereerd</li>
          <li>2. We zoeken naar matching document chunks met cosine similarity</li>
          <li>3. Vragen met similarity ≥ 0.75 worden automatisch gevalideerd</li>
          <li>4. Vragen met score 0.60-0.75 worden gemarkeerd voor handmatige review</li>
          <li>5. Vragen met score &lt; 0.60 zijn waarschijnlijk niet relevant voor de cursus</li>
        </ul>
      </div>
    </div>
  );
}
