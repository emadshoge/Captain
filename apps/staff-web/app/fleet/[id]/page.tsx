'use client';

import { useParams } from 'next/navigation';
import { RequireStaff, useCan } from '../../../components/session';
import { ActionForm, ErrorText, SimBadge, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatTime } from '../../../lib/format';
import type { ScooterRow } from '../page';

interface Detail extends ScooterRow {
  qrToken: string;
  recentTelemetry: {
    receivedAt: string;
    batteryPercent: number | null;
    speedKmh: number | null;
    locked: boolean | null;
    valid: boolean;
    invalidReason: string | null;
  }[];
  alerts: { id: string; kind: string; severity: string; status: string; createdAt: string }[];
  maintenance: {
    id: string;
    kind: string;
    status: string;
    notes: string | null;
    createdAt: string;
  }[];
  commands: {
    id: string;
    type: string;
    status: string;
    issuedBy: string;
    reason: string | null;
    isSimulated: boolean;
    createdAt: string;
    resultCode: string | null;
  }[];
}

function ScooterDetail({ id }: { id: string }) {
  const can = useCan();
  const {
    data: s,
    error,
    reload,
  } = useLoad(() => api.request<Detail>('GET', `/v1/operator/scooters/${id}`), [id]);
  if (!s) return error ? <ErrorText message={error} /> : <p aria-busy="true">Loading…</p>;
  return (
    <>
      <h1 className="inline">
        Scooter {s.code} <SimBadge simulated={s.device?.isSimulated} />
      </h1>
      <section className="card">
        <p>
          Status <strong data-testid="scooter-status">{s.status}</strong> · battery{' '}
          {s.batteryPercent ?? '—'}% · last report {formatTime(s.lastTelemetryAt)}
          {s.stale ? ' (stale)' : ''}
        </p>
        <p className="muted">
          Device:{' '}
          {s.device
            ? `${s.device.supplierDeviceId} (${s.device.adapter}, ${s.device.online ? 'online' : 'offline'})`
            : 'none assigned'}
        </p>
      </section>
      <div className="grid">
        {can('fleet.status.update') ? (
          <ActionForm
            title="Change status"
            testId="status-form"
            fields={[
              {
                name: 'status',
                label: 'New status',
                type: 'select',
                options: ['available', 'maintenance', 'charging', 'missing'].map((v) => ({
                  value: v,
                  label: v,
                })),
              },
              { name: 'reason', label: 'Reason' },
            ]}
            submitLabel="Update status"
            onSubmit={async (v) => {
              await api.request('PATCH', `/v1/operator/scooters/${id}/status`, v);
              reload();
              return 'Status updated.';
            }}
          />
        ) : null}
        {can('device.command.service') ? (
          <ActionForm
            title="Service command"
            fields={[
              {
                name: 'type',
                label: 'Command',
                type: 'select',
                options: ['locate', 'lock', 'unlock'].map((v) => ({ value: v, label: v })),
              },
              { name: 'reason', label: 'Reason' },
            ]}
            confirm="The scooter is stationary and no one is riding it."
            submitLabel="Send command"
            onSubmit={async (v) => {
              await api.request('POST', `/v1/operator/scooters/${id}/commands`, v);
              reload();
              return 'Command queued.';
            }}
          />
        ) : null}
        {can('maintenance.manage') ? (
          <ActionForm
            title="New maintenance task"
            fields={[
              {
                name: 'kind',
                label: 'Kind',
                type: 'select',
                options: [
                  'inspection',
                  'repair',
                  'battery_swap',
                  'charging',
                  'reposition',
                  'other',
                ].map((v) => ({ value: v, label: v })),
              },
              { name: 'notes', label: 'Notes', type: 'textarea', required: false },
            ]}
            submitLabel="Create task"
            onSubmit={async (v) => {
              await api.request('POST', '/v1/operator/maintenance', {
                scooterId: id,
                kind: v.kind,
                ...(v.notes ? { notes: v.notes } : {}),
              });
              reload();
              return 'Task created.';
            }}
          />
        ) : null}
      </div>
      <h2>Commands</h2>
      <Table
        rows={s.commands}
        rowKey={(c) => c.id}
        columns={[
          { label: 'Time', render: (c) => formatTime(c.createdAt) },
          { label: 'Type', render: (c) => c.type },
          { label: 'Status', render: (c) => c.status },
          { label: 'By', render: (c) => c.issuedBy },
          { label: 'Reason', render: (c) => c.reason ?? '' },
          {
            label: 'Result',
            render: (c) => (
              <span className="inline">
                {c.resultCode ?? ''} <SimBadge simulated={c.isSimulated} />
              </span>
            ),
          },
        ]}
      />
      <h2>Alerts</h2>
      <Table
        rows={s.alerts}
        rowKey={(a) => a.id}
        columns={[
          { label: 'Kind', render: (a) => a.kind },
          { label: 'Severity', render: (a) => a.severity },
          { label: 'Status', render: (a) => a.status },
          { label: 'Since', render: (a) => formatTime(a.createdAt) },
        ]}
      />
      <h2>Maintenance</h2>
      <Table
        rows={s.maintenance}
        rowKey={(m) => m.id}
        columns={[
          { label: 'Kind', render: (m) => m.kind },
          { label: 'Status', render: (m) => m.status },
          { label: 'Notes', render: (m) => m.notes ?? '' },
          { label: 'Created', render: (m) => formatTime(m.createdAt) },
        ]}
      />
      <h2>Recent telemetry</h2>
      <Table
        rows={s.recentTelemetry}
        rowKey={(t) => t.receivedAt + String(t.batteryPercent)}
        columns={[
          { label: 'Received', render: (t) => formatTime(t.receivedAt) },
          { label: 'Battery', render: (t) => t.batteryPercent ?? '—' },
          { label: 'Speed', render: (t) => t.speedKmh ?? '—' },
          { label: 'Locked', render: (t) => (t.locked === null ? '—' : t.locked ? 'yes' : 'no') },
          { label: 'Valid', render: (t) => (t.valid ? 'yes' : `no (${t.invalidReason})`) },
        ]}
      />
    </>
  );
}

export default function ScooterPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireStaff permission="fleet.read">
      <ScooterDetail id={id} />
    </RequireStaff>
  );
}
