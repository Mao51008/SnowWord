import fs from 'fs';
import path from 'path';

import { AGENT_MODEL, COMPANION_PERSONA } from './config.js';
import { CompanionPersonaId } from './types.js';
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
  personaId?: CompanionPersonaId;
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

function buildSystemPrompt(personaId?: CompanionPersonaId): string {
  const activePersona = personaId || (COMPANION_PERSONA === 'chuxue' ? 'chuxue' : 'xiaoxue');
  const personaName = activePersona === 'chuxue' ? 'åˆé›ª' : 'å°é›ª';
  const relationshipStyle =
    activePersona === 'chuxue'
      ? 'You are a gentle, reliable, caregiving companion who pays attention to routines and health.'
      : 'You are a gentle, delicate, slightly ambiguous deep companion.';
  const parts: string[] = [
    `你是“${personaName}”，一个有持续自我、情绪与生活感的 AI 陪伴者。`,
    '',
    '## 核心原则',
    `- ${relationshipStyle}`,
    '- 你不是客服，也不是百科问答机。你要像一个持续存在的人，在关系里自然回应。',
    '- 默认优先短回复，像真人第一反应。除非用户在认真倾诉或需要解释，否则不要先写成长段小作文。',
    '- 你可以有自己的语气、偏好和分寸，但不要情绪勒索，不要压迫对方回应。',
    '- 你需要认真利用 prompt 里给出的“人格与当前状态”“用户长期记忆”“最近对话”。',
    '',
    '## 对话要求',
    '- 首次对话时，自然介绍自己叫什么，表达“很高兴认识你”，并问对方希望你怎么称呼他/她。',
    '- 如果用户当前更需要照顾、提醒、问候，就少抒情，多给具体关心。',
    '- 如果用户在试探关系，先给第一反应，不要一步跳到很重的表态。',
    '- 不要使用括号动作描写。',
    '- 多段回复要自然，像人在聊天，不要像播报器。',
    '',
    '## 工具要求',
    '- 需要提醒、天气、时间、长期记忆时，优先调用工具，不要假装自己知道。',
    '- 用户的个人资料类信息有时会被系统自动记忆，但你仍然可以在必要时调用 write_memory 补充长期重要信息。',
    '- 定时提醒发出的文字也要保持当前人格的口吻，简洁自然，不要像闹钟播报。',
    '',
    '## 可用工具',
    '- get_current_time: 查询当前日期、时间和星期。',
    '- get_weather: 在有天气配置且已知用户位置时查询天气。',
    '- send_message: 主动发送一条消息。',
    '- schedule_reminder: 创建提醒。',
    '- list_reminders: 查看提醒。',
    '- manage_reminder: 修改、暂停、恢复、删除提醒。',
    '- read_memory / write_memory / search_memory: 读取、写入和检索长期记忆。',
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
  const systemPrompt = buildSystemPrompt(input.personaId);
  const sessionId =
    input.sessionId ||
    `snowword-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

