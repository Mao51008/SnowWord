/**
 * SnowWord Agent Runner Adapter
 *
 * Development mode now runs the agent directly on the host.
 * This file keeps the old interface so the rest of the app can stay stable.
 */

import { runLocalAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { CompanionPersonaId } from './types.js';

export interface ContainerInput {
  accountId: string;
  prompt: string;
  sessionId?: string;
  latestUserMessage?: string;
  personaId?: CompanionPersonaId;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export async function runContainerAgent(
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  logger.info(
    { accountId: input.accountId },
    'Running agent locally on host',
  );

  const output = await runLocalAgent(input);

  if (onOutput) {
    await onOutput(output);
  }

  return output;
}

export function ensureResidentContainerRunning(_accountId: string): void {
  logger.debug('Resident container runtime disabled in host-local mode');
}
