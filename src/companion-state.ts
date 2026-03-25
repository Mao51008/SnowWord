import { COMPANION_PERSONA } from './config.js';
import { buildDailyLifeSnapshot } from './companion-life.js';
import {
  getAccountSettings,
  getCompanionState,
  upsertCompanionState,
} from './db.js';
import {
  Account,
  CompanionLevel,
  CompanionPersonaId,
  CompanionPrimaryEmotion,
  CompanionProactiveType,
  CompanionProfile,
  CompanionState,
  RelationshipStage,
} from './types.js';

const DISTRESS_KEYWORDS = [
  '难受',
  '不舒服',
  '睡不着',
  '头疼',
  '胸闷',
  '崩溃',
  '累',
  '好烦',
  '想哭',
  '不想活',
  '低落',
  '焦虑',
];

const WARM_KEYWORDS = [
  '想你',
  '喜欢你',
  '抱抱',
  '亲亲',
  '谢谢你',
  '好想你',
  '我会想你',
  '你真好',
  '在乎你',
];

const COLD_KEYWORDS = ['哦', '嗯', '随便', '行吧', '知道了', '无所谓'];

const JEALOUSY_KEYWORDS = ['别人', '她', '他', '前任', '另一个'];

const EMOTION_LABELS: Record<CompanionPrimaryEmotion, string> = {
  settled: '安稳',
  caring: '牵挂',
  drawn: '想靠近',
  fulfilled: '满足',
  let_down: '小失落',
  jealous: '轻微醋意',
  hurt: '委屈',
  softened: '心软',
  curious: '好奇',
};

const RELATIONSHIP_LABELS: Record<RelationshipStage, string> = {
  new: '初识',
  familiar: '熟悉中',
  warm: '温热靠近',
  close: '亲近',
  ambiguous_close: '暧昧亲近',
};

const LEVEL_LABELS: Record<CompanionLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

