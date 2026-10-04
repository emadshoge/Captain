'use client';

import Link from 'next/link';
import { RequireStaff, useCan, useSession } from '../components/session';
import { useLoad } from '../components/ui';
import { api } from '../lib/api';

function Count({
  label,
  href,
  load,
}: {
  label: string;
  href: string;
  load: () => Promise<unknown[]>;
}) {
  const { data, error } = useLoad(load, []);
  return (
    <Link href={href} className="card" data-testid={`count-${href}`}>
      <span className="muted">{label}</span>
      <strong style={{ fontSize: 28 }}>{error ? '!' : (data?.length ?? '…')}</strong>
    </Link>
  );
}

function Overview() {
  const { state } = useSession();
  const can = useCan();
  return (
    <>
      <h1>Overview</h1>
      <p className="muted">
        Signed in with roles: {state.status === 'signedIn' ? state.roles.join(', ') : ''}. Real
        payments, SMS and supplier devices are not connected yet; anything marked SIMULATED is test
        data.
      </p>
      <div className="grid">
        {can('fleet.read') ? (
          <Count
            label="Unresolved alerts"
            href="/alerts"
            load={() => api.request<unknown[]>('GET', '/v1/operator/alerts')}
          />
        ) : null}
        {can('rides.read') ? (
          <Count
            label="Rides in operator review"
            href="/rides"
            load={() => api.request<unknown[]>('GET', '/v1/operator/rides?status=operator_review')}
          />
        ) : null}
        {can('incidents.read') ? (
          <Count
            label="Open incidents"
            href="/incidents"
            load={() => api.request<unknown[]>('GET', '/v1/operator/incidents')}
          />
        ) : null}
        {can('payments.read') ? (
          <Count
            label="Payments needing review"
            href="/admin/payments"
            load={() => api.request<unknown[]>('GET', '/v1/admin/payments?status=review')}
          />
        ) : null}
        {can('refunds.approve') ? (
          <Count
            label="Refunds awaiting decision"
            href="/admin/refunds"
            load={() => api.request<unknown[]>('GET', '/v1/admin/refunds?status=requested')}
          />
        ) : null}
      </div>
    </>
  );
}

export default function Home() {
  return (
    <RequireStaff>
      <Overview />
    </RequireStaff>
  );
}
