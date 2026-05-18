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
  const { t } = useLanguage();
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
    if (!confirm(t('admin.quizValidation.confirmValidate'))) {
      return;
    }

    setValidating(true);
    try {
      await validateAllQuizQuestions(profile.id, setProgress);
      await loadStats();
      alert(t('admin.quizValidation.validationComplete'));
    } catch (error) {
      console.error('Error validating questions:', error);
      alert(t('admin.quizValidation.validationError'));
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
            <h3 className="font-semibold text-gray-900 mb-1">{t('admin.quizValidation.title')}</h3>
            <p className="text-sm text-gray-700">{t('admin.quizValidation.desc')}</p>
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
              <span className="text-sm font-medium text-gray-600">{t('admin.quizValidation.stat.validated')}</span>
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.validated}</p>
            <p className="text-xs text-gray-500 mt-1">
              {stats.total > 0 ? Math.round((stats.validated / stats.total) * 100) : 0}% {t('admin.quizValidation.stat.ofTotal')}
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{t('admin.quizValidation.stat.manual')}</span>
              <CheckCircle className="w-5 h-5 text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.manuallyApproved}</p>
            <p className="text-xs text-gray-500 mt-1">{t('admin.quizValidation.stat.manuallyApproved')}</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{t('admin.quizValidation.stat.notValidated')}</span>
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.notValidated}</p>
            <p className="text-xs text-gray-500 mt-1">{t('admin.quizValidation.stat.needsReview')}</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">{t('admin.quizValidation.stat.rejected')}</span>
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.rejected}</p>
            <p className="text-xs text-gray-500 mt-1">{t('admin.quizValidation.stat.notRelevant')}</p>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4">{t('admin.quizValidation.bulk.title')}</h3>
        <p className="text-sm text-gray-600 mb-4">{t('admin.quizValidation.bulk.desc')}</p>

        <button
          onClick={handleValidateAll}
          disabled={validating}
          className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Play className="w-5 h-5" />
          {t('admin.quizValidation.bulk.btn')}
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
                {progress.questionsValidated} {t('admin.quizValidation.bulk.of')} {progress.totalQuestions} {t('admin.quizValidation.bulk.processed')}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-gray-900 mb-2">{t('admin.quizValidation.how.title')}</h4>
        <ul className="text-sm text-gray-700 space-y-2">
          <li>{t('admin.quizValidation.how.step1')}</li>
          <li>{t('admin.quizValidation.how.step2')}</li>
          <li>{t('admin.quizValidation.how.step3')}</li>
          <li>{t('admin.quizValidation.how.step4')}</li>
          <li>{t('admin.quizValidation.how.step5')}</li>
        </ul>
      </div>
    </div>
  );
}
