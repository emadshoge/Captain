/** Integer santim → "ETB 1,234.50" (no floating-point arithmetic on money). */
export function formatEtb(santim: number): string {
  const negative = santim < 0;
  const abs = Math.abs(Math.trunc(santim));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}ETB ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "500" / "1,250.5" → santim, or null. */
export function parseEtbInput(input: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replaceAll(',', ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const STATUS_TEXT: Record<string, string> = {
  start_requested: 'Unlocking the scooter…',
  unlock_pending: 'Unlocking the scooter…',
  active: 'Ride in progress',
  paused: 'Paused — billing at the pause rate',
  end_requested: 'Ending your ride…',
  completion_pending: 'Ending your ride…',
  completed: 'Ride complete',
  start_failed: 'The scooter did not unlock. You were not charged.',
  operator_review: 'Our team is checking this ride. We will update your receipt.',
};

export const OPEN_STATUSES = [
  'start_requested',
  'unlock_pending',
  'active',
  'paused',
  'end_requested',
  'completion_pending',
];
