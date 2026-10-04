'use client';

import { useState } from 'react';
import { RequireStaff, useCan } from '../../../components/session';
import { ActionForm, ConfirmButton, ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatEtb, formatTime } from '../../../lib/format';

interface Payment {
  id: string;
  riderId: string;
  txRef: string;
  amountSantim: number;
  status: string;
  provider: string;
  verifiedAmountSantim: number | null;
  failureReason: string | null;
  createdAt: string;
}

function Payments() {
  const can = useCan();
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad(
    () => api.request<Payment[]>('GET', `/v1/admin/payments${status ? `?status=${status}` : ''}`),
    [status],
  );
  const today = new Date();
  const start = new Date(today.getTime() - 7 * 86_400_000);
  const local = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return (
    <>
      <h1>Payments</h1>
      <p className="muted">
        Credits happen only after server-side verification with the provider. “fake” payments are
        SIMULATED.
      </p>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['', 'review', 'pending', 'succeeded', 'failed', 'expired', 'initiated'].map((s) => (
            <option key={s} value={s}>
              {s || 'any'}
            </option>
          ))}
        </select>
      </label>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(p) => p.id}
        empty="No payments."
        columns={[
          { label: 'Created', render: (p) => formatTime(p.createdAt) },
          { label: 'Reference', render: (p) => <code>{p.txRef}</code> },
          {
            label: 'Provider',
            render: (p) => (p.provider === 'fake' ? 'fake (SIMULATED)' : p.provider),
          },
          { label: 'Amount', render: (p) => formatEtb(p.amountSantim) },
          { label: 'Verified', render: (p) => formatEtb(p.verifiedAmountSantim) },
          {
            label: 'Status',
            render: (p) => (p.failureReason ? `${p.status} (${p.failureReason})` : p.status),
          },
          {
            label: 'Actions',
            render: (p) =>
              can('payments.reconcile') && p.status !== 'succeeded' ? (
                <ConfirmButton
                  label="Re-verify"
                  onConfirm={async () => {
                    await api.request('POST', `/v1/admin/payments/${p.id}/verify`, {});
                    reload();
                  }}
                />
              ) : null,
          },
        ]}
      />
      {can('reports.export') ? (
        <ActionForm
          title="Reconciliation export (CSV, max 31 days)"
          testId="export-form"
          fields={[
            { name: 'from', label: 'From', type: 'datetime-local', initial: local(start) },
            { name: 'to', label: 'To', type: 'datetime-local', initial: local(today) },
          ]}
          submitLabel="Download CSV"
          onSubmit={async (v) => {
            const from = new Date(v.from!).toISOString();
            const to = new Date(v.to!).toISOString();
            await api.download(
              `/v1/admin/payments/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
              `captain-payments-${v.from!.slice(0, 10)}.csv`,
            );
            return 'Export downloaded.';
          }}
        />
      ) : null}
    </>
  );
}

export default function PaymentsPage() {
  return (
    <RequireStaff permission="payments.read">
      <Payments />
    </RequireStaff>
  );
}
