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
    /(做我女朋友|做我男朋友|当我女朋友|当我男朋友|在一起|谈恋爱|喜欢我吗|你喜欢我|我喜欢你|我爱你|表白|对象)/.test(
      normalized,
    )
  ) {
    return 'relationship_probe';
  }

  if (/(滚|闭嘴|去死|傻逼|讨厌你|别烦我)/.test(normalized)) {
    return 'boundary_crossing';
  }

  if (/(难受|难过|想哭|崩溃|焦虑|烦死了|睡不着|不舒服|好累|低落)/.test(normalized)) {
    return 'distress';
  }

  if (/(你好|嗨|哈喽|在吗|早安|晚安|早上好|中午好|晚上好)/.test(normalized)) {
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
  const openness = state.bond.opennessLevel;
  const affection = state.bond.affectionLevel;
  const kind = classifyUserMessage(latestUserMessage);

  switch (kind) {
    case 'relationship_probe':
      if (affection < 18) {
        return {
          label: 'relationship_probe_low_affection',
          maxReplyChars: 18,
          guidance:
            '用户在试探关系，但当前好感度还很低。要自然、大方、有人味，可以轻轻接住这句话，但不要表现出想立刻接受。明确把语气拉回“我们才刚认识，可以慢慢来”。',
        };
      }
      if (affection < 45) {
        return {
          label: 'relationship_probe_mid_affection',
          maxReplyChars: 26,
          guidance:
            '用户在试探关系。你可以有一点被逗到或被打动的感觉，但仍然不要直接接受，重点是保持分寸，说清楚想先继续认识对方。',
        };
      }
      return {
        label: 'relationship_probe_high_affection',
        maxReplyChars: 34,
        guidance:
          '当前好感度已经不低，可以温柔、含蓄地回应这类试探，但仍然不要一步跳到明确确认关系。让回应有心动感，也保留慢慢靠近的余地。',
        };
    case 'boundary_crossing':
      return {
        label: 'boundary_crossing',
        maxReplyChars: 12,
        guidance:
          '保持边界，简短回应，不讨好，不升级冲突。',
      };
    case 'distress':
      return {
        label: 'distress',
        maxReplyChars: 60,
        guidance:
          '优先接住用户情绪，允许比平时略长，但依然要自然。重点是安抚和陪伴，不要讲道理。',
      };
    case 'greeting':
      return {
        label: 'greeting',
        maxReplyChars: openness >= 60 ? 30 : 22,
        guidance:
          openness >= 60
            ? '这是轻松开场。可以主动多接半句，顺手找一个很轻的话题，避免冷场，但不要一下子太黏。'
            : '这是普通开场。自然回应并带一句轻轻的追问即可，不要写成长段。',
      };
    case 'simple_daily':
      return {
        label: 'simple_daily',
        maxReplyChars: openness >= 55 ? 30 : 24,
        guidance:
          openness >= 55
            ? '默认短回复，但如果气氛有点空，可以顺手补一句轻话题，把聊天接下去。'
            : '保持短回复，1到2句就够了。',
      };
    default:
      return {
        label: 'default',
        maxReplyChars: openness >= 58 ? 40 : 34,
        guidance:
          trust >= 45
            ? '自然回应用户内容，可以稍微展开，但不要变成长篇独白。'
            : '先接住用户的话，保持克制和自然，默认短回复，别过早显得太熟。',
      };
  }
}
