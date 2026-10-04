import * as SecureStore from 'expo-secure-store';
import type { Tokens, TokenStore } from '../api/client';

const KEY = 'captain.session.v1';

/**
 * Tokens are kept only in the OS keychain (iOS) / Keystore-backed storage
 * (Android), readable after the first unlock of the device. Never in
 * AsyncStorage, logs or analytics.
 */
export const secureTokenStore: TokenStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Tokens>;
      return parsed.accessToken && parsed.refreshToken
        ? { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
        : null;
    } catch {
      return null;
    }
  },
  async save(tokens) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY);
  },
};

export function memoryTokenStore(
  initial: Tokens | null = null,
): TokenStore & { current: Tokens | null } {
  const store = {
    current: initial,
    load: async () => store.current,
    save: async (tokens: Tokens) => {
      store.current = tokens;
    },
    clear: async () => {
      store.current = null;
    },
  };
  return store;
}
