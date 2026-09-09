import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './store/auth';
import { LoginPage } from './pages/LoginPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { WorkspacePage } from './pages/WorkspacePage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading your portfolio…
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
}

function WorkspaceRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  return <WorkspacePage projectId={projectId!} />;
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <PortfolioPage />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/*"
          element={
            <RequireAuth>
              <WorkspaceRoute />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
