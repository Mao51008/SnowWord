import { AGENT_MODEL } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { persistStructuredMemory } from './user-memory.js';
import { Account } from './types.js';

type Provider = 'openai' | 'anthropic';

interface ExtractedMemoryItem {
  content: string;
  tags: string[];
  importance?: number;
}

function getSecrets(): Record<string, string | undefined> {
  const fileSecrets = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);

  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || fileSecrets.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || fileSecrets.OPENAI_BASE_URL,
    ANTHROPIC_API_KEY:
      process.env.ANTHROPIC_API_KEY || fileSecrets.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL:
      process.env.ANTHROPIC_BASE_URL || fileSecrets.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN:
      process.env.CLAUDE_CODE_OAUTH_TOKEN || fileSecrets.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_AUTH_TOKEN:
      process.env.ANTHROPIC_AUTH_TOKEN || fileSecrets.ANTHROPIC_AUTH_TOKEN,
  };
}

function detectProvider(secrets: Record<string, string | undefined>): Provider {
  if (secrets.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

function getAnthropicToken(
  secrets: Record<string, string | undefined>,
): string | undefined {
  return secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
}

function normalizeOpenAIBaseUrl(baseUrl?: string): string {
  const base = (baseUrl || 'https://api.openai.com').replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function getDefaultImportance(tags: string[]): number {
  if (tags.includes('preferred_name') || tags.includes('health')) return 5;
  if (
    tags.includes('name') ||
    tags.includes('age') ||
    tags.includes('gender') ||
    tags.includes('city') ||
    tags.includes('medication')
  ) {
    return 4;
  }
  if (tags.includes('schedule') || tags.includes('occupation')) return 3;
  return 3;
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function callOpenAI(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const res = await fetch(`${normalizeOpenAIBaseUrl(params.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            '你是一个个人信息记忆抽取器。只提取关于用户的个人资料类信息，输出严格 JSON。',
        },
        { role: 'user', content: params.prompt },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI-compatible API ${res.status}: ${text}`);
  }

  const data = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(params: {
  baseUrl: string;
  apiKey?: string;
  oauthToken?: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (params.apiKey) headers['x-api-key'] = params.apiKey;
  if (params.oauthToken) headers.authorization = `Bearer ${params.oauthToken}`;

  const res = await fetch(`${params.baseUrl?.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 800,
      temperature: 0.1,
      system:
        '你是一个个人信息记忆抽取器。只提取关于用户的个人资料类信息，输出严格 JSON。',
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic-compatible API ${res.status}: ${text}`);
  }

  const data = JSON.parse(text) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return data.content
    ?.filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n') ?? '';
}

async function extractMemoryCandidates(args: {
  latestUserMessage: string;
  assistantMessage: string;
  recentContext?: string;
}): Promise<ExtractedMemoryItem[]> {
  const prompt = [
    '请从下面对话里抽取“关于用户的个人资料类信息”。',
    '只保留适合长期记住的信息，例如：姓名、偏好称呼、性别、年龄、城市/常住地、职业工作、作息习惯、身体状况、是否吃药、药物名称、家庭角色、长期习惯。',
    '不要提取一次性闲聊内容，不要提取纯情绪，不要提取你不确定的推测。',
    '如果没有可记的信息，返回 {"items":[] }。',
    '输出必须是 JSON，对象结构为 {"items":[{"content":"用户...","tags":["profile","city"],"importance":4}] }。',
    '',
    `最近上下文：\n${args.recentContext || '(无)'}`,
    '',
    `用户刚说：\n${args.latestUserMessage}`,
    '',
    `助手回复：\n${args.assistantMessage}`,
  ].join('\n');

  const secrets = getSecrets();
  const provider = detectProvider(secrets);
  const raw =
    provider === 'openai' && secrets.OPENAI_API_KEY
      ? await callOpenAI({
          baseUrl: secrets.OPENAI_BASE_URL || 'https://api.openai.com',
          apiKey: secrets.OPENAI_API_KEY,
          model: AGENT_MODEL,
          prompt,
        })
      : await callAnthropic({
          baseUrl: secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
          apiKey: secrets.ANTHROPIC_API_KEY,
          oauthToken: getAnthropicToken(secrets),
          model: AGENT_MODEL,
          prompt,
        });

  const jsonText = extractJsonObject(raw);
  if (!jsonText) return [];

  const parsed = JSON.parse(jsonText) as { items?: ExtractedMemoryItem[] };
  return Array.isArray(parsed.items) ? parsed.items : [];
}

export async function extractAndPersistPersonalMemories(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
  latestUserMessage: string;
  assistantMessage: string;
  recentContext?: string;
}): Promise<{ created: number; skipped: number }> {
  try {
    const candidates = await extractMemoryCandidates({
      latestUserMessage: args.latestUserMessage,
      assistantMessage: args.assistantMessage,
      recentContext: args.recentContext,
    });

    let created = 0;
    let skipped = 0;

    for (const item of candidates.slice(0, 8)) {
      const content = item.content?.trim();
      const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
      if (!content || !content.startsWith('用户')) {
        skipped += 1;
        continue;
      }

      const result = persistStructuredMemory({
        account: args.account,
        content,
        importance: item.importance ?? getDefaultImportance(tags),
        tags: tags.join(','),
      });

      if (result.created) created += 1;
      else skipped += 1;
    }

    return { created, skipped };
  } catch (err) {
    logger.warn({ err, accountId: args.account.id }, 'Personal memory extraction failed');
    return { created: 0, skipped: 0 };
  }
}
