'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCan, useSession } from './session';

const LINKS: { href: string; label: string; permission: string }[] = [
  { href: '/fleet', label: 'Fleet', permission: 'fleet.read' },
  { href: '/alerts', label: 'Alerts', permission: 'fleet.read' },
  { href: '/maintenance', label: 'Maintenance', permission: 'fleet.read' },
  { href: '/rides', label: 'Rides', permission: 'rides.read' },
  { href: '/incidents', label: 'Incidents', permission: 'incidents.read' },
  { href: '/admin/riders', label: 'Riders', permission: 'riders.read' },
  { href: '/admin/payments', label: 'Payments', permission: 'payments.read' },
  { href: '/admin/refunds', label: 'Refunds', permission: 'refunds.approve' },
  { href: '/admin/onboarding', label: 'Onboarding', permission: 'fleet.manage' },
  { href: '/admin/pricing', label: 'Pricing', permission: 'pricing.manage' },
  { href: '/admin/zones', label: 'Zones', permission: 'zones.manage' },
  { href: '/admin/staff', label: 'Staff', permission: 'staff.manage' },
  { href: '/admin/audit', label: 'Audit', permission: 'audit.read' },
];

export function Nav() {
  const { state, signOut } = useSession();
  const can = useCan();
  const router = useRouter();
  return (
    <nav aria-label="Main">
      <Link href="/">
        <strong>Captain Staff</strong>
      </Link>
      {state.status === 'signedIn' ? (
        <>
          {LINKS.filter((l) => can(l.permission)).map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
          <Link href="/account">Account</Link>
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