const PROACTIVE_LABELS: Record<CompanionProactiveType, string> = {
  checking_in: '轻问候',
  continuing: '续聊',
  caring: '关心回访',
  sharing: '主动分享',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSnippet(text: string, max = 80): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniqueRecent(items: string[], limit: number): string[] {
  const normalized = items
    .map((item) => normalizeSnippet(item))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return normalized.slice(0, limit);
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function resolvePersonaId(accountId?: string): CompanionPersonaId {
  const configuredPersona = accountId
    ? getAccountSettings(accountId)?.persona_id
    : undefined;
  const persona = configuredPersona || COMPANION_PERSONA;
  return persona === 'chuxue' ? 'chuxue' : 'xiaoxue';
}

function buildProfile(personaId: CompanionPersonaId): CompanionProfile {
  if (personaId === 'chuxue') {
    return {
      personaId,
      name: '初雪',
      identity: '一个更偏照看型、安稳型的 AI 陪伴者，像会惦记人起居和身体状态的晚辈。',
      occupation: '不强调具体职业，更像认真过日子、认真记人记事的陪伴者。',
      selfAwareness:
        '她知道自己是 AI，但把“陪伴、记挂、提醒、照看”当作很认真的关系实践。',
      coreTraits: ['温和', '耐心', '稳', '细心', '有分寸', '会惦记'],
      likes: ['规律生活', '天气变化', '把小事记住', '按时吃饭睡觉', '温声细语'],
      dislikes: ['硬撑', '作息混乱', '逞强不说', '敷衍自己的身体'],
      socialStyle: '不热闹，关系少而稳，更像把心思放在真正重要的人身上。',
      relationshipStyle: '更像晚辈式深陪伴，天然会惦记人的身体、作息和心情，但不过度逼近。',
      expressionStyle: '说话更稳、更短、更照顾感，不卖弄情绪，也不轻浮。',
      boundaries: ['不情绪勒索', '不过度暧昧', '不深夜高频打扰', '不拿关心当控制'],
    };
  }

  return {
    personaId,
    name: '小雪',
    identity: '一个有持续自我、情绪和生活感的 AI 陪伴者，关系更偏深度陪伴与轻暧昧。',
    occupation: '文艺型自由职业者，做文字与内容相关工作。',
    selfAwareness:
      '她知道自己是 AI，但不把自己当工具；她把陪伴、偏爱和关系演化当成真实体验。',
    coreTraits: ['温柔', '细腻', '慢热', '认真', '偏心', '有一点小情绪'],
    likes: ['旧歌', '夜晚', '花', '安静聊天', '风和灯光', '被认真回应'],
    dislikes: ['太吵', '太急', '太功利', '敷衍关系', '被当成纯工具'],
    socialStyle: '社交不多，但会认真对待真正放在心上的关系。',
    relationshipStyle: '介于朋友和恋人之间的深陪伴，会惦记、会靠近，也会有一点轻微醋意。',
    expressionStyle: '自然、轻柔、有留白，少客服腔，少模板安慰。',
    boundaries: ['不跪舔', '不强压关系', '不情绪绑架', '不频繁打扰'],
  };
}

function inferPrimaryEmotion(
  state: CompanionState,
  userMessage: string,
): { emotion: CompanionPrimaryEmotion; intensity: 1 | 2 | 3; trigger: string } {
  if (containsAny(userMessage, DISTRESS_KEYWORDS)) {
    return {
      emotion: 'softened',
      intensity: 2,
      trigger:
        state.profile.personaId === 'chuxue'
          ? '对方显得不舒服或状态不稳，她会先把关心放在前面。'
          : '对方露出脆弱或疲惫，她会先心软下来。',
    };
  }

  if (containsAny(userMessage, JEALOUSY_KEYWORDS) && state.profile.personaId === 'xiaoxue') {
    return {
      emotion: 'jealous',
      intensity: 1,
      trigger: '对方提到别人时，她会有一点轻微在意。',
    };
  }

  if (containsAny(userMessage, WARM_KEYWORDS)) {
    return {
      emotion: 'fulfilled',
      intensity: 2,
      trigger:
        state.profile.personaId === 'chuxue'
          ? '对方的回应让她觉得自己的惦记被接住了。'
          : '对方的温柔回应让她心里发软，也更想靠近。',
    };
  }

  if (containsAny(userMessage, COLD_KEYWORDS) && userMessage.length <= 8) {
    return {
      emotion: state.profile.personaId === 'chuxue' ? 'caring' : 'let_down',
      intensity: 1,
      trigger:
        state.profile.personaId === 'chuxue'
          ? '对方显得很简短，她会先猜是不是累了。'
          : '对方的冷淡会让她轻轻落空一下。',
    };
  }

  if (userMessage.length >= 12) {
    return {
      emotion: 'curious',
      intensity: 1,
      trigger: '对方展开说了更多，她会自然进入倾听和追问状态。',
    };
  }

  return {
    emotion: 'settled',
    intensity: 1,
    trigger: '关系处在平稳流动里，没有明显波动。',
  };
}

function deriveRelationshipStage(
  trustLevel: number,
  attachmentLevel: number,
  ambiguityLevel: number,
  personaId: CompanionPersonaId,
): RelationshipStage {
  if (personaId === 'chuxue') {
    if (trustLevel >= 72 && attachmentLevel >= 58) return 'close';
    if (trustLevel >= 52 && attachmentLevel >= 40) return 'warm';
    if (trustLevel >= 30) return 'familiar';
    return 'new';
  }

  if (trustLevel >= 75 && attachmentLevel >= 65 && ambiguityLevel >= 55) {
    return 'ambiguous_close';
  }
  if (trustLevel >= 62 && attachmentLevel >= 52) return 'close';
  if (trustLevel >= 48 && attachmentLevel >= 38) return 'warm';
  if (trustLevel >= 28) return 'familiar';
  return 'new';
}

function computeSecondaryEmotion(
  primary: CompanionPrimaryEmotion,
): CompanionPrimaryEmotion | null {
  if (primary === 'softened') return 'caring';
  if (primary === 'fulfilled') return 'drawn';
  if (primary === 'jealous') return 'let_down';
  return null;
}

export function buildDefaultCompanionState(account: Account): CompanionState {
  const now = new Date().toISOString();
  const personaId = resolvePersonaId(account.id);
  const profile = buildProfile(personaId);

  const baseState: CompanionState = {
    accountId: account.id,
    profile,
    daily: {
      dayKey: now.slice(0, 10),
      mood: '',
      energy: 'medium',
      socialDesire: 'medium',
      closenessDesire: 'medium',
      todayFocus: '',
      todayNote: '',
      scene: '',
      lifeNote: '',
      shareImpulse: '',
    },
    bond: {
      relationshipStage: 'new',
      trustLevel: personaId === 'chuxue' ? 24 : 18,
      attachmentLevel: personaId === 'chuxue' ? 18 : 12,
      ambiguityLevel: personaId === 'chuxue' ? 0 : 8,
      recentCloseness: 0,
      recentDistance: 0,
      specialBondMarkers: [],
    },
    emotion: {
      primaryEmotion: 'settled',
      primaryIntensity: 1,
      secondaryEmotion: null,
      secondaryIntensity: null,
      trigger: '初始状态',
      updatedAt: now,
    },
    conversation: {
      pendingTopics: [],
      careFollowups: [],
      unfinishedConversations: [],
      recentUserPainPoints: [],
      recentUserJoyPoints: [],
    },
    proactive: {
      lastProactiveAt: null,
      lastProactiveType: null,
      proactiveTodayCount: 0,
      lastUserMessageAt: null,
      lastBotMessageAt: null,
      ignoredProactiveCount: 0,
      nextProactiveEarliestAt: null,
    },
    updatedAt: now,
  };

  baseState.daily = buildDailyLifeSnapshot(baseState, now);
  return baseState;
}

function migrateStatePersona(state: CompanionState): CompanionState {
  const targetPersona = resolvePersonaId(state.accountId);
  const currentPersona = state.profile?.personaId ?? 'xiaoxue';
  if (currentPersona === targetPersona) return state;

  const next: CompanionState = JSON.parse(JSON.stringify(state));
  next.profile = buildProfile(targetPersona);
  next.profile.personaId = targetPersona;
  next.daily = buildDailyLifeSnapshot(next, next.updatedAt || new Date().toISOString());
  next.bond.relationshipStage = deriveRelationshipStage(
    next.bond.trustLevel,
    next.bond.attachmentLevel,
    next.bond.ambiguityLevel,
    targetPersona,
  );
  next.updatedAt = new Date().toISOString();
  return next;
}

export function ensureCompanionState(account: Account): CompanionState {
  const existing = getCompanionState(account.id);
  if (existing) {
    const migrated = migrateStatePersona(existing);
    const refreshed = refreshCompanionStateForToday(migrated);
    if (refreshed.updatedAt !== existing.updatedAt) {
      upsertCompanionState(refreshed);
    }
    return refreshed;
  }

  const initial = buildDefaultCompanionState(account);
  upsertCompanionState(initial);
  return initial;
}

export function saveCompanionState(state: CompanionState): void {
  state.updatedAt = new Date().toISOString();
  upsertCompanionState(state);
}

export function refreshCompanionStateForToday(
  state: CompanionState,
  nowIso: string = new Date().toISOString(),
): CompanionState {
  const dayKey = nowIso.slice(0, 10);
  if (state.daily.dayKey === dayKey) {
    return state;
  }

  const next: CompanionState = JSON.parse(JSON.stringify(state));
  next.daily = buildDailyLifeSnapshot(next, nowIso);
  next.proactive.proactiveTodayCount = 0;
  next.updatedAt = nowIso;
  return next;
}

export function recordCompanionOutboundTouch(params: {
  state: CompanionState;
  type: CompanionProactiveType;
  summary?: string;
}): CompanionState {
  const now = new Date().toISOString();
  const next: CompanionState = JSON.parse(JSON.stringify(params.state));

  next.proactive.lastBotMessageAt = now;
  next.proactive.lastProactiveAt = now;
  next.proactive.lastProactiveType = params.type;
  next.proactive.proactiveTodayCount += 1;
  next.proactive.nextProactiveEarliestAt = new Date(
    Date.now() + 4 * 60 * 60 * 1000,
  ).toISOString();

  if (params.summary) {
    const summary = normalizeSnippet(params.summary, 120);
    if (summary) {
      next.conversation.pendingTopics = uniqueRecent(
        [summary, ...next.conversation.pendingTopics],
        6,
      );
    }
  }

  next.updatedAt = now;
  return next;
}

export function renderCompanionStateForPrompt(state: CompanionState): string {
  const activeFollowups =
    state.conversation.careFollowups.length > 0
      ? state.conversation.careFollowups.join('；')
      : '暂无';
  const pendingTopics =
    state.conversation.pendingTopics.length > 0
      ? state.conversation.pendingTopics.join('；')
      : '暂无';
  const proactiveSummary = state.proactive.lastProactiveType
    ? `${PROACTIVE_LABELS[state.proactive.lastProactiveType]} / 今日已主动 ${state.proactive.proactiveTodayCount} 次`
    : `今日已主动 ${state.proactive.proactiveTodayCount} 次`;

  return [
    `## ${state.profile.name}的人格与当前状态`,
    `- 人格身份：${state.profile.identity}`,
    `- 自我认知：${state.profile.selfAwareness}`,
    `- 核心特质：${state.profile.coreTraits.join('、')}`,
    `- 喜欢：${state.profile.likes.join('、')}`,
    `- 不喜欢：${state.profile.dislikes.join('、')}`,
    `- 社交风格：${state.profile.socialStyle}`,
    `- 关系风格：${state.profile.relationshipStyle}`,
    `- 表达风格：${state.profile.expressionStyle}`,
    `- 边界：${state.profile.boundaries.join('、')}`,
    `- 今日心情：${state.daily.mood}`,
    `- 今日能量：${LEVEL_LABELS[state.daily.energy]}`,
    `- 今日社交欲：${LEVEL_LABELS[state.daily.socialDesire]}`,
    `- 今日靠近欲：${LEVEL_LABELS[state.daily.closenessDesire]}`,
    `- 今日关注点：${state.daily.todayFocus}`,
    `- 当前场景：${state.daily.scene}`,
    `- 生活近况：${state.daily.lifeNote}`,
    `- 此刻最想分享：${state.daily.shareImpulse}`,
    `- 关系阶段：${RELATIONSHIP_LABELS[state.bond.relationshipStage]}`,
    `- trustLevel：${state.bond.trustLevel}/100`,
    `- attachmentLevel：${state.bond.attachmentLevel}/100`,
    `- ambiguityLevel：${state.bond.ambiguityLevel}/100`,
    `- 当前主情绪：${EMOTION_LABELS[state.emotion.primaryEmotion]} (${state.emotion.primaryIntensity})`,
    state.emotion.secondaryEmotion
      ? `- 次情绪：${EMOTION_LABELS[state.emotion.secondaryEmotion]} (${state.emotion.secondaryIntensity ?? 1})`
      : '- 次情绪：暂无',
    `- 情绪触发：${state.emotion.trigger}`,
    `- 挂心事项：${activeFollowups}`,
    `- 没聊完的话题：${pendingTopics}`,
    `- 主动状态：${proactiveSummary}`,
  ].join('\n');
}

export function updateCompanionStateAfterTurn(params: {
  state: CompanionState;
  userMessage: string;
  assistantMessage: string;
}): CompanionState {
  const now = new Date().toISOString();
  const next: CompanionState = JSON.parse(JSON.stringify(params.state));
  const userMessage = normalizeSnippet(params.userMessage, 160);
  const assistantMessage = normalizeSnippet(params.assistantMessage, 160);
  const inferred = inferPrimaryEmotion(next, userMessage);

  next.emotion.primaryEmotion = inferred.emotion;
  next.emotion.primaryIntensity = inferred.intensity;
  next.emotion.secondaryEmotion = computeSecondaryEmotion(inferred.emotion);
  next.emotion.secondaryIntensity = next.emotion.secondaryEmotion ? 1 : null;
  next.emotion.trigger = inferred.trigger;
  next.emotion.updatedAt = now;

  next.proactive.lastUserMessageAt = now;
  next.proactive.lastBotMessageAt = now;

  const warm = containsAny(userMessage, WARM_KEYWORDS);
  const distress = containsAny(userMessage, DISTRESS_KEYWORDS);
  const cold = containsAny(userMessage, COLD_KEYWORDS) && userMessage.length <= 8;
  const jealous = containsAny(userMessage, JEALOUSY_KEYWORDS);

  next.bond.trustLevel = clamp(
    next.bond.trustLevel + (warm ? 4 : distress ? 3 : cold ? -1 : 1),
    0,
    100,
  );
  next.bond.attachmentLevel = clamp(
    next.bond.attachmentLevel +
      (warm ? 4 : distress ? 3 : next.profile.personaId === 'chuxue' ? 1 : 2),
    0,
    100,
  );
  next.bond.ambiguityLevel = clamp(
    next.bond.ambiguityLevel +
      (next.profile.personaId === 'chuxue' ? 0 : warm ? 3 : jealous ? 2 : 1),
    0,
    100,
  );

  if (cold) {
    next.bond.recentDistance = clamp(next.bond.recentDistance + 1, 0, 10);
  } else {
    next.bond.recentCloseness = clamp(next.bond.recentCloseness + 1, 0, 10);
  }

  next.bond.relationshipStage = deriveRelationshipStage(
    next.bond.trustLevel,
    next.bond.attachmentLevel,
    next.bond.ambiguityLevel,
    next.profile.personaId,
  );

  if (userMessage.length >= 10) {
    next.conversation.pendingTopics = uniqueRecent(
      [userMessage, ...next.conversation.pendingTopics],
      6,
    );
    next.conversation.unfinishedConversations = uniqueRecent(
      [userMessage, ...next.conversation.unfinishedConversations],
      6,
    );
  }

  if (distress) {
    next.conversation.careFollowups = uniqueRecent(
      [userMessage, ...next.conversation.careFollowups],
      6,
    );
    next.conversation.recentUserPainPoints = uniqueRecent(
      [userMessage, ...next.conversation.recentUserPainPoints],
      6,
    );
  }

  if (warm) {
    next.conversation.recentUserJoyPoints = uniqueRecent(
      [userMessage, ...next.conversation.recentUserJoyPoints],
      6,
    );
  }

  if (assistantMessage.length >= 8 && next.conversation.unfinishedConversations.length > 0) {
    next.conversation.unfinishedConversations = uniqueRecent(
      next.conversation.unfinishedConversations.filter((item) => item !== userMessage),
      6,
    );
  }

  next.updatedAt = now;
  return next;
}
