/**
 * Protocol-neutral device adapter contract. A real supplier adapter
 * (`supplier_tcp`) will implement this from the supplier's documentation
 * (decision D-IOT). Nothing here defines packet formats or command codes.
 */
export type CommandType = 'unlock' | 'lock' | 'locate';

export interface DeviceInfo {
  id: string;
  supplierDeviceId: string;
  isSimulated: boolean;
  lastLat: number | null;
  lastLng: number | null;
  batteryPercent: number | null;
  simulation?: unknown;
}

export interface DeviceCommand {
  id: string;
  supplierDeviceId: string;
  type: CommandType;
  deadlineAt: string;
}

export interface CommandResult {
  outcome: 'ack' | 'nack';
  resultCode?: string;
  payload?: Record<string, unknown>;
}

export interface TelemetryReport {
  supplierDeviceId: string;
  recordedAt?: string;
  lat?: number;
  lng?: number;
  batteryPercent?: number;
  speedKmh?: number;
  locked?: boolean;
  raw?: Record<string, unknown>;
}

export interface AdapterEvents {
  telemetry(report: TelemetryReport): void;
  result(commandId: string, result: CommandResult): void;
}

export interface DeviceAdapter {
  readonly name: 'simulated' | 'supplier_tcp';
  readonly isSimulated: boolean;
  start(events: AdapterEvents): Promise<void>;
  /** Replace the set of devices this adapter serves. */
  syncDevices(devices: DeviceInfo[]): void;
  /** Deliver a command; the outcome arrives later through `events.result` (or never). */
  deliver(command: DeviceCommand): Promise<void>;
  stop(): Promise<void>;
}
