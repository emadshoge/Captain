import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@captain/logging';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, DeviceInfo, TelemetryReport } from '../src/adapters/adapter';
import { SimulatedDeviceAdapter } from '../src/adapters/simulated';
import { InternalApiClient } from '../src/api-client';
import { Gateway } from '../src/gateway';

const silentLogger = createLogger({ service: 'test', level: 'silent', appEnv: 'test' });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function device(id: string, simulation?: unknown): DeviceInfo {
  return {
    id,
    supplierDeviceId: id,
    isSimulated: true,
    lastLat: 9.01,
    lastLng: 38.76,
    batteryPercent: 80,
    simulation,
  };
}

describe('SimulatedDeviceAdapter', () => {
  function harness() {
    const telemetry: TelemetryReport[] = [];
    const results: [string, CommandResult][] = [];
    const adapter = new SimulatedDeviceAdapter({ telemetryIntervalMs: 60_000, random: () => 0 });
    return {
      adapter,
      telemetry,
      results,
      events: {
        telemetry: (r: TelemetryReport) => telemetry.push(r),
        result: (id: string, r: CommandResult) => results.push([id, r]),
      },
    };
  }

  it('acks after the scenario delay, changes lock state, and labels everything simulated', async () => {
    const h = harness();
    await h.adapter.start(h.events);
    h.adapter.syncDevices([device('SIM-1', { delayMs: 10 })]);
    await h.adapter.deliver({
      id: 'c1',
      supplierDeviceId: 'SIM-1',
      type: 'unlock',
      deadlineAt: '',
    });
    expect(h.results).toEqual([]);
    await wait(30);
    expect(h.results).toEqual([
      ['c1', { outcome: 'ack', resultCode: 'SIM_OK', payload: { simulated: true, locked: false } }],
    ]);
    expect(h.telemetry.at(-1)).toMatchObject({
      supplierDeviceId: 'SIM-1',
      locked: false,
      raw: { simulated: true },
    });
    await h.adapter.stop();
  });

  it('follows nack and silence scenarios and ignores unknown devices', async () => {
    const h = harness();
    await h.adapter.start(h.events);
    h.adapter.syncDevices([device('SIM-N', { unlock: 'nack', lock: 'silence', delayMs: 5 })]);
    await h.adapter.deliver({
      id: 'n1',
      supplierDeviceId: 'SIM-N',
      type: 'unlock',
      deadlineAt: '',
    });
    await h.adapter.deliver({ id: 's1', supplierDeviceId: 'SIM-N', type: 'lock', deadlineAt: '' });
    await h.adapter.deliver({
      id: 'u1',
      supplierDeviceId: 'NOT-MINE',
      type: 'unlock',
      deadlineAt: '',
    });
    await wait(30);
    expect(h.results.map(([id, r]) => [id, r.outcome])).toEqual([['n1', 'nack']]);
    await h.adapter.stop();
  });

  it('only moves when unlocked with a configured speed, and ignores real devices', async () => {
    const h = harness();
    await h.adapter.start(h.events);
    h.adapter.syncDevices([
      device('SIM-M', { delayMs: 0, speedKmh: 15 }),
      { ...device('REAL-1'), isSimulated: false },
    ]);
    h.adapter.emitAllTelemetry();
    expect(h.telemetry.map((t) => t.supplierDeviceId)).toEqual(['SIM-M']);
    expect(h.telemetry[0]).toMatchObject({ speedKmh: 0, lat: 9.01, lng: 38.76 });
    await h.adapter.deliver({ id: 'u', supplierDeviceId: 'SIM-M', type: 'unlock', deadlineAt: '' });
    await wait(10);
    h.adapter.emitAllTelemetry();
    const last = h.telemetry.at(-1)!;
    expect(last.speedKmh).toBe(15);
    expect(last.lat).not.toBe(9.01);
    await h.adapter.stop();
  });
});

