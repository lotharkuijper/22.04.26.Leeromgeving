import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  MessageSquare,
  BookOpen,
  FileQuestion,
  BarChart3,
  TrendingUp,
  Clock
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  linkTo: string;
}

function StatsCard({ title, value, icon: Icon, color, linkTo }: StatsCardProps) {
  return (
    <Link
      to={linkTo}
      className="bg-white rounded-2xl p-6 border border-gray-200 hover:shadow-xl transition-all group"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600 mb-2">{title}</p>
          <p className="text-3xl font-bold text-gray-900">{value}</p>
        </div>
        <div className={`p-3 rounded-xl bg-gradient-to-br ${color} group-hover:scale-110 transition-transform`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const { profile, isDocent, isAdmin } = useAuth();
  const { t } = useLanguage();
  const [stats, setStats] = useState({
    totalConversations: 0,
    totalExplanations: 0,
    quizAttempts: 0,
    projectSessions: 0,
    recentActivity: [] as any[]
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, [profile?.id]);

  const fetchStats = async () => {
    if (!profile) {
      setStats({
        totalConversations: 0,
        totalExplanations: 0,
        quizAttempts: 0,
        projectSessions: 0,
        recentActivity: []
      });
      setLoading(false);
      return;
    }

    try {
      const [conversationsRes, explanationsRes, quizAttemptsRes, projectSessionsRes] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('status', 'active'),
        supabase.from('student_explanations').select('id', { count: 'exact', head: true }).eq('student_id', profile.id),
        supabase.from('quiz_attempts').select('id', { count: 'exact', head: true }).eq('student_id', profile.id),
        supabase.from('student_project_sessions').select('id', { count: 'exact', head: true }).eq('student_id', profile.id)
      ]);

      setStats({
        totalConversations: conversationsRes.count || 0,
        totalExplanations: explanationsRes.count || 0,
        quizAttempts: quizAttemptsRes.count || 0,
        projectSessions: projectSessionsRes.count || 0,
        recentActivity: []
      });
    } catch (error) {
      console.error('[DASHBOARD] Error fetching stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {t('dashboard.welcomeBack', { name: profile?.full_name || '...' })}
        </h1>
        <p className="text-gray-600">
          {t('dashboard.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title={t('dashboard.activeChats')}
          value={stats.totalConversations}
          icon={MessageSquare}
          color="from-green-500 to-emerald-600"
          linkTo="/chat"
        />
        <StatsCard
          title={t('dashboard.conceptsExplained')}
          value={stats.totalExplanations}
          icon={BookOpen}
          color="from-blue-500 to-blue-600"
          linkTo="/explain"
        />
        <StatsCard
          title={t('dashboard.quizAttempts')}
          value={stats.quizAttempts}
          icon={FileQuestion}
          color="from-cyan-500 to-cyan-600"
          linkTo="/quiz"
        />
        <StatsCard
          title={t('dashboard.projectSessions')}
          value={stats.projectSessions}
          icon={BarChart3}
          color="from-orange-500 to-orange-600"
          linkTo="/projects"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl p-6 border border-gray-200">
          <div className="flex items-center gap-3 mb-4">
            <TrendingUp className="w-6 h-6 text-blue-600" />
            <h2 className="text-xl font-bold text-gray-900">{t('dashboard.yourProgress')}</h2>
          </div>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">{t('dashboard.activeChatSessions')}</span>
                <span className="font-semibold text-gray-900">{stats.totalConversations}</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-emerald-600 transition-all"
                  style={{ width: `${Math.min((stats.totalConversations / 10) * 100, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">{t('dashboard.conceptsMastered')}</span>
                <span className="font-semibold text-gray-900">{stats.totalExplanations}</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
                  style={{ width: `${Math.min((stats.totalExplanations / 20) * 100, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">{t('dashboard.quizScore')}</span>
                <span className="font-semibold text-gray-900">{stats.quizAttempts} {t('dashboard.quizAttemptsSuffix')}</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-cyan-600 transition-all"
                  style={{ width: `${Math.min((stats.quizAttempts / 15) * 100, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-6 border border-gray-200">
          <div className="flex items-center gap-3 mb-4">
            <Clock className="w-6 h-6 text-orange-600" />
            <h2 className="text-xl font-bold text-gray-900">{t('dashboard.quickActions')}</h2>
          </div>
          <div className="space-y-3">
            <Link
              to="/chat"
              className="block p-4 rounded-xl border border-gray-200 hover:border-green-300 hover:bg-green-50 transition-all group"
            >
              <div className="flex items-center gap-3">
                <MessageSquare className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-semibold text-gray-900 group-hover:text-green-700">{t('dashboard.startChat')}</p>
                  <p className="text-sm text-gray-600">{t('dashboard.startChatSub')}</p>
                </div>
              </div>
            </Link>
            <Link
              to="/explain"
              className="block p-4 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all group"
            >
              <div className="flex items-center gap-3">
                <BookOpen className="w-5 h-5 text-blue-600" />
                <div>
                  <p className="font-semibold text-gray-900 group-hover:text-blue-700">{t('dashboard.explainConcept')}</p>
                  <p className="text-sm text-gray-600">{t('dashboard.explainConceptSub')}</p>
                </div>
              </div>
            </Link>
            <Link
              to="/quiz"
              className="block p-4 rounded-xl border border-gray-200 hover:border-cyan-300 hover:bg-cyan-50 transition-all group"
            >
              <div className="flex items-center gap-3">
                <FileQuestion className="w-5 h-5 text-cyan-600" />
                <div>
                  <p className="font-semibold text-gray-900 group-hover:text-cyan-700">{t('dashboard.makeQuiz')}</p>
                  <p className="text-sm text-gray-600">{t('dashboard.makeQuizSub')}</p>
                </div>
              </div>
            </Link>
            <Link
              to="/projects"
              className="block p-4 rounded-xl border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-all group"
            >
              <div className="flex items-center gap-3">
                <BarChart3 className="w-5 h-5 text-orange-600" />
                <div>
                  <p className="font-semibold text-gray-900 group-hover:text-orange-700">{t('dashboard.startProject')}</p>
                  <p className="text-sm text-gray-600">{t('dashboard.startProjectSub')}</p>
                </div>
              </div>
            </Link>
          </div>
        </div>
      </div>

      {(isDocent || isAdmin) && (
        <div className="bg-gradient-to-br from-slate-600 to-slate-700 rounded-2xl p-6 text-white">
          <h2 className="text-xl font-bold mb-2">{t('dashboard.adminAccess')}</h2>
          <p className="text-slate-200 mb-4">
            {t('dashboard.adminAccessDesc', {
              role: isAdmin ? t('dashboard.role.administrator') : t('dashboard.role.docent')
            })}
          </p>
          <Link
            to="/admin"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-white text-slate-700 font-semibold rounded-lg hover:bg-slate-100 transition-colors"
          >
            {t('dashboard.goToAdmin')}
          </Link>
        </div>
      )}
    </div>
  );
}
