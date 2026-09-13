import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore, UNAUTHORIZED_EVENT } from '../api/client';
import { authApi } from '../api/endpoints';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (body: { email: string; name: string; password: string; jobTitle?: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then((data) => setUser(data.user))
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  // The API client reports a rejected session here. Clearing `user` is what actually ends the
  // session in the UI — without it the context still holds the old account, RequireAuth keeps
  // rendering protected screens, and LoginPage bounces straight back to them.
  useEffect(() => {
    const endSession = () => {
      setUser(null);
      queryClient.clear();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, endSession);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, endSession);
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: async (email, password) => {
        const data = await authApi.login(email, password);
        // Cached queries belong to whoever was signed in a moment ago. Query keys like
        // ['overview'] are not scoped per user, and defaultOptions sets staleTime, so without
        // this the next account renders the previous account's data — including its
        // `capabilities`, which is what decides whether "+ Program" is shown at all.
        queryClient.clear();
        tokenStore.set(data.token);
        setUser(data.user);
      },
      register: async (body) => {
        const data = await authApi.register(body);
        queryClient.clear();
        tokenStore.set(data.token);
        setUser(data.user);
      },
      logout: () => {
        tokenStore.clear();
        setUser(null);
        // Also drop it on the way out, so a signed-out account's projects are not sitting in
        // memory waiting to be rendered to whoever signs in next.
        queryClient.clear();
      },
    }),
    [user, loading, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
