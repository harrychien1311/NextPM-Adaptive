import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './store/auth';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AdminPage } from './pages/AdminPage';
import { ProgramOverviewPage } from './pages/ProgramOverviewPage';
import { WorkspacePage } from './pages/WorkspacePage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading your workspace…
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
}

/**
 * Administrators and delivery accounts live on separate sides of the app: an admin never lands on
 * a program or project screen, and a delivery account never lands on the account console.
 */
function DeliveryOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  return user?.role === 'ADMIN' ? <Navigate to="/admin" replace /> : children;
}

function AdminOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  return user?.role === 'ADMIN' ? children : <Navigate to="/" replace />;
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
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DeliveryOnly>
                <ProgramOverviewPage />
              </DeliveryOnly>
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <AdminOnly>
                <AdminPage />
              </AdminOnly>
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/*"
          element={
            <RequireAuth>
              <DeliveryOnly>
                <WorkspaceRoute />
              </DeliveryOnly>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
