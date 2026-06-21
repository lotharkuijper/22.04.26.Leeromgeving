import { ReactNode, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  MessageSquare,
  BookOpen,
  FileQuestion,
  BarChart3,
  Settings,
  LogOut,
  Menu,
  X,
  GraduationCap,
  RefreshCw,
  BookText,
  Package,
  Coffee
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import ActiveCourseBadge from "./ActiveCourseBadge";
import { useLanguage } from '../i18n';
import { LanguageSelector } from './LanguageSelector';
import { useStudiecafeUnread } from '../hooks/useStudiecafeUnread';

interface LayoutProps {
  children: ReactNode;
}

interface NavItemProps {
  to: string;
  icon: React.ElementType;
  label: string;
  active: boolean;
  color: string;
  onClick?: () => void;
  badge?: number;
  badgeTitle?: string;
}

function NavItem({ to, icon: Icon, label, active, color, onClick, badge = 0, badgeTitle }: NavItemProps) {
  const baseClass = "flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium";
  const activeClass = active
    ? `bg-gradient-to-r ${color} text-white shadow-md ring-1 ring-white/30`
    : "text-slate-700 hover:bg-slate-100/70";

  return (
    <Link
      to={to}
      className={`${baseClass} ${activeClass}`}
      onClick={onClick}
    >
      <span className="relative inline-flex">
        <Icon className="w-5 h-5" />
        {badge > 0 && (
          <span
            className={`absolute -top-1.5 -right-1.5 min-w-[1.05rem] h-[1.05rem] px-1 inline-flex items-center justify-center rounded-full text-[10px] font-bold leading-none ring-2 ${active ? 'bg-white text-rose-600 ring-white/40' : 'bg-rose-500 text-white ring-white'}`}
            title={badgeTitle}
            data-testid="badge-studiecafe-unread"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span>{label}</span>
    </Link>
  );
}

export function Layout({ children }: LayoutProps) {
  const { profile, signOut, refreshProfile, isDocent, isAdmin } = useAuth();
  const { activeCourseId } = useActiveCourse();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();

  // De chat-met-document weergave krijgt iets meer horizontale ruimte (nog steeds
  // begrensd); andere pagina's houden de standaardbreedte zodat de algehele
  // opmaak consistent blijft.
  const wideLayout = location.pathname === '/chat';
  const shellMaxWidth = wideLayout ? 'max-w-[1800px]' : 'max-w-7xl';

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Ongelezen-indicator voor het Studiecafé van de actieve cursus.
  const studiecafeUnread = useStudiecafeUnread(activeCourseId);

  const navItems = useMemo(() => {
    const items = [
      { to: '/dashboard', icon: GraduationCap, label: t('nav.dashboard'), color: 'from-gray-600 to-gray-700' },
      { to: '/chat', icon: MessageSquare, label: t('nav.chat'), color: 'from-green-500 to-emerald-600' },
      { to: '/explain', icon: BookOpen, label: t('nav.explain'), color: 'from-blue-500 to-blue-600' },
      { to: '/quiz', icon: FileQuestion, label: t('nav.quiz'), color: 'from-cyan-500 to-cyan-600' },
      { to: '/projects', icon: BarChart3, label: t('nav.projects'), color: 'from-orange-500 to-orange-600' },
      { to: '/studiecafe', icon: Coffee, label: t('nav.studiecafe'), color: 'from-amber-500 to-rose-500' },
      { to: '/feedback', icon: BookText, label: t('nav.feedback'), color: 'from-teal-500 to-teal-600' },
      { to: '/resources', icon: Package, label: t('nav.resources'), color: 'from-purple-500 to-purple-600' },
    ];
    if (isDocent || isAdmin) {
      items.push({ to: '/admin', icon: Settings, label: t('nav.admin'), color: 'from-slate-600 to-slate-700' });
    }
    return items;
  }, [isDocent, isAdmin, t]);

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  }, [signOut]);

  const handleRefreshProfile = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshProfile();
    } catch (error) {
      console.error('Error refreshing profile:', error);
    } finally {
      setRefreshing(false);
    }
  }, [refreshProfile]);

  const roleLabel = isAdmin
    ? t('nav.role.admin')
    : isDocent
    ? t('nav.role.docent')
    : t('nav.role.student');

  return (
    <div className="min-h-screen">
      <nav className="bg-white/75 backdrop-blur-md border-b border-slate-200/70 sticky top-0 z-50 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-100/40">
        <div className={`${shellMaxWidth} mx-auto px-4 sm:px-6 lg:px-8`}>
          <div className="flex items-center justify-between h-16">

            {/* LEFT SIDE: LOGO + TITLE */}
            <div className="flex items-center gap-2">
              <img src="/leap-vu-logo.png" alt="LEAP-VU logo" className="h-10 w-auto" />
              <span className="font-bold text-lg text-gray-900 hidden sm:block">
                LEAP-VU
              </span>
            </div>

            {/* RIGHT SIDE: USER + ROLE + ACTIVE COURSE + BUTTONS */}
            <div className="flex items-center gap-3">

              {/* USER INFO */}
              <div className="hidden md:flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700">{profile?.full_name}</span>
                <span className="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-blue-100 to-green-100 text-blue-700 font-semibold">
                  {roleLabel}
                </span>
              </div>

              {/* ACTIVE COURSE BADGE */}
              <div className="hidden md:flex items-center gap-2">
                <ActiveCourseBadge />
              </div>

              {/* LANGUAGE SELECTOR */}
              <LanguageSelector />

              {/* REFRESH BUTTON */}
              <button
                onClick={handleRefreshProfile}
                disabled={refreshing}
                className="hidden md:flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                title={t('nav.refreshProfileShort')}
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>

              {/* LOGOUT */}
              <button
                onClick={handleLogout}
                className="hidden md:flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                {t('nav.logout')}
              </button>

              {/* MOBILE MENU */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* SIDEBAR + MAIN */}
      <div className={`flex ${shellMaxWidth} mx-auto`}>

        {/* SIDEBAR */}
        <aside className={`
          ${mobileMenuOpen ? 'block' : 'hidden'} md:block
          w-full md:w-64 bg-white/70 backdrop-blur-md border-r border-slate-200/70 ring-1 ring-slate-100/40 md:sticky md:top-16 md:h-[calc(100vh-4rem)]
          fixed inset-0 top-16 z-40 overflow-visible
        `}>
          <div className="p-4 space-y-2">

            {navItems.map((item) => {
              const isStudiecafe = item.to === '/studiecafe';
              const badge = isStudiecafe ? studiecafeUnread.count : 0;
              return (
                <NavItem
                  key={item.to}
                  to={item.to}
                  icon={item.icon}
                  label={item.label}
                  active={location.pathname === item.to}
                  color={item.color}
                  onClick={() => setMobileMenuOpen(false)}
                  badge={badge}
                  badgeTitle={badge > 0 ? t('studiecafe.unread.navTitle', { count: badge }) : undefined}
                />
              );
            })}

            {/* SWITCH COURSE BUTTON */}
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                navigate('/choose-course');
              }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-700 hover:bg-slate-100/70 transition-all font-medium w-full"
            >
              <GraduationCap className="w-5 h-5" />
              <span>{t('nav.switchCourse')}</span>
            </button>

            {/* MOBILE ONLY: LANG SELECTOR + REFRESH + LOGOUT */}
            <div className="md:hidden pt-4 border-t border-gray-200 mt-4 space-y-2">
              <LanguageSelector variant="mobile" onSelect={() => setMobileMenuOpen(false)} />

              <button
                onClick={handleRefreshProfile}
                disabled={refreshing}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full disabled:opacity-50"
              >
                <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>{t('nav.refreshProfile')}</span>
              </button>

              <button
                onClick={handleLogout}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full"
              >
                <LogOut className="w-5 h-5" />
                <span>{t('nav.logout')}</span>
              </button>
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="flex-1 p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
