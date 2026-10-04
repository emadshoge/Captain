'use client';

import { RequireStaff, useCan } from '../../components/session';
import { ErrorText, Table, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

interface Task {
  id: string;
  scooterCode: string;
  kind: string;
  status: string;
  notes: string | null;
  createdAt: string;
}

function Maintenance() {
  const can = useCan();
  const { data, error, reload } = useLoad(
    () => api.request<Task[]>('GET', '/v1/operator/maintenance'),
    [],
  );
  const set = (id: string, status: string) =>
    void api.request('PATCH', `/v1/operator/maintenance/${id}`, { status }).then(reload);
  return (
    <>
      <h1>Maintenance and repositioning</h1>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(t) => t.id}
        empty="No tasks."
        columns={[
          { label: 'Created', render: (t) => formatTime(t.createdAt) },
          { label: 'Scooter', render: (t) => t.scooterCode },
          { label: 'Kind', render: (t) => t.kind },
          { label: 'Notes', render: (t) => t.notes ?? '' },
          { label: 'Status', render: (t) => t.status },
          {
            label: 'Actions',
            render: (t) =>
              can('maintenance.manage') && (t.status === 'open' || t.status === 'in_progress') ? (
                <span className="inline">
                  {t.status === 'open' ? (
                    <button className="secondary" onClick={() => set(t.id, 'in_progress')}>
                      Start
                    </button>
                  ) : null}
                  <button className="secondary" onClick={() => set(t.id, 'done')}>
                    Done
                  </button>
                  <button className="secondary" onClick={() => set(t.id, 'cancelled')}>
                    Cancel
                  </button>
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}

export default function MaintenancePage() {
  return (
    <RequireStaff permission="fleet.read">
      <Maintenance />
    </RequireStaff>
  );
}
