/**
 * SnowWord Task Scheduler
 * Tasks are scheduled per-account and executed by the local agent runtime.
 */

import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ensureCompanionState,
  recordCompanionOutboundTouch,
  renderCompanionStateForPrompt,
  saveCompanionState,
} from './companion-state.js';
import { runContainerAgent } from './container-runner.js';
import {
  getAllAccounts,
  getDueTasks,
  getRecentMessages,
  getTaskById,
  getTasksForAccount,
  logTaskRun,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { sendMessage as ilinkSendMessage } from './ilink.js';
import { logger } from './logger.js';
import { NewMessage, ScheduledTask } from './types.js';
import { getWeatherSummary } from './weather.js';

const HOUR_MS = 60 * 60 * 1000;

export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      return interval.next().toISOString();
    } catch {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid cron expression',
      );
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }

    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

function writeTasksSnapshot(accountId: string, tasks: ScheduledTask[]): void {
  const tasksFile = path.join(DATA_DIR, 'ipc', accountId, 'current_tasks.json');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}

function previewText(text: string | null | undefined, limit = 120): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
}

function buildReminderPrompt(
  task: ScheduledTask,
  companionContext: string,
): string {
  return [
    '你正在以当前人格身份执行一次主动提醒或回访。',
    companionContext,
    '## 提醒任务',
    `- 提醒类型：${task.reminder_type ?? 'custom'}`,
    `- 原始提醒：${task.prompt}`,
    task.voice_text ? `- 语音文案：${task.voice_text}` : '- 语音文案：暂无',
    '请把这次提醒写得像真人发来的关心或提醒，简短、自然，不要像系统播报。',
  ].join('\n\n');
}

function buildProactivePrompt(params: {
  companionContext: string;
  reason: string;
  careFollowups: string[];
  pendingTopics: string[];
  recentPainPoints: string[];
  recentJoyPoints: string[];
  weatherContext?: string | null;
}): string {
  const careFollowups =
    params.careFollowups.length > 0 ? params.careFollowups.join('；') : '暂无';
  const pendingTopics =
    params.pendingTopics.length > 0 ? params.pendingTopics.join('；') : '暂无';
  const recentPainPoints =
    params.recentPainPoints.length > 0 ? params.recentPainPoints.join('；') : '暂无';
  const recentJoyPoints =
    params.recentJoyPoints.length > 0 ? params.recentJoyPoints.join('；') : '暂无';

  return [
    '你正在准备一条主动发起的消息。',
    params.companionContext,
    '## 主动原因',
    params.reason,
    params.weatherContext ? `## 天气补充\n${params.weatherContext}` : null,
    '## 关系上下文',
    `- 挂心事项：${careFollowups}`,
    `- 没聊完的话题：${pendingTopics}`,
    `- 最近痛点：${recentPainPoints}`,
    `- 最近开心点：${recentJoyPoints}`,
    '请只写一条自然的主动消息，像真人忍不住来关心或分享一下。不要写成长段，不要像运营推送。',
  ]
    .filter(Boolean)
    .join('\n\n');
}
function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function getProactiveCandidate(accountId: string): {
  type: 'checking_in' | 'continuing' | 'caring' | 'sharing';
  reason: string;
} | null {
  const recentMessages = getRecentMessages(accountId, 12);
  const inboundMessages = recentMessages.filter((msg) => !msg.is_from_me);
  if (inboundMessages.length < 2) {
    return null;
  }

  const account = getAllAccounts().find((item) => item.id === accountId);
  if (!account) return null;

  const state = ensureCompanionState(account);
  const now = Date.now();
  const lastUserAt = parseTime(state.proactive.lastUserMessageAt);
  const lastProactiveAt = parseTime(state.proactive.lastProactiveAt);
  const nextEarliest = parseTime(state.proactive.nextProactiveEarliestAt);

  if (!lastUserAt) return null;
  if (state.proactive.proactiveTodayCount >= 3) return null;
  if (nextEarliest && now < nextEarliest) return null;
  if (lastProactiveAt && now - lastProactiveAt < 4 * HOUR_MS) return null;
  if (lastProactiveAt && lastProactiveAt > lastUserAt && now - lastProactiveAt < 12 * HOUR_MS) {
    return null;
  }

  const silenceMs = now - lastUserAt;

  if (
    state.conversation.careFollowups.length > 0 &&
    silenceMs >= 2 * HOUR_MS
  ) {
    return {
      type: 'caring',
      reason: '用户之前提过让你挂心的身体或情绪状态，现在隔了一段时间，可以轻轻回访一下。',
    };
  }

  if (
    state.conversation.pendingTopics.length > 0 &&
    silenceMs >= 8 * HOUR_MS
  ) {
    return {
      type: 'continuing',
      reason: '你们之间还有没聊完的话题，可以自然地把线头接回来。',
    };
  }

  if (state.bond.trustLevel >= 22 && silenceMs >= 10 * HOUR_MS) {
    return {
      type: 'sharing',
      reason: `你今天有一点自己的生活感想说给用户听：${state.daily.shareImpulse}`,
    };
  }

  if (state.bond.trustLevel >= 30 && silenceMs >= 18 * HOUR_MS) {
    return {
      type: 'checking_in',
      reason: '已经安静了一段时间，你有点惦记用户，适合轻轻问候一下。',
    };
  }

  return null;
}

