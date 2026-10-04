import { createLogger, type CreateLoggerOptions } from '../src';

/** Logger writing JSON lines into memory, plus helpers to inspect them. */
export function captureLogger(overrides: Partial<CreateLoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    appEnv: 'test',
    destination: { write: (line: string) => void lines.push(line) },
    ...overrides,
  });
  return {
    logger,
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join(''),
  };
}
