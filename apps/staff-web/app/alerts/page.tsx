'use client';

import { useState } from 'react';
import { RequireStaff, useCan } from '../../components/session';
import { ConfirmButton, ErrorText, Table, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

interface Alert {
  id: string;
  kind: string;
  severity: string;
  status: string;
  scooterCode: string | null;
  rideId: string | null;
  data: unknown;
  createdAt: string;
}

function Alerts() {
  const can = useCan();
  const [status, setStatus] = useState('unresolved');
  const { data, error, reload } = useLoad(
    () => api.request<Alert[]>('GET', `/v1/operator/alerts?status=${status}`),
    [status],
  );
  return (
    <>
      <h1>Alerts</h1>
      <label>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['unresolved', 'open', 'acknowledged', 'resolved'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(a) => a.id}
        empty="No alerts."
        columns={[
          { label: 'Since', render: (a) => formatTime(a.createdAt) },
          { label: 'Severity', render: (a) => a.severity },
          { label: 'Kind', render: (a) => a.kind },
          { label: 'Scooter', render: (a) => a.scooterCode ?? '—' },
          { label: 'Details', render: (a) => <code>{JSON.stringify(a.data)}</code> },
          { label: 'Status', render: (a) => a.status },
          {
            label: 'Actions',
            render: (a) =>
              can('alerts.manage') && a.status !== 'resolved' ? (
                <span className="inline">
                  {a.status === 'open' ? (
                    <button
                      className="secondary"
                      onClick={() =>
                        void api
                          .request('POST', `/v1/operator/alerts/${a.id}/acknowledge`, {})
                          .then(reload)
                      }
                    >
                      Acknowledge
                    </button>
                  ) : null}
                  <ConfirmButton
                    label="Resolve"
                    onConfirm={async () => {
                      await api.request('POST', `/v1/operator/alerts/${a.id}/resolve`, {});
                      reload();
                    }}
                  />
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}

export default function AlertsPage() {
  return (
    <RequireStaff permission="fleet.read">
      <Alerts />
    </RequireStaff>
  );
}
