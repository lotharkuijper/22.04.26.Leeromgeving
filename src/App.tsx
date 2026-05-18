import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CourseAccessProvider } from './contexts/CourseAccessContext';
import { ActiveCourseProvider } from './contexts/ActiveCourseContext';
import { Layout } from './components/Layout';
import { LoadingSpinner } from './components/LoadingSpinner';
import { LanguageProvider } from './i18n';
import { ProfileLangSync } from './components/ProfileLangSync';
import ChooseCoursePage from "./pages/ChooseCoursePage";
import ShareStatsTopicsPage from "./pages/ShareStatsTopicsPage";
import ShareStatsQuizPage from "./pages/ShareStatsQuizPage";

const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const ChatPage = lazy(() => import('./pages/ChatPage').then(m => ({ default: m.ChatPage })));
const ExplainPage = lazy(() => import('./pages/ExplainPage').then(m => ({ default: m.ExplainPage })));
const QuizPage = lazy(() => import('./pages/QuizPage').then(m => ({ default: m.QuizPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then(m => ({ default: m.ProjectsPage })));
const ProjectRoomPage = lazy(() => import('./pages/ProjectRoomPage').then(m => ({ default: m.ProjectRoomPage })));
const FeedbackPage = lazy(() => import('./pages/FeedbackPage').then(m => ({ default: m.FeedbackPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));
const ResourcesPage = lazy(() => import('./pages/ResourcesPage').then(m => ({ default: m.ResourcesPage })));
const CoursesAdminPage = lazy(() => import('./pages/CoursesAdminPage').then(m => ({ default: m.CoursesAdminPage })));
const TestCourses = lazy(() => import('./pages/TestCourses'));
const FileManager = lazy(() => import('./pages/FileManager'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/login" replace />;

  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingSpinner />;

  return (
    <Suspense fallback={<LoadingSpinner />}>
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

            {/* ShareStats – onderwerpenoverzicht */}
      <Route
        path="/sharestats"
        element={
          <ProtectedRoute>
            <ShareStatsTopicsPage />
          </ProtectedRoute>
        }
      />

      {/* ShareStats – quiz voor gekozen onderwerp */}
      <Route
        path="/sharestats/:topic"
        element={
          <ProtectedRoute>
            <ShareStatsQuizPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/explain"
        element={
          <ProtectedRoute>
            <ExplainPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/quiz"
        element={
          <ProtectedRoute>
            <QuizPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/projects"
        element={
          <ProtectedRoute>
            <ProjectsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/projects/:projectId/group/:groupId"
        element={
          <ProtectedRoute>
            <ProjectRoomPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/feedback"
        element={
          <ProtectedRoute>
            <FeedbackPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/resources"
        element={
          <ProtectedRoute>
            <ResourcesPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/documenten"
        element={
          <ProtectedRoute>
            <DocumentsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/courses"
        element={
          <ProtectedRoute>
            <CoursesAdminPage />
          </ProtectedRoute>
        }
      />
      
      {/* <Route path="/test-courses" element={<TestCourses />} /> */}

      <Route
        path="/filemanager"
        element={
          <ProtectedRoute>
            <FileManager />
          </ProtectedRoute>
        }
      />

      <Route path="/choose-course" element={<ChooseCoursePage />} />

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProfileLangSync />
          <CourseAccessProvider>
            <ActiveCourseProvider>
              <AppRoutes />
            </ActiveCourseProvider>
          </CourseAccessProvider>
        </AuthProvider>
      </BrowserRouter>
    </LanguageProvider>
  );
}

export default App;