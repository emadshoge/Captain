'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RequireStaff } from '../../components/session';
import { ErrorText, SimBadge, Table, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { formatEtb, formatTime } from '../../lib/format';

export interface StaffRide {
  id: string;
  status: string;
  scooterCode: string;
  riderId: string;
  isSimulated: boolean;
  requestedAt: string;
  startedAt: string | null;
  endRequestedAt: string | null;
  completedAt: string | null;
  billingCutoffAt: string | null;
  parkingStatus: string;
  fare: { totalSantim: number } | null;
  fareIsEstimate: boolean;
  chargedSantim: number | null;
  unpaidSantim: number | null;
  failureReason: string | null;
  pricing: { name: string; isDevFixture: boolean };
}

const STATUSES = [
  '',
  'operator_review',
  'unlock_pending',
  'active',
  'paused',
  'completion_pending',
  'completed',
  'start_failed',
];

function Rides() {
  const [status, setStatus] = useState('operator_review');
  const { data, error } = useLoad(
    () => api.request<StaffRide[]>('GET', `/v1/operator/rides${status ? `?status=${status}` : ''}`),
    [status],
  );
  return (
    <>
      <h1>Rides</h1>
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
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(r) => r.id}
        empty="No rides."
        columns={[
          {
            label: 'Requested',
            render: (r) => <Link href={`/rides/${r.id}`}>{formatTime(r.requestedAt)}</Link>,
          },
          {
            label: 'Scooter',
            render: (r) => (
              <span className="inline">
                {r.scooterCode} <SimBadge simulated={r.isSimulated} />
              </span>
            ),
          },
          { label: 'Status', render: (r) => r.status },
          {
            label: 'Fare',
            render: (r) =>
              r.fare ? `${formatEtb(r.fare.totalSantim)}${r.fareIsEstimate ? ' (est.)' : ''}` : '—',
          },
          { label: 'Charged', render: (r) => formatEtb(r.chargedSantim) },
          { label: 'Issue', render: (r) => r.failureReason ?? '' },
        ]}
      />
    </>
  );
}

export default function RidesPage() {
  return (
    <RequireStaff permission="rides.read">
      <Rides />
    </RequireStaff>
  );
}
