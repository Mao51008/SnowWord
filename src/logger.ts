import fs from 'fs';
import path from 'path';

import pino from 'pino';

function getStartupTimestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

export const LOG_FILE_PATH = path.join(
  LOGS_DIR,
  `hushbay-${getStartupTimestamp()}.log`,
);

const transport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      level: 'debug',
      options: { colorize: true },
    },
    {
      target: 'pino/file',
      level: 'debug',
      options: { destination: LOG_FILE_PATH, mkdir: true },
    },
  ],
});

export const logger = pino(
  {
    level: 'debug',
  },
  transport,
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
