/**
 * Redaction for logs. Two layers:
 * 1. Keys: any property whose name looks sensitive is replaced wholesale.
 * 2. Strings: credentials embedded in free text (connection strings, bearer
 *    tokens, `password=` pairs) are masked wherever they appear.
 */
export const REDACTED = '[REDACTED]';

/** Property names whose values are never logged. Matched case-insensitively. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)?$/i,
  /^pwd$/i,
  /secret/i,
  /token/i,
  // One-time codes (but not settings such as OTP_SMS_PROVIDER).
  /^otp$/i,
  /otp[-_]?(code|value|hash|secret)$/i,
  /verification_?code/i,
  /authorization/i,
  /^(set-)?cookie$/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
  /signature/i,
  /database_?url/i,
  /connection_?string/i,
  /^dsn$/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

const STRING_SCRUBBERS: readonly [RegExp, string][] = [
  // scheme://user:password@host -> scheme://[REDACTED]@host (postgres, redis, amqp, https…)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization header values embedded in text
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, `$1 ${REDACTED}`],
  // key=value / key: value pairs for sensitive keys (query strings, libpq DSNs, messages)
  [
    /\b(password|passwd|pwd|secret|token|otp|api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi,
    `$1$2${REDACTED}`,
  ],
];

export function redactString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of STRING_SCRUBBERS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

const MAX_DEPTH = 8;

/**
 * Returns a deep copy of `value` with sensitive keys replaced and strings
 * scrubbed. Cycle-safe and depth-limited. Errors become plain objects.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen));
  if (value instanceof Error) {
    return redactDeep(
      { ...value, type: value.name, message: value.message, stack: value.stack },
      depth,
      new WeakSet(),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(child, depth + 1, seen);
  }
  return out;
}

/** Masks sensitive query parameters and embedded credentials in a request URL. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return redactString(url);
  const path = url.slice(0, queryStart);
  const params = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // keep raw key
      }
      return eq !== -1 && isSensitiveKey(key) ? `${rawKey}=${REDACTED}` : pair;
    });
  return redactString(`${path}?${params.join('&')}`);
}
