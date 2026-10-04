'use client';

import { useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

type State =
  { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; riderId: string };

const SessionContext = createContext<{
  state: State;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const session = await api.currentSession();
      setState(
        session ? { status: 'signedIn', riderId: session.riderId } : { status: 'signedOut' },
      );
    } catch {
      setState({ status: 'signedOut' });
    }
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
        setState(
          session ? { status: 'signedIn', riderId: session.riderId } : { status: 'signedOut' },
        );
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <SessionContext.Provider value={{ state, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/** Renders children only for a signed-in rider; otherwise goes to sign-in. */
export function RequireRider({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'signedOut') router.replace('/sign-in');
  }, [state.status, router]);
  if (state.status !== 'signedIn') return <p aria-busy="true">Loading…</p>;
  return <>{children}</>;
}
