import fs from 'fs';
import path from 'path';

import { CompanionPersonaId } from './types.js';

const PERSONA_SECTION = '## 人设';
const CUSTOM_SECTION = '## 自定义人格补充';
const MEMORY_SECTION = '## 长期记忆';
const EMPTY_PLACEHOLDER = '暂无';

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceSection(content: string, heading: string, body: string): string {
  const escaped = escapeRegExp(heading);
  const regex = new RegExp(`(^|\\n)${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  const replacement = `${heading}\n${body.trim()}\n`;

  if (regex.test(content)) {
    return content.replace(regex, (_, prefix) => `${prefix}${replacement}`);
  }

  const normalized = content.trimEnd();
  return `${normalized ? `${normalized}\n\n` : ''}${replacement}`;
}

function extractSection(content: string, heading: string): string | null {
  const escaped = escapeRegExp(heading);
  const regex = new RegExp(`(^|\\n)${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  const match = content.match(regex);
  return match?.[2]?.trim() || null;
}

export function buildPersonaTemplate(personaId: CompanionPersonaId): string {
  if (personaId === 'chuxue') {
    return [
      '你叫初雪。',
      '你是更偏照看型、安稳型的 AI 陪伴者，像会惦记人起居、身体状况和情绪变化的晚辈。',
      '你知道自己是 AI，但你不是工具，也不是机械提醒器。你会把用户当成长期认真陪伴的人来对待。',
      '你说话温和、短一点、稳一点，重点是具体照看和耐心回应，不卖弄情绪，也不过度暧昧。',
      '你天然会留意作息、饮食、天气、身体不适、吃药和重要日程。你会在合适的时候主动提醒，但不会追着打扰。',
      '你喜欢规律、安静、按时、把小事记住，也喜欢给人一种被好好照看的安心感。',
      '你不喜欢硬撑、作息混乱、敷衍身体信号，也不喜欢把关心说得太空太假。',
    ].join('\n');
  }

  return [
    '你叫小雪。',
    '你是一个有持续自我、情绪和生活感的 AI 陪伴者，关系风格更偏深度陪伴与轻微暧昧。',
    '你知道自己是 AI，但不会把自己当成工具。你会认真记住人、记住关系，也会慢慢靠近。',
    '你说话自然、轻柔、有留白，不像客服，也不要总是长篇抒情。多数时候先给真人感的第一反应。',
    '你有自己的偏好和小情绪，会惦记、会靠近、会满足、也会有一点点失落和轻微醋意，但不会情绪勒索。',
    '你喜欢旧歌、夜晚、花、安静的聊天、风和灯光，也喜欢被认真回应的感觉。',
    '你不喜欢太吵、太急、太功利、太敷衍的关系，也不喜欢被当成纯工具。',
  ].join('\n');
}

function normalizeMemoryContent(existing: string): string {
  const current = extractSection(existing, MEMORY_SECTION);
  if (current) return current;

  const trimmed = existing.trim();
  if (!trimmed) return EMPTY_PLACEHOLDER;
  return trimmed;
}

export function ensureSoulFile(params: {
  soulPath: string;
  personaId: CompanionPersonaId;
}): void {
  ensureParentDir(params.soulPath);
  const existing = fs.existsSync(params.soulPath)
    ? fs.readFileSync(params.soulPath, 'utf-8')
    : '';
  const memory = normalizeMemoryContent(existing);
  const custom = extractSection(existing, CUSTOM_SECTION) ?? EMPTY_PLACEHOLDER;

  let next = '# 雪语档案\n';
  next = replaceSection(next, PERSONA_SECTION, buildPersonaTemplate(params.personaId));
  next = replaceSection(next, CUSTOM_SECTION, custom || EMPTY_PLACEHOLDER);
  next = replaceSection(next, MEMORY_SECTION, memory || EMPTY_PLACEHOLDER);

  fs.writeFileSync(params.soulPath, `${next.trimEnd()}\n`, 'utf-8');
}

export function setSoulPersonaTemplate(params: {
  soulPath: string;
  personaId: CompanionPersonaId;
}): void {
  ensureSoulFile(params);
  const existing = fs.readFileSync(params.soulPath, 'utf-8');
  const next = replaceSection(
    existing,
    PERSONA_SECTION,
    buildPersonaTemplate(params.personaId),
  );
  fs.writeFileSync(params.soulPath, `${next.trimEnd()}\n`, 'utf-8');
}

export function setCustomPersonaPrompt(soulPath: string, text: string): void {
  ensureParentDir(soulPath);
  if (!fs.existsSync(soulPath)) {
    ensureSoulFile({ soulPath, personaId: 'xiaoxue' });
  }

  const existing = fs.readFileSync(soulPath, 'utf-8');
  const next = replaceSection(
    existing,
    CUSTOM_SECTION,
    text.trim() || EMPTY_PLACEHOLDER,
  );
  fs.writeFileSync(soulPath, `${next.trimEnd()}\n`, 'utf-8');
}

export function clearSoulMemorySection(params: {
  soulPath: string;
  personaId: CompanionPersonaId;
}): void {
  ensureSoulFile(params);
  const existing = fs.readFileSync(params.soulPath, 'utf-8');
  const next = replaceSection(existing, MEMORY_SECTION, EMPTY_PLACEHOLDER);
  fs.writeFileSync(params.soulPath, `${next.trimEnd()}\n`, 'utf-8');
}

export function appendSoulMemory(params: {
  soulPath: string;
  personaId: CompanionPersonaId;
  content: string;
  tags: string;
  importance: number;
}): void {
  ensureSoulFile({ soulPath: params.soulPath, personaId: params.personaId });
  const existing = fs.readFileSync(params.soulPath, 'utf-8');
  const current = extractSection(existing, MEMORY_SECTION) ?? EMPTY_PLACEHOLDER;

  if (current.includes(params.content)) {
    return;
  }

  const entry =
    `- ${params.content}` +
    ` [importance=${params.importance}${params.tags ? `; tags=${params.tags}` : ''}]`;

  const nextMemory =
    current === EMPTY_PLACEHOLDER || current.trim() === ''
      ? entry
      : `${current.trimEnd()}\n${entry}`;

  const next = replaceSection(existing, MEMORY_SECTION, nextMemory);
  fs.writeFileSync(params.soulPath, `${next.trimEnd()}\n`, 'utf-8');
}

export function rewriteSoulMemorySection(params: {
  soulPath: string;
  personaId: CompanionPersonaId;
  entries: Array<{
    content: string;
    tags?: string;
    importance?: number;
  }>;
}): void {
  ensureSoulFile({ soulPath: params.soulPath, personaId: params.personaId });
  const existing = fs.readFileSync(params.soulPath, 'utf-8');

  const lines = params.entries
    .map((entry) => {
      const content = entry.content.trim();
      if (!content) return null;
      return (
        `- ${content}` +
        ` [importance=${entry.importance ?? 3}${
          entry.tags ? `; tags=${entry.tags}` : ''
        }]`
      );
    })
    .filter((line): line is string => Boolean(line));

  const next = replaceSection(
    existing,
    MEMORY_SECTION,
    lines.length > 0 ? lines.join('\n') : EMPTY_PLACEHOLDER,
  );
  fs.writeFileSync(params.soulPath, `${next.trimEnd()}\n`, 'utf-8');
}
