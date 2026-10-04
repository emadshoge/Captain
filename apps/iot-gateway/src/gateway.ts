import type { Logger } from '@captain/logging';
import type { CommandResult, DeviceAdapter, TelemetryReport } from './adapters/adapter';
import type { InternalApiClient } from './api-client';

export interface GatewayOptions {
  commandPollIntervalMs: number;
  telemetryFlushIntervalMs?: number;
  deviceSyncIntervalMs?: number;
  /** Bounded buffers: oldest telemetry is dropped (and counted) when full. */
  maxBufferedTelemetry?: number;
  maxPendingResults?: number;
}

export interface GatewayStats {
  adapter: string;
  simulated: boolean;
  devices: number;
  lastPollAt: string | null;
  bufferedTelemetry: number;
  droppedTelemetry: number;
  pendingResults: number;
  apiErrors: number;
}

/**
 * Bridges a device adapter and the API:
 * - polls queued commands and hands them to the adapter;
 * - forwards command results (retried until accepted; the API is idempotent);
 * - batches telemetry.
 * Never invents commands: it only delivers what the API queued.
 */
export class Gateway {
  private readonly telemetry: TelemetryReport[] = [];
  private readonly results = new Map<string, { result: CommandResult; attempts: number }>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stats: GatewayStats;
  private polling = false;

  constructor(
    private readonly adapter: DeviceAdapter,
    private readonly api: InternalApiClient,
    private readonly logger: Logger,
    private readonly options: GatewayOptions,
  ) {
    this.stats = {
      adapter: adapter.name,
      simulated: adapter.isSimulated,
      devices: 0,
      lastPollAt: null,
      bufferedTelemetry: 0,
      droppedTelemetry: 0,
      pendingResults: 0,
      apiErrors: 0,
    };
  }

  getStats(): GatewayStats {
    return {
      ...this.stats,
      bufferedTelemetry: this.telemetry.length,
      pendingResults: this.results.size,
    };
  }

  async start() {
    await this.adapter.start({
      telemetry: (report) => this.bufferTelemetry(report),
      result: (commandId, result) => {
        this.results.set(commandId, { result, attempts: 0 });
        void this.flushResults();
      },
    });
    await this.syncDevices();
    this.timers.push(
      setInterval(() => void this.pollCommands(), this.options.commandPollIntervalMs),
    );
    this.timers.push(
      setInterval(() => void this.flushTelemetry(), this.options.telemetryFlushIntervalMs ?? 1_000),
    );
    this.timers.push(setInterval(() => void this.flushResults(), 2_000));
    this.timers.push(
      setInterval(() => void this.syncDevices(), this.options.deviceSyncIntervalMs ?? 60_000),
    );
  }

  async stop() {
    for (const timer of this.timers) clearInterval(timer);
    await this.adapter.stop();
    await this.flushResults();
    await this.flushTelemetry();
  }

  async syncDevices() {
    try {
      const devices = await this.api.listDevices(this.adapter.name);
      this.adapter.syncDevices(devices);
      this.stats.devices = devices.length;
    } catch (error) {
      this.stats.apiErrors++;
      this.logger.warn({ err: error }, 'device sync failed');
    }
  }

  async pollCommands() {
    if (this.polling) return;
    this.polling = true;
    try {
      const commands = await this.api.pendingCommands(this.adapter.name);
      this.stats.lastPollAt = new Date().toISOString();
      for (const command of commands) {
        this.logger.info(
          {
            commandId: command.id,
            type: command.type,
            adapter: this.adapter.name,
            simulated: this.adapter.isSimulated,
          },
          'delivering command',
        );
        await this.adapter.deliver(command);
      }
    } catch (error) {
      this.stats.apiErrors++;
      this.logger.warn({ err: error }, 'command poll failed');
    } finally {
      this.polling = false;
    }
  }

  bufferTelemetry(report: TelemetryReport) {
    this.telemetry.push(report);
    const max = this.options.maxBufferedTelemetry ?? 1_000;
    while (this.telemetry.length > max) {
      this.telemetry.shift();
      this.stats.droppedTelemetry++;
    }
  }

  async flushTelemetry() {
    while (this.telemetry.length > 0) {
      const batch = this.telemetry.splice(0, 200);
      try {
        await this.api.postTelemetry(batch);
      } catch (error) {
        // Put the batch back (front) and retry on the next flush.
        this.telemetry.unshift(...batch);
        this.stats.apiErrors++;
        this.logger.warn({ err: error, count: batch.length }, 'telemetry upload failed');
        return;
      }
    }
  }

  async flushResults() {
    for (const [commandId, entry] of [...this.results]) {
      try {
        const response = await this.api.postResult(commandId, entry.result);
        this.results.delete(commandId);
        if (response.late) this.logger.warn({ commandId }, 'API recorded a late acknowledgment');
      } catch (error) {
        entry.attempts++;
        this.stats.apiErrors++;
        const status = (error as { status?: number }).status;
        // 4xx other than 429 will not succeed on retry (e.g. unknown command).
        if (
          (status !== undefined && status >= 400 && status < 500 && status !== 429) ||
          entry.attempts >= 30
        ) {
          this.logger.error(
            { err: error, commandId, attempts: entry.attempts },
            'dropping command result',
          );
          this.results.delete(commandId);
        }
      }
    }
    const max = this.options.maxPendingResults ?? 1_000;
    while (this.results.size > max) this.results.delete(this.results.keys().next().value!);
  }
}
