'use client';

import { RequireStaff } from '../../../components/session';
import { ActionForm, ConfirmButton, ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatEtb, formatTime, parseEtb } from '../../../lib/format';

interface Plan {
  planId: string;
  name: string;
  status: string;
  isDevFixture: boolean;
  unlockFeeSantim: number;
  perMinuteSantim: number;
  billingIncrementSeconds: number;
  pausePerMinuteSantim: number | null;
  minStartBalanceSantim: number;
  activatedAt: string | null;
  createdAt: string;
}

const money = (v: string | undefined, label: string) => {
  const santim = parseEtb(v ?? '');
  if (santim === null) throw new Error(`${label}: enter an amount in ETB`);
  return santim;
};
const optionalMoney = (v: string | undefined, label: string) =>
  v?.trim() ? money(v, label) : null;
const optionalInt = (v: string | undefined) => (v?.trim() ? Number.parseInt(v, 10) : null);

/** Pricing values are business decisions (D-PRICE); plans are immutable once active. */
function Pricing() {
  const { data, error, reload } = useLoad(
    () => api.request<Plan[]>('GET', '/v1/admin/pricing-plans'),
    [],
  );
  return (
    <>
      <h1>Pricing plans</h1>
      <p className="muted">
        New rides use the active plan; each ride keeps the prices it started with. Active plans
        cannot be edited.
      </p>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(p) => p.planId}
        empty="No plans."
        columns={[
          { label: 'Name', render: (p) => `${p.name}${p.isDevFixture ? ' (DEV FIXTURE)' : ''}` },
          { label: 'Status', render: (p) => p.status },
          { label: 'Unlock', render: (p) => formatEtb(p.unlockFeeSantim) },
          { label: 'Per minute', render: (p) => formatEtb(p.perMinuteSantim) },
          { label: 'Billing step', render: (p) => `${p.billingIncrementSeconds}s` },
          {
            label: 'Pause/min',
            render: (p) =>
              p.pausePerMinuteSantim === null ? 'no pause' : formatEtb(p.pausePerMinuteSantim),
          },
          { label: 'Min balance', render: (p) => formatEtb(p.minStartBalanceSantim) },
          { label: 'Activated', render: (p) => formatTime(p.activatedAt) },
          {
            label: 'Actions',
            render: (p) =>
              p.status === 'draft' ? (
                <ConfirmButton
                  label="Activate"
                  confirmLabel="Confirm: new rides use this plan"
                  onConfirm={async () => {
                    await api.request('POST', `/v1/admin/pricing-plans/${p.planId}/activate`, {
                      reason: 'activated from staff console',
                    });
                    reload();
                  }}
                />
              ) : null,
          },
        ]}
      />
      <ActionForm
        title="New draft plan"
        fields={[
          { name: 'name', label: 'Name' },
          { name: 'unlock', label: 'Unlock fee (ETB)' },
          { name: 'perMinute', label: 'Per minute (ETB)' },
          { name: 'increment', label: 'Billing step (seconds)', initial: '60' },
          { name: 'pause', label: 'Pause per minute (ETB, empty = no pause)', required: false },
          { name: 'maxPause', label: 'Max pause minutes (empty = none)', required: false },
          { name: 'minBalance', label: 'Minimum balance to start (ETB)' },
          { name: 'hold', label: 'Hold amount (ETB)', initial: '0' },
          {
            name: 'reservationMinutes',
            label: 'Reservation minutes (empty = off)',
            required: false,
          },
          { name: 'reservationFee', label: 'Reservation fee (ETB, with minutes)', required: false },
          {
            name: 'maxRide',
            label: 'Max ride minutes (alert only; empty = none)',
            required: false,
          },
          {
            name: 'floor',
            label: 'Lowest balance a ride may reach (ETB, 0 or negative)',
            initial: '0',
          },
          { name: 'reason', label: 'Reason' },
        ]}
        submitLabel="Create draft"
        onSubmit={async (v) => {
          const floor = parseEtb(v.floor ?? '', true);
          if (floor === null || floor > 0) throw new Error('Lowest balance must be 0 or negative');
          await api.request('POST', '/v1/admin/pricing-plans', {
            name: v.name,
            unlockFeeSantim: money(v.unlock, 'Unlock fee'),
            perMinuteSantim: money(v.perMinute, 'Per minute'),
            billingIncrementSeconds: Number.parseInt(v.increment ?? '60', 10),
            pausePerMinuteSantim: optionalMoney(v.pause, 'Pause'),
            maxPauseMinutes: optionalInt(v.maxPause),
            minStartBalanceSantim: money(v.minBalance, 'Minimum balance'),
            holdAmountSantim: money(v.hold, 'Hold'),
            reservationMinutes: optionalInt(v.reservationMinutes),
            reservationFeeSantim: optionalMoney(v.reservationFee, 'Reservation fee'),
            maxRideMinutes: optionalInt(v.maxRide),
            lowBalanceFloorSantim: floor,
            reason: v.reason,
          });
          reload();
          return 'Draft created.';
        }}
      />
    </>
  );
}

export default function PricingPage() {
  return (
    <RequireStaff permission="pricing.manage">
      <Pricing />
    </RequireStaff>
  );
}
