'use client';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface StaffSession {
  staffId: string;
  roles: string[];
  permissions: string[];
}

/**
 * Staff API client: HttpOnly SameSite=Strict session cookies set by the API,
 * session-bound CSRF token kept in memory only, one shared refresh on 401.
 * The API enforces every permission; the UI only hides what cannot be used.
 */
class StaffApi {
  private csrf: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  private async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    try {
      return await fetch(`${API_URL}${path}`, {
        method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method !== 'GET' && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Captain API.');
    }
  }

  private async fail(response: Response): Promise<never> {
    const text = await response.text();
    let e: { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
    try {
      e = (JSON.parse(text) as { error?: typeof e }).error;
    } catch {
      e = undefined;
    }
    throw new ApiError(
      response.status,
      e?.code ?? 'HTTP_ERROR',
      e?.message ?? 'Something went wrong.',
      e?.details,
    );
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const response = await this.send('POST', '/v1/auth/refresh', {});
        if (!response.ok) return false;
        await this.loadSession();
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async withRefresh(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    let response = await this.send(method, path, body, headers);
    if (response.status === 401 && !path.startsWith('/v1/auth/')) {
      if (await this.refresh()) response = await this.send(method, path, body, headers);
    }
    return response;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = opts.idempotencyKey
      ? { 'idempotency-key': opts.idempotencyKey }
      : {};
    const response = await this.withRefresh(method, path, body, headers);
    if (!response.ok) return this.fail(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Downloads a file (e.g. CSV export) through the authenticated session. */
  async download(path: string, filename: string) {
    const response = await this.withRefresh('GET', path);
    if (!response.ok) return this.fail(response);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async loadSession(): Promise<StaffSession | null> {
    const response = await this.send('GET', '/v1/auth/session');
    if (response.status === 401) {
      this.csrf = null;
      return null;
    }
    if (!response.ok) return this.fail(response);
    const s = (await response.json()) as {
      type: string;
      staffId?: string;
      roles?: string[];
      permissions?: string[];
      csrfToken: string;
    };
    this.csrf = s.csrfToken;
    return s.type === 'staff' && s.staffId
      ? { staffId: s.staffId, roles: s.roles ?? [], permissions: s.permissions ?? [] }
      : null;
  }

  async currentSession() {
    const session = await this.loadSession();
    if (session) return session;
    return (await this.refresh()) ? this.loadSession() : null;
  }

  requestCode = (email: string) =>
    this.request<{ challengeId: string }>('POST', '/v1/auth/otp/request', {
      audience: 'staff',
      channel: 'email',
      destination: email,
    });

  async verifyCode(challengeId: string, code: string, totpCode?: string) {
    const session = await this.request<{ csrfToken?: string }>('POST', '/v1/auth/otp/verify', {
      challengeId,
      code,
      client: 'web',
      ...(totpCode ? { totpCode } : {}),
    });
    this.csrf = session.csrfToken ?? null;
  }

  async signOut() {
    try {
      await this.request('POST', '/v1/auth/logout', {});
    } finally {
      this.csrf = null;
    }
  }
}

export const api = new StaffApi();

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `s-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === 'FORBIDDEN')
      return 'You do not have permission to do this.';
    return error.message || 'Something went wrong.';
  }
  return 'Something went wrong.';
}
