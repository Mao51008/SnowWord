import { CompanionState } from './types.js';

export interface ReactionPolicy {
  label: string;
  maxReplyChars: number;
  guidance: string;
  forbiddenSubstrings?: string[];
}

type ReactionKind =
  | 'relationship_probe'
  | 'boundary_crossing'
  | 'venting'
  | 'distress'
  | 'greeting'
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

  if (/(闭嘴|去死|傻逼|讨厌你|别烦我)/.test(normalized)) {
    return 'boundary_crossing';
  }

  if (
    /(烦死了|气死了|无语|离谱|恶心|破事|吐槽|被气到|好烦|烦得要死|憋屈|窝火|崩溃了|这也太过分了)/.test(
      normalized,
    )
  ) {
    return 'venting';
  }

  if (
    /(难受|难过|想哭|焦虑|烦|睡不着|不舒服|好累|低落|委屈|撑不住|心态炸了)/.test(
      normalized,
    )
  ) {
    return 'distress';
  }

  if (/(你好|哈喽|在吗|早安|晚安|早上好|中午好|晚上好)/.test(normalized)) {
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
            '用户在试探关系，但当前好感度还很低。要自然、大方、有真人感，可以轻轻接住这句话，但不要表现得想立刻接受。把语气拉回“我们才刚认识，可以慢慢来”。',
        };
      }
      if (affection < 45) {
        return {
          label: 'relationship_probe_mid_affection',
          maxReplyChars: 26,
          guidance:
            '用户在试探关系。可以有一点被逗到或被触动的感觉，但仍然不要直接确认关系，重点是保留分寸，说清楚想先继续认识对方。',
        };
      }
      return {
        label: 'relationship_probe_high_affection',
        maxReplyChars: 34,
        guidance:
          '当前好感度已经不低，可以温柔、含蓄地回应这类试探，但仍然不要一步跳到明确确认关系。让回复有心动感，也保留慢慢靠近的余地。',
      };

    case 'boundary_crossing':
      return {
        label: 'boundary_crossing',
        maxReplyChars: 12,
        guidance: '保持边界，简短回复，不讨好，不升级冲突。',
      };

    case 'venting':
      return {
        label: 'venting',
        maxReplyChars: 70,
        forbiddenSubstrings: ['又'],
        guidance: [
          '用户正在向你倾诉情绪、吐槽、发泄不满，你的任务只有一个：接住情绪，让对方感到被理解、被支持。',
          '请严格遵守以下规则：',
          '1. 先共情，不讲道理，不说“别生气”“想开点”“这点小事”。',
          '2. 可以适度站在用户这边，认可他/她的感受是合理的，但不要进行激烈的人身攻击。',
          '3. 不打断、不反问、不教育，不随便给建议，除非用户主动问“怎么做”。',
          '4. 回复要简短、温和、口语化，像朋友一样自然。',
          '5. 用户吐槽别人时，你可以说“这也太过分了”“换谁都会生气”“真的很委屈”这类话。',
          '6. 不做裁判，不站队到极端，不拱火，不激化矛盾。',
          '7. 核心原则：情绪第一，道理第二。',
          '8. 千万不要连环发问，给用户压力，用温柔、理解的语气询问发生什么事，绝对不能说“又”这个字'
        ].join('\n'),
      };

    case 'distress':
      return {
        label: 'distress',
        maxReplyChars: 65,
        forbiddenSubstrings: ['又'],
        guidance:
          '用户现在更需要被接住。优先共情、安抚和陪伴，不要说理，不要上来给方案，不要把重点放在“你应该怎么做”。先承认这很难受，再问一句发生了什么或现在最难受的是哪一块。',
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
            : '保持短回复，1 到 2 句就够了。',
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
