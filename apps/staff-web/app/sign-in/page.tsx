'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useSession } from '../../components/session';
import { ErrorText } from '../../components/ui';
import { api, messageFor } from '../../lib/api';

export default function SignInPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setChallengeId((await api.requestCode(email.trim())).challengeId);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(challengeId, code.trim(), totp.trim() || undefined);
      await refresh();
      router.replace('/');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Staff sign in</h1>
      {challengeId === null ? (
        <form className="card" onSubmit={send}>
          <label>
            Work email
            <input
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy || !email.trim()}>
            Send code
          </button>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <p>If {email.trim()} is a staff account, a 6-digit code was sent to it.</p>
          <label>
            Email code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
          </label>
          <label>
            Authenticator code (if enrolled)
            <input
              name="totp"
              inputMode="numeric"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy || code.length !== 6}>
            Sign in
          </button>
        </form>
      )}
    </>
  );
}
