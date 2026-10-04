import Link from 'next/link';

export default function StaffHomePage() {
  return (
    <main>
      <h1>Captain Staff</h1>
      <p>Staff app skeleton. Access control is enforced by the API per role.</p>
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
