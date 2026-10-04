'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, type StaffSession } from '../lib/api';

type State =
  { status: 'loading' } | { status: 'signedOut' } | ({ status: 'signedIn' } & StaffSession);

const Ctx = createContext<{
  state: State;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const refresh = useCallback(async () => {
    const session = await api.currentSession().catch(() => null);
    setState(session ? { status: 'signedIn', ...session } : { status: 'signedOut' });
  }, []);
  const signOut = useCallback(async () => {
    await api.signOut().catch(() => undefined);
    setState({ status: 'signedOut' });
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await api.currentSession().catch(() => null);
      if (!cancelled)
        setState(session ? { status: 'signedIn', ...session } : { status: 'signedOut' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return <Ctx.Provider value={{ state, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export function useCan() {
  const { state } = useSession();
  return (permission: string) =>
    state.status === 'signedIn' && state.permissions.includes(permission);
}

/**
 * Page guard. Signed-out staff go to sign-in; staff without the page's
 * permission see a refusal (the API refuses the calls regardless).
 */
export function RequireStaff({
  permission,
  children,
}: {
  permission?: string;
  children: ReactNode;
}) {
  const { state } = useSession();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (state.status === 'signedOut' && path !== '/sign-in') router.replace('/sign-in');
  }, [state.status, router, path]);
  if (state.status !== 'signedIn') return <p aria-busy="true">Loading…</p>;
  if (permission && !state.permissions.includes(permission)) {
    return (
      <section className="card" data-testid="forbidden">
        <h1>No access</h1>
        <p>You do not have access to this page.</p>
      </section>
    );
  }
  return <>{children}</>;
}
