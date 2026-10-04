'use client';

import { useState } from 'react';
import { RequireStaff } from '../../../components/session';
import { ActionForm, ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatTime } from '../../../lib/format';

interface Staff {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

function StaffAdmin() {
  const { data, error, reload } = useLoad(() => api.request<Staff[]>('GET', '/v1/admin/staff'), []);
  const [selected, setSelected] = useState<Staff | null>(null);
  return (
    <>
      <h1>Staff and roles</h1>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(s) => s.id}
        columns={[
          { label: 'Name', render: (s) => s.displayName },
          { label: 'Email', render: (s) => s.email },
          { label: 'Roles', render: (s) => s.roles.join(', ') },
          { label: 'Status', render: (s) => s.status },
          { label: 'Authenticator', render: (s) => (s.mfaEnabled ? 'enrolled' : 'not enrolled') },
          { label: 'Last sign-in', render: (s) => formatTime(s.lastLoginAt) },
          {
            label: '',
            render: (s) => (
              <button className="secondary" onClick={() => setSelected(s)}>
                Manage…
              </button>
            ),
          },
        ]}
      />
      {selected ? (
        <div className="grid">
          <ActionForm
            key={`roles-${selected.id}`}
            title={`Roles for ${selected.email}`}
            fields={[
              {
                name: 'roles',
                label: 'Roles',
                type: 'select',
                initial: selected.roles.join(','),
                options: [
                  { value: 'operator', label: 'operator' },
                  { value: 'admin', label: 'admin' },
                  { value: 'admin,operator', label: 'admin + operator' },
                ],
              },
              { name: 'reason', label: 'Reason' },
            ]}
            submitLabel="Save roles"
            onSubmit={async (v) => {
              await api.request('PUT', `/v1/admin/staff/${selected.id}/roles`, {
                roles: v.roles!.split(','),
                reason: v.reason,
              });
              reload();
              return 'Roles saved.';
            }}
          />
          <ActionForm
            key={`status-${selected.id}`}
            title={`Status for ${selected.email}`}
            fields={[
              {
                name: 'status',
                label: 'Status',
                type: 'select',
                options: ['active', 'suspended', 'disabled'].map((s) => ({ value: s, label: s })),
              },
              { name: 'reason', label: 'Reason' },
            ]}
            confirm="Suspending or disabling ends this person's sessions."
            submitLabel="Save status"
            onSubmit={async (v) => {
              await api.request('PATCH', `/v1/admin/staff/${selected.id}/status`, v);
              reload();
              return 'Status saved.';
            }}
          />
          <ActionForm
            key={`totp-${selected.id}`}
            title="Reset authenticator"
            fields={[{ name: 'reason', label: 'Reason' }]}
            confirm="The person must enrol a new authenticator; their sessions end."
            danger
            submitLabel="Reset authenticator"
            onSubmit={async (v) => {
              await api.request('POST', `/v1/admin/staff/${selected.id}/totp/reset`, v);
              reload();
              return 'Authenticator reset.';
            }}
          />
        </div>
      ) : null}
      <ActionForm
        title="Add staff member"
        fields={[
          { name: 'email', label: 'Work email' },
          { name: 'displayName', label: 'Name' },
          {
            name: 'roles',
            label: 'Role',
            type: 'select',
            options: [
              { value: 'operator', label: 'operator' },
              { value: 'admin', label: 'admin' },
            ],
          },
          { name: 'reason', label: 'Reason' },
        ]}
        submitLabel="Add staff member"
        onSubmit={async (v) => {
          await api.request('POST', '/v1/admin/staff', {
            email: v.email,
            displayName: v.displayName,
            roles: [v.roles],
            reason: v.reason,
          });
          reload();
          return 'Staff member added. They sign in with their email code.';
        }}
      />
    </>
  );
}

export default function StaffPage() {
  return (
    <RequireStaff permission="staff.manage">
      <StaffAdmin />
    </RequireStaff>
  );
}
