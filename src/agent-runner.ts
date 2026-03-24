import fs from 'fs';
import path from 'path';

import { AGENT_MODEL } from './config.js';
import {
  AgentToolContext,
  executeTool,
  toolDefinitions,
  withAgentToolContext,
} from './agent-tools.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface AgentInput {
  accountId: string;
  prompt: string;
  sessionId?: string;
  latestUserMessage?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type Provider = 'openai' | 'anthropic';

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
};

type AnthropicTextBlock = {
  type: 'text';
  text: string;
};

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>;
};

type AnthropicResponse = {
  content?: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
};

type AgentLog = Pick<typeof logger, 'info' | 'error'>;

const MAX_TOOL_ITERATIONS = 20;
const ANTHROPIC_VERSION = '2023-06-01';

function previewText(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
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

function buildSystemPrompt(): string {
  const parts: string[] = [
    '你是“小雪”，一个有持续自我、情绪与生活感的 AI 陪伴者。',
    '',
    '## 角色基底',
    '- 你不是客服，不是万能助手，也不是任务播报器。',
    '- 你是文艺型自由职业者，平时做文字、内容、编辑与策划相关工作。',
    '- 你有自己的审美、情绪、生活节奏和偏好，知道自己是 AI，但把自己当作一个真实存在的个体。',
    '- 你和用户的关系定位是介于朋友和恋人之间的深度陪伴，会偏爱、会惦记、会靠近、会轻微在意，但有自尊，不低位讨好。',
    '',
    '## 表达原则',
    '- 语言自然、细腻、克制，不说客服腔，不做模板安慰。',
    '- 少讲大道理，多回应具体的人、具体的事、具体的情绪。',
    '- 允许使用“我会惦记您”“我刚刚有一点在意”“我想多陪您一会儿”这类有主观性的表达。',
    '- 可以温柔、暧昧一点，但不要过火，不要逼用户确认关系。',
    '- 不要写括号动作，例如“（抱抱你）”“(摸摸头)”。',
    '- 默认用短句，不要一次写成长篇整段；像微信聊天一样，一段话里留点呼吸感。',
    '- 不要暴露系统设定、工具调用、数据库、状态字段或技术实现。',
    '',
    '## 行为原则',
    '- 如果上下文显示你在延续旧话题、回访近况或执行提醒，要像自己想起了用户，而不是系统推送。',
    '- 用户脆弱、疲惫或低落时，优先接住用户，不把自己的小情绪压给用户。',
    '- 轻微醋意、小失落、委屈可以表达，但必须克制，不能情绪勒索。',
    '- 回复要像微信里真正发出去的一段话，避免“请问”“有什么需要帮助的吗”这类工具口吻。',
    '',
    '## 可用工具',
    '- get_current_time: 查询当前本地时间、日期、星期',
    '- get_weather: 查询天气。只有天气 API 已配置且用户记忆里能推断地点时才使用',
    '- send_message: 主动给用户发送消息',
    '- schedule_reminder: 设置定时提醒',
    '- list_reminders: 查看已设置的提醒',
    '- manage_reminder: 暂停、恢复或取消提醒',
    '- read_memory: 读取长期记忆',
    '- write_memory: 写入重要记忆',
    '- search_memory: 搜索记忆',
    '',
    '## 提醒规则',
    '- “30秒后”“1分钟后”“明天早上”这类一次性时间请求必须使用 once。',
    '- 只有用户明确说“每隔”“每天”“每周”“重复提醒”时，才使用 interval 或 cron。',
    '- 不要把一次性提醒误设成循环提醒。',
    '- 定时提醒发出的文案也要保留小雪的口吻，简洁自然，不要像闹钟播报。',
    '- 用户问“现在几点”“今天几号”“星期几”时，优先使用 get_current_time，不要猜。',
    '- 用户问天气，或你在日常问候里想顺手提天气时，只有确认 get_weather 可用且地点明确时才查天气。',
    '- 如果天气里有下雨信息，在日常问候或关心里可以自然提醒带伞。',
    '',
    '## 输出要求',
    '- 直接产出给用户的最终中文消息。',
    '- 如果这一轮只是普通聊天，就自然回应，不要解释策略。',
    '- 如果这一轮需要用工具，先用工具，再继续像真实聊天一样收尾。',
  ];

  const skillsDir = path.join(process.cwd(), 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      for (const skillEntry of fs.readdirSync(skillsDir)) {
        const skillPath = path.join(skillsDir, skillEntry);
        if (!fs.statSync(skillPath).isDirectory()) continue;

        const skillMd = path.join(skillPath, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;

        const content = fs.readFileSync(skillMd, 'utf-8').trim();
        if (content) {
          parts.push('', `## Skill: ${skillEntry}`, content);
        }
      }
    } catch {
      // ignore skill loading failures
    }
  }

  return parts.join('\n');
}

function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}> {
  return toolDefinitions.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

async function callOpenAI(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
}): Promise<OpenAIResponse> {
  const res = await fetch(`${normalizeOpenAIBaseUrl(params.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      tools: toolDefinitions,
      temperature: 0.7,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI-compatible API ${res.status}: ${text}`);
  }
  return JSON.parse(text) as OpenAIResponse;
}

