import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hotp,
  newTotpSecret,
  otpauthUri,
  totpAt,
  verifyTotp,
} from '../src/lib/totp';

const RFC_KEY = Buffer.from('12345678901234567890'); // RFC 4226/6238 SHA-1 test secret

describe('HOTP (RFC 4226 Appendix D test vectors)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [9, '520489'],
  ])('counter %d -> %s', (counter, expected) => {
    expect(hotp(RFC_KEY, counter)).toBe(expected);
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
  ])('T=%d -> %s', (seconds, expected) => {
    expect(totpAt(RFC_KEY, seconds * 1000, 8)).toBe(expected);
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  it('accepts current and ±1 step, and never the same step twice', () => {
    const code = totpAt(RFC_KEY, now);
    const step = verifyTotp(RFC_KEY, code, now, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_KEY, code, now, step)).toBeNull(); // replay
    expect(verifyTotp(RFC_KEY, totpAt(RFC_KEY, now - 30_000), now, null)).not.toBeNull();
    expect(verifyTotp(RFC_KEY, totpAt(RFC_KEY, now - 90_000), now, null)).toBeNull();
    expect(verifyTotp(RFC_KEY, 'abcdef', now, null)).toBeNull();
  });
});

describe('secret handling', () => {
  it('round-trips base32 and the RFC 4648 example', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const secret = newTotpSecret();
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('encrypts at rest with authentication (tampering fails)', () => {
    const secret = newTotpSecret();
    const sealed = encryptSecret(secret, 'k'.repeat(40));
    expect(sealed).not.toContain(base32Encode(secret));
    expect(decryptSecret(sealed, 'k'.repeat(40))).toEqual(secret);
    expect(() => decryptSecret(sealed, 'x'.repeat(40))).toThrow();
    const tampered = Buffer.from(sealed, 'base64url');
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptSecret(tampered.toString('base64url'), 'k'.repeat(40))).toThrow();
  });

  it('builds a standard otpauth URI', () => {
    expect(otpauthUri(RFC_KEY, 'admin@captain.et')).toBe(
      'otpauth://totp/Captain%3Aadmin%40captain.et?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Captain&algorithm=SHA1&digits=6&period=30',
    );
  });
});
