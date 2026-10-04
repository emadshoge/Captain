'use client';

import { useState } from 'react';
import { RequireStaff, useSession } from '../../../components/session';
import { ActionForm, ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatEtb, formatTime } from '../../../lib/format';

interface Refund {
  id: string;
  riderId: string;
  amountSantim: number;
  destination: string;
  status: string;
  reason: string;
  requestedByStaffId: string | null;
  decidedByStaffId: string | null;
  providerReference: string | null;
  createdAt: string;
}

function Refunds() {
  const { state } = useSession();
  const me = state.status === 'signedIn' ? state.staffId : null;
  const [status, setStatus] = useState('requested');
  const [deciding, setDeciding] = useState<{
    id: string;
    action: 'approve' | 'reject' | 'complete';
  } | null>(null);
  const { data, error, reload } = useLoad(
    () => api.request<Refund[]>('GET', `/v1/admin/refunds${status ? `?status=${status}` : ''}`),
    [status],
  );
  return (
    <>
      <h1>Refunds</h1>
      <p className="muted">
        Maker-checker: the staff member who requested a refund cannot approve it.
      </p>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['requested', 'approved', 'completed', 'rejected', ''].map((s) => (
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
        empty="No refunds."
        columns={[
          { label: 'Requested', render: (r) => formatTime(r.createdAt) },
          {
            label: 'Rider',
            render: (r) => <a href={`/admin/riders/${r.riderId}`}>{r.riderId.slice(0, 8)}</a>,
          },
          { label: 'Amount', render: (r) => formatEtb(r.amountSantim) },
          { label: 'To', render: (r) => r.destination },
          { label: 'Reason', render: (r) => r.reason },
          { label: 'Status', render: (r) => r.status },
          {
            label: 'Actions',
            render: (r) =>
              r.status === 'requested' ? (
                r.requestedByStaffId === me ? (
                  <span className="muted">Needs another administrator</span>
                ) : (
                  <span className="inline">
                    <button
                      className="secondary"
                      onClick={() => setDeciding({ id: r.id, action: 'approve' })}
                    >
                      Approve…
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setDeciding({ id: r.id, action: 'reject' })}
                    >
                      Reject…
                    </button>
                  </span>
                )
              ) : r.status === 'approved' && r.destination === 'original_payment' ? (
                <button
                  className="secondary"
                  onClick={() => setDeciding({ id: r.id, action: 'complete' })}
                >
                  Record provider refund…
                </button>
              ) : null,
          },
        ]}
      />
      {deciding ? (
        <ActionForm
          key={`${deciding.id}-${deciding.action}`}
          title={
            deciding.action === 'complete'
              ? 'Record the provider refund'
              : `${deciding.action === 'approve' ? 'Approve' : 'Reject'} refund`
          }
          fields={
            deciding.action === 'complete'
              ? [
                  { name: 'providerReference', label: 'Provider refund reference' },
                  { name: 'note', label: 'Note' },
                ]
              : [{ name: 'note', label: 'Note' }]
          }
          confirm={
            deciding.action === 'reject'
              ? undefined
              : 'I verified this refund; money will move when I confirm.'
          }
          submitLabel={
            deciding.action === 'approve'
              ? 'Approve refund'
              : deciding.action === 'reject'
                ? 'Reject refund'
                : 'Complete refund'
          }
          onSubmit={async (v) => {
            await api.request('POST', `/v1/admin/refunds/${deciding.id}/${deciding.action}`, v);
            setDeciding(null);
            reload();
            return 'Saved.';
          }}
        />
      ) : null}
    </>
  );
}

export default function RefundsPage() {
  return (
    <RequireStaff permission="refunds.approve">
      <Refunds />
    </RequireStaff>
  );
}