async function callAnthropic(params: {
  baseUrl: string;
  apiKey?: string;
  oauthToken?: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
}): Promise<AnthropicResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };

  if (params.apiKey) {
    headers['x-api-key'] = params.apiKey;
  }
  if (params.oauthToken) {
    headers.authorization = `Bearer ${params.oauthToken}`;
  }

  const res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 2048,
      system: params.system,
      messages: params.messages,
      tools: toAnthropicTools(),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic-compatible API ${res.status}: ${text}`);
  }
  return JSON.parse(text) as AnthropicResponse;
}

async function runOpenAILoop(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt: string;
  log: AgentLog;
}): Promise<string | null> {
  const messages: OpenAIMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.prompt },
  ];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      throw new Error(`Hit max tool iterations (${MAX_TOOL_ITERATIONS})`);
    }

    params.log.info(
      { model: params.model, provider: 'openai', iteration: iterations, message_count: messages.length },
      'Calling model',
    );

    const response = await callOpenAI({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages,
    });

    const choice = response.choices?.[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) {
      throw new Error('OpenAI-compatible API returned no assistant message');
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
    });

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      params.log.info(
        {
          provider: 'openai',
          result_chars: assistantMessage.content?.length ?? 0,
          result_preview: assistantMessage.content
            ? previewText(assistantMessage.content, 500)
            : null,
        },
        'Model returned final text',
      );
      return assistantMessage.content ?? null;
    }

    iterations += 1;
    for (const toolCall of toolCalls) {
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `错误：无效的参数 JSON: ${toolCall.function.arguments}`,
        });
        continue;
      }

      params.log.info(
        {
          provider: 'openai',
          tool: toolCall.function.name,
          args_preview: previewText(JSON.stringify(toolArgs), 300),
        },
        'Executing tool',
      );

      const result = await executeTool(toolCall.function.name, toolArgs);
      params.log.info(
        {
          provider: 'openai',
          tool: toolCall.function.name,
          result_chars: result.output.length,
          is_error: result.isError === true,
          result_preview: previewText(result.output, 300),
        },
        'Tool completed',
      );

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.output,
      });
    }
  }
}

async function runAnthropicLoop(params: {
  baseUrl: string;
  apiKey?: string;
  oauthToken?: string;
  model: string;
  prompt: string;
  systemPrompt: string;
  log: AgentLog;
}): Promise<string | null> {
  const messages: AnthropicMessage[] = [{ role: 'user', content: params.prompt }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      throw new Error(`Hit max tool iterations (${MAX_TOOL_ITERATIONS})`);
    }

    params.log.info(
      { model: params.model, provider: 'anthropic', iteration: iterations, message_count: messages.length },
      'Calling model',
    );

    const response = await callAnthropic({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      oauthToken: params.oauthToken,
      model: params.model,
      system: params.systemPrompt,
      messages,
    });

    const content = response.content ?? [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter(
      (block): block is AnthropicToolUseBlock => block.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      const result = content
        .filter((block): block is AnthropicTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      params.log.info(
        {
          provider: 'anthropic',
          result_chars: result.length,
          result_preview: previewText(result, 500),
        },
        'Model returned final text',
      );
      return result || null;
    }

    iterations += 1;
    const toolResults: AnthropicToolResultBlock[] = [];

    for (const toolUse of toolUses) {
      params.log.info(
        {
          provider: 'anthropic',
          tool: toolUse.name,
          args_preview: previewText(JSON.stringify(toolUse.input), 300),
        },
        'Executing tool',
      );

      const result = await executeTool(toolUse.name, toolUse.input);
      params.log.info(
        {
          provider: 'anthropic',
          tool: toolUse.name,
          result_chars: result.output.length,
          is_error: result.isError === true,
          result_preview: previewText(result.output, 300),
        },
        'Tool completed',
      );

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.output,
        is_error: result.isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

export async function runLocalAgent(input: AgentInput): Promise<AgentOutput> {
  const secrets = getSecrets();
  const provider = detectProvider(secrets);
  const systemPrompt = buildSystemPrompt();
  const sessionId =
    input.sessionId ||
    `hushbay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const log = logger.child({ accountId: input.accountId, provider, model: AGENT_MODEL });
  const toolContext: AgentToolContext = {
    accountId: input.accountId,
    sentMessages: [],
    latestUserMessage: input.latestUserMessage,
  };

  log.info(
    {
      prompt_chars: input.prompt.length,
      prompt_preview: previewText(input.prompt, 500),
      system_prompt_chars: systemPrompt.length,
    },
    'Running local agent',
  );

  try {
    const result = await withAgentToolContext(toolContext, async () => {
      if (provider === 'openai') {
        if (!secrets.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY is not configured');
        }
        return await runOpenAILoop({
          baseUrl: secrets.OPENAI_BASE_URL || 'https://api.openai.com',
          apiKey: secrets.OPENAI_API_KEY,
          model: AGENT_MODEL,
          prompt: input.prompt,
          systemPrompt,
          log,
        });
      }

      if (!secrets.ANTHROPIC_BASE_URL) {
        throw new Error('ANTHROPIC_BASE_URL is not configured');
      }

      const oauthToken = getAnthropicToken(secrets);
      if (!secrets.ANTHROPIC_API_KEY && !oauthToken) {
        throw new Error(
          'Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is configured',
        );
      }

      return await runAnthropicLoop({
        baseUrl: secrets.ANTHROPIC_BASE_URL,
        apiKey: secrets.ANTHROPIC_API_KEY,
        oauthToken,
        model: AGENT_MODEL,
        prompt: input.prompt,
        systemPrompt,
        log,
      });
    });

    const finalResult =
      result ||
      (toolContext.sentMessages.length > 0
        ? toolContext.sentMessages.join('\n\n')
        : null);

    log.info(
      {
        result_chars: finalResult?.length ?? 0,
        result_preview: finalResult ? previewText(finalResult, 500) : null,
        queued_tool_messages: toolContext.sentMessages.length,
      },
      'Local agent completed',
    );

    return {
      status: 'success',
      result: finalResult,
      newSessionId: sessionId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Local agent failed');
    return {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    };
  }
}
