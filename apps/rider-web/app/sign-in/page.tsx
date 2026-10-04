'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ErrorText } from '../../components/ui';
import { useSession } from '../../components/session';
import { api, messageFor } from '../../lib/api';

export default function SignInPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [destination, setDestination] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setChallengeId((await api.requestCode(channel, destination.trim())).challengeId);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(challengeId, code.trim());
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      {challengeId === null ? (
        <form onSubmit={send} className="card">
          <div className="row" role="radiogroup" aria-label="Sign in with">
            <label>
              <span>
                <input
                  type="radio"
                  name="channel"
                  checked={channel === 'sms'}
                  onChange={() => setChannel('sms')}
                  style={{ width: 'auto', minHeight: 0 }}
                />{' '}
                Phone
              </span>
            </label>
            <label>
              <span>
                <input
                  type="radio"
                  name="channel"
                  checked={channel === 'email'}
                  onChange={() => setChannel('email')}
                  style={{ width: 'auto', minHeight: 0 }}
                />{' '}
                Email
              </span>
            </label>
          </div>
          <label>
            {channel === 'sms' ? 'Phone number' : 'Email address'}
            <input
              name="destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              type={channel === 'sms' ? 'tel' : 'email'}
              autoComplete={channel === 'sms' ? 'tel' : 'email'}
              required
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy || destination.trim().length < 3}>
            Send code
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="card">
          <p>We sent a 6-digit code to {destination.trim()}.</p>
          <label>
            Code
            <input
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy || code.length !== 6}>
            Sign in
          </button>
          <button type="button" className="secondary" onClick={() => setChallengeId(null)}>
            Use a different number or email
          </button>
        </form>
      )}
    </>
  );
}
