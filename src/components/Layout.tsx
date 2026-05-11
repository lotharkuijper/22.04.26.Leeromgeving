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
  Package
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import ActiveCourseBadge from "./ActiveCourseBadge";

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
}

function NavItem({ to, icon: Icon, label, active, color, onClick }: NavItemProps) {
  const baseClass = "flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium";
  const activeClass = active
    ? `bg-gradient-to-r ${color} text-white shadow-lg`
    : "text-gray-700 hover:bg-gray-100";

  return (
    <Link
      to={to}
      className={`${baseClass} ${activeClass}`}
      onClick={onClick}
    >
      <Icon className="w-5 h-5" />
      <span>{label}</span>
    </Link>
  );
}

export function Layout({ children }: LayoutProps) {
  const { profile, signOut, refreshProfile, isDocent, isAdmin } = useAuth();
  const { activeCourseId } = useActiveCourse();
  const location = useLocation();
  const navigate = useNavigate();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const navItems = useMemo(() => {
    const items = [
      { to: '/dashboard', icon: GraduationCap, label: 'Dashboard', color: 'from-gray-600 to-gray-700' },
      { to: '/chat', icon: MessageSquare, label: 'Chat', color: 'from-green-500 to-emerald-600' },
      { to: '/explain', icon: BookOpen, label: 'Ik Leg Uit', color: 'from-blue-500 to-blue-600' },
      { to: '/quiz', icon: FileQuestion, label: 'Quiz', color: 'from-cyan-500 to-cyan-600' },
      { to: '/projects', icon: BarChart3, label: 'Projecten', color: 'from-orange-500 to-orange-600' },
      { to: '/feedback', icon: BookText, label: 'Leer Dagboek', color: 'from-teal-500 to-teal-600' },
      { to: '/resources', icon: Package, label: 'Bronnen', color: 'from-purple-500 to-purple-600' },
    ];
    if (isDocent || isAdmin) {
      items.push({ to: '/admin', icon: Settings, label: 'Beheer', color: 'from-slate-600 to-slate-700' });
    }
    return items;
  }, [isDocent, isAdmin]);

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

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">

            {/* LEFT SIDE: LOGO + TITLE */}
            <div className="flex items-center gap-3">
              <div className="bg-white p-2 rounded-lg border-2 border-blue-600">
                <div className="text-center leading-tight">
                  <div className="text-sm font-bold text-blue-600">VU</div>
                  <div className="text-[8px] text-gray-600">Amsterdam</div>
                </div>
              </div>
              <span className="font-bold text-lg text-gray-900 hidden sm:block">
                VU Leeromgeving Epi & Biostat
              </span>
            </div>

            {/* RIGHT SIDE: USER + ROLE + ACTIVE COURSE + BUTTONS */}
            <div className="flex items-center gap-4">

              {/* USER INFO */}
              <div className="hidden md:flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700">{profile?.full_name}</span>
                <span className="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-blue-100 to-green-100 text-blue-700 font-semibold">
                  {isAdmin ? 'Admin' : isDocent ? 'Docent' : 'Student'}
                </span>
              </div>

              {/* ACTIVE COURSE BADGE */}
              <div className="hidden md:flex items-center gap-2">
                <ActiveCourseBadge />
              </div>

              {/* REFRESH BUTTON */}
              <button
                onClick={handleRefreshProfile}
                disabled={refreshing}
                className="hidden md:flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                title="Ververs profiel"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>

              {/* LOGOUT */}
              <button
                onClick={handleLogout}
                className="hidden md:flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Uitloggen
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
      <div className="flex max-w-7xl mx-auto">

        {/* SIDEBAR */}
        <aside className={`
          ${mobileMenuOpen ? 'block' : 'hidden'} md:block
          w-full md:w-64 bg-white border-r border-gray-200 md:sticky md:top-16 md:h-[calc(100vh-4rem)]
          fixed inset-0 top-16 z-40 overflow-visible
        `}>
          <div className="p-4 space-y-2">

            {navItems.map((item) => (
              <NavItem
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={item.label}
                active={location.pathname === item.to}
                color={item.color}
                onClick={() => setMobileMenuOpen(false)}
              />
            ))}

            {/*
              Task #52: ShareStats-oefenen is verwijderd uit de zijbalk.
              De /sharestats-routes blijven bestaan in App.tsx zodat oude
              deeplinks en de Beheer-import nog werken; in fase 2 keert
              ShareStats terug als één van de bronnen onder de nieuwe
              quiz-architectuur.
            */}

            {/* SWITCH COURSE BUTTON */}
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                navigate('/choose-course');
              }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full"
            >
              <GraduationCap className="w-5 h-5" />
              <span>Wissel cursus</span>
            </button>

            {/* MOBILE ONLY: REFRESH + LOGOUT */}
            <div className="md:hidden pt-4 border-t border-gray-200 mt-4 space-y-2">
              <button
                onClick={handleRefreshProfile}
                disabled={refreshing}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full disabled:opacity-50"
              >
                <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>Ververs Profiel</span>
              </button>

              <button
                onClick={handleLogout}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full"
              >
                <LogOut className="w-5 h-5" />
                <span>Uitloggen</span>
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
