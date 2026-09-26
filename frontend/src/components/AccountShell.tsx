import type { ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints';
import type { CustomerSummary } from '../api/types';
import { useAuth } from '../store/auth';
import { SignOutIcon } from './icons';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  PROGRAM_OWNER: 'Program owner',
  PROJECT_OWNER: 'Project owner',
};

/** The house default is the customer holding the `*` alias — the FPT Standard every project gets. */
export const isHouseLibrary = (customer: CustomerSummary) => customer.aliases.includes('*');

/** House default first, then the account libraries in the order the API gives them. */
export function orderLibraries(customers: CustomerSummary[]) {
  return [...customers.filter(isHouseLibrary), ...customers.filter((customer) => !isHouseLibrary(customer))];
}

/**
 * The frame every account-level screen shares — Account Libraries and Program Overview — so the
 * two read as one side of the app, the way every project screen shares the workspace sidebar.
 *
 * The sidebar carries the same classes as the workspace's, so it looks the same without a second
 * copy of the styling. Its library tree lists every library by name: a PM opening the SKAX library
 * should not have to land on the FPT one first and then find SKAX in a grid.
 */
export function AccountShell({
  crumb,
  title,
  children,
}: {
  crumb: string;
  title: string;
  children: ReactNode;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const library = useQuery({ queryKey: ['customers'], queryFn: customersApi.list });

  const onLibraries = location.pathname.startsWith('/libraries');
  const selectedLibrary = params.get('lib');
  const libraries = orderLibraries(library.data?.customers ?? []);
  const canWrite = user?.role === 'PROGRAM_OWNER' || user?.role === 'ADMIN';

  return (
    <div className="app-shell account-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>NEXTFIT AI</strong>
            <span>Adaptive Planning Agent</span>
          </div>
        </div>

        <nav aria-label="Account navigation">
          <div className="flow-label">ACCOUNT LIBRARIES</div>
          <button
            className={`nav-item${onLibraries && !selectedLibrary ? ' active' : ''}`}
            onClick={() => navigate('/libraries')}
          >
            <span className="nav-icon">▤</span>
            <span>Libraries</span>
          </button>
          <div className="nav-sub">
            {libraries.map((entry) => (
              <button
                key={entry.id}
                className={`nav-item${onLibraries && selectedLibrary === entry.id ? ' active' : ''}`}
                onClick={() => navigate(`/libraries?lib=${entry.id}`)}
              >
                <span>{entry.name}</span>
              </button>
            ))}
            {canWrite && (
              <button className="nav-item nav-add" onClick={() => navigate('/libraries?new=1')}>
                <span>+ New Library</span>
              </button>
            )}
          </div>

          {/* An administrator never lands on delivery screens; the console is their other half. */}
          <div className="flow-label">{user?.role === 'ADMIN' ? 'ADMINISTRATION' : 'PROGRAM CENTER'}</div>
          {user?.role === 'ADMIN' ? (
            <button className="nav-item" onClick={() => navigate('/admin')}>
              <span className="nav-icon">⚙</span>
              <span>Account console</span>
            </button>
          ) : (
            <button
              className={`nav-item${location.pathname === '/' ? ' active' : ''}`}
              onClick={() => navigate('/')}
            >
              <span className="nav-icon">▦</span>
              <span>Program Overview</span>
            </button>
          )}
        </nav>

        <div className="side-spacer" />
        <div className="profile">
          <div className="avatar">{user?.initials}</div>
          <div>
            <strong>{user?.name}</strong>
            <span>{user?.jobTitle || ROLE_LABEL[user?.role ?? 'PROJECT_OWNER']}</span>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar account-topbar">
          <div className="account-crumb">
            <small>{crumb}</small>
            <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <div className="avatar" title={user?.name}>
              {user?.initials}
            </div>
            <button className="icon-button signout-button" onClick={logout} title="Sign out" aria-label="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </header>
        <div className="account-content">{children}</div>
      </main>
    </div>
  );
}
