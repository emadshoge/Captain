'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RequireStaff } from '../../../components/session';
import { ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatTime } from '../../../lib/format';

interface RiderSummary {
  id: string;
  displayName: string | null;
  status: string;
  contacts: { kind: string; value: string }[];
  createdAt: string;
}

function Riders() {
  const [q, setQ] = useState('');
  const { data, error } = useLoad(
    () =>
      api.request<RiderSummary[]>(
        'GET',
        `/v1/admin/riders${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
    [q],
  );
  return (
    <>
      <h1>Riders</h1>
      <label>
        Search phone, email or name
        <input value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(r) => r.id}
        empty="No riders."
        columns={[
          {
            label: 'Rider',
            render: (r) => (
              <Link href={`/admin/riders/${r.id}`}>
                {r.displayName ?? r.contacts[0]?.value ?? r.id}
              </Link>
            ),
          },
          { label: 'Contacts', render: (r) => r.contacts.map((c) => c.value).join(', ') },
          { label: 'Status', render: (r) => r.status },
          { label: 'Joined', render: (r) => formatTime(r.createdAt) },
        ]}
      />
    </>
  );
}

export default function RidersPage() {
  return (
    <RequireStaff permission="riders.read">
      <Riders />
    </RequireStaff>
  );
}
