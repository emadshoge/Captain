export function formatEtb(santim: number | null | undefined): string {
  if (santim === null || santim === undefined) return '—';
  const negative = santim < 0;
  const abs = Math.abs(Math.trunc(santim));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}ETB ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "-12.5" / "500" → signed santim, or null. */
export function parseEtb(input: string, allowNegative = false): number | null {
  const match = /^(-)?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replaceAll(',', ''));
  if (!match || (match[1] && !allowNegative)) return null;
  const value = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -value : value;
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}
