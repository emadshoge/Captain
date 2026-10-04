import Link from 'next/link';

export default function StaffHomePage() {
  return (
    <main>
      <h1>Captain Staff</h1>
      <p>
        Staff app skeleton. No sign-in or role checks exist yet: these placeholder pages are
        reachable by anyone. Staff authentication and role enforcement are planned for Phases 4–5.
      </p>
      <ul>
        <li>
          <Link href="/admin">Admin area</Link>
        </li>
        <li>
          <Link href="/operator">Operator area</Link>
        </li>
      </ul>
    </main>
  );
}
