import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { ApiError } from '../api/client';

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  // Empty, not prefilled with a seeded account: a sign-in form that arrives already holding
  // somebody's credentials invites signing in as them by accident, and publishes a working
  // password to anyone who opens the page.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
            <strong>NEXTFIT AI</strong>
            <span>Adaptive</span>
          </div>
        </div>
        <h1>Sign in to your workspace</h1>
        {/*
          Replaced a feature list ("program roll-up, AI governance-model recommendations…") —
          internal vocabulary that means nothing to someone who has not used the app yet, which is
          everyone reading this screen.
        */}
        {/* Typographic apostrophe, as the rest of the app's copy uses. */}
        <p>Let’s plan your project</p>
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
          Don't have an account? <Link to="/register">Sign up</Link>
        </p>
      </form>
    </div>
  );
}
