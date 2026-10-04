'use client';

import { useState } from 'react';
import { RequireStaff, useCan } from '../../components/session';
import { ActionForm, ErrorText, SimBadge, Table, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

interface Incident {
  id: string;
  kind: string;
  status: string;
  scooterCode: string | null;
  rideId: string | null;
  description: string;
  resolution: string | null;
  isSimulated: boolean;
  createdAt: string;
}

const RESOLUTIONS = [
  'completed_confirmed',
  'completed_adjusted',
  'cancelled_no_charge',
  'no_action',
  'other',
];

function Incidents() {
  const can = useCan();
  const [status, setStatus] = useState('unresolved');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, reload } = useLoad(
    () => api.request<Incident[]>('GET', `/v1/operator/incidents?status=${status}`),
    [status],
  );
  return (
    <>
      <h1>Incidents</h1>
      <p className="muted">
        Handling an incident never sends a command to a scooter. Ride charges are settled from the
        ride page.
      </p>
      <label>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['unresolved', 'open', 'in_progress', 'resolved'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(i) => i.id}
        empty="No incidents."
        columns={[
          { label: 'Since', render: (i) => formatTime(i.createdAt) },
          {
            label: 'Kind',
            render: (i) => (
              <span className="inline">
                {i.kind} <SimBadge simulated={i.isSimulated} />
              </span>
            ),
          },
          { label: 'Scooter', render: (i) => i.scooterCode ?? '—' },
          {
            label: 'Ride',
            render: (i) => (i.rideId ? <a href={`/rides/${i.rideId}`}>open</a> : '—'),
          },
          { label: 'Description', render: (i) => i.description },
          {
            label: 'Status',
            render: (i) => (i.resolution ? `${i.status} (${i.resolution})` : i.status),
          },
          {
            label: 'Actions',
            render: (i) =>
              can('incidents.resolve') && i.status !== 'resolved' ? (
                <span className="inline">
                  {i.status === 'open' ? (
                    <button
                      className="secondary"
                      onClick={() =>
                        void api
                          .request('POST', `/v1/operator/incidents/${i.id}/assign`, {})
                          .then(reload)
                      }
                    >
                      Take
                    </button>
                  ) : null}
                  <button className="secondary" onClick={() => setSelected(i.id)}>
                    Resolve…
                  </button>
                </span>
              ) : null,
          },
        ]}
      />
      {selected ? (
        <ActionForm
          title="Resolve incident"
          fields={[
            {
              name: 'resolution',
              label: 'Resolution',
              type: 'select',
              options: RESOLUTIONS.map((r) => ({ value: r, label: r })),
            },
            { name: 'note', label: 'What was done' },
          ]}
          submitLabel="Resolve incident"
          onSubmit={async (v) => {
            await api.request('POST', `/v1/operator/incidents/${selected}/resolve`, v);
            setSelected(null);
            reload();
            return 'Incident resolved.';
          }}
        />
      ) : null}
      {can('incidents.resolve') ? (
        <ActionForm
          title="Report an incident"
          fields={[
            {
              name: 'kind',
              label: 'Kind',
              type: 'select',
              options: [
                'damage_report',
                'parking_dispute',
                'billing_dispute',
                'safety_report',
                'other',
              ].map((k) => ({ value: k, label: k })),
            },
            { name: 'description', label: 'Description', type: 'textarea' },
          ]}
          submitLabel="Report incident"
          onSubmit={async (v) => {
            await api.request('POST', '/v1/operator/incidents', v);
            reload();
            return 'Incident reported.';
          }}
        />
      ) : null}
    </>
  );
}

export default function IncidentsPage() {
  return (
    <RequireStaff permission="incidents.read">
      <Incidents />
    </RequireStaff>
  );
}
