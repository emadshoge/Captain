'use client';

import { useParams } from 'next/navigation';
import { useRef } from 'react';
import { RequireStaff, useCan } from '../../../../components/session';
import { ActionForm, ErrorText, Table, useLoad } from '../../../../components/ui';
import { api, newIdempotencyKey } from '../../../../lib/api';
import { formatEtb, formatTime, parseEtb } from '../../../../lib/format';

interface RiderDetail {
  id: string;
  displayName: string | null;
  status: string;
  statusReason: string | null;
  contacts: { kind: string; value: string }[];
  walletBalanceSantim: number;
  heldSantim: number;
  openRideId: string | null;
  createdAt: string;
}
interface WalletView {
  wallet: { balanceSantim: number; heldSantim: number; availableSantim: number };
  transactions: {
    journalId: string;
    kind: string;
    amountSantim: number;
    description: string;
    createdAt: string;
  }[];
}

function amount(value: string, allowNegative: boolean) {
  const santim = parseEtb(value, allowNegative);
  if (santim === null || santim === 0)
    throw new Error('Enter an amount in ETB, e.g. 25.50' + (allowNegative ? ' or -25.50' : ''));
  return santim;
}

function Rider({ id }: { id: string }) {
  const can = useCan();
  const rider = useLoad(() => api.request<RiderDetail>('GET', `/v1/admin/riders/${id}`), [id]);
  const wallet = useLoad(
    () =>
      can('wallet.read')
        ? api.request<WalletView>('GET', `/v1/admin/riders/${id}/wallet`)
        : Promise.resolve(null),
    [id],
  );
  const adjustKey = useRef<string | null>(null);
  const reload = () => {
    rider.reload();
    wallet.reload();
  };
  if (!rider.data)
    return rider.error ? <ErrorText message={rider.error} /> : <p aria-busy="true">Loading…</p>;
  const r = rider.data;
  return (
    <>
      <h1>{r.displayName ?? r.contacts[0]?.value ?? 'Rider'}</h1>
      <section className="card">
        <p>
          Status <strong data-testid="rider-status">{r.status}</strong>
          {r.statusReason ? ` — ${r.statusReason}` : ''}
        </p>
        <p>{r.contacts.map((c) => `${c.kind}: ${c.value}`).join(' · ')}</p>
        <p>
          Balance{' '}
          <strong data-testid="rider-balance">
            {formatEtb(wallet.data?.wallet.balanceSantim ?? r.walletBalanceSantim)}
          </strong>{' '}
          · held {formatEtb(r.heldSantim)}{' '}
          {r.openRideId ? <a href={`/rides/${r.openRideId}`}>· open ride</a> : null}
        </p>
      </section>
      <div className="grid">
        {can('wallet.adjust') ? (
          <ActionForm
            title="Wallet adjustment"
            testId="adjust-form"
            fields={[
              { name: 'amount', label: 'Amount in ETB (negative to debit)' },
              { name: 'reason', label: 'Reason' },
            ]}
            confirm="I understand this changes the rider's balance and is recorded in the audit log."
            submitLabel="Apply adjustment"
            onSubmit={async (v) => {
              adjustKey.current ??= newIdempotencyKey();
              await api.request(
                'POST',
                `/v1/admin/riders/${id}/adjustments`,
                { amountSantim: amount(v.amount!, true), reason: v.reason },
                { idempotencyKey: adjustKey.current },
              );
              adjustKey.current = null;
              reload();
              return 'Adjustment applied.';
            }}
          />
        ) : null}
        {can('refunds.approve') ? (
          <ActionForm
            title="Request a refund"
            fields={[
              { name: 'amount', label: 'Amount in ETB' },
              {
                name: 'destination',
                label: 'Destination',
                type: 'select',
                options: [{ value: 'wallet', label: 'Rider wallet' }],
              },
              { name: 'reason', label: 'Reason' },
            ]}
            submitLabel="Request refund"
            onSubmit={async (v) => {
              await api.request('POST', '/v1/admin/refunds', {
                riderId: id,
                amountSantim: amount(v.amount!, false),
                destination: v.destination,
                reason: v.reason,
              });
              return 'Refund requested. A second administrator must approve it.';
            }}
          />
        ) : null}
        {can('riders.manage') ? (
          <ActionForm
            title={r.status === 'suspended' ? 'Unsuspend rider' : 'Suspend rider'}
            fields={[{ name: 'reason', label: 'Reason' }]}
            confirm={
              r.status === 'suspended'
                ? undefined
                : 'Suspending stops this rider from starting rides.'
            }
            danger={r.status !== 'suspended'}
            submitLabel={r.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
            onSubmit={async (v) => {
              await api.request(
                'POST',
                `/v1/admin/riders/${id}/${r.status === 'suspended' ? 'unsuspend' : 'suspend'}`,
                v,
              );
              reload();
              return 'Status changed.';
            }}
          />
        ) : null}
      </div>
      <h2>Wallet transactions</h2>
      <ErrorText message={wallet.error} />
      <Table
        rows={wallet.data?.transactions ?? (can('wallet.read') ? null : [])}
        rowKey={(t) => t.journalId}
        empty="No transactions."
        columns={[
          { label: 'Time', render: (t) => formatTime(t.createdAt) },
          { label: 'Kind', render: (t) => t.kind },
          { label: 'Description', render: (t) => t.description },
          { label: 'Amount', render: (t) => formatEtb(t.amountSantim) },
        ]}
      />
    </>
  );
}

export default function RiderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireStaff permission="riders.read">
      <Rider id={id} />
    </RequireStaff>
  );
}
