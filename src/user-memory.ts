import { Account, Memory } from './types.js';
import {
  clearMemoriesForAccount,
  createMemory,
  deleteMemory,
  getAccountSettings,
  getMemoriesForAccount,
} from './db.js';
import { rewriteSoulMemorySection } from './soul.js';

export interface PreferredNameCapture {
  preferredName: string;
  memoryContent: string;
}

const SINGLE_VALUE_TAGS = new Set([
  'preferred_name',
  'name',
  'gender',
  'age',
  'city',
  'occupation',
]);

function parseTags(tags: string): string[] {
  return tags
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function canonicalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  const mapping: Record<string, string> = {
    nickname: 'preferred_name',
    preferred_nickname: 'preferred_name',
    addressing: 'addressing',
    preference: 'preference',
    location: 'city',
    place: 'city',
    work: 'occupation',
    profession: 'occupation',
    job: 'occupation',
  };
  return mapping[normalized] ?? normalized;
}

function buildTags(tags: string[]): string {
  return Array.from(new Set(tags.map(canonicalizeTag))).join(',');
}

function normalizePreferredName(raw: string): string | null {
  const candidate = raw
    .trim()
    .replace(/^[“"'‘’「『（(【\[]+/, '')
    .replace(/[”"'‘’」』）)】\],.!?，。！？：:]+$/, '')
    .trim();

  if (!candidate || candidate.length > 12) return null;

  const blocked = new Set([
    '你',
    '您',
    '我',
    '自己',
    '名字',
    '称呼',
    '一下',
    '这个',
    '那个',
    '随便',
  ]);

  if (blocked.has(candidate)) return null;
  return candidate;
}

function normalizeText(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function getPrimarySingularTag(tags: string): string | null {
  for (const tag of parseTags(tags)) {
    if (SINGLE_VALUE_TAGS.has(tag)) return tag;
  }
  return null;
}

function parsePreferredName(text: string): string | null {
  const patterns = [
    /(?:你可以叫我|可以叫我|叫我|喊我|称呼我)([^，。！？\s"'“”‘’]{1,12})/,
    /(?:用户(?:喜欢被|希望被)?称呼为|用户喜欢被叫)(?:“|"|')?([^，。！？\s"'“”‘’]{1,12})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const preferredName = normalizePreferredName(match?.[1] ?? '');
    if (preferredName) return preferredName;
  }

  return null;
}

function extractPersonName(text: string): string | null {
  const patterns = [
    /(?:我叫|我的名字是)([^，。！？\s"'“”‘’]{1,12})/,
    /用户的名字是(?:“|"|')?([^，。！？\s"'“”‘’]{1,12})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = normalizePreferredName(match?.[1] ?? '');
    if (name) return name;
  }

  return null;
}

function extractAge(text: string): number | null {
  const match = text.match(/(?:今年|现在)?(\d{1,3})岁/);
  if (!match) return null;
  const age = Number.parseInt(match[1], 10);
  if (!Number.isFinite(age) || age <= 0 || age > 120) return null;
  return age;
}

function extractCity(text: string): string | null {
  const match =
    text.match(/(?:住在|常住(?:在|地是)?|在)(北京|上海|天津|重庆|香港|澳门|台北|台中|高雄|[^\s，。！？]{2,12}(?:市|区|县|州))/) ??
    text.match(/(?:来自|城市是)(北京|上海|天津|重庆|香港|澳门|台北|台中|高雄|[^\s，。！？]{2,12}(?:市|区|县|州))/);
  return match?.[1] ?? null;
}

function extractOccupation(text: string): string | null {
  const explicit =
    text.match(/(?:职业是|工作是|从事)([^，。！？]{2,20})/) ??
    text.match(/(?:用户(?:的)?职业是)([^，。！？]{2,20})/);
  if (explicit?.[1]) {
    return normalizeText(explicit[1]).replace(/[。！？，,]+$/, '');
  }

  if (/(在上班|上班中|有正式工作|要上班|正在上班)/.test(text)) {
    return '在上班';
  }

  return null;
}

function normalizeMemoryFact(
  content: string,
  tags: string,
): {
  content: string;
  tags: string;
} {
  const rawTags = parseTags(tags);
  const normalizedTags = buildTags(rawTags);
  const text = normalizeText(content);

  const preferredName =
    parsePreferredName(text) ??
    (rawTags.some((tag) =>
      ['preferred_name', 'nickname', 'preferred_nickname', 'addressing', 'preference'].includes(
        canonicalizeTag(tag),
      ),
    )
      ? normalizePreferredName(
          text.match(/[“"'‘’「『（(【\[]?([^“”"'‘’」』）)】\]，。！？\s]{1,12})[”"'‘’」』）)】\]]?/)?.[1] ??
            '',
        )
      : null);
  if (preferredName) {
    return {
      content: `用户喜欢被称呼为“${preferredName}”。`,
      tags: 'profile,addressing,preferred_name',
    };
  }

  const name =
    extractPersonName(text) ??
    (rawTags.some((tag) => canonicalizeTag(tag) === 'name')
      ? normalizePreferredName(
          text.match(/[“"'‘’「『（(【\[]?([^“”"'‘’」』）)】\]，。！？\s]{1,12})[”"'‘’」』）)】\]]?/)?.[1] ??
            '',
        )
      : null);
  if (name) {
    return {
      content: `用户的名字是“${name}”。`,
      tags: 'profile,name',
    };
  }

  if (
    /(男性|男生|男的)/.test(text) ||
    rawTags.some((tag) => canonicalizeTag(tag) === 'gender' && /男/.test(text))
  ) {
    return {
      content: '用户是男性。',
      tags: 'profile,gender',
    };
  }

  if (
    /(女性|女生|女的)/.test(text) ||
    rawTags.some((tag) => canonicalizeTag(tag) === 'gender' && /女/.test(text))
  ) {
    return {
      content: '用户是女性。',
      tags: 'profile,gender',
    };
  }

  const age = extractAge(text);
  if (age !== null || rawTags.some((tag) => canonicalizeTag(tag) === 'age')) {
    return {
      content: `用户今年${age ?? text.replace(/[^\d]/g, '')}岁。`,
      tags: 'profile,age',
    };
  }

  const city = extractCity(text);
  if (city || rawTags.some((tag) => canonicalizeTag(tag) === 'city')) {
    return {
      content: `用户在${city ?? text.replace(/^用户(?:在|住在|来自)?/, '').replace(/[。！？，,]+$/g, '')}。`,
      tags: 'profile,city',
    };
  }

  const occupation = extractOccupation(text);
  if (occupation || rawTags.some((tag) => canonicalizeTag(tag) === 'occupation')) {
    return {
      content: occupation === '在上班' ? '用户在上班。' : `用户的工作是${occupation ?? text}。`,
      tags: 'profile,occupation',
    };
  }

  return {
    content: text,
    tags: normalizedTags,
  };
}

function rebuildSoulMemory(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
}): void {
  const personaId = getAccountSettings(args.account.id)?.persona_id ?? 'xiaoxue';
  const memories = getMemoriesForAccount(args.account.id)
    .slice()
    .reverse()
    .map((memory) => ({
      content: memory.content,
      tags: memory.tags,
      importance: memory.importance,
    }));

  rewriteSoulMemorySection({
    soulPath: args.account.soul_md_path,
    personaId,
    entries: memories,
  });
}

export function compactStructuredMemories(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
}): void {
  const memories = getMemoriesForAccount(args.account.id);
  if (memories.length === 0) {
    rebuildSoulMemory({ account: args.account });
    return;
  }

  const kept = new Map<
    string,
    {
      content: string;
      tags: string;
      importance: number;
      created_at: string;
      accessed_at: string;
    }
  >();

  for (const memory of memories) {
    const normalized = normalizeMemoryFact(memory.content, memory.tags);
    const singularTag = getPrimarySingularTag(normalized.tags);
    const key = singularTag
      ? `single:${singularTag}`
      : `fact:${normalized.tags}:${normalized.content}`;

    if (kept.has(key)) continue;

    kept.set(key, {
      content: normalized.content,
      tags: normalized.tags,
      importance: memory.importance,
      created_at: memory.created_at,
      accessed_at: memory.accessed_at,
    });
  }

  clearMemoriesForAccount(args.account.id);

  const ordered = Array.from(kept.values()).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  for (const memory of ordered) {
    createMemory({
      account_id: args.account.id,
      content: memory.content,
      importance: memory.importance,
      tags: memory.tags,
      created_at: memory.created_at,
      accessed_at: memory.accessed_at,
    });
  }

  rebuildSoulMemory({ account: args.account });
}

function deleteConflictingSingleValueMemories(
  memories: Memory[],
  nextContent: string,
  nextTags: string,
): void {
  const primaryTag = getPrimarySingularTag(nextTags);
  if (!primaryTag) return;

  for (const memory of memories) {
    const normalizedExisting = normalizeMemoryFact(memory.content, memory.tags);
    const existingPrimaryTag = getPrimarySingularTag(normalizedExisting.tags);
    if (existingPrimaryTag !== primaryTag) continue;
    if (
      normalizedExisting.content === nextContent &&
      normalizedExisting.tags === nextTags
    ) {
      continue;
    }
    deleteMemory(memory.id);
  }
}

export function extractPreferredName(text: string): PreferredNameCapture | null {
  const preferredName = parsePreferredName(text);
  if (!preferredName) return null;

  return {
    preferredName,
    memoryContent: `用户喜欢被称呼为“${preferredName}”。`,
  };
}

export function persistStructuredMemory(args: {
  account: Pick<Account, 'id' | 'soul_md_path'>;
  content: string;
  importance?: number;
  tags?: string;
}): { created: boolean } {
  const normalized = normalizeMemoryFact(args.content, args.tags ?? '');
  const content = normalized.content;
  const tags = normalized.tags;
  const currentMemories = getMemoriesForAccount(args.account.id);
  const existing = currentMemories.find((memory) => {
    const normalizedExisting = normalizeMemoryFact(memory.content, memory.tags);
    return (
      normalizedExisting.content === content && normalizedExisting.tags === tags
    );
  });

  if (existing) {
    return { created: false };
  }

  deleteConflictingSingleValueMemories(currentMemories, content, tags);

  const now = new Date().toISOString();
  createMemory({
    account_id: args.account.id,
    content,
    importance: args.importance ?? 3,
    tags,
    created_at: now,
    accessed_at: now,
  });

  rebuildSoulMemory({ account: args.account });
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
