'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { RequireRider } from '../components/session';
import { Badge, Card, ErrorText } from '../components/ui';
import {
  api,
  messageFor,
  newIdempotencyKey,
  type Pricing,
  type Ride,
  type ScooterLookup,
} from '../lib/api';
import { formatEtb, STATUS_TEXT } from '../lib/format';

const REASONS: Record<string, string> = {
  in_use: 'This scooter is in use.',
  reserved: 'This scooter is reserved.',
  maintenance: 'This scooter is being serviced.',
  low_battery: 'This scooter’s battery is too low.',
  offline: 'This scooter is offline.',
  stale_location: 'We cannot confirm this scooter’s location right now.',
  not_in_service: 'This scooter is not in service.',
};

function Home() {
  const router = useRouter();
  const [current, setCurrent] = useState<Ride | null | undefined>(undefined);
  const [code, setCode] = useState('');
  const [target, setTarget] = useState<{ scooter: ScooterLookup; pricing: Pricing | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startKey = useRef<string | null>(null);

  useEffect(() => {
    api.currentRide().then(
      (r) => setCurrent(r.ride),
      (e) => {
        setCurrent(null);
        setError(messageFor(e));
      },
    );
  }, []);

  async function find(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const [scooter, pricing] = await Promise.all([
        api.lookup(code.trim()),
        api.pricing().catch(() => null),
      ]);
      setTarget({ scooter, pricing });
      startKey.current = newIdempotencyKey();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const ride = await api.startRide(
        target.scooter.code,
        startKey.current ?? newIdempotencyKey(),
      );
      router.push(`/ride/${ride.id}`);
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  }

  if (current === undefined) return <p aria-busy="true">Loading…</p>;
  if (current) {
    return (
      <Card>
        <h2>You have a ride in progress</h2>
        <p>{STATUS_TEXT[current.status]}</p>
        <Link href={`/ride/${current.id}`}>Open ride</Link>
      </Card>
    );
  }
  return (
    <>
      <h1>Ride</h1>
      <p className="muted">Map coming soon. Enter the code printed on the scooter.</p>
      {!target ? (
        <form onSubmit={find} className="card tint">
          <label>
            Scooter code
            <input
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CAP-001"
              required
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy || !code.trim()}>
            Find scooter
          </button>
        </form>
      ) : (
        <Card>
          <h2>Start ride on {target.scooter.code}?</h2>
          {target.pricing ? (
            <>
              <p>
                Unlock {formatEtb(target.pricing.unlockFeeSantim)} +{' '}
                {formatEtb(target.pricing.perMinuteSantim)} per minute
              </p>
              <Badge devPricing={target.pricing.isDevFixture} />
            </>
          ) : null}
          {target.scooter.batteryPercent !== null ? (
            <p className="muted">Battery {target.scooter.batteryPercent}%</p>
          ) : null}
          {!target.scooter.available ? (
            <p className="error">{REASONS[target.scooter.unavailableReason ?? 'not_in_service']}</p>
          ) : null}
          <ErrorText message={error} />
          <button onClick={() => void start()} disabled={busy || !target.scooter.available}>
            Start ride
          </button>
          <button className="secondary" onClick={() => setTarget(null)}>
            Cancel
          </button>
        </Card>
      )}
    </>
  );
}

export default function HomePage() {
  return (
    <RequireRider>
      <Home />
    </RequireRider>
  );
}
