import type { AdapterEvents, DeviceAdapter, DeviceCommand, DeviceInfo } from './adapter';

/**
 * SIMULATED hardware for development and testing. Every report and result is
 * labelled `simulated: true`; the API also knows these devices are simulated
 * (devices.is_simulated) and production refuses them.
 *
 * Behaviour per device comes from its scenario (set via the admin
 * simulation endpoint): ack / nack / silence per command type, a reply delay,
 * and a reported speed.
 */
export interface Scenario {
  unlock: 'ack' | 'nack' | 'silence';
  lock: 'ack' | 'nack' | 'silence';
  locate: 'ack' | 'nack' | 'silence';
  delayMs: number;
  speedKmh: number;
}

const DEFAULT_SCENARIO: Scenario = {
  unlock: 'ack',
  lock: 'ack',
  locate: 'ack',
  delayMs: 500,
  speedKmh: 0,
};

interface SimState {
  info: DeviceInfo;
  lat: number;
  lng: number;
  battery: number;
  locked: boolean;
  scenario: Scenario;
}

export class SimulatedDeviceAdapter implements DeviceAdapter {
  readonly name = 'simulated' as const;
  readonly isSimulated = true;
  private events: AdapterEvents | null = null;
  private readonly devices = new Map<string, SimState>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private telemetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      telemetryIntervalMs: number;
      random?: () => number;
      now?: () => Date;
    } = {
      telemetryIntervalMs: 10_000,
    },
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  async start(events: AdapterEvents): Promise<void> {
    this.events = events;
    this.telemetryTimer = setInterval(
      () => this.emitAllTelemetry(),
      this.options.telemetryIntervalMs,
    );
  }

  syncDevices(devices: DeviceInfo[]): void {
    const seen = new Set<string>();
    for (const info of devices.filter((d) => d.isSimulated)) {
      seen.add(info.supplierDeviceId);
      const scenario = { ...DEFAULT_SCENARIO, ...((info.simulation as Partial<Scenario>) ?? {}) };
      const existing = this.devices.get(info.supplierDeviceId);
      if (existing) {
        existing.info = info;
        existing.scenario = scenario;
      } else {
        this.devices.set(info.supplierDeviceId, {
          info,
          // Default position: central Addis Ababa when the device has never reported.
          lat: info.lastLat ?? 9.0108,
          lng: info.lastLng ?? 38.7613,
          battery: info.batteryPercent ?? 90,
          locked: true,
          scenario,
        });
      }
    }
    for (const key of this.devices.keys()) if (!seen.has(key)) this.devices.delete(key);
  }

  async deliver(command: DeviceCommand): Promise<void> {
    const device = this.devices.get(command.supplierDeviceId);
    if (!device) return; // unknown to this adapter: the API will time the command out
    const behaviour = device.scenario[command.type];
    if (behaviour === 'silence') return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (behaviour === 'ack') {
        if (command.type === 'unlock') device.locked = false;
        if (command.type === 'lock') device.locked = true;
      }
      this.events?.result(command.id, {
        outcome: behaviour,
        resultCode: behaviour === 'ack' ? 'SIM_OK' : 'SIM_REJECTED',
        payload: { simulated: true, locked: device.locked },
      });
      this.emitTelemetry(device);
    }, device.scenario.delayMs);
    this.timers.add(timer);
  }

  emitAllTelemetry() {
    for (const device of this.devices.values()) this.emitTelemetry(device);
  }

  private emitTelemetry(device: SimState) {
    const random = this.options.random ?? Math.random;
    const moving = !device.locked && device.scenario.speedKmh > 0;
    if (moving) {
      // ~speed km/h along a random heading for one interval.
      const metres =
        (device.scenario.speedKmh * 1000 * this.options.telemetryIntervalMs) / 3_600_000;
      const heading = random() * 2 * Math.PI;
      device.lat += (metres * Math.cos(heading)) / 111_320;
      device.lng +=
        (metres * Math.sin(heading)) / (111_320 * Math.cos((device.lat * Math.PI) / 180));
      device.battery = Math.max(0, device.battery - 0.05);
    }
    this.events?.telemetry({
      supplierDeviceId: device.info.supplierDeviceId,
      recordedAt: this.now().toISOString(),
      lat: Number(device.lat.toFixed(6)),
      lng: Number(device.lng.toFixed(6)),
      batteryPercent: Math.round(device.battery),
      speedKmh: moving ? device.scenario.speedKmh : 0,
      locked: device.locked,
      raw: { simulated: true },
    });
  }

  async stop(): Promise<void> {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
