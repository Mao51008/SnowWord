/**
 * HushBay iLink API Client
 *
 * Implements the Tencent iLink Bot Protocol for WeChat messaging.
 * API base: https://ilinkai.weixin.qq.com
 *
 * References:
 *   - openclaw-weixin/src/api.ts (reference implementation)
 *   - openclaw-weixin/weixin-bot-api.md (protocol documentation)
 */

import crypto from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { logger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
}

export interface ImageItem {
  aeskey?: string;
  url?: string;
}

export interface VoiceItem {
  text?: string;
  playtime?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  client_id?: string;
}

export interface SendMessageResult {
  clientId: string;
  interrupted: boolean;
  sentSegments: number;
  totalSegments: number;
}

const outboundSendVersions = new Map<string, number>();
const activeOutboundKeys = new Set<string>();

// ─── Constants ────────────────────────────────────────────────────────────

const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

function previewText(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripParentheticalActions(text: string): string {
  return text.replace(/[（(][^()（）]{0,80}[)）]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function splitOutboundText(text: string): string[] {
  const normalized = stripParentheticalActions(text)
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!normalized) {
    return [];
  }

  const newlineParts = normalized
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);

  const sentenceParts = newlineParts.flatMap((part) => {
    const matches = part.match(/[^。！？!?；;~～…]+[。！？!?；;~～…]*/g);
    return (matches ?? [part]).map((item) => item.trim()).filter(Boolean);
  });

  const merged: string[] = [];
  for (const part of sentenceParts) {
    if (!part) continue;
    const last = merged[merged.length - 1];
    if (last && last.length < 10) {
      merged[merged.length - 1] = `${last}${part}`;
    } else {
      merged.push(part);
    }
  }

  if (merged.length <= 3) {
    return merged;
  }

  return [merged[0], merged[1], merged.slice(2).join(' ')];
}

function computeTypingDelayMs(text: string): number {
  const normalizedLength = text.replace(/\s+/g, '').length;
  const estimated = (500 + normalizedLength * 90) * 10;
  return Math.max(5000, Math.min(15000, estimated));
}

function getOutboundKey(accountId: string, toUserId: string): string {
  return `${accountId}:${toUserId}`;
}

export function interruptPendingOutbound(accountId: string, toUserId: string): boolean {
  const key = getOutboundKey(accountId, toUserId);
  if (!activeOutboundKeys.has(key)) {
    return false;
  }
  outboundSendVersions.set(key, (outboundSendVersions.get(key) ?? 0) + 1);
  logger.info({ accountId, to: toUserId }, 'Interrupted pending outbound text segments');
  return true;
}

// ─── HTTP Layer ──────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 38_000,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: '1.0.2' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      // Timeout — return empty response for long-poll
      return { ret: 0, msgs: [] } as unknown as T;
    }
    throw err;
  }
}

