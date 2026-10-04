'use client';

import type { ReactNode } from 'react';

export function Badge({ simulated, devPricing }: { simulated?: boolean; devPricing?: boolean }) {
  if (!simulated && !devPricing) return null;
  return (
    <p className="badge" data-testid="simulated-badge">
      {simulated ? <strong>SIMULATED</strong> : null}
      {simulated && devPricing ? ' · ' : null}
      {devPricing ? 'Test pricing — not real prices' : null}
    </p>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="error">
      {message}
    </p>
  ) : null;
}

export function Card({ children }: { children: ReactNode }) {
  return <section className="card">{children}</section>;
}
