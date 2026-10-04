import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** RFC 4648 base32 (no padding), as used by authenticator apps. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with HMAC-SHA1 and dynamic truncation. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

export function totpAt(key: Buffer, timeMs: number, digits = 6): string {
  return hotp(key, Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS), digits);
}

/**
 * Checks a code within ±1 step of clock drift. Returns the matched step, or
 * null. Steps <= `lastUsedStep` are rejected, so a code works only once.
 */
export function verifyTotp(
  key: Buffer,
  code: string,
  timeMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (hotp(key, step) === code) return step;
  }
  return null;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits, RFC 4226 recommendation
}

export function otpauthUri(secret: Buffer, account: string): string {
  const label = encodeURIComponent(`Captain:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=Captain&algorithm=SHA1&digits=6&period=30`;
}

function encryptionKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, 'captain', 'staff-totp-secret', 32));
}

/** AES-256-GCM; output = base64url(iv | tag | ciphertext). */
export function encryptSecret(secret: Buffer, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(authSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptSecret(encoded: string, authSecret: string): Buffer {
  const raw = Buffer.from(encoded, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(authSecret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}
