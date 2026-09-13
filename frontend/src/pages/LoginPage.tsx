import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { ApiError } from '../api/client';

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('lina.vuong@nextpm.local');
  const [password, setPassword] = useState('NextPM!2026');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Declarative redirect, not navigate() during render: a render-phase side effect here is what
  // let an already-rejected session ping-pong between /login and the protected routes.
  if (user) return <Navigate to="/" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>NextPM</strong>
            <span>Adaptive</span>
          </div>
        </div>
        <h1>Sign in to your workspace</h1>
        <p>Program roll-up, AI governance-model recommendations and PM-approved planning packs.</p>
        {error && <div className="auth-error">{error}</div>}
        <label>
          Work email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="auth-hint">
          Seeded demo accounts · NextPM!2026
          <br />
          lina.vuong@nextpm.local (program owner) · nam.hoang@nextpm.local (project owner) · admin@nextpm.local
        </p>
        <p className="auth-hint">
          Don't have an account? <Link to="/register">Sign up</Link>
        </p>
      </form>
    </div>
  );
}
