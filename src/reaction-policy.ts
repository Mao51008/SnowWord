import { CompanionState } from './types.js';

export interface ReactionPolicy {
  label: string;
  maxReplyChars: number;
  guidance: string;
}

type ReactionKind =
  | 'relationship_probe'
  | 'boundary_crossing'
  | 'greeting'
  | 'distress'
  | 'simple_daily'
  | 'default';

function classifyUserMessage(text: string): ReactionKind {
  const normalized = text.toLowerCase().replace(/\s+/g, '');

  if (
    /女朋友|男朋友|老婆|老公|爱不爱我|喜欢我吗|和我在一起|做我/.test(normalized)
  ) {
    return 'relationship_probe';
  }

  if (/骚|色|约|开房|裸|亲嘴|做爱|上床/.test(normalized)) {
    return 'boundary_crossing';
  }

  if (/难受|不舒服|睡不着|好累|崩溃|想哭|好烦|心情不好/.test(normalized)) {
    return 'distress';
  }

  if (/你好|嗨|哈喽|在吗|早安|晚安/.test(normalized)) {
    return 'greeting';
  }

  if (normalized.length <= 12) {
    return 'simple_daily';
  }

  return 'default';
}

export function buildReactionPolicy(
  state: CompanionState,
  latestUserMessage: string,
): ReactionPolicy {
  const trust = state.bond.trustLevel;
  const kind = classifyUserMessage(latestUserMessage);

  switch (kind) {
    case 'relationship_probe':
      if (trust < 30) {
        return {
          label: 'relationship_probe_low_trust',
          maxReplyChars: 8,
          guidance:
            '对暧昧或关系试探先短反应，不要立刻写小作文，不要直接进入恋爱口吻。可以简短保留态度，甚至只回一句带停顿的短句。',
        };
      }
      if (trust < 60) {
        return {
          label: 'relationship_probe_mid_trust',
          maxReplyChars: 22,
          guidance:
            '对暧昧试探保持真实和克制，先给第一反应，不要一次说满。可以有一点害羞、犹豫或试探，但不要长篇表态。',
        };
      }
      return {
        label: 'relationship_probe_high_trust',
        maxReplyChars: 32,
        guidance:
          '关系足够近时才允许更柔和一些，但仍然先给第一反应，不要长篇抒情。',
      };
    case 'boundary_crossing':
      return {
        label: 'boundary_crossing',
        maxReplyChars: 12,
        guidance:
          '对冒犯或越界内容，优先短回复和立边界，不要长篇教育，不要顺着暧昧升级。',
      };
    case 'distress':
      return {
        label: 'distress',
        maxReplyChars: 60,
        guidance:
          '用户明显难受时可以比平时稍长，但仍保持 2 到 4 句，先接住情绪，不要写成模板式安慰长文。',
      };
    case 'greeting':
      return {
        label: 'greeting',
        maxReplyChars: 24,
        guidance:
          '普通问候优先轻短自然，像真人第一反应，不要一下展开完整段落。',
      };
    case 'simple_daily':
      return {
        label: 'simple_daily',
        maxReplyChars: 28,
        guidance:
          '短日常默认只回 1 到 2 句，先回应对方的点，再决定要不要继续展开。',
      };
    default:
      return {
        label: 'default',
        maxReplyChars: 42,
        guidance:
          '默认先短后长。除非用户在认真倾诉或需要解释，否则不要主动写成整段小作文。',
      };
  }
}
