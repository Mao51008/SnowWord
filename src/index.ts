/**
 * SnowWord Runtime - Single entry point for AI companion
 *
 * Architecture:
 * - Host-local agent runtime
 * - File IPC directories kept for local tools and task snapshots
 * - iLink API for WeChat (long-polling via getUpdates)
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { DATA_DIR, STORE_DIR } from './config.js';
import {
  clearCompanionState,
  clearMemoriesForAccount,
  clearMessagesForAccount,
  clearTasksForAccount,
  createAccount,
  deleteAccount,
  getAccount,
  getAccountSettings,
  getAllAccounts,
  getRecentMessages,
  getTasksForAccount,
  initDatabase,
  storeMessage,
  upsertAccountSettings,
  updateAccount,
} from './db.js';
import {
  ensureCompanionState,
  recordCompanionOutboundTouch,
  renderDynamicCompanionStateForPrompt,
  saveCompanionState,
  updateCompanionStateAfterTurn,
} from './companion-state.js';
import { runContainerAgent } from './container-runner.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import {
  Account,
  CompanionPersonaId,
  CompanionState,
  NewMessage,
} from './types.js';
import { buildReactionPolicy } from './reaction-policy.js';
import { extractAndPersistPersonalMemories } from './memory-extractor.js';
import {
  capturePreferredNameMemory,
  compactStructuredMemories,
} from './user-memory.js';
import { tryAutoScheduleReminderFromUserText } from './agent-tools.js';
import {
  clearSoulMemorySection,
  ensureSoulFile,
  setCustomPersonaPrompt,
  setSoulPersonaTemplate,
} from './soul.js';
import {
  getUpdates,
  interruptPendingOutbound,
  sendMessage as ilinkSendMessage,
  parseWeixinMessage,
  IlinkAccount,
} from './ilink.js';

function previewText(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

const INSTANCE_LOCK_PATH = path.join(STORE_DIR, 'runtime.lock.json');
const INBOUND_BATCH_WINDOW_MS = 4000;
let shuttingDown = false;

export interface LocalDebugSession {
  accountId: string;
  state: CompanionState;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface BufferedInboundMessage {
  msgId: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  contextToken?: string;
}

interface ConversationBuffer {
  account: Account;
  sender: string;
  senderName: string;
  messages: BufferedInboundMessage[];
  timer?: ReturnType<typeof setTimeout>;
  processing: boolean;
  interruptedPendingReply?: boolean;
}

const conversationBuffers = new Map<string, ConversationBuffer>();

function releaseInstanceLock(): void {
  if (!fs.existsSync(INSTANCE_LOCK_PATH)) return;

  try {
    const raw = fs.readFileSync(INSTANCE_LOCK_PATH, 'utf-8');
    const lock = JSON.parse(raw) as { pid?: number };
    if (lock.pid === process.pid) {
      fs.unlinkSync(INSTANCE_LOCK_PATH);
    }
  } catch {
    // Ignore lock cleanup errors on shutdown.
  }
}

function shutdown(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down SnowWord');
  releaseInstanceLock();
  process.exit(0);
}

function acquireInstanceLock(): void {
  fs.mkdirSync(path.dirname(INSTANCE_LOCK_PATH), { recursive: true });

  if (fs.existsSync(INSTANCE_LOCK_PATH)) {
    try {
      const raw = fs.readFileSync(INSTANCE_LOCK_PATH, 'utf-8');
      const lock = JSON.parse(raw) as { pid?: number; started_at?: string };
      const existingPid = lock.pid;

      if (typeof existingPid === 'number') {
        try {
          process.kill(existingPid, 0);
          throw new Error(
            `Another SnowWord instance is already running (pid=${existingPid}, started_at=${lock.started_at ?? 'unknown'}, lock_file=${INSTANCE_LOCK_PATH})`,
          );
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.startsWith('Another SnowWord instance is already running')
          ) {
            throw err;
          }
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith('Another SnowWord instance is already running')
      ) {
        throw err;
      }
    }

    try {
      fs.unlinkSync(INSTANCE_LOCK_PATH);
    } catch {
      // If cleanup fails, the write below will surface the problem.
    }
  }

  fs.writeFileSync(
    INSTANCE_LOCK_PATH,
    JSON.stringify(
      {
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', releaseInstanceLock);
}

async function ensureRuntimeReady(): Promise<void> {
  acquireInstanceLock();
  logger.info('Agent runtime ready (host-local mode)');
}

// =====================
// Directory helpers
// =====================

function getIpcDir(accountId: string): string {
  return path.join(DATA_DIR, 'ipc', accountId);
}

function getInboxDir(accountId: string): string {
  return path.join(getIpcDir(accountId), 'inbox');
}

function getOutboxDir(accountId: string): string {
  return path.join(getIpcDir(accountId), 'outbox');
}

function getSoulPath(accountId: string): string {
  return path.join(DATA_DIR, 'soul', `${accountId}.md`);
}

function ensureDirectories(accountId: string): void {
  const dirs = [
    path.join(DATA_DIR, 'soul'),
    getInboxDir(accountId),
    getOutboxDir(accountId),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clearConversationBuffersForAccount(accountId: string): void {
  for (const [key, buffer] of conversationBuffers.entries()) {
    if (!key.startsWith(`${accountId}:`)) continue;
    if (buffer.timer) clearTimeout(buffer.timer);
    conversationBuffers.delete(key);
  }
}

function clearSoulMemory(accountId: string): void {
  const soulPath = getSoulPath(accountId);
  const personaId = getAccountSettings(accountId)?.persona_id ?? 'xiaoxue';
  clearSoulMemorySection({ soulPath, personaId });
}

function normalizePersonaInput(raw: string): CompanionPersonaId | null {
  const value = raw.trim().toLowerCase();
  if (['xiaoxue', '小雪'].includes(value)) return 'xiaoxue';
  if (['chuxue', '初雪'].includes(value)) return 'chuxue';
  return null;
}

async function sendCommandReply(params: {
  account: Account;
  to: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  await ilinkSendMessage(
    {
      id: params.account.id,
      bot_token: params.account.bot_token,
      base_url: params.account.base_url,
    },
    params.to,
    params.text,
    params.contextToken,
    { disableSplit: true },
  );
}

async function handleSlashCommand(params: {
  account: Account;
  sender: string;
  content: string;
  contextToken?: string;
}): Promise<boolean> {
  const raw = params.content.trim();
  if (!raw.startsWith('/')) return false;

  interruptPendingOutbound(params.account.id, params.sender);
  clearConversationBuffersForAccount(params.account.id);

  const [command, ...rest] = raw.split(/\s+/);
  const argument = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case '/persona':
    case '/切换人格': {
      const personaId = normalizePersonaInput(argument);
      if (!personaId) {
        await sendCommandReply({
          account: params.account,
          to: params.sender,
          contextToken: params.contextToken,
          text: '人格切换失败。可用值：/切换人格 小雪 或 /切换人格 初雪',
        });
        return true;
      }

      upsertAccountSettings(params.account.id, { persona_id: personaId });
      setSoulPersonaTemplate({
        soulPath: params.account.soul_md_path,
        personaId,
      });
      const nextState = ensureCompanionState(params.account);
      saveCompanionState(nextState);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text: `已切换到${nextState.profile.name}人格。`,
      });
      return true;
    }

    case '/clear-memory':
    case '/清除记忆': {
      const cleared = clearMemoriesForAccount(params.account.id);
      clearSoulMemory(params.account.id);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text: `已清除记忆，共删除 ${cleared} 条。`,
      });
      return true;
    }

    case '/clear-history':
    case '/清除历史对话': {
      const cleared = clearMessagesForAccount(params.account.id);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text: `已清除历史对话，共删除 ${cleared} 条。`,
      });
      return true;
    }

    case '/clear-schedule':
    case '/清除日程': {
      const cleared = clearTasksForAccount(params.account.id);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text: `已清除日程，共删除 ${cleared} 条。`,
      });
      return true;
    }

    case '/clear-all':
    case '/清除所有': {
      const memoryCount = clearMemoriesForAccount(params.account.id);
      const messageCount = clearMessagesForAccount(params.account.id);
      const taskCount = clearTasksForAccount(params.account.id);
      clearCompanionState(params.account.id);
      clearSoulMemory(params.account.id);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text:
          `已清除全部数据：记忆 ${memoryCount} 条、历史 ${messageCount} 条、日程 ${taskCount} 条。` +
          '账号绑定和人格设置已保留。',
      });
      return true;
    }

    case '/persona-prompt':
    case '/自定义人格提示词': {
      setCustomPersonaPrompt(params.account.soul_md_path, argument);
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text: argument
          ? '已写入自定义人格补充，后续对话会按新的 soul.md 人设生效。'
          : '已清空自定义人格补充，当前会恢复使用基础人设模板。',
      });
      return true;
    }

    default: {
      await sendCommandReply({
        account: params.account,
        to: params.sender,
        contextToken: params.contextToken,
        text:
          '未识别的命令。可用命令：/切换人格、/清除记忆、/清除历史对话、/清除日程、/清除所有、/自定义人格提示词',
      });
      return true;
    }
  }
}

function buildConversationPrompt(params: {
  account: Account;
  companionName?: string;
  recentContext: string;
  soulContent: string;
  companionContext: string;
  latestUserMessage: string;
  replyPolicy?: string;
  interruptionNote?: string;
  isFirstContact?: boolean;
}): string {
  const recentContext = params.recentContext || '暂无';
  const soulContent = params.soulContent || '暂无';
  const companionName = params.companionName ?? '小雪';
  const firstContactRequirement = `## 首次对话要求
这是你和用户的第一次正式对话。开场时先自然介绍自己叫${companionName}，表达“很高兴认识你”，再主动问一句“我应该怎么称呼你呀？”。不要介绍自己的工作，也不要做过长的自我说明。如果用户第一句话本身带有具体内容，要先顺着对方的话回应，再自然完成这段自我介绍。`;

  const sections = [
    `你正在和微信用户进行一对一聊天。请始终以 ${params.account.name} / ${companionName} 的身份回复。`,
    params.isFirstContact ? firstContactRequirement : null,
    params.companionContext,
    params.replyPolicy ? `## 回复策略\n${params.replyPolicy}` : null,
    '## 人格档案与长期记忆',
    soulContent,
    '## 近期对话',
    recentContext,
    '## 用户刚刚发来的消息',
    params.interruptionNote ? '## 被打断的上一轮回复' : null,
    params.interruptionNote ?? null,
    params.latestUserMessage,
    '请直接给出要发送给用户的自然中文回复，优先像真人在聊天，不要模板化，不要解释系统或技术细节。',
  ].filter(Boolean);

  return sections.join('\n\n');
}

function buildReplyPolicyText(
  state: CompanionState,
  latestUserMessage: string,
): string {
  const policy = buildReactionPolicy(state, latestUserMessage);
  return `当前场景：${policy.label}\n默认优先短回复。\n本轮总字数尽量不超过 ${policy.maxReplyChars} 个字。\n${policy.guidance}`;
}

function enforceReplyPolicy(params: {
  reply: string;
  state: CompanionState;
  latestUserMessage: string;
}): string {
  let nextReply = params.reply.trim();
  if (!nextReply) {
    return nextReply;
  }

  const policy = buildReactionPolicy(params.state, params.latestUserMessage);
  for (const forbidden of policy.forbiddenSubstrings ?? []) {
    if (!forbidden) continue;

    while (nextReply.includes(forbidden)) {
      if (forbidden === '又') {
        nextReply = nextReply
          .replaceAll('又是', '是')
          .replaceAll('又被', '被')
          .replaceAll('又在', '在')
          .replaceAll('又让', '让')
          .replaceAll('又把', '把')
          .replaceAll('又给', '给')
          .replaceAll('又', '');
      } else {
        nextReply = nextReply.replaceAll(forbidden, '');
      }
    }
  }

  return nextReply.replace(/\s{2,}/g, ' ').trim();
}

function readSoulContent(accountId: string): string {
  const soulPath = getSoulPath(accountId);
  if (!fs.existsSync(soulPath)) {
    return '';
  }
  return fs.readFileSync(soulPath, 'utf-8');
}

function buildRecentContextFromMessages(
  messages: Array<Pick<NewMessage, 'is_from_me' | 'content'>>,
): string {
  return messages
    .map((message) => `${message.is_from_me ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n');
}

async function generateAgentReply(params: {
  account: Account;
  companionState: CompanionState;
  latestUserMessage: string;
  recentContext: string;
  isFirstContact: boolean;
  interruptionNote?: string;
  logScope?: Record<string, unknown>;
}): Promise<string> {
  const log = logger.child({ accountId: params.account.id, ...params.logScope });
  const soulContent = readSoulContent(params.account.id);
  const prompt = buildConversationPrompt({
    account: params.account,
    companionName: params.companionState.profile.name,
    recentContext: params.recentContext,
    soulContent,
    companionContext: renderDynamicCompanionStateForPrompt(params.companionState),
    latestUserMessage: params.latestUserMessage,
    replyPolicy: buildReplyPolicyText(
      params.companionState,
      params.latestUserMessage,
    ),
    interruptionNote: params.interruptionNote,
    isFirstContact: params.isFirstContact,
  });

  log.info(
    {
      latest_user_chars: params.latestUserMessage.length,
      recent_context_chars: params.recentContext.length,
      soul_chars: soulContent.length,
      prompt_chars: prompt.length,
    },
    'Built prompt for direct agent turn',
  );

  try {
    const output = await runContainerAgent({
      accountId: params.account.id,
      prompt,
      sessionId: undefined,
      latestUserMessage: params.latestUserMessage,
      personaId: params.companionState.profile.personaId,
    });

    log.info(
      {
        output_status: output.status,
        output_error: output.error,
        output_chars: output.result?.length ?? 0,
        output_preview: output.result ? previewText(output.result, 500) : null,
      },
      'Direct agent turn completed',
    );

    if (output.status === 'error') {
      return `抱歉，我刚刚有点没接稳这句话。${output.error ?? '请稍后再试。'}`;
    }

    return enforceReplyPolicy({
      reply: output.result || '我收到了，正在认真想着怎么回您。',
      state: params.companionState,
      latestUserMessage: params.latestUserMessage,
    });
  } catch (err) {
    log.error({ err }, 'Direct agent turn failed');
    return '抱歉，我这边刚刚短暂走神了一下，您稍后再和我说一句。';
  }
}

function looksLikeReminderIntent(text: string): boolean {
  return /(提醒|记得|别忘|叫我)/.test(text);
}

function maybeAutoScheduleReminder(params: {
  account: Account;
  userMessage: string;
  tasksBeforeCount: number;
  log: Pick<typeof logger, 'info'>;
  scope: Record<string, unknown>;
}): void {
  if (!looksLikeReminderIntent(params.userMessage)) return;

  const tasksAfterCount = getTasksForAccount(params.account.id).length;
  if (tasksAfterCount > params.tasksBeforeCount) return;

  const fallback = tryAutoScheduleReminderFromUserText({
    accountId: params.account.id,
    userText: params.userMessage,
  });

  if (fallback.created) {
    params.log.info(
      {
        ...params.scope,
        taskId: fallback.taskId,
      },
      'Auto-scheduled reminder from user request because the model did not create one',
    );
  }
}

// =====================
// Message processing
// =====================

async function processWeixinMessage(
  account: Account,
  msg: import('./ilink.js').WeixinMessage,
): Promise<void> {
  const log = logger.child({ accountId: account.id });
  const msgId = String(msg.message_id ?? `msg-${Date.now()}`);

  log.info(
    {
      msg_id: msgId,
      from: msg.from_user_id,
      message_type: msg.message_type,
      item_count: msg.item_list?.length ?? 0,
    },
    'Processing message',
  );

  const parsed = parseWeixinMessage(msg, account.id);
  if (!parsed) {
    log.info(
      { msg_id: msgId, from: msg.from_user_id, message_type: msg.message_type },
      'Skipping message because no supported text content was extracted',
    );
    return;
  }

  const { content, sender, sender_name } = parsed;
  const companionState = ensureCompanionState(account);
  const preferredNameCapture = capturePreferredNameMemory({
    account,
    latestUserMessage: content,
  });
  if (preferredNameCapture) {
    log.info(
      { msg_id: msgId, preferred_name: preferredNameCapture.preferredName },
      'Captured preferred name into memory',
    );
  }

  log.info(
    {
      msg_id: msgId,
      from: sender,
      content_length: content.length,
      content_preview: previewText(content, 500),
      preferred_name_capture: preferredNameCapture?.preferredName ?? null,
    },
    'Parsed inbound message content',
  );

  const newMessage: NewMessage = {
    id: msgId,
    account_id: account.id,
    sender,
    sender_name,
    content,
    timestamp: msg.create_time_ms
      ? new Date(msg.create_time_ms).toISOString()
      : new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
  storeMessage(newMessage);

  const recentMsgs = getRecentMessages(account.id, 20);
  const contextLines = recentMsgs
    .slice()
    .reverse()
    .map((m) => `${m.is_from_me ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');

  let soulContent = '';
  const soulPath = getSoulPath(account.id);
  if (fs.existsSync(soulPath)) {
    soulContent = fs.readFileSync(soulPath, 'utf-8');
  }

  const prompt = buildConversationPrompt({
    account,
    companionName: companionState.profile.name,
    recentContext: contextLines,
    soulContent,
    companionContext: renderDynamicCompanionStateForPrompt(companionState),
    latestUserMessage: content,
    replyPolicy: (() => {
      const policy = buildReactionPolicy(companionState, content);
      return `当前场景：${policy.label}\n默认优先短回复。\n本轮总字数尽量不超过 ${policy.maxReplyChars} 个字。\n${policy.guidance}`;
    })(),
    isFirstContact: recentMsgs.length <= 1,
  });

  log.info(
    {
      msg_id: msgId,
      context_message_count: recentMsgs.length,
      context_chars: contextLines.length,
      soul_chars: soulContent.length,
      prompt_chars: prompt.length,
    },
    'Built agent prompt',
  );

  const tasksBeforeCount = getTasksForAccount(account.id).length;
  let response: string;
  try {
    const output = await runContainerAgent({
      accountId: account.id,
      prompt,
      sessionId: undefined,
      latestUserMessage: content,
      personaId: companionState.profile.personaId,
    });

    log.info(
      {
        msg_id: msgId,
        output_status: output.status,
        output_error: output.error,
        output_chars: output.result?.length ?? 0,
        output_preview: output.result ? previewText(output.result, 500) : null,
      },
      'Container agent completed',
    );

    if (output.status === 'error') {
      response = `抱歉，我刚刚有点没接稳这句话。${output.error ?? '请稍后再试。'}`;
    } else {
      response = enforceReplyPolicy({
        reply: output.result || '我收到了，正在认真想着怎么回您。',
        state: companionState,
        latestUserMessage: content,
      });
    }
  } catch (err) {
    log.error({ err }, 'Container agent failed');
    response = '抱歉，我这边刚刚短暂走神了一下，您稍后再和我说一句。';
  }

  maybeAutoScheduleReminder({
    account,
    userMessage: content,
    tasksBeforeCount,
    log,
    scope: { msg_id: msgId, sender },
  });

  let replySent = false;
  try {
    const sendResult = await ilinkSendMessage(
      {
        id: account.id,
        bot_token: account.bot_token,
        base_url: account.base_url,
      },
      sender,
      response,
      msg.context_token,
    );
    log.info(
      {
        to: sender,
        reply_chars: response.length,
        reply_preview: previewText(response, 500),
        interrupted: sendResult.interrupted,
        sent_segments: sendResult.sentSegments,
        total_segments: sendResult.totalSegments,
      },
      'Reply sent via iLink',
    );
    replySent = !sendResult.interrupted;
  } catch (err) {
    log.error(
      {
        err,
        to: sender,
        reply_chars: response.length,
        reply_preview: previewText(response, 500),
      },
      'Failed to send reply via iLink',
    );
  }

  if (replySent) {
    const botMsg: NewMessage = {
      id: `${msgId}_reply`,
      account_id: account.id,
      sender: account.id,
      sender_name: account.name,
      content: response,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    };
    storeMessage(botMsg);

    const memoryExtraction = await extractAndPersistPersonalMemories({
      account,
      latestUserMessage: content,
      assistantMessage: response,
      recentContext: contextLines,
    });
    log.info(
      { msg_id: msgId, ...memoryExtraction },
      'Persisted personal memories from turn',
    );

    const nextCompanionState = updateCompanionStateAfterTurn({
      state: companionState,
      userMessage: content,
      assistantMessage: response,
    });
    saveCompanionState(nextCompanionState);
  }
}

function getConversationBufferKey(accountId: string, sender: string): string {
  return `${accountId}:${sender}`;
}

function scheduleConversationFlush(key: string, delayMs = INBOUND_BATCH_WINDOW_MS): void {
  const buffer = conversationBuffers.get(key);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    void flushConversationBuffer(key);
  }, delayMs);
}

async function flushConversationBuffer(key: string): Promise<void> {
  const buffer = conversationBuffers.get(key);
  if (!buffer) return;

  buffer.timer = undefined;
  if (buffer.processing || buffer.messages.length === 0) {
    return;
  }

  buffer.processing = true;
  const batch = buffer.messages.splice(0, buffer.messages.length);
  const account = buffer.account;
  const sender = buffer.sender;
  const log = logger.child({ accountId: account.id, sender });
  const firstMsgId = batch[0]?.msgId ?? `batch-${Date.now()}`;
  const latestMsg = batch[batch.length - 1];
  const mergedUserMessage = batch.map((item) => item.content).join('\n');
  const companionState = ensureCompanionState(account);
  const interruptionNote = buffer.interruptedPendingReply
    ? '你刚才有一段回复还没发完，用户中途插话了。不要重复已经发出去的话，直接顺着用户刚刚的新消息自然接住。'
    : undefined;
  buffer.interruptedPendingReply = false;

  log.info(
    {
      first_msg_id: firstMsgId,
      last_msg_id: latestMsg?.msgId ?? null,
      batch_size: batch.length,
      merged_chars: mergedUserMessage.length,
      merged_preview: previewText(mergedUserMessage, 500),
    },
    batch.length > 1
      ? 'Processing buffered user message batch'
      : 'Processing single buffered user message',
  );

  const recentMsgs = getRecentMessages(account.id, 20);
  const contextLines = recentMsgs
    .slice()
    .reverse()
    .map((m) => `${m.is_from_me ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');

  let soulContent = '';
  const soulPath = getSoulPath(account.id);
  if (fs.existsSync(soulPath)) {
    soulContent = fs.readFileSync(soulPath, 'utf-8');
  }

  const prompt = buildConversationPrompt({
    account,
    companionName: companionState.profile.name,
    recentContext: contextLines,
    soulContent,
    companionContext: renderDynamicCompanionStateForPrompt(companionState),
    latestUserMessage: mergedUserMessage,
    replyPolicy: (() => {
      const policy = buildReactionPolicy(companionState, mergedUserMessage);
      return `当前场景：${policy.label}\n默认优先短回复。\n本轮总字数尽量不超过 ${policy.maxReplyChars} 个字。\n${policy.guidance}`;
    })(),
    interruptionNote,
    isFirstContact: recentMsgs.length <= batch.length,
  });

  log.info(
    {
      first_msg_id: firstMsgId,
      context_message_count: recentMsgs.length,
      context_chars: contextLines.length,
      soul_chars: soulContent.length,
      prompt_chars: prompt.length,
    },
    'Built agent prompt',
  );

  const tasksBeforeCount = getTasksForAccount(account.id).length;
  let response: string;
  try {
    const output = await runContainerAgent({
      accountId: account.id,
      prompt,
      sessionId: undefined,
      latestUserMessage: mergedUserMessage,
      personaId: companionState.profile.personaId,
    });

    log.info(
      {
        first_msg_id: firstMsgId,
        output_status: output.status,
        output_error: output.error,
        output_chars: output.result?.length ?? 0,
        output_preview: output.result ? previewText(output.result, 500) : null,
      },
      'Container agent completed',
    );

    if (output.status === 'error') {
      response = `æŠ±æ­‰ï¼Œæˆ‘åˆšåˆšæœ‰ç‚¹æ²¡æŽ¥ç¨³è¿™å¥è¯ã€‚${output.error ?? 'è¯·ç¨åŽå†è¯•ã€‚'}`;
    } else {
      response = enforceReplyPolicy({
        reply: output.result || 'æˆ‘æ”¶åˆ°äº†ï¼Œæ­£åœ¨è®¤çœŸæƒ³ç€æ€Žä¹ˆå›žæ‚¨ã€‚',
        state: companionState,
        latestUserMessage: mergedUserMessage,
      });
    }
  } catch (err) {
    log.error({ err, first_msg_id: firstMsgId }, 'Container agent failed');
    response = 'æŠ±æ­‰ï¼Œæˆ‘è¿™è¾¹åˆšåˆšçŸ­æš‚èµ°ç¥žäº†ä¸€ä¸‹ï¼Œæ‚¨ç¨åŽå†å’Œæˆ‘è¯´ä¸€å¥ã€‚';
  }

  maybeAutoScheduleReminder({
    account,
    userMessage: mergedUserMessage,
    tasksBeforeCount,
    log,
    scope: { first_msg_id: firstMsgId, sender },
  });

  let replySent = false;
  try {
    const sendResult = await ilinkSendMessage(
      {
        id: account.id,
        bot_token: account.bot_token,
        base_url: account.base_url,
      },
      sender,
      response,
      latestMsg?.contextToken,
    );
    log.info(
      {
        to: sender,
        batch_size: batch.length,
        reply_chars: response.length,
        reply_preview: previewText(response, 500),
        interrupted: sendResult.interrupted,
        sent_segments: sendResult.sentSegments,
        total_segments: sendResult.totalSegments,
      },
      'Reply sent via iLink',
    );
    replySent = !sendResult.interrupted;

    if (sendResult.interrupted) {
      log.info(
        {
          to: sender,
          batch_size: batch.length,
          sent_segments: sendResult.sentSegments,
          total_segments: sendResult.totalSegments,
        },
        'Reply was interrupted by new inbound message; skipping full turn persistence',
      );
    }
  } catch (err) {
    log.error(
      {
        err,
        to: sender,
        batch_size: batch.length,
        reply_chars: response.length,
        reply_preview: previewText(response, 500),
      },
      'Failed to send reply via iLink',
    );
  }

  if (replySent) {
    const botMsg: NewMessage = {
      id: `${latestMsg?.msgId ?? firstMsgId}_reply`,
      account_id: account.id,
      sender: account.id,
      sender_name: account.name,
      content: response,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    };
    storeMessage(botMsg);

    const memoryExtraction = await extractAndPersistPersonalMemories({
      account,
      latestUserMessage: mergedUserMessage,
      assistantMessage: response,
      recentContext: contextLines,
    });
    log.info(
      { first_msg_id: firstMsgId, ...memoryExtraction },
      'Persisted personal memories from merged turn',
    );

    const nextCompanionState = updateCompanionStateAfterTurn({
      state: companionState,
      userMessage: mergedUserMessage,
      assistantMessage: response,
    });
    saveCompanionState(nextCompanionState);
  }

  buffer.processing = false;
  if (buffer.messages.length > 0) {
    scheduleConversationFlush(key);
    return;
  }

  if (!buffer.timer) {
    conversationBuffers.delete(key);
  }
}

async function enqueueWeixinMessage(
  account: Account,
  msg: import('./ilink.js').WeixinMessage,
): Promise<void> {
  const log = logger.child({ accountId: account.id });
  const msgId = String(msg.message_id ?? `msg-${Date.now()}`);

  log.info(
    {
      msg_id: msgId,
      from: msg.from_user_id,
      message_type: msg.message_type,
      item_count: msg.item_list?.length ?? 0,
    },
    'Processing message',
  );

  const parsed = parseWeixinMessage(msg, account.id);
  if (!parsed) {
    log.info(
      { msg_id: msgId, from: msg.from_user_id, message_type: msg.message_type },
      'Skipping message because no supported text content was extracted',
    );
    return;
  }

  const { content, sender, sender_name } = parsed;
  const timestamp = msg.create_time_ms
    ? new Date(msg.create_time_ms).toISOString()
    : new Date().toISOString();

  if (
    await handleSlashCommand({
      account,
      sender,
      content,
      contextToken: msg.context_token,
    })
  ) {
    log.info({ msg_id: msgId, sender, command: content }, 'Handled slash command');
    return;
  }

  const interruptedPendingReply = interruptPendingOutbound(account.id, sender);
  const preferredNameCapture = capturePreferredNameMemory({
    account,
    latestUserMessage: content,
  });
  if (preferredNameCapture) {
    log.info(
      { msg_id: msgId, preferred_name: preferredNameCapture.preferredName },
      'Captured preferred name into memory',
    );
  }

  log.info(
    {
      msg_id: msgId,
      from: sender,
      content_length: content.length,
      content_preview: previewText(content, 500),
      preferred_name_capture: preferredNameCapture?.preferredName ?? null,
    },
    'Parsed inbound message content',
  );

  const newMessage: NewMessage = {
    id: msgId,
    account_id: account.id,
    sender,
    sender_name,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
  storeMessage(newMessage);

  const key = getConversationBufferKey(account.id, sender);
  const buffer =
    conversationBuffers.get(key) ??
    ({
      account,
      sender,
      senderName: sender_name,
      messages: [],
      processing: false,
    } satisfies ConversationBuffer);

  buffer.account = account;
  buffer.senderName = sender_name;
  if (interruptedPendingReply) {
    buffer.interruptedPendingReply = true;
  }
  buffer.messages.push({
    msgId,
    sender,
    senderName: sender_name,
    content,
    timestamp,
    contextToken: msg.context_token,
  });
  conversationBuffers.set(key, buffer);

  log.info(
    {
      msg_id: msgId,
      sender,
      buffered_count: buffer.messages.length,
      flush_in_ms: INBOUND_BATCH_WINDOW_MS,
      interrupted_pending_reply: interruptedPendingReply,
    },
    'Queued inbound message for short-window merge',
  );

  scheduleConversationFlush(key);
}

// =====================
// Account management
// =====================

export async function addAccount(
  name: string,
  userId: string,
  botToken: string,
  accountId?: string,
  baseUrl: string = 'https://ilinkai.weixin.qq.com',
): Promise<Account> {
  const resolvedAccountId =
    accountId || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const account: Account = {
    id: resolvedAccountId,
    user_id: userId,
    name,
    bot_token: botToken,
    base_url: baseUrl,
    soul_md_path: getSoulPath(resolvedAccountId),
    get_updates_buf: '',
    enabled: 1,
    created_at: new Date().toISOString(),
  };

  ensureDirectories(resolvedAccountId);

  const soulPath = getSoulPath(resolvedAccountId);
  fs.writeFileSync(
    soulPath,
    `# ${name} 的记忆\n\n## 基本信息\n- 姓名：${name}\n\n## 重要事件\n\n`,
  );

  ensureSoulFile({ soulPath, personaId: 'xiaoxue' });
  createAccount(account);
  upsertAccountSettings(account.id, {});
  ensureCompanionState(account);
  logger.info({ accountId: resolvedAccountId, name }, 'Account created');

  return account;
}

export function removeAccount(accountId: string): void {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const soulPath = getSoulPath(accountId);
  if (fs.existsSync(soulPath)) {
    fs.unlinkSync(soulPath);
  }

  const ipcDir = getIpcDir(accountId);
  if (fs.existsSync(ipcDir)) {
    fs.rmSync(ipcDir, { recursive: true });
  }

  deleteAccount(accountId);
  logger.info({ accountId }, 'Account removed');
}

export function listAccounts(): Account[] {
  return getAllAccounts();
}

export async function sendManualAgentMessage(params: {
  accountId: string;
  text: string;
  toUserId?: string;
  disableSplit?: boolean;
}): Promise<{
  toUserId: string;
  clientId: string;
  interrupted: boolean;
  sentSegments: number;
  totalSegments: number;
}> {
  const account = getAccount(params.accountId);
  if (!account) {
    throw new Error(`Account not found: ${params.accountId}`);
  }

  const text = params.text.trim();
  if (!text) {
    throw new Error('Message text must not be empty.');
  }

  const toUserId = params.toUserId?.trim() || account.user_id;
  const sendResult = await ilinkSendMessage(
    {
      id: account.id,
      bot_token: account.bot_token,
      base_url: account.base_url,
    },
    toUserId,
    text,
    undefined,
    { disableSplit: params.disableSplit ?? true },
  );

  if (!sendResult.interrupted) {
    const botMsg: NewMessage = {
      id: sendResult.clientId || `manual_${Date.now()}`,
      account_id: account.id,
      sender: account.id,
      sender_name: account.name,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    };
    storeMessage(botMsg);

    const nextCompanionState = recordCompanionOutboundTouch({
      state: ensureCompanionState(account),
      type: 'sharing',
      summary: text,
    });
    saveCompanionState(nextCompanionState);
  }

  logger.info(
    {
      accountId: account.id,
      to: toUserId,
      chars: text.length,
      interrupted: sendResult.interrupted,
      sent_segments: sendResult.sentSegments,
      total_segments: sendResult.totalSegments,
    },
    'Manual agent message sent',
  );

  return {
    toUserId,
    clientId: sendResult.clientId,
    interrupted: sendResult.interrupted,
    sentSegments: sendResult.sentSegments,
    totalSegments: sendResult.totalSegments,
  };
}

export function createLocalDebugSession(accountId: string): LocalDebugSession {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const baseState = ensureCompanionState(account);
  return {
    accountId: account.id,
    state: JSON.parse(JSON.stringify(baseState)) as CompanionState,
    transcript: [],
  };
}

export async function runLocalDebugTurn(
  session: LocalDebugSession,
  userText: string,
): Promise<string> {
  const account = getAccount(session.accountId);
  if (!account) {
    throw new Error(`Account not found: ${session.accountId}`);
  }

  const trimmed = userText.trim();
  if (!trimmed) {
    throw new Error('User text must not be empty.');
  }

  const storedContext = getRecentMessages(account.id, 12)
    .slice()
    .reverse()
    .map((message) => ({
      is_from_me: message.is_from_me,
      content: message.content,
    }));
  const debugContext = session.transcript.map((turn) => ({
    is_from_me: turn.role === 'assistant',
    content: turn.content,
  }));
  const recentContext = buildRecentContextFromMessages(
    [...storedContext, ...debugContext].slice(-20),
  );

  const response = await generateAgentReply({
    account,
    companionState: session.state,
    latestUserMessage: trimmed,
    recentContext,
    isFirstContact: storedContext.length === 0 && session.transcript.length === 0,
    logScope: { mode: 'local-debug' },
  });

  session.transcript.push(
    { role: 'user', content: trimmed },
    { role: 'assistant', content: response },
  );
  session.state = updateCompanionStateAfterTurn({
    state: session.state,
    userMessage: trimmed,
    assistantMessage: response,
  });

  return response;
}

// =====================
// iLink polling per account
// =====================

async function startAccountPolling(account: Account): Promise<void> {
  if (!account.enabled) {
    logger.debug(
      { accountId: account.id },
      'Account disabled, skipping polling',
    );
    return;
  }

  const log = logger.child({ accountId: account.id });
  log.info('Starting iLink long-polling');

  const ilinkAccount: IlinkAccount = {
    id: account.id,
    bot_token: account.bot_token,
    base_url: account.base_url,
  };

  let buf = account.get_updates_buf ?? '';

  while (true) {
    try {
      const resp = await getUpdates(ilinkAccount, buf);

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        log.error(
          { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg },
          'getUpdates error',
        );
        await sleep(5000);
        continue;
      }

      if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
        buf = resp.get_updates_buf;
        updateAccount(account.id, { get_updates_buf: buf });
      }

      if (resp.msgs && resp.msgs.length > 0) {
        log.info(
          {
            count: resp.msgs.length,
            messages: resp.msgs.map((m) => ({
              id: String(m.message_id ?? ''),
              from: m.from_user_id ?? '',
              type: m.message_type ?? null,
              text_preview: previewText(
                (m.item_list ?? [])
                  .map((item) => item.text_item?.text ?? item.voice_item?.text ?? '')
                  .filter(Boolean)
                  .join(' | '),
                200,
              ),
            })),
          },
          'Received messages',
        );
        for (const msg of resp.msgs) {
          if (msg.message_type === 1) {
            enqueueWeixinMessage(account, msg);
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'Error in iLink polling loop');
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================
// Main entry
// =====================

export async function main(): Promise<void> {
  logger.info('SnowWord starting...');

  await ensureRuntimeReady();

  initDatabase();
  logger.info('Database initialized');

  const accounts = getAllAccounts();
  const enabledAccounts = accounts.filter((a) => a.enabled);

  for (const account of accounts) {
    ensureDirectories(account.id);
    ensureSoulFile({
      soulPath: account.soul_md_path,
      personaId: getAccountSettings(account.id)?.persona_id ?? 'xiaoxue',
    });
    compactStructuredMemories({ account });
    ensureCompanionState(account);
  }

  for (const account of enabledAccounts) {
    startAccountPolling(account).catch((err) => {
      logger.error({ accountId: account.id, err }, 'Account polling crashed');
    });
  }

  logger.info(
    { count: enabledAccounts.length },
    'iLink polling started for enabled accounts',
  );

  startSchedulerLoop();

  logger.info('SnowWord running');
}

const isDirectRun =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    if (
      err instanceof Error &&
      err.message.startsWith('Another SnowWord instance is already running')
    ) {
      logger.error({ err }, 'Refusing to start a second SnowWord instance');
      console.error(
        '\nSnowWord is already running.\n' +
          `Lock file: ${INSTANCE_LOCK_PATH}\n` +
          'Stop the existing process or remove the stale lock file if that process is gone.\n',
      );
      process.exit(1);
      return;
    }

    logger.error({ err }, 'Fatal error');
    process.exit(1);
  });
}

