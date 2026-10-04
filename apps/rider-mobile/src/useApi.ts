import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api/client';
import { t } from './i18n';
import { errorMessage } from './ride/model';

/** Rider-facing message for any thrown error. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return t(errorMessage(error.code, error.details));
  return t('error.generic');
}

/** Loads data on mount (and on reload / optional polling interval). */
export function useApi<T>(load: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(async () => {
    try {
      const value = await loadRef.current();
      setData(value);
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const id = setInterval(() => void reload(), pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, pollMs, ...deps]);

  return { data, error, loading, reload, setData };
}
