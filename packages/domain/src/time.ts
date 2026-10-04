/** Timestamps are stored in UTC; riders and staff see Ethiopia local time. */
export const ETHIOPIA_TIME_ZONE = 'Africa/Addis_Ababa';

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ETHIOPIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "04/10/2026, 17:05" in East Africa Time (UTC+3), Gregorian calendar. */
export function formatEthiopiaDateTime(date: Date): string {
  return dateTimeFormat.format(date);
}

/** Whole seconds between two instants, never negative. */
export function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}
