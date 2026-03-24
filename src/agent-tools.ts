import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, TIMEZONE } from './config.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  getTasksForAccount,
  updateTask,
} from './db.js';
import {
  getCurrentTimeSnapshot,
  getWeatherSummary,
  inferLocationFromMemory,
  isWeatherConfigured,
} from './weather.js';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface AgentToolContext {
  accountId: string;
  sentMessages: string[];
  latestUserMessage?: string;
}

const toolContextStorage = new AsyncLocalStorage<AgentToolContext>();

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function requireToolContext(): AgentToolContext {
  const context = toolContextStorage.getStore();
  if (!context) {
    throw new Error('Agent tool context is not initialized');
  }
  return context;
}

export async function withAgentToolContext<T>(
  context: AgentToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  return await toolContextStorage.run(context, fn);
}

function getSoulPath(accountId: string): string {
  return path.join(DATA_DIR, 'soul', `${accountId}.md`);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated, ${text.length - max} chars omitted)`;
}

function computeNextRunFromSchedule(args: {
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
}): string | null {
  if (args.schedule_type === 'once') {
    const date = new Date(args.schedule_value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  if (args.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(args.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  const ms = parseInt(args.schedule_value, 10);
  if (!ms || ms <= 0) return null;
  return new Date(Date.now() + ms).toISOString();
}

function validateSchedule(args: {
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
}): string | null {
  if (args.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(args.schedule_value, { tz: TIMEZONE });
      return null;
    } catch {
      return `Invalid cron expression: "${args.schedule_value}"`;
    }
  }

  if (args.schedule_type === 'interval') {
    const ms = parseInt(args.schedule_value, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      return `Invalid interval: "${args.schedule_value}". Must be positive milliseconds.`;
    }
    return null;
  }

  if (Number.isNaN(new Date(args.schedule_value).getTime())) {
    return `Invalid timestamp: "${args.schedule_value}"`;
  }
  return null;
}

function inferScheduleTypeFromUserText(
  text: string | undefined,
): 'once' | 'interval' | null {
  if (!text) return null;

  const normalized = text.toLowerCase().replace(/\s+/g, '');

  const recurringPatterns = [
    /每隔/,
    /每天/,
    /每周/,
    /每月/,
    /每小时/,
    /重复提醒/,
    /按时提醒/,
    /every/,
    /daily/,
    /weekly/,
    /monthly/,
    /hourly/,
    /recurring/,
    /repeat/,
  ];

  if (recurringPatterns.some((pattern) => pattern.test(normalized))) {
    return 'interval';
  }

  const oneShotPatterns = [
    /后/,
    /今天/,
    /今晚/,
    /今早/,
    /上午/,
    /中午/,
    /下午/,
    /晚上/,
    /明天/,
    /后天/,
    /later/,
    /tomorrow/,
    /in\d+/,
  ];

  if (oneShotPatterns.some((pattern) => pattern.test(normalized))) {
    return 'once';
  }

  return null;
}

function parseChineseNumber(raw: string): number | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  if (/^\d+(\.\d+)?$/.test(normalized)) {
    return parseFloat(normalized);
  }
  if (normalized === '半') return 0.5;
  if (normalized === '十') return 10;

  const tenIndex = normalized.indexOf('十');
  if (tenIndex !== -1) {
    const left = normalized.slice(0, tenIndex);
    const right = normalized.slice(tenIndex + 1);
    const tens = left ? CHINESE_DIGITS[left] : 1;
    const ones = right ? CHINESE_DIGITS[right] : 0;
    if (tens == null || (right && ones == null)) return null;
    return tens * 10 + ones;
  }

  if (normalized.length === 1 && CHINESE_DIGITS[normalized] != null) {
    return CHINESE_DIGITS[normalized];
  }

  return null;
}

function inferRelativeDelayMsFromUserText(text: string | undefined): number | null {
  if (!text) return null;

  const normalized = text.toLowerCase().replace(/\s+/g, '');

  const chineseMatch = normalized.match(
    /(\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)(秒后|分钟后|分后|小时后|天后)/,
  );
  if (chineseMatch) {
    const value = parseChineseNumber(chineseMatch[1]);
    const unit = chineseMatch[2];
    if (value == null) return null;

    if (unit.startsWith('秒')) return Math.round(value * 1000);
    if (unit.startsWith('分')) return Math.round(value * 60_000);
    if (unit.startsWith('小时')) return Math.round(value * 3_600_000);
    if (unit.startsWith('天')) return Math.round(value * 86_400_000);
  }

  const englishMatch = normalized.match(
    /in(\d+)(second|seconds|minute|minutes|hour|hours|day|days)/,
  );
  if (englishMatch) {
    const value = parseInt(englishMatch[1], 10);
    const unit = englishMatch[2];
    if (unit.startsWith('second')) return value * 1000;
    if (unit.startsWith('minute')) return value * 60_000;
    if (unit.startsWith('hour')) return value * 3_600_000;
    if (unit.startsWith('day')) return value * 86_400_000;
  }

  return null;
}

function parseClockTimeFromUserText(text: string): { hour: number; minute: number } | null {
  const normalized = text.replace(/\s+/g, '');
  const match = normalized.match(
    /(\d{1,2}|[零一二两三四五六七八九十]+)点(?:(\d{1,2}|[零一二两三四五六七八九十]+)分?|半)?/,
  );
  if (!match) return null;

  const hourRaw = parseChineseNumber(match[1]);
  if (hourRaw == null) return null;
  let hour = Math.floor(hourRaw);
  let minute = 0;

  if (match[2] === '半') {
    minute = 30;
  } else if (normalized.includes(`${match[1]}点半`)) {
    minute = 30;
  } else if (match[2]) {
    const minuteRaw = parseChineseNumber(match[2]);
    if (minuteRaw == null) return null;
    minute = Math.floor(minuteRaw);
  }

  if (/(下午|晚上|今晚|傍晚)/.test(normalized) && hour < 12) {
    hour += 12;
  }
  if (/(中午)/.test(normalized) && hour < 11) {
    hour += 12;
  }
  if (/(凌晨)/.test(normalized) && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function inferAbsoluteOnceFromUserText(text: string | undefined): string | null {
  if (!text) return null;

  const normalized = text.replace(/\s+/g, '');
  const clock = parseClockTimeFromUserText(normalized);
  if (!clock) return null;

  const now = new Date();
  const target = new Date(now);
  target.setSeconds(0, 0);

  if (normalized.includes('后天')) {
    target.setDate(target.getDate() + 2);
  } else if (normalized.includes('明天')) {
    target.setDate(target.getDate() + 1);
  }

  target.setHours(clock.hour, clock.minute, 0, 0);

  const hasExplicitDay =
    normalized.includes('今天') ||
    normalized.includes('今晚') ||
    normalized.includes('今早') ||
    normalized.includes('明天') ||
    normalized.includes('后天');

  if (!hasExplicitDay && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.toISOString();
}

function normalizeScheduleArgs(args: {
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  reminder_type?: 'medicine' | 'exercise' | 'water' | 'custom';
  voice_text?: string;
}): {
  normalized: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    reminder_type?: 'medicine' | 'exercise' | 'water' | 'custom';
    voice_text?: string;
  };
  note: string | null;
} {
  const context = requireToolContext();
  const userText = context.latestUserMessage;
  const inferredType = inferScheduleTypeFromUserText(userText);
  const inferredDelayMs = inferRelativeDelayMsFromUserText(userText);
  const inferredAbsoluteOnce = inferAbsoluteOnceFromUserText(userText);

  if (args.schedule_type === 'interval' && inferredType === 'once') {
    const ms = parseInt(args.schedule_value, 10);
    if (!Number.isNaN(ms) && ms > 0) {
      return {
        normalized: {
          ...args,
          schedule_type: 'once',
          schedule_value: new Date(Date.now() + ms).toISOString(),
        },
        note:
          'Normalized schedule_type from interval to once based on the latest user request.',
      };
    }
  }

  if (args.schedule_type === 'once' && inferredDelayMs != null) {
    return {
      normalized: {
        ...args,
        schedule_value: new Date(Date.now() + inferredDelayMs).toISOString(),
      },
      note:
        'Normalized one-time reminder timestamp from the latest user request.',
    };
  }

  if (args.schedule_type === 'once' && inferredAbsoluteOnce) {
    return {
      normalized: {
        ...args,
        schedule_value: inferredAbsoluteOnce,
      },
      note:
        'Normalized one-time reminder clock time from the latest user request.',
    };
  }

  return { normalized: args, note: null };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current local time and date for the assistant.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        'Get current weather for a location. Use only when WEATHER_BASE_URL is configured. WEATHER_API_KEY is optional and only needed if the provider requires it. If location is omitted, infer it from the user memory. If no location can be inferred, do not call.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'Optional city or district name. Omit to use the user location from memory.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a text message to the user. Use for AI companion responses.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send to the user' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description:
        'Schedule a recurring or one-time reminder. Use once for one-time requests like "30 seconds later", "today at 12", "tomorrow at 8". Use interval only for repeating requests like "every 30 minutes". Cron example: "0 9 * * *". Interval example: "3600000". Once example: "2026-03-25T15:30:00".',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to remind the user about' },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description:
              'Schedule type. Use once for one-time reminders, interval only for repeating reminders, cron for calendar-style repeating reminders.',
          },
          schedule_value: { type: 'string', description: 'Schedule value' },
          reminder_type: {
            type: 'string',
            enum: ['medicine', 'exercise', 'water', 'custom'],
            description: 'Reminder type',
          },
          voice_text: {
            type: 'string',
            description: 'Text to speak or show for the reminder',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List all scheduled reminders for this account.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_reminder',
      description: 'Pause, resume, or cancel a scheduled reminder.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string', description: 'Reminder ID' },
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'cancel'],
            description: 'Action',
          },
        },
        required: ['reminder_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        "Read relevant memories from the user's long-term memory (soul.md).",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in memory' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description:
        'Write an important fact to long-term memory. Use sparingly for durable facts.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content to write' },
          importance: {
            type: 'number',
            description: 'Importance level 1-5',
            minimum: 1,
            maximum: 5,
          },
          tags: { type: 'string', description: 'Comma-separated tags' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search memory entries by tag or importance.',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Tag to search for' },
          min_importance: {
            type: 'number',
            description: 'Minimum importance level',
            minimum: 1,
            maximum: 5,
          },
        },
      },
    },
  },
];

async function executeSendMessage(args: { text: string }): Promise<ToolResult> {
  const context = requireToolContext();
  context.sentMessages.push(args.text);
  return { output: 'Message queued for delivery.' };
}

async function executeGetCurrentTime(): Promise<ToolResult> {
  const snapshot = getCurrentTimeSnapshot();
  return {
    output: `当前时间：${snapshot.formatted}（${snapshot.weekday}，时区 ${snapshot.timezone}）`,
  };
}

async function executeGetWeather(args: { location?: string }): Promise<ToolResult> {
  const context = requireToolContext();

  if (!isWeatherConfigured()) {
    return {
      output:
        'Weather API is not configured. Set WEATHER_BASE_URL first. WEATHER_API_KEY is optional if your provider needs it.',
      isError: true,
    };
  }

  const inferredLocation = args.location || inferLocationFromMemory(context.accountId);
  if (!inferredLocation) {
    return {
      output: 'No user location found in memory, so weather lookup was skipped.',
      isError: true,
    };
  }

  try {
    const weather = await getWeatherSummary({
      accountId: context.accountId,
      location: inferredLocation,
    });
    if (!weather) {
      return {
        output: 'Weather lookup is unavailable right now.',
        isError: true,
      };
    }

    const parts = [
      `${weather.location}当前天气：${weather.description}`,
      weather.temperatureC != null ? `气温 ${weather.temperatureC}°C` : null,
      weather.feelsLikeC != null ? `体感 ${weather.feelsLikeC}°C` : null,
      weather.humidity != null ? `湿度 ${weather.humidity}%` : null,
      weather.windSpeed != null ? `风速 ${weather.windSpeed}m/s` : null,
      weather.advice,
    ].filter(Boolean);

    return { output: parts.join('，') };
  } catch (err) {
    return {
      output: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

async function executeScheduleReminder(args: {
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  reminder_type?: 'medicine' | 'exercise' | 'water' | 'custom';
  voice_text?: string;
}): Promise<ToolResult> {
  const { normalized, note } = normalizeScheduleArgs(args);
  const validationError = validateSchedule(normalized);
  if (validationError) {
    return { output: validationError, isError: true };
  }

  const context = requireToolContext();
  const taskId = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const nextRun = computeNextRunFromSchedule(normalized);

  createTask({
    id: taskId,
    account_id: context.accountId,
    prompt: normalized.prompt,
    schedule_type: normalized.schedule_type,
    schedule_value: normalized.schedule_value,
    reminder_type: normalized.reminder_type || 'custom',
    voice_text: normalized.voice_text || normalized.prompt,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  return {
    output: `${note ? `${note} ` : ''}Reminder ${taskId} scheduled (${normalized.schedule_type}: ${normalized.schedule_value}) next=${nextRun ?? 'none'}`,
  };
}

async function executeListReminders(): Promise<ToolResult> {
  const context = requireToolContext();
  const tasks = getTasksForAccount(context.accountId);

  if (tasks.length === 0) {
    return { output: 'No scheduled reminders found.' };
  }

  const formatted = tasks
    .map(
      (task) =>
        `- [${task.id}] ${task.prompt.slice(0, 60)} (${task.schedule_type}: ${task.schedule_value}) status=${task.status} next=${task.next_run ?? 'N/A'}`,
    )
    .join('\n');

  return { output: `Scheduled reminders:\n${formatted}` };
}

async function executeManageReminder(args: {
  reminder_id: string;
  action: 'pause' | 'resume' | 'cancel';
}): Promise<ToolResult> {
  const context = requireToolContext();
  const task = getTaskById(args.reminder_id);

  if (!task || task.account_id !== context.accountId) {
    return {
      output: `Reminder ${args.reminder_id} not found for this account.`,
      isError: true,
    };
  }

  if (args.action === 'cancel') {
    deleteTask(task.id);
    return { output: `Reminder ${task.id} cancelled.` };
  }

  if (args.action === 'pause') {
    updateTask(task.id, { status: 'paused' });
    return { output: `Reminder ${task.id} paused.` };
  }

  const nextRun = computeNextRunFromSchedule(task);
  updateTask(task.id, { status: 'active', next_run: nextRun });
  return { output: `Reminder ${task.id} resumed. next=${nextRun ?? 'none'}` };
}

async function executeReadMemory(args: { query: string }): Promise<ToolResult> {
  const context = requireToolContext();
  const soulPath = getSoulPath(context.accountId);

  if (!fs.existsSync(soulPath)) {
    return { output: 'No memory found for this user.' };
  }

  const content = fs.readFileSync(soulPath, 'utf-8');
  const query = args.query.toLowerCase();

  if (content.toLowerCase().includes(query)) {
    return { output: truncate(content, 2000) };
  }

  const lines = content.split('\n');
  const firstSection = lines.slice(0, 50).join('\n');
  return {
    output: `No direct match for "${args.query}". Relevant memory:\n${firstSection}`,
  };
}

async function executeWriteMemory(args: {
  content: string;
  importance?: number;
  tags?: string;
}): Promise<ToolResult> {
  const context = requireToolContext();
  const soulPath = getSoulPath(context.accountId);
  fs.mkdirSync(path.dirname(soulPath), { recursive: true });

  let existing = '';
  if (fs.existsSync(soulPath)) {
    existing = fs.readFileSync(soulPath, 'utf-8');
  }

  const importance = args.importance || 3;
  const tagLine = args.tags ? `\nTags: ${args.tags}` : '';
  const newEntry = `\n\n## ${new Date().toLocaleDateString('zh-CN')} (importance: ${importance})${tagLine}\n${args.content}`;

  fs.writeFileSync(soulPath, existing + newEntry);
  return { output: `Memory written: ${truncate(args.content, 80)}` };
}

