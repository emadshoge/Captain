/**
 * CSV with spreadsheet formula-injection protection (OWASP): cells that
 * start with =, +, -, @, tab or carriage return are prefixed with a single
 * quote so spreadsheet apps treat them as text.
 */
const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Real numbers (e.g. -1050 santim) stay numeric; only text can smuggle formulas.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (DANGEROUS.test(text)) text = `'${text}`;
  return /[",\n\r']/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return (
    [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join(
      '\r\n',
    ) + '\r\n'
  );
}
