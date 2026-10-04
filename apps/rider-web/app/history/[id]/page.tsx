'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RequireRider } from '../../../components/session';
import { Badge, Card, ErrorText } from '../../../components/ui';
import { api, messageFor, type Ride } from '../../../lib/api';
import { formatEtb, STATUS_TEXT } from '../../../lib/format';

function Line({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="row">
      <span className="muted">{label}</span>
      <strong data-testid={testId}>{value}</strong>
    </div>
  );
}

function ReceiptView({ id }: { id: string }) {
  const [ride, setRide] = useState<Ride | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.ride(id).then(setRide, (e) => setError(messageFor(e)));
  }, [id]);
  if (!ride) return error ? <ErrorText message={error} /> : <p aria-busy="true">Loading…</p>;
  const fare = ride.fare;
  return (
    <Card>
      <h1>Receipt</h1>
      <Badge simulated={ride.isSimulated} devPricing={ride.pricing.isDevFixture} />
      <p className="muted">
        {ride.scooterCode} · {STATUS_TEXT[ride.status]}
      </p>
      {fare ? (
        <>
          <Line label="Unlock" value={formatEtb(fare.unlockFeeSantim)} />
          <Line
            label={`Riding (${Math.ceil(fare.ridingSeconds / 60)} min)`}
            value={formatEtb(fare.ridingSantim)}
          />
          {fare.pausedSeconds > 0 ? (
            <Line
              label={`Paused (${Math.ceil(fare.pausedSeconds / 60)} min)`}
              value={formatEtb(fare.pausedSantim)}
            />
          ) : null}
          <Line label="Total" value={formatEtb(fare.totalSantim)} testId="receipt-total" />
        </>
      ) : null}
      {ride.chargedSantim !== null ? (
        <Line label="Charged from wallet" value={formatEtb(ride.chargedSantim)} />
      ) : null}
      {ride.unpaidSantim ? (
        <Line label="Unpaid balance" value={formatEtb(ride.unpaidSantim)} />
      ) : null}
    </Card>
  );
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireRider>
      <ReceiptView id={id} />
    </RequireRider>
  );
}
