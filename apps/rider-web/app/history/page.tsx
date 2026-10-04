'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RequireRider } from '../../components/session';
import { ErrorText } from '../../components/ui';
import { api, messageFor, type Ride } from '../../lib/api';
import { formatEtb, STATUS_TEXT } from '../../lib/format';

function HistoryView() {
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.rides().then(setRides, (e) => setError(messageFor(e)));
  }, []);
  return (
    <>
      <h1>History</h1>
      <ErrorText message={error} />
      {rides?.length === 0 ? <p className="muted">No rides yet.</p> : null}
      {rides?.map((ride) => (
        <Link key={ride.id} href={`/history/${ride.id}`} className="card">
          <div className="row">
            <span>{new Date(ride.requestedAt).toLocaleString()}</span>
            <strong>{ride.chargedSantim !== null ? formatEtb(ride.chargedSantim) : '—'}</strong>
          </div>
          <span className="muted">
            {ride.scooterCode} · {STATUS_TEXT[ride.status]}
          </span>
        </Link>
      ))}
    </>
  );
}

export default function HistoryPage() {
  return (
    <RequireRider>
      <HistoryView />
    </RequireRider>
  );
}
