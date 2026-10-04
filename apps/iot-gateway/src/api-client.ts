import type { CommandResult, DeviceCommand, DeviceInfo, TelemetryReport } from './adapters/adapter';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Client for the API's /internal/v1 endpoints (shared service token). */
export class InternalApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 5_000,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new ApiError(response.status, `${method} ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  }

  listDevices(adapter: string) {
    return this.call<DeviceInfo[]>('GET', `/internal/v1/devices?adapter=${adapter}`);
  }

  pendingCommands(adapter: string) {
    return this.call<DeviceCommand[]>('GET', `/internal/v1/commands/pending?adapter=${adapter}`);
  }

  postResult(commandId: string, result: CommandResult) {
    return this.call<{ accepted: true; late: boolean; duplicate: boolean }>(
      'POST',
      `/internal/v1/commands/${commandId}/result`,
      result,
    );
  }

  postTelemetry(reports: TelemetryReport[]) {
    return this.call<{ results: string[] }>('POST', '/internal/v1/telemetry', { reports });
  }
}
