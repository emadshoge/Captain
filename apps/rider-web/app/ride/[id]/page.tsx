'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RequireRider } from '../../../components/session';
import { Badge, Card, ErrorText } from '../../../components/ui';
import { api, messageFor, type Ride } from '../../../lib/api';
import { formatDuration, formatEtb, OPEN_STATUSES, STATUS_TEXT } from '../../../lib/format';

/** Best-effort location; never blocks ending a ride (an unanswered prompt times out). */
function position(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const timer = setTimeout(() => resolve(null), 6_000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 5_000, maximumAge: 30_000 },
    );
  });
}

function RideView({ id }: { id: string }) {
  const [ride, setRide] = useState<Ride | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const open = ride ? OPEN_STATUSES.includes(ride.status) : true;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.ride(id);
        if (!cancelled) setRide(next);
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    };
    void load();
    if (!open) {
      return () => {
        cancelled = true;
      };
    }
    const poll = setInterval(() => void load(), 2_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [id, open]);

  async function act(action: 'pause' | 'resume' | 'end') {
    if (!ride) return;
    setBusy(action);
    setError(null);
    try {
      setRide(
        action === 'pause'
          ? await api.pause(ride.id)
          : action === 'resume'
            ? await api.resume(ride.id)
            : await api.endRide(ride.id, await position()),
      );
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ride) return error ? <ErrorText message={error} /> : <p aria-busy="true">Loading…</p>;
  const elapsed = ride.startedAt
    ? ((ride.endRequestedAt ? Date.parse(ride.endRequestedAt) : now) - Date.parse(ride.startedAt)) /
      1000
    : 0;
  const fare = ride.fare;
  return (
    <Card>
      <h1 data-testid="ride-status">{STATUS_TEXT[ride.status]}</h1>
      <Badge simulated={ride.isSimulated} devPricing={ride.pricing.isDevFixture} />
      <div className="stats">
        <div className="stat">
          <span>Scooter</span>
          <strong>{ride.scooterCode}</strong>
        </div>
        {ride.startedAt ? (
          <div className="stat">
            <span>Time</span>
            <strong>{formatDuration(elapsed)}</strong>
          </div>
        ) : null}
        {fare ? (
          <div className="stat">
            <span>{ride.fareIsEstimate ? 'Estimated cost' : 'Total'}</span>
            <strong data-testid="fare">{formatEtb(fare.totalSantim)}</strong>
          </div>
        ) : null}
      </div>
      {ride.status === 'completed' && ride.chargedSantim !== null ? (
        <div className="row">
          <span className="muted">Charged from wallet</span>
          <strong data-testid="charged">{formatEtb(ride.chargedSantim)}</strong>
        </div>
      ) : null}
      {ride.parkingStatus === 'outside' ? (
        <p className="error">Parked outside the allowed area.</p>
      ) : null}
      <ErrorText message={error} />
      {ride.status === 'active' && ride.pricing.pausePerMinuteSantim !== null ? (
        <button className="outline" disabled={!!busy} onClick={() => void act('pause')}>
          Pause
        </button>
      ) : null}
      {ride.status === 'paused' ? (
        <button className="outline" disabled={!!busy} onClick={() => void act('resume')}>
          Resume
        </button>
      ) : null}
      {ride.status === 'active' || ride.status === 'paused' ? (
        <>
          <p className="muted">Park safely and stop the scooter before ending.</p>
          <button className="dark" disabled={!!busy} onClick={() => void act('end')}>
            End ride
          </button>
        </>
      ) : null}
      {!open ? <Link href="/">Done</Link> : null}
    </Card>
  );
}

export default function RidePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireRider>
      <RideView id={id} />
    </RequireRider>
  );
}
