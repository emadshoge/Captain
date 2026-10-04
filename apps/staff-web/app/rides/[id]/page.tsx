'use client';

import { useParams } from 'next/navigation';
import { RequireStaff, useCan } from '../../../components/session';
import { ActionForm, ErrorText, SimBadge, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatEtb, formatTime } from '../../../lib/format';
import type { StaffRide } from '../page';

interface Detail {
  ride: StaffRide;
  events: {
    id: number;
    fromStatus: string | null;
    toStatus: string;
    cause: string;
    actorStaffId: string | null;
    data: unknown;
    createdAt: string;
  }[];
}

function RideDetail({ id }: { id: string }) {
  const can = useCan();
  const { data, error, reload } = useLoad(
    () => api.request<Detail>('GET', `/v1/operator/rides/${id}`),
    [id],
  );
  if (!data) return error ? <ErrorText message={error} /> : <p aria-busy="true">Loading…</p>;
  const r = data.ride;
  const open = ['active', 'paused', 'end_requested', 'completion_pending'].includes(r.status);
  return (
    <>
      <h1 className="inline">
        Ride on {r.scooterCode} <SimBadge simulated={r.isSimulated} />
      </h1>
      <section className="card">
        <p>
          Status <strong data-testid="ride-status">{r.status}</strong>
          {r.failureReason ? ` — ${r.failureReason}` : ''}
        </p>
        <p className="muted">
          Rider {r.riderId} · pricing “{r.pricing.name}”
          {r.pricing.isDevFixture ? ' (DEV FIXTURE)' : ''} · parking {r.parkingStatus}
        </p>
        <p>
          Started {formatTime(r.startedAt)} · end requested {formatTime(r.endRequestedAt)} ·
          completed {formatTime(r.completedAt)} · billing cutoff {formatTime(r.billingCutoffAt)}
        </p>
        <p>
          Fare {r.fare ? formatEtb(r.fare.totalSantim) : '—'} · charged {formatEtb(r.chargedSantim)}{' '}
          · unpaid {formatEtb(r.unpaidSantim)}
        </p>
      </section>
      {can('rides.review') && open ? (
        <ActionForm
          title="Send to operator review"
          fields={[{ name: 'reason', label: 'Reason' }]}
          submitLabel="Send to review"
          onSubmit={async (v) => {
            await api.request('POST', `/v1/operator/rides/${id}/review`, v);
            reload();
            return 'Ride sent to review.';
          }}
        />
      ) : null}
      {can('rides.review') && r.status === 'operator_review' ? (
        <ActionForm
          title="Resolve ride"
          testId="resolve-form"
          fields={[
            {
              name: 'action',
              label: 'Outcome',
              type: 'select',
              options: [
                { value: 'complete', label: 'Complete and charge' },
                { value: 'complete_no_charge', label: 'Complete without charge' },
              ],
            },
            {
              name: 'endedAt',
              label: 'Billing cutoff (optional)',
              type: 'datetime-local',
              required: false,
            },
            { name: 'reason', label: 'Reason' },
          ]}
          confirm="I checked the scooter and the ride log; this charge decision is final."
          submitLabel="Resolve ride"
          onSubmit={async (v) => {
            await api.request('POST', `/v1/operator/rides/${id}/resolve`, {
              action: v.action,
              reason: v.reason,
              ...(v.endedAt ? { endedAt: new Date(v.endedAt).toISOString() } : {}),
            });
            reload();
            return 'Ride resolved.';
          }}
        />
      ) : null}
      <h2>Event log</h2>
      <Table
        rows={data.events}
        rowKey={(e) => String(e.id)}
        columns={[
          { label: 'Time', render: (e) => formatTime(e.createdAt) },
          { label: 'Change', render: (e) => `${e.fromStatus ?? '—'} → ${e.toStatus}` },
          { label: 'Cause', render: (e) => e.cause },
          { label: 'Data', render: (e) => <code>{JSON.stringify(e.data)}</code> },
        ]}
      />
    </>
  );
}

export default function RidePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireStaff permission="rides.read">
      <RideDetail id={id} />
    </RequireStaff>
  );
}
