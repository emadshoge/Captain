/** Integer santim → "ETB 1,234.50" (never floating-point arithmetic on money). */
export function formatEtb(santim: number): string {
  const negative = santim < 0;
  const abs = Math.abs(Math.trunc(santim));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = String(abs % 100).padStart(2, '0');
  return `${negative ? '−' : ''}ETB ${whole}.${cents}`;
}

/** "500" / "500.5" / "1,250.00" → santim, or null when invalid. */
export function parseEtbInput(input: string): number | null {
  const cleaned = input.trim().replaceAll(',', '');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Seconds → "1:05:09" or "5:09". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "120 m" / "1.4 km" */
export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

/**
 * QR codes may carry the bare scooter token or a link ending in it. The
 * printed QR format is not decided yet; both are accepted.
 */
export function parseScooterQr(data: string): string | null {
  const value = data.trim();
  if (!value) return null;
  const token = /^[A-Za-z0-9_-]{8,200}$/;
  if (/^https?:\/\//i.test(value)) {
    try {
      const last = new URL(value).pathname.split('/').filter(Boolean).at(-1) ?? '';
      return token.test(last) ? last : null;
    } catch {
      return null;
    }
  }
  return token.test(value) ? value : null;
}
