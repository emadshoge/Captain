'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RequireStaff } from '../../components/session';
import { ErrorText, SimBadge, Table, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

export interface ScooterRow {
  id: string;
  code: string;
  status: string;
  model: string | null;
  batteryPercent: number | null;
  lat: number | null;
  lng: number | null;
  lastTelemetryAt: string | null;
  stale: boolean;
  device: {
    id: string;
    supplierDeviceId: string;
    adapter: string;
    isSimulated: boolean;
    online: boolean;
  } | null;
  openAlerts: number;
}

const STATUSES = [
  '',
  'available',
  'reserved',
  'in_ride',
  'maintenance',
  'charging',
  'missing',
  'retired',
];

function Fleet() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  });
  const { data, error } = useLoad(
    () => api.request<ScooterRow[]>('GET', `/v1/operator/scooters?${params}`),
    [status, q],
  );
  return (
    <>
      <h1>Fleet</h1>
      <div className="row">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Code
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search code" />
        </label>
      </div>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(s) => s.id}
        columns={[
          { label: 'Code', render: (s) => <Link href={`/fleet/${s.id}`}>{s.code}</Link> },
          { label: 'Status', render: (s) => s.status },
          {
            label: 'Battery',
            render: (s) => (s.batteryPercent === null ? '—' : `${s.batteryPercent}%`),
          },
          {
            label: 'Device',
            render: (s) =>
              s.device ? (
                <span className="inline">
                  {s.device.supplierDeviceId} {s.device.online ? 'online' : 'offline'}{' '}
                  <SimBadge simulated={s.device.isSimulated} />
                </span>
              ) : (
                'none'
              ),
          },
          {
            label: 'Last report',
            render: (s) => `${formatTime(s.lastTelemetryAt)}${s.stale ? ' (stale)' : ''}`,
          },
          { label: 'Alerts', render: (s) => s.openAlerts },
        ]}
      />
    </>
  );
}

export default function FleetPage() {
  return (
    <RequireStaff permission="fleet.read">
      <Fleet />
    </RequireStaff>
  );
}
