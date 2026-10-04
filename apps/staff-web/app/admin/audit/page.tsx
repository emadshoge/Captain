'use client';

import { useState } from 'react';
import { RequireStaff } from '../../../components/session';
import { ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatTime } from '../../../lib/format';

interface Entry {
  id: number;
  actorType: string;
  actorStaffId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  createdAt: string;
}

function Audit() {
  const [action, setAction] = useState('');
  const { data, error } = useLoad(
    () =>
      api.request<{ entries: Entry[] }>(
        'GET',
        `/v1/admin/audit?limit=100${action.trim() ? `&action=${encodeURIComponent(action.trim())}` : ''}`,
      ),
    [action],
  );
  return (
    <>
      <h1>Audit trail</h1>
      <label>
        Action
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="e.g. wallet.adjusted"
        />
      </label>
      <ErrorText message={error} />
      <Table
        rows={data?.entries ?? null}
        rowKey={(e) => String(e.id)}
        columns={[
          { label: 'Time', render: (e) => formatTime(e.createdAt) },
          {
            label: 'Actor',
            render: (e) => (e.actorStaffId ? `staff ${e.actorStaffId.slice(0, 8)}` : e.actorType),
          },
          { label: 'Action', render: (e) => e.action },
          { label: 'Target', render: (e) => `${e.targetType} ${e.targetId ?? ''}` },
          { label: 'Reason', render: (e) => e.reason ?? '' },
        ]}
      />
    </>
  );
}

export default function AuditPage() {
  return (
    <RequireStaff permission="audit.read">
      <Audit />
    </RequireStaff>
  );
}