async function executeSearchMemory(args: {
  tag?: string;
  min_importance?: number;
}): Promise<ToolResult> {
  const context = requireToolContext();
  const soulPath = getSoulPath(context.accountId);

  if (!fs.existsSync(soulPath)) {
    return { output: 'No memory found for this user.' };
  }

  const content = fs.readFileSync(soulPath, 'utf-8');
  const lines = content.split('\n');
  const results: string[] = [];
  const minImportance = args.min_importance || 1;

  for (const line of lines) {
    if (args.tag && line.toLowerCase().includes(args.tag.toLowerCase())) {
      results.push(line);
      continue;
    }

    if (line.includes('importance:')) {
      const match = line.match(/importance:\s*(\d)/);
      if (match && parseInt(match[1], 10) >= minImportance) {
        results.push(line);
      }
    }
  }

  if (results.length === 0) {
    return {
      output: `No memories found${args.tag ? ` for tag "${args.tag}"` : ''}.`,
    };
  }

  return {
    output: `Found ${results.length} memory entries:\n${results.slice(0, 20).join('\n')}`,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_current_time':
      return executeGetCurrentTime();
    case 'get_weather':
      return executeGetWeather(args as Parameters<typeof executeGetWeather>[0]);
    case 'send_message':
      return executeSendMessage(args as Parameters<typeof executeSendMessage>[0]);
    case 'schedule_reminder':
      return executeScheduleReminder(
        args as Parameters<typeof executeScheduleReminder>[0],
      );
    case 'list_reminders':
      return executeListReminders();
    case 'manage_reminder':
      return executeManageReminder(
        args as Parameters<typeof executeManageReminder>[0],
      );
    case 'read_memory':
      return executeReadMemory(args as Parameters<typeof executeReadMemory>[0]);
    case 'write_memory':
      return executeWriteMemory(args as Parameters<typeof executeWriteMemory>[0]);
    case 'search_memory':
      return executeSearchMemory(
        args as Parameters<typeof executeSearchMemory>[0],
      );
    default:
      return { output: `Unknown tool: ${name}`, isError: true };
  }
}
