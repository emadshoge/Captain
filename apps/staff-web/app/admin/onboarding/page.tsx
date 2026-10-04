'use client';

import { RequireStaff } from '../../../components/session';
import { ActionForm } from '../../../components/ui';
import { api } from '../../../lib/api';

/**
 * Scooter and device onboarding. Real supplier devices can be registered but
 * cannot be commanded until the supplier protocol is documented (D-IOT).
 */
function Onboarding() {
  return (
    <>
      <h1>Onboarding</h1>
      <div className="grid">
        <ActionForm
          title="Add scooter"
          fields={[
            { name: 'code', label: 'Printed code (A-Z, 0-9, -)' },
            { name: 'model', label: 'Model', required: false },
            { name: 'reason', label: 'Reason' },
          ]}
          submitLabel="Add scooter"
          onSubmit={async (v) => {
            const s = await api.request<{ id: string; code: string }>(
              'POST',
              '/v1/admin/scooters',
              {
                code: v.code!.trim().toUpperCase(),
                reason: v.reason,
                ...(v.model ? { model: v.model } : {}),
              },
            );
            return `Scooter ${s.code} added (id ${s.id}).`;
          }}
        />
        <ActionForm
          title="Register device"
          fields={[
            { name: 'supplierDeviceId', label: 'Device ID (from the supplier label)' },
            {
              name: 'adapter',
              label: 'Adapter',
              type: 'select',
              options: [
                { value: 'simulated', label: 'Simulated (test only; refused in production)' },
                { value: 'supplier_tcp', label: 'Supplier TCP (protocol not implemented yet)' },
              ],
            },
            { name: 'reason', label: 'Reason' },
          ]}
          submitLabel="Register device"
          onSubmit={async (v) => {
            const d = await api.request<{ id: string }>('POST', '/v1/admin/devices', v);
            return `Device registered (id ${d.id}).`;
          }}
        />
        <ActionForm
          title="Assign device to scooter"
          fields={[
            { name: 'scooterId', label: 'Scooter id' },
            { name: 'deviceId', label: 'Device id' },
            { name: 'reason', label: 'Reason' },
          ]}
          submitLabel="Assign"
          onSubmit={async (v) => {
            await api.request('POST', `/v1/admin/scooters/${v.scooterId!.trim()}/device`, {
              deviceId: v.deviceId!.trim(),
              reason: v.reason,
            });
            return 'Device assigned.';
          }}
        />
      </div>
    </>
  );
}

export default function OnboardingPage() {
  return (
    <RequireStaff permission="fleet.manage">
      <Onboarding />
    </RequireStaff>
  );
}
