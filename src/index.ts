/**
 * HushBay Runtime - Single entry point for AI companion
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
  createAccount,
  deleteAccount,
  getAccount,
  getAllAccounts,
  getRecentMessages,
  initDatabase,
  storeMessage,
  updateAccount,
} from './db.js';
import {
  ensureCompanionState,
  renderCompanionStateForPrompt,
  saveCompanionState,
  updateCompanionStateAfterTurn,
} from './companion-state.js';
import { runContainerAgent } from './container-runner.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import { Account, NewMessage } from './types.js';
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
  logger.info({ signal }, 'Shutting down HushBay');
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
            `Another HushBay instance is already running (pid=${existingPid}, started_at=${lock.started_at ?? 'unknown'}, lock_file=${INSTANCE_LOCK_PATH})`,
          );
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.startsWith('Another HushBay instance is already running')
          ) {
            throw err;
          }
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith('Another HushBay instance is already running')
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

function buildConversationPrompt(params: {
  account: Account;
  recentContext: string;
  soulContent: string;
  companionContext: string;
  latestUserMessage: string;
  interruptionNote?: string;
}): string {
  const recentContext = params.recentContext || '暂无';
  const soulContent = params.soulContent || '暂无';

  const sections = [
    `你正在和微信用户进行一对一聊天。请始终以 ${params.account.name} / 小雪 的身份回复。`,
    params.companionContext,
    '## 用户长期记忆',
    soulContent,
    '## 近期对话',
    recentContext,
    '## 用户刚刚发来的消息',
    params.interruptionNote ? '## Interrupted Reply Context' : null,
    params.interruptionNote ?? null,
    params.latestUserMessage,
    '请直接给出要发送给用户的自然中文回复，不要解释系统、状态或技术细节。',
  ].filter(Boolean);

  return sections.join('\n\n');
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

  log.info(
    {
      msg_id: msgId,
      from: sender,
      content_length: content.length,
      content_preview: previewText(content, 500),
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
    recentContext: contextLines,
    soulContent,
    companionContext: renderCompanionStateForPrompt(companionState),
    latestUserMessage: content,
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

  let response: string;
  try {
    const output = await runContainerAgent({
      accountId: account.id,
      prompt,
      sessionId: undefined,
      latestUserMessage: content,
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
      response = output.result || '我收到了，正在认真想着怎么回您。';
    }
  } catch (err) {
    log.error({ err }, 'Container agent failed');
    response = '抱歉，我这边刚刚短暂走神了一下，您稍后再和我说一句。';
  }

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
    recentContext: contextLines,
    soulContent,
    companionContext: renderCompanionStateForPrompt(companionState),
    latestUserMessage: mergedUserMessage,
    interruptionNote,
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

  let response: string;
  try {
    const output = await runContainerAgent({
      accountId: account.id,
      prompt,
      sessionId: undefined,
      latestUserMessage: mergedUserMessage,
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
      response = output.result || 'æˆ‘æ”¶åˆ°äº†ï¼Œæ­£åœ¨è®¤çœŸæƒ³ç€æ€Žä¹ˆå›žæ‚¨ã€‚';
    }
  } catch (err) {
    log.error({ err, first_msg_id: firstMsgId }, 'Container agent failed');
    response = 'æŠ±æ­‰ï¼Œæˆ‘è¿™è¾¹åˆšåˆšçŸ­æš‚èµ°ç¥žäº†ä¸€ä¸‹ï¼Œæ‚¨ç¨åŽå†å’Œæˆ‘è¯´ä¸€å¥ã€‚';
  }

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

function enqueueWeixinMessage(
  account: Account,
  msg: import('./ilink.js').WeixinMessage,
): void {
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

  const interruptedPendingReply = interruptPendingOutbound(account.id, sender);

  log.info(
    {
      msg_id: msgId,
      from: sender,
      content_length: content.length,
      content_preview: previewText(content, 500),
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

  createAccount(account);
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
  logger.info('HushBay starting...');

  await ensureRuntimeReady();

  initDatabase();
  logger.info('Database initialized');

  const accounts = getAllAccounts();
  const enabledAccounts = accounts.filter((a) => a.enabled);

  for (const account of accounts) {
    ensureDirectories(account.id);
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

  logger.info('HushBay running');
}

const isDirectRun =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    if (
      err instanceof Error &&
      err.message.startsWith('Another HushBay instance is already running')
    ) {
      logger.error({ err }, 'Refusing to start a second HushBay instance');
      console.error(
        '\nHushBay is already running.\n' +
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