async function maybeSendProactiveMessage(accountId: string): Promise<void> {
  const candidate = getProactiveCandidate(accountId);
  if (!candidate) return;

  const account = getAllAccounts().find((item) => item.id === accountId);
  if (!account) return;

  const state = ensureCompanionState(account);
  let weather = null;
  try {
    weather = await getWeatherSummary({ accountId });
  } catch (err) {
    logger.warn(
      { accountId, err },
      'Weather lookup failed during proactive message generation',
    );
  }
  const weatherContext = weather
    ? `- ${weather.location}天气：${weather.description}${
        weather.temperatureC != null ? `，气温 ${weather.temperatureC}°C` : ''
      }${weather.advice ? `，${weather.advice}` : ''}`
    : null;
  const prompt = buildProactivePrompt({
    companionContext: renderCompanionStateForPrompt(state),
    reason: candidate.reason,
    careFollowups: state.conversation.careFollowups,
    pendingTopics: state.conversation.pendingTopics,
    recentPainPoints: state.conversation.recentUserPainPoints,
    recentJoyPoints: state.conversation.recentUserJoyPoints,
    weatherContext,
  });

  logger.info(
    { accountId, proactive_type: candidate.type },
    'Triggering proactive companion message',
  );

  const output = await runContainerAgent({
    accountId,
    prompt,
    sessionId: undefined,
    personaId: state.profile.personaId,
  });

  if (output.status === 'error' || !output.result?.trim()) {
    logger.warn(
      { accountId, proactive_type: candidate.type, error: output.error },
      'Proactive companion message generation failed',
    );
    return;
  }

  const sendResult = await ilinkSendMessage(
    {
      id: account.id,
      bot_token: account.bot_token,
      base_url: account.base_url,
    },
    account.user_id,
    output.result,
  );

  if (sendResult.interrupted) {
    logger.info(
      {
        accountId,
        proactive_type: candidate.type,
        sent_segments: sendResult.sentSegments,
        total_segments: sendResult.totalSegments,
      },
      'Proactive companion message was interrupted by a new inbound message',
    );
    return;
  }

  const botMessage: NewMessage = {
    id: sendResult.clientId || `proactive_${candidate.type}_${Date.now()}`,
    account_id: account.id,
    sender: account.id,
    sender_name: account.name,
    content: output.result,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
  };
  storeMessage(botMessage);

  const nextCompanionState = recordCompanionOutboundTouch({
    state,
    type: candidate.type,
    summary: output.result,
  });
  saveCompanionState(nextCompanionState);

  logger.info(
    {
      accountId,
      proactive_type: candidate.type,
      preview: previewText(output.result),
      sent_segments: sendResult.sentSegments,
    },
    'Proactive companion message sent',
  );
}

async function runTask(task: ScheduledTask): Promise<void> {
  const startTime = Date.now();

  logger.info(
    { taskId: task.id, accountId: task.account_id },
    'Running scheduled task',
  );

  const accounts = getAllAccounts();
  const account = accounts.find((a) => a.id === task.account_id);
  if (!account) {
    logger.error({ taskId: task.id }, 'Account not found for task');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Account not found: ${task.account_id}`,
    });
    updateTask(task.id, { status: 'paused' });
    return;
  }

  const allTasks = getTasksForAccount(task.account_id);
  writeTasksSnapshot(task.account_id, allTasks);

  const companionState = ensureCompanionState(account);
  let result: string | null = null;
  let error: string | null = null;
  let outboundText: string | null = null;

  try {
    const output = await runContainerAgent({
      accountId: task.account_id,
      prompt: buildReminderPrompt(
        task,
        renderCompanionStateForPrompt(companionState),
      ),
      sessionId: undefined,
      personaId: companionState.profile.personaId,
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      outboundText = task.voice_text || task.prompt;
    } else {
      result = output.result;
      outboundText = output.result || task.voice_text || task.prompt;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    outboundText = task.voice_text || task.prompt;
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  if (outboundText) {
    try {
      logger.info(
        {
          taskId: task.id,
          accountId: account.id,
          to: account.user_id,
          preview: previewText(outboundText),
          length: outboundText.length,
        },
        'Sending scheduled reminder via iLink',
      );

      const sendResult = await ilinkSendMessage(
        {
          id: account.id,
          bot_token: account.bot_token,
          base_url: account.base_url,
        },
        account.user_id,
        outboundText,
      );

      if (sendResult.interrupted) {
        logger.info(
          {
            taskId: task.id,
            accountId: account.id,
            sent_segments: sendResult.sentSegments,
            total_segments: sendResult.totalSegments,
          },
          'Scheduled reminder outbound was interrupted by a new inbound message',
        );
      } else {
        const botMessage: NewMessage = {
          id: sendResult.clientId || `${task.id}_run_${Date.now()}`,
          account_id: account.id,
          sender: account.id,
          sender_name: account.name,
          content: outboundText,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        };
        storeMessage(botMessage);

        logger.info(
          {
            taskId: task.id,
            accountId: account.id,
            preview: previewText(outboundText),
            sent_segments: sendResult.sentSegments,
          },
          'Scheduled reminder sent via iLink',
        );

        const nextCompanionState = recordCompanionOutboundTouch({
          state: companionState,
          type: 'caring',
          summary: outboundText,
        });
        saveCompanionState(nextCompanionState);
      }
    } catch (sendErr) {
      const sendError =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      error = error ? `${error}; send failed: ${sendError}` : sendError;
      logger.error(
        { taskId: task.id, accountId: account.id, error: sendError },
        'Failed to send scheduled reminder via iLink',
      );
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : outboundText
        ? outboundText.slice(0, 200)
        : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }
        runTask(currentTask).catch((err) => {
          logger.error({ taskId: task.id, err }, 'Task execution failed');
        });
      }

      for (const account of getAllAccounts().filter((item) => item.enabled)) {
        maybeSendProactiveMessage(account.id).catch((err) => {
          logger.error(
            { accountId: account.id, err },
            'Proactive companion message failed',
          );
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

