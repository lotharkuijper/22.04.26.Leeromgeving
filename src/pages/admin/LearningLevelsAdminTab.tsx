import { useCallback, useEffect, useState } from 'react';
import { GraduationCap, RefreshCw, AlertTriangle, Lock } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { LEVEL_MIN, LEVEL_MAX } from '../../hooks/useLearningLevel';

interface LevelRow {
  user_id: string;
  name: string | null;
  email: string | null;
  level: number;
  label: string | null;
  updated_at: string | null;
}

interface LevelsResponse {
  levels: LevelRow[];
  distribution: Record<string, number>;
  total: number;
  defaultLevel: number;
  warning?: string;
}

const LEVELS = Array.from({ length: LEVEL_MAX - LEVEL_MIN + 1 }, (_, i) => LEVEL_MIN + i);

// Vaste kleuren per niveau (beginner → expert), zodat de verdeling visueel
// leesbaar is. Read-only: dit paneel toont alleen, het wijzigt niets.
const LEVEL_BAR_COLORS: Record<number, string> = {
  1: 'bg-sky-400',
  2: 'bg-emerald-400',
  3: 'bg-amber-400',
  4: 'bg-orange-400',
  5: 'bg-rose-400',
};

export function LearningLevelsAdminTab() {
  const { t, lang } = useLanguage();
  const { session } = useAuth();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [data, setData] = useState<LevelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCourseId || !session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/courses/${activeCourseId}/learning-levels?lang=${encodeURIComponent(lang)}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d as LevelsResponse);
    } catch (e: any) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [activeCourseId, session?.access_token, lang]);

  useEffect(() => {
    load();
  }, [load]);

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(lang === 'nl' ? 'nl-NL' : undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  if (!activeCourseId) {
    return (
      <div className="text-sm text-gray-500" data-testid="text-learning-levels-no-course">
        {t('admin.learningLevels.noCourse')}
      </div>
    );
  }

  const maxCount = data
    ? Math.max(1, ...LEVELS.map(l => data.distribution?.[String(l)] || 0))
    : 1;

  return (
    <div className="space-y-5" data-testid="panel-learning-levels">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-blue-600" />
            {t('admin.learningLevels.title')}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.learningLevels.intro', { course: activeCourse?.name || '' })}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          data-testid="button-refresh-learning-levels"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('admin.learningLevels.refresh')}
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-gray-400">
        <Lock className="w-3.5 h-3.5" />
        {t('admin.learningLevels.readonlyNote')}
      </div>

      {data?.warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="banner-learning-levels-warning">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{t('admin.learningLevels.warning')}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="text-learning-levels-error">
          {t('admin.learningLevels.error', { message: error })}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-gray-500" data-testid="text-learning-levels-loading">
          {t('admin.learningLevels.loading')}
        </div>
      )}

      {data && (
        <>
          {/* Geaggregeerde verdeling per niveau */}
          <div className="chic-card p-4" data-testid="block-learning-levels-distribution">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              {t('admin.learningLevels.distributionTitle')}
            </h3>
            <div className="space-y-2">
              {LEVELS.map(l => {
                const count = data.distribution?.[String(l)] || 0;
                const pct = Math.round((count / maxCount) * 100);
                const label = data.levels.find(r => r.level === l)?.label || `${l}`;
                return (
                  <div key={l} className="flex items-center gap-3" data-testid={`row-distribution-level-${l}`}>
                    <div className="w-28 shrink-0 text-xs text-gray-500 truncate" title={label}>
                      {l}. {label}
                    </div>
                    <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                      <div
                        className={`h-full ${LEVEL_BAR_COLORS[l] || 'bg-blue-400'} transition-all`}
                        style={{ width: count > 0 ? `${Math.max(pct, 6)}%` : '0%' }}
                      />
                    </div>
                    <div className="w-8 shrink-0 text-right text-sm font-medium text-gray-700" data-testid={`count-level-${l}`}>
                      {count}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-gray-400">
              {t('admin.learningLevels.total', { count: String(data.total) })}
            </p>
          </div>

          {/* Per-student lijst */}
          {data.levels.length === 0 ? (
            <div className="text-sm text-gray-500" data-testid="text-learning-levels-empty">
              <p>{t('admin.learningLevels.empty')}</p>
              <p className="mt-1 text-xs text-gray-400">
                {t('admin.learningLevels.emptyHint', { level: String(data.defaultLevel) })}
              </p>
            </div>
          ) : (
            <div className="chic-card overflow-hidden">
              <table className="w-full text-sm" data-testid="table-learning-levels">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    <th className="px-4 py-2.5">{t('admin.learningLevels.colName')}</th>
                    <th className="px-4 py-2.5">{t('admin.learningLevels.colLevel')}</th>
                    <th className="px-4 py-2.5">{t('admin.learningLevels.colUpdated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.levels.map(row => (
                    <tr
                      key={row.user_id}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50"
                      data-testid={`row-student-level-${row.user_id}`}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-800" data-testid={`text-student-name-${row.user_id}`}>
                          {row.name || row.email || row.user_id}
                        </div>
                        {row.name && row.email && (
                          <div className="text-xs text-gray-400">{row.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium text-gray-700 bg-gray-100"
                          data-testid={`badge-student-level-${row.user_id}`}
                        >
                          <span className={`w-2 h-2 rounded-full ${LEVEL_BAR_COLORS[row.level] || 'bg-blue-400'}`} />
                          {row.level}. {row.label || ''}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500">{formatDate(row.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
