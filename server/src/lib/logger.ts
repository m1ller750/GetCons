import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';

export type { Logger };

function hasPrettyPrinter(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(level: string, prettyRequested: boolean): Logger {
  const pretty = prettyRequested && hasPrettyPrinter();
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-telegram-bot-api-secret-token"]',
        '*.botToken',
        '*.bot_token',
        '*.token',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

/** A logger that discards everything; handy in tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
