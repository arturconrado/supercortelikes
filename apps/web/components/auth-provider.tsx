'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, clearSession, endpoints, hasSession, storedUser, unwrap } from '@/lib/api';
import type { User } from '@/lib/types';

type AuthContextValue = { user?: User; loading: boolean; logout: () => void; refresh: () => Promise<void> };
const AuthContext = createContext<AuthContextValue>({ loading: true, logout() {}, async refresh() {} });
const PUBLIC_ROUTES = new Set(['/login', '/register', '/forgot-password', '/terms', '/privacy', '/refunds']);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);
  const router = useRouter(); const pathname = usePathname();
  const refresh = useCallback(async () => {
    if (!hasSession()) { setUser(undefined); setLoading(false); return; }
    const cached = storedUser();
    if (cached) setUser(cached);
    setLoading(true);
    try {
      const identity = unwrap(await api<(User & { displayName?: string }) | { data: User & { displayName?: string } }>(endpoints.me));
      setUser({ ...identity, name: identity.name ?? identity.displayName ?? cached?.name ?? identity.email });
    }
    catch { if (!hasSession()) setUser(undefined); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = () => {
      const cached = storedUser();
      if (cached) setUser(cached);
      void refresh();
    };
    window.addEventListener('clipbr:session', listener);
    return () => window.removeEventListener('clipbr:session', listener);
  }, [refresh]);
  useEffect(() => { if (!loading && !user && !PUBLIC_ROUTES.has(pathname)) router.replace(`/login?next=${encodeURIComponent(pathname)}`); }, [loading, user, pathname, router]);
  const logout = () => { clearSession(); setUser(undefined); router.replace('/login'); };
  return <AuthContext.Provider value={{ user, loading, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
