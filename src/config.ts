import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read non-secret config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'AGENT_MODEL',
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'PROACTIVE_WEIGHT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Kept only to preserve the current public API of config.ts.
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
);
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const AGENT_MODEL =
  process.env.AGENT_MODEL ||
  envConfig.AGENT_MODEL ||
  process.env.OPENAI_MODEL ||
  envConfig.OPENAI_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  envConfig.ANTHROPIC_MODEL ||
  'gpt-4o';

export const COMPANION_PERSONA = 'xiaoxue';

const proactiveWeightRaw =
  process.env.PROACTIVE_WEIGHT || envConfig.PROACTIVE_WEIGHT || '1';
const proactiveWeightParsed = Number.parseFloat(proactiveWeightRaw);
export const PROACTIVE_WEIGHT = Number.isFinite(proactiveWeightParsed)
  ? Math.min(2, Math.max(0.4, proactiveWeightParsed))
  : 1;
