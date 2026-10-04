/**
 * Normalizes Ethiopian mobile numbers to E.164 (+2519XXXXXXXX / +2517XXXXXXXX).
 * Accepts common local forms: 0911…, 911…, 2519…, +251 911 …
 * Returns null for anything else (SMS OTP is for Ethiopian numbers only).
 */
export function normalizeEthiopianPhone(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, '');
  const match = /^(?:\+?251|0)?([79]\d{8})$/.exec(compact);
  return match ? `+251${match[1]}` : null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,187}\.[^\s@]{2,63}$/;

export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  return value.length <= 254 && EMAIL.test(value) ? value : null;
}

/** Shows enough to recognize a contact without revealing it in logs/UIs. */
export function maskDestination(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${value.slice(0, 4)}*****${value.slice(-2)}`;
}
