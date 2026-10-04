import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiClient, type TokenStore } from '../api/client';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface SessionValue {
  client: ApiClient;
  status: Status;
  /** Call after a successful verifyCode. */
  markSignedIn: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  children,
  baseUrl,
  store,
  client: injected,
}: {
  children: ReactNode;
  baseUrl: string;
  store: TokenStore;
  /** Tests inject a client with a fake fetch. */
  client?: ApiClient;
}) {
  const [status, setStatus] = useState<Status>('loading');
  const client = useMemo(
    () => injected ?? new ApiClient({ baseUrl, store, onSignedOut: () => setStatus('signedOut') }),
    [injected, baseUrl, store],
  );

  useEffect(() => {
    let cancelled = false;
    client.isSignedIn().then(
      (signedIn) => !cancelled && setStatus(signedIn ? 'signedIn' : 'signedOut'),
      () => !cancelled && setStatus('signedOut'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const markSignedIn = useCallback(() => setStatus('signedIn'), []);
  const signOut = useCallback(async () => {
    await client.signOut();
    setStatus('signedOut');
  }, [client]);

  const value = useMemo(
    () => ({ client, status, markSignedIn, signOut }),
    [client, status, markSignedIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
