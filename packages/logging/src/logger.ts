import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import { REDACTED, isSensitiveKey, redactDeep, redactString, redactUrl } from './redact';

const SERIALIZED_KEYS = new Set(['req', 'res', 'err', 'error']);

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  service: string;
  level: LogLevel;
  appEnv: string;
  /** Test hook: write log lines here instead of stdout. */
  destination?: DestinationStream;
}

/** Header paths pino removes before any other processing (defence in depth). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

interface RequestLike {
  id?: string;
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
  socket?: { remoteAddress?: string };
}

/**
 * Request serializer: method, URL with sensitive query values masked, and the
 * matched route. Headers and bodies are deliberately not logged.
 */
function serializeRequest(req: RequestLike) {
  return {
    method: req.method,
    url: req.url === undefined ? undefined : redactUrl(req.url),
    route: req.routeOptions?.url,
  };
}

function serializeResponse(res: { statusCode?: number }) {
  return { statusCode: res.statusCode };
}

function serializeError(err: Error) {
  return redactDeep(stdSerializers.err(err));
}

/** Pino options shared by every Captain service (also used by Fastify). */
export function loggerOptions({
  service,
  level,
  appEnv,
}: Omit<CreateLoggerOptions, 'destination'>): LoggerOptions {
  return {
    level,
    base: { service, env: appEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: serializeError,
      error: serializeError,
    },
    formatters: {
      level: (label) => ({ level: label }),
      // Base bindings. Pino skips this formatter for child loggers, so
      // `createLogger` also redacts child bindings (see below).
      bindings: (bindings) => redactDeep(bindings) as Record<string, unknown>,
      // Runs on every log object before the serializers above. `req`, `res`
      // and errors are left to their serializers (which redact), so live
      // request objects are not deep-walked.
      log: (object) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) {
          out[key] = SERIALIZED_KEYS.has(key)
            ? value
            : isSensitiveKey(key)
              ? REDACTED
              : redactDeep(value);
        }
        return out;
      },
    },
    hooks: {
      // Scrub credentials from free-text messages and string interpolation args.
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? redactString(arg) : arg));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };
}

/**
 * Wraps `child()` so bindings are redacted. Children are created with
 * `Object.create(parent)`, so they inherit the wrapped method.
 */
export function redactChildBindings(logger: Logger): Logger {
  const originalChild = logger.child;
  logger.child = function child(this: Logger, bindings, childOptions) {
    return originalChild.call(this, redactDeep(bindings) as typeof bindings, childOptions);
  } as Logger['child'];
  return logger;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const opts = loggerOptions(options);
  return redactChildBindings(options.destination ? pino(opts, options.destination) : pino(opts));
}

export type { Logger };