describe('Gateway with a fake internal API', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  });

  async function fakeApi(
    handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown },
  ) {
    const seen: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        const reply = handler(req, body);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { seen, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
  }

  it('delivers queued commands, posts results with the service token, and batches telemetry', async () => {
    let served = false;
    const api = await fakeApi((req) => {
      if (req.url?.startsWith('/internal/v1/devices'))
        return { status: 200, body: [device('SIM-G', { delayMs: 5 })] };
      if (req.url?.startsWith('/internal/v1/commands/pending')) {
        const body = served
          ? []
          : [
              {
                id: 'cmd-1',
                supplierDeviceId: 'SIM-G',
                type: 'locate',
                deadlineAt: new Date().toISOString(),
              },
            ];
        served = true;
        return { status: 200, body };
      }
      if (req.url?.includes('/result'))
        return { status: 200, body: { accepted: true, late: false, duplicate: false } };
      return { status: 200, body: { results: ['stored'] } };
    });
    const gateway = new Gateway(
      new SimulatedDeviceAdapter({ telemetryIntervalMs: 60_000 }),
      new InternalApiClient(api.url, 't'.repeat(40)),
      silentLogger,
      { commandPollIntervalMs: 20, telemetryFlushIntervalMs: 20 },
    );
    await gateway.start();
    await wait(150);
    await gateway.stop();

    expect(api.seen.every((r) => r.auth === `Bearer ${'t'.repeat(40)}`)).toBe(true);
    const result = api.seen.find((r) => r.url === '/internal/v1/commands/cmd-1/result');
    expect(result?.body).toMatchObject({ outcome: 'ack', payload: { simulated: true } });
    const telemetry = api.seen.filter((r) => r.url === '/internal/v1/telemetry');
    expect(telemetry.length).toBeGreaterThan(0);
    expect(gateway.getStats()).toMatchObject({ adapter: 'simulated', simulated: true, devices: 1 });
  });

  it('does not take commands before the device list has been loaded (API down at start)', async () => {
    let deviceCalls = 0;
    const api = await fakeApi((req) => {
      if (req.url?.startsWith('/internal/v1/devices')) {
        deviceCalls++;
        return deviceCalls === 1
          ? { status: 503, body: {} }
          : { status: 200, body: [device('SIM-L', { delayMs: 5 })] };
      }
      if (req.url?.startsWith('/internal/v1/commands/pending')) {
        return {
          status: 200,
          body: [
            {
              id: 'cmd-late',
              supplierDeviceId: 'SIM-L',
              type: 'unlock',
              deadlineAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (req.url?.includes('/result'))
        return { status: 200, body: { accepted: true, late: false, duplicate: false } };
      return { status: 200, body: { results: ['stored'] } };
    });
    const gateway = new Gateway(
      new SimulatedDeviceAdapter({ telemetryIntervalMs: 60_000 }),
      new InternalApiClient(api.url, 't'.repeat(40)),
      silentLogger,
      { commandPollIntervalMs: 20, telemetryFlushIntervalMs: 20, deviceSyncIntervalMs: 60_000 },
    );
    await gateway.start();
    await wait(150);
    await gateway.stop();
    const urls = api.seen.map((r) => r.url);
    const firstPoll = urls.findIndex((u) => u.startsWith('/internal/v1/commands/pending'));
    const secondSync = urls.findIndex((u, i) => u.startsWith('/internal/v1/devices') && i > 0);
    expect(secondSync).toBeGreaterThan(-1);
    expect(firstPoll).toBeGreaterThan(secondSync);
    expect(
      api.seen.find((r) => r.url === '/internal/v1/commands/cmd-late/result')?.body,
    ).toMatchObject({ outcome: 'ack' });
  });

  it('retries results while the API is failing and drops after a permanent 4xx', async () => {
    let failures = 2;
    const api = await fakeApi((req) => {
      if (req.url === '/internal/v1/commands/keep/result') {
        if (failures-- > 0) return { status: 503, body: {} };
        return { status: 200, body: { accepted: true, late: true, duplicate: false } };
      }
      if (req.url === '/internal/v1/commands/gone/result') return { status: 404, body: {} };
      return { status: 200, body: [] };
    });
    const adapter = new SimulatedDeviceAdapter({ telemetryIntervalMs: 60_000 });
    const gateway = new Gateway(
      adapter,
      new InternalApiClient(api.url, 't'.repeat(40)),
      silentLogger,
      { commandPollIntervalMs: 10_000 },
    );
    await gateway.start();
    // Inject results as if the adapter produced them.
    (gateway as unknown as { results: Map<string, unknown> }).results.set('keep', {
      result: { outcome: 'ack' },
      attempts: 0,
    });
    (gateway as unknown as { results: Map<string, unknown> }).results.set('gone', {
      result: { outcome: 'ack' },
      attempts: 0,
    });
    await gateway.flushResults();
    await gateway.flushResults();
    expect(gateway.getStats().pendingResults).toBe(1); // 'keep' retried, 'gone' dropped
    await gateway.flushResults();
    expect(gateway.getStats().pendingResults).toBe(0);
    expect(api.seen.filter((r) => r.url === '/internal/v1/commands/keep/result')).toHaveLength(3);
    await gateway.stop();
  });

  it('bounds the telemetry buffer and keeps unsent batches for retry', async () => {
    const api = await fakeApi(() => ({ status: 500, body: {} }));
    const gateway = new Gateway(
      new SimulatedDeviceAdapter({ telemetryIntervalMs: 60_000 }),
      new InternalApiClient(api.url, 't'.repeat(40)),
      silentLogger,
      { commandPollIntervalMs: 10_000, maxBufferedTelemetry: 5 },
    );
    for (let i = 0; i < 8; i++) gateway.bufferTelemetry({ supplierDeviceId: `D${i}` });
    expect(gateway.getStats()).toMatchObject({ bufferedTelemetry: 5, droppedTelemetry: 3 });
    await gateway.flushTelemetry();
    expect(gateway.getStats().bufferedTelemetry).toBe(5);
  });
});
