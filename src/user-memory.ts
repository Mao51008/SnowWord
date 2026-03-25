import fs from 'fs';
import path from 'path';

import { Account } from './types.js';
import { createMemory, getMemoriesForAccount } from './db.js';

export interface PreferredNameCapture {
  preferredName: string;
  memoryContent: string;
}

function normalizePreferredName(raw: string): string | null {
  const candidate = raw
    .trim()
    .replace(/^[“"'‘（(【\[]+/, '')
    .replace(/[”"'’）)】\],.!?，。！？、：:]+$/, '')
    .trim();

  if (!candidate || candidate.length > 12) return null;

  const blocked = new Set([
    '一下',
    '这个',
    '那个',
    '自己',
    '宝宝',
    '老公',
    '老婆',
    '哥哥',
    '姐姐',
    '叔叔',
    '阿姨',
    '男的',
    '女的',
    '学生',
    '老师',
  ]);

  if (blocked.has(candidate)) return null;
  return candidate;
}

export function extractPreferredName(text: string): PreferredNameCapture | null {
  const patterns = [
    /(?:叫我|你可以叫我|你就叫我|称呼我|喊我)([^\s，。！？、,.!?]{1,12})/,
    /(?:我叫|我是)([^\s，。！？、,.!?]{1,12})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const preferredName = normalizePreferredName(match[1]);
    if (!preferredName) continue;

    return {
      preferredName,
      memoryContent: `用户希望被称呼为“${preferredName}”。之后优先这样称呼对方。`,
    };
  }

  return null;
}

function appendMemoryToSoulFile(soulPath: string, content: string, tags: string): void {
  fs.mkdirSync(path.dirname(soulPath), { recursive: true });
  const existing = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';

  if (existing.includes(content)) {
    return;
  }

  const entry =
    `\n\n## ${new Date().toLocaleDateString('zh-CN')} (importance: 5)\n` +
    `Tags: ${tags}\n` +
    `${content}`;

  fs.writeFileSync(soulPath, existing + entry);
}

export function persistStructuredMemory(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
  content: string;
  importance?: number;
  tags?: string;
}): { created: boolean } {
  const tags = args.tags ?? '';
  const existing = getMemoriesForAccount(args.account.id).find(
    (memory) => memory.content === args.content && memory.tags === tags,
  );

  if (existing) {
    return { created: false };
  }

  const now = new Date().toISOString();
  createMemory({
    account_id: args.account.id,
    content: args.content,
    importance: args.importance ?? 3,
    tags,
    created_at: now,
    accessed_at: now,
  });

  appendMemoryToSoulFile(args.account.soul_md_path, args.content, tags);
  return { created: true };
}

export function capturePreferredNameMemory(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
  latestUserMessage: string;
}): PreferredNameCapture | null {
  const extracted = extractPreferredName(args.latestUserMessage);
  if (!extracted) return null;

  persistStructuredMemory({
    account: args.account,
    content: extracted.memoryContent,
    importance: 5,
    tags: 'profile,addressing,preferred_name',
  });

  return extracted;
}