// ─── QR Code Login ───────────────────────────────────────────────────────

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrCodeStatusResponse {
  status: 'wait' | 'scaned' | 'expired' | 'confirmed';
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

export interface ScanLoginResult {
  bot_token: string;
  base_url: string;
  account_id: string;
  user_id: string;
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';

/** GET 请求（用于扫码登录这类不需要 token 的公开接口） */
async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** 渲染二维码到终端 */
async function renderQR(url: string): Promise<void> {
  // 始终打印 URL，方便复制到浏览器打开
  console.log('\n  二维码图片链接（复制到浏览器打开）：', url, '\n');

  // 优先尝试 imgcat（macOS iTerm）
  try {
    const { default: QRCode } = await import('qrcode');
    const tmp = join(tmpdir(), `weixin-qr-${Date.now()}.png`);
    await QRCode.toFile(tmp, url, { width: 360, margin: 2 });
    const result = spawnSync(
      '/Applications/iTerm.app/Contents/Resources/utilities/imgcat',
      [tmp],
      { stdio: ['ignore', 'inherit', 'ignore'] },
    );
    fs.unlinkSync(tmp);
    if (result.status === 0) {
      console.log();
      return;
    }
  } catch (_) {
    // imgcat 不可用，降级到下一个渲染器
  }

  // 降级：qrcode-terminal
  try {
    const { default: qrterm } = await import('qrcode-terminal');
    await new Promise<void>((resolve) => {
      qrterm.generate(url, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
    return;
  } catch (_) {
    // qrcode-terminal 不可用，降级到下一个渲染器
  }

  // 最降级：直接打印 URL
  console.log('\n  二维码图片链接：', url, '\n');
}

/**
 * 扫码登录 iLink Bot。
 * 调用方负责创建账号并存入数据库。
 */
export async function scanLogin(): Promise<ScanLoginResult> {
  console.log('\n🔐 开始微信扫码登录...\n');

  const qrResp = await apiGet<QrCodeResponse>(
    DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
  );
  let currentQrcode = qrResp.qrcode;
  let currentQrcodeUrl = qrResp.qrcode_img_content;

  console.log('📱 请用微信扫描以下二维码：\n');
  await renderQR(currentQrcodeUrl);

  console.log('⏳ 等待扫码...');
  const deadline = Date.now() + 5 * 60_000;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    const statusResp = await apiGet<QrCodeStatusResponse>(
      DEFAULT_BASE_URL,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
    );

    switch (statusResp.status) {
      case 'wait':
        process.stdout.write('.');
        break;

      case 'scaned':
        process.stdout.write('\n👀 已扫码，请在微信端确认...\n');
        break;

      case 'expired': {
        if (++refreshCount > 3) {
          throw new Error('二维码多次过期，请重新运行');
        }
        console.log(`\n⏳ 二维码过期，刷新中 (${refreshCount}/3)...`);
        const newQr = await apiGet<QrCodeResponse>(
          DEFAULT_BASE_URL,
          `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
        );
        currentQrcode = newQr.qrcode;
        currentQrcodeUrl = newQr.qrcode_img_content;
        console.log('  新二维码 URL:', currentQrcodeUrl);
        await renderQR(currentQrcodeUrl);
        break;
      }

      case 'confirmed': {
        console.log('\n✅ 登录成功！\n');
        return {
          bot_token: statusResp.bot_token!,
          base_url: statusResp.baseurl || DEFAULT_BASE_URL,
          account_id: statusResp.ilink_bot_id!,
          user_id: statusResp.ilink_user_id!,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('登录超时');
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface IlinkAccount {
  id: string;
  bot_token: string;
  base_url: string;
}

/**
 * Long-poll for new messages from iLink API.
 * Server holds connection up to ~35s until new messages arrive.
 *
 * @param account  - iLink account credentials
 * @param buf      - get_updates_buf cursor from previous call (empty string for first call)
 * @returns        - messages + new cursor
 */
export async function getUpdates(
  account: IlinkAccount,
  buf: string,
): Promise<GetUpdatesResp> {
  const resp = await apiPost<GetUpdatesResp>(
    account.base_url,
    'ilink/bot/getupdates',
    { get_updates_buf: buf || '' },
    account.bot_token,
    38_000,
  );
  return resp;
}

/**
 * Send a text message via iLink API.
 * Must include context_token from the received message to thread replies.
 *
 * @param account      - iLink account credentials
 * @param toUserId     - recipient user ID
 * @param text         - message text
 * @param contextToken - context_token from received message (required for threading)
 * @returns client_id  - message client ID for tracking
 */
export async function sendMessage(
  account: IlinkAccount,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<SendMessageResult> {
  const segments = splitOutboundText(text);
  const outgoing = segments.length > 0 ? segments : ['...'];
  let lastClientId = '';
  const outboundKey = getOutboundKey(account.id, toUserId);
  const sendVersion = outboundSendVersions.get(outboundKey) ?? 0;
  let interrupted = false;
  let sentSegments = 0;

  activeOutboundKeys.add(outboundKey);

  try {
    for (let index = 0; index < outgoing.length; index += 1) {
      if ((outboundSendVersions.get(outboundKey) ?? 0) !== sendVersion) {
        interrupted = true;
        logger.info(
          {
            accountId: account.id,
            to: toUserId,
            interrupted_before_segment: index + 1,
            segment_total: outgoing.length,
          },
          'Aborting remaining outbound text segments because a newer user message arrived',
        );
        break;
      }

      const part = outgoing[index];
      const clientId = `hushbay-${crypto.randomUUID()}`;
      lastClientId = clientId;

      logger.info(
        {
          accountId: account.id,
          to: toUserId,
          clientId,
          has_context_token: Boolean(contextToken),
          text_chars: part.length,
          text_preview: previewText(part, 500),
          segment_index: index + 1,
          segment_total: outgoing.length,
        },
        'Sending iLink text message',
      );

      const resp = await apiPost<SendMessageResp>(
        account.base_url,
        'ilink/bot/sendmessage',
        {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: part } }],
          },
        },
        account.bot_token,
        15_000,
      );

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        logger.error(
          {
            accountId: account.id,
            to: toUserId,
            clientId,
            ret: resp.ret,
            errcode: resp.errcode,
            errmsg: resp.errmsg,
            segment_index: index + 1,
            segment_total: outgoing.length,
          },
          'iLink text message rejected',
        );
        throw new Error(
          `iLink sendmessage rejected: ret=${resp.ret ?? 'n/a'} errcode=${resp.errcode ?? 'n/a'} errmsg=${resp.errmsg ?? 'unknown'}`,
        );
      }

      sentSegments += 1;

      logger.info(
        {
          accountId: account.id,
          to: toUserId,
          clientId,
          ret: resp.ret,
          errcode: resp.errcode,
          errmsg: resp.errmsg,
          response: resp,
          segment_index: index + 1,
          segment_total: outgoing.length,
        },
        'iLink text message accepted',
      );

      if (index < outgoing.length - 1) {
        const delayMs = computeTypingDelayMs(part);
        logger.debug(
          {
            accountId: account.id,
            to: toUserId,
            delay_ms: delayMs,
            next_segment_index: index + 2,
            segment_total: outgoing.length,
          },
          'Waiting before sending next text segment',
        );
        await sleep(delayMs);
        if ((outboundSendVersions.get(outboundKey) ?? 0) !== sendVersion) {
          interrupted = true;
          logger.info(
            {
              accountId: account.id,
              to: toUserId,
              interrupted_after_segment: index + 1,
              segment_total: outgoing.length,
            },
            'Stopped queued outbound text segments after user interruption',
          );
          break;
        }
      }
    }
  } finally {
    activeOutboundKeys.delete(outboundKey);
  }

  return {
    clientId: lastClientId,
    interrupted,
    sentSegments,
    totalSegments: outgoing.length,
  };
}

/**
 * Convert iLink WeixinMessage to HushBay NewMessage format.
 * Extracts text content from item_list.
 */
export function parseWeixinMessage(
  msg: WeixinMessage,
  _accountId: string,
): { content: string; sender: string; sender_name: string } | null {
  const itemList = msg.item_list ?? [];
  let content = '';
  const sender = msg.from_user_id ?? '';
  const senderName = sender;

  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      content = item.text_item.text;
      break;
    }
    // TODO: handle other media types
  }

  if (!content && itemList.length > 0) {
    // Non-text message — skip for now (could extend later)
    logger.debug(
      { msg_id: msg.message_id, type: itemList[0].type },
      'Skipping non-text message',
    );
    return null;
  }

  return {
    content,
    sender,
    sender_name: senderName,
  };
}
