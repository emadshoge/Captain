// Build-time public configuration (EXPO_PUBLIC_* values are inlined into the
// JS bundle, so they must never contain secrets). Set per EAS build profile.
export const appConfig = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? 'development',
  /** Mapbox public token (blocked: user action B5). Without it the app shows a list. */
  mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? null,
};
