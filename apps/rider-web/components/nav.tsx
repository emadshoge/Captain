'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from './session';

export function Nav() {
  const { state, signOut } = useSession();
  const router = useRouter();
  return (
    <nav aria-label="Main">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true">
          C
        </span>
        Captain
      </Link>
      <span className="spacer" />
      {state.status === 'signedIn' ? (
        <>
          <Link href="/wallet">Wallet</Link>
          <Link href="/history">History</Link>
          <button
            className="secondary"
            onClick={() => void signOut().then(() => router.replace('/sign-in'))}
          >
            Sign out
          </button>
        </>
      ) : null}
    </nav>
  );
}
