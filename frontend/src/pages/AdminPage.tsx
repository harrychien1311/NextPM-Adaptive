import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../api/endpoints';
import type { AdminAccount, Role } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';
import { SignOutIcon } from '../components/icons';
import { ApiError } from '../api/client';

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  PROGRAM_OWNER: 'Program owner',
  PROJECT_OWNER: 'Project owner',
};

const ROLE_HINT: Record<Role, string> = {
  ADMIN: 'Manages accounts only — no access to any project workspace.',
  PROGRAM_OWNER: 'Creates programs and projects, and can open every workspace.',
  PROJECT_OWNER: 'Creates projects, but only opens the ones it owns or was granted.',
};

/**
 * Administrator console. This is the only screen an ADMIN account can reach: the API refuses
 * administrators on every delivery route, so account management is genuinely their whole scope.
 */
export function AdminPage() {
  const { user, logout } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();

  const accounts = useQuery({ queryKey: ['admin-users'], queryFn: adminApi.users });

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<AdminAccount | null>(null);

  const fail = (title: string) => (error: unknown) =>
    notify({ title, detail: error instanceof ApiError ? error.message : 'Unexpected error' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const createUser = useMutation({
    mutationFn: adminApi.createUser,
    onSuccess: () => {
      refresh();
      notify({ title: 'Account created', detail: 'The new account can sign in immediately.' });
      setCreateOpen(false);
    },
    onError: fail('Could not create account'),
  });

  const updateUser = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: Role; active?: boolean } }) => adminApi.updateUser(id, body),
    onSuccess: () => {
      refresh();
      notify({ title: 'Account updated' });
    },
    onError: fail('Could not update account'),
  });

  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => adminApi.resetPassword(id, password),
    onSuccess: () => {
      notify({ title: 'Password reset', detail: 'Share the new password with the account holder.' });
      setResetFor(null);
    },
    onError: fail('Could not reset password'),
  });

  const deleteUser = useMutation({
    mutationFn: adminApi.deleteUser,
    onSuccess: () => {
      refresh();
      notify({ title: 'Account deleted' });
    },
    onError: fail('Could not delete account'),
  });

  const users = accounts.data?.users ?? [];
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return users.filter(
      (account) =>
        (roleFilter === 'all' || account.role === roleFilter) &&
        (!query || account.name.toLowerCase().includes(query) || account.email.toLowerCase().includes(query)),
    );
  }, [users, search, roleFilter]);

  if (accounts.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading accounts…
      </div>
    );
  }

  const counts = accounts.data?.counts;

  return (
    <>
      <section className="portfolio-screen">
        <header className="portfolio-top">
          <div className="brand portfolio-brand">
            <div className="brand-mark">N</div>
            <div>
              <strong>NEXTFIT AI</strong>
              <span>Adaptive Planning Agent</span>
            </div>
          </div>
          <div className="portfolio-level">
            <span>ADMIN CONSOLE</span>
            <b>User accounts</b>
          </div>
          <div className="portfolio-profile">
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>Administrator</span>
            </div>
            {/* Last child, so sign out is the top-right corner — the same place on every screen. */}
            <button className="icon-button signout-button" onClick={logout} title="Sign out" aria-label="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </header>

        <main className="portfolio-main admin-main">
          <div className="portfolio-title">
            <div>
              <p>ACCOUNT MANAGEMENT</p>
              <h1>Users, roles and access</h1>
              <span>
                Create accounts, assign a role, reset a forgotten password or retire an account. A PROGRAM OWNER can
                only be created here — self sign-up always produces a project owner.
              </span>
            </div>
            <div className="portfolio-create-actions">
              {/* Configuration, not delivery data — see the route comment in App.tsx. */}
              <Link className="secondary button-link" to="/customers">
                Customer library
              </Link>
              <button className="primary" onClick={() => setCreateOpen(true)}>
                + New account
              </button>
            </div>
          </div>

          {counts && (
            <div className="portfolio-summary">
              <article>
                <span>ACCOUNTS</span>
                <strong>{counts.total}</strong>
                <small>{counts.active} active</small>
              </article>
              <article>
                <span>PROGRAM OWNERS</span>
                <strong>{counts.programOwners}</strong>
                <small>May create programs</small>
              </article>
              <article>
                <span>PROJECT OWNERS</span>
                <strong>{counts.projectOwners}</strong>
                <small>May create projects</small>
              </article>
              <article>
                <span>ADMINISTRATORS</span>
                <strong>{counts.admins}</strong>
                <small>Account management only</small>
              </article>
            </div>
          )}

          <div className="portfolio-toolbar">
            <div className="project-filters">
              {(['all', 'PROGRAM_OWNER', 'PROJECT_OWNER', 'ADMIN'] as const).map((option) => (
                <button
                  key={option}
                  className={roleFilter === option ? 'active' : ''}
                  onClick={() => setRoleFilter(option)}
                >
                  {option === 'all' ? 'All roles' : ROLE_LABEL[option]}{' '}
                  <b>{option === 'all' ? users.length : users.filter((account) => account.role === option).length}</b>
                </button>
              ))}
            </div>
            <div>
              <input
                placeholder="Search name or email…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>

          <div className="account-table">
            <div className="account-row account-head">
              <span>Account</span>
              <span>Role</span>
              <span>Projects</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {visible.map((account) => {
              const isSelf = account.id === user?.id;
              return (
                <div className={`account-row${account.active ? '' : ' inactive'}`} key={account.id}>
                  <div className="account-identity">
                    <div className="avatar">{account.initials}</div>
                    <div>
                      <strong>
                        {account.name}
                        {isSelf && <em> (you)</em>}
                      </strong>
                      <small>
                        {account.email} · {account.jobTitle}
                      </small>
                    </div>
                  </div>
                  <div>
                    <select
                      value={account.role}
                      disabled={isSelf || updateUser.isPending}
                      title={ROLE_HINT[account.role]}
                      onChange={(event) =>
                        updateUser.mutate({ id: account.id, body: { role: event.target.value as Role } })
                      }
                    >
                      {(Object.keys(ROLE_LABEL) as Role[]).map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="account-counts">
                    <span>
                      <b>{account.ownedProjects}</b> owned
                    </span>
                    <span>
                      <b>{account.memberships}</b> member of
                    </span>
                  </div>
                  <div>
                    <span className={`project-status ${account.active ? 'active-status' : 'closed-status'}`}>
                      {account.active ? '● Active' : '○ Disabled'}
                    </span>
                  </div>
                  <div className="account-actions">
                    <button className="secondary" onClick={() => setResetFor(account)}>
                      Reset password
                    </button>
                    <button
                      className="secondary"
                      disabled={isSelf || updateUser.isPending}
                      onClick={() => updateUser.mutate({ id: account.id, body: { active: !account.active } })}
                    >
                      {account.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      className="secondary danger"
                      disabled={isSelf || deleteUser.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete ${account.email}? This cannot be undone.`)) {
                          deleteUser.mutate(account.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {visible.length === 0 && <div className="program-empty">No account matches this filter.</div>}
          </div>
        </main>
      </section>

      <Backdrop open={createOpen || resetFor !== null} onClose={() => (createOpen ? setCreateOpen(false) : setResetFor(null))} />

      <CreateAccountModal
        open={createOpen}
        busy={createUser.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(body) => createUser.mutate(body)}
      />
      <ResetPasswordModal
        account={resetFor}
        busy={resetPassword.isPending}
        onClose={() => setResetFor(null)}
        onSubmit={(password) => resetFor && resetPassword.mutate({ id: resetFor.id, password })}
      />
    </>
  );
}

function CreateAccountModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { email: string; name: string; password: string; jobTitle?: string; role: Role }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('Project Manager');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('PROJECT_OWNER');

  return (
    <ModalShell open={open} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>NEW ACCOUNT</small>
          <h2>Create a user account</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ email: email.trim(), name: name.trim(), password, jobTitle, role });
        }}
      >
        <label>
          Full name *
          <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
        </label>
        <div className="create-grid">
          <label>
            Email *
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Job title
            <input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
          </label>
          <label>
            Initial password *
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              placeholder="At least 8 characters"
            />
          </label>
          <label>
            Role *
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="create-note">
          <span>🔑</span>
          <p>{ROLE_HINT[role]}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ResetPasswordModal({
  account,
  busy,
  onClose,
  onSubmit,
}: {
  account: AdminAccount | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');

  return (
    <ModalShell open={account !== null} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>RESET PASSWORD</small>
          <h2>{account?.name}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(password);
          setPassword('');
        }}
      >
        <label>
          New password *
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
            placeholder="At least 8 characters"
          />
        </label>
        <div className="create-note">
          <span>✉</span>
          <p>
            The account signs in with this password immediately. NEXTFIT AI does not email it — pass it to {account?.email}{' '}
            through your normal channel and ask them to change it.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
