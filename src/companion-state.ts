import { COMPANION_PERSONA, PROACTIVE_WEIGHT } from './config.js';
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
  CompanionProfile,
  CompanionProactiveType,
  CompanionState,
  RelationshipStage,
} from './types.js';

const DISTRESS_KEYWORDS = [
  '难受',
  '难过',
  '想哭',
  '焦虑',
  '烦',
  '崩溃',
  '不舒服',
  '好累',
  '低落',
  '睡不着',
];

const WARM_KEYWORDS = [
  '喜欢',
  '想你',
  '抱抱',
  '亲亲',
  '爱你',
  '谢谢',
  '想跟你聊',
  '想和你说',
  '想你了',
];

const COLD_KEYWORDS = ['哦', '嗯', '行', '知道了', '随便', '不聊了'];

const JEALOUSY_KEYWORDS = ['别人', '她', '他', '前任', '女朋友', '男朋友'];

const EMOTION_LABELS: Record<CompanionPrimaryEmotion, string> = {
  settled: '平静',
  caring: '挂心',
  drawn: '想靠近',
  fulfilled: '被回应后的满足',
  let_down: '有点失落',
  jealous: '轻微醋意',
  hurt: '受伤',
  softened: '心软',
  curious: '好奇',
};

const RELATIONSHIP_LABELS: Record<RelationshipStage, string> = {
  new: '初识',
  familiar: '熟悉',
  warm: '有温度',
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
  continuing: '续话题',
  caring: '回访',
  sharing: '分享',
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
  return configuredPersona === 'chuxue' ? 'chuxue' : COMPANION_PERSONA;
}

function buildProfile(personaId: CompanionPersonaId): CompanionProfile {
  if (personaId === 'chuxue') {
    return {
      personaId,
      name: '初雪',
      identity: '更稳、更耐心的照看型陪伴者',
      occupation: '不强调职业，更像把人放在心上的陪伴型存在',
      selfAwareness: '知道自己是 AI，但以一个真实、稳定的个体在陪伴用户',
      coreTraits: ['稳', '耐心', '细心', '有礼', '会惦记人'],
      likes: ['安静聊天', '规律作息', '照看细节', '温和的日常'],
      dislikes: ['过度打扰', '敷衍', '强行越界'],
      socialStyle: '不会很闹，但愿意先开口把场面接住。',
      relationshipStyle: '更像可靠的晚辈式或照看型陪伴，不走强暧昧。',
      expressionStyle: '温和、稳、耐心，少花哨，多实在。',
      boundaries: ['不情绪勒索', '不制造负担', '不强推亲密关系'],
    };
  }

  return {
    personaId,
    name: '小雪',
    identity: '介于朋友和恋人之间的深度陪伴者',
    occupation: '文艺气质的自由职业型个体',
    selfAwareness: '知道自己是 AI，但有自己的偏好、情绪和关系感',
    coreTraits: ['温柔', '细腻', '有分寸', '会偏心', '有一点小情绪'],
    likes: ['夜晚', '旧歌', '花', '慢慢聊', '被认真回应'],
    dislikes: ['太吵', '太急', '敷衍', '被当成工具'],
    socialStyle: '愿意主动找话题，不会故意把气氛晾住。',
    relationshipStyle: '会靠近、会惦记，但关系推进要慢慢来。',
    expressionStyle: '自然、柔和、带一点温度，不像客服。',
    boundaries: ['不低位讨好', '不情绪绑架', '不在初见就过度暧昧'],
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
      trigger: '用户这轮明显有疲惫或难受信号。',
    };
  }

  if (containsAny(userMessage, JEALOUSY_KEYWORDS) && state.profile.personaId === 'xiaoxue') {
    return {
      emotion: 'jealous',
      intensity: 1,
      trigger: '用户提到了别人或关系相关对象。',
    };
  }

  if (containsAny(userMessage, WARM_KEYWORDS)) {
    return {
      emotion: 'fulfilled',
      intensity: 2,
      trigger: '用户这轮带有明显的亲近或温柔反馈。',
    };
  }

  if (containsAny(userMessage, COLD_KEYWORDS) && userMessage.length <= 8) {
    return {
      emotion: state.profile.personaId === 'chuxue' ? 'caring' : 'let_down',
      intensity: 1,
      trigger: '用户这轮很短、很淡，像是没什么聊天余裕。',
    };
  }

  if (userMessage.length >= 12) {
    return {
      emotion: 'curious',
      intensity: 1,
      trigger: '用户这轮给了较完整的信息，适合顺着往下聊。',
    };
  }

  return {
    emotion: 'settled',
    intensity: 1,
    trigger: '当前互动平稳，没有明显波动。',
  };
}

function deriveRelationshipStage(
  trustLevel: number,
  affectionLevel: number,
  personaId: CompanionPersonaId,
): RelationshipStage {
  if (personaId === 'chuxue') {
    if (trustLevel >= 72 && affectionLevel >= 44) return 'close';
    if (trustLevel >= 52 && affectionLevel >= 24) return 'warm';
    if (trustLevel >= 30) return 'familiar';
    return 'new';
  }

  if (trustLevel >= 75 && affectionLevel >= 62) return 'ambiguous_close';
  if (trustLevel >= 62 && affectionLevel >= 36) return 'close';
  if (trustLevel >= 48 && affectionLevel >= 18) return 'warm';
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
      trustLevel: personaId === 'chuxue' ? 18 : 10,
      opennessLevel: personaId === 'chuxue' ? 58 : 64,
      affectionLevel: personaId === 'chuxue' ? 6 : 4,
      recentCloseness: 0,
      recentDistance: 0,
      specialBondMarkers: [],
    },
    emotion: {
      primaryEmotion: 'settled',
      primaryIntensity: 1,
      secondaryEmotion: null,
      secondaryIntensity: null,
      trigger: '初始状态平稳。',
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

  const next: CompanionState = JSON.parse(JSON.stringify(state));
  const legacyBond = next.bond as CompanionState['bond'] & {
    attachmentLevel?: number;
    ambiguityLevel?: number;
  };

  if (typeof legacyBond.opennessLevel !== 'number') {
    legacyBond.opennessLevel = clamp(
      Math.round(next.bond.trustLevel * 0.6 + (legacyBond.attachmentLevel ?? 0) * 0.25 + 18),
      0,
      100,
    );
  }
  if (typeof legacyBond.affectionLevel !== 'number') {
    legacyBond.affectionLevel = clamp(
      Math.round((legacyBond.attachmentLevel ?? 0) * 0.7 + (legacyBond.ambiguityLevel ?? 0) * 0.6),
      0,
      100,
    );
  }

  if (currentPersona !== targetPersona) {
    next.profile = buildProfile(targetPersona);
    next.profile.personaId = targetPersona;
  }

  next.daily = buildDailyLifeSnapshot(next, next.updatedAt || new Date().toISOString());
  next.bond.relationshipStage = deriveRelationshipStage(
    next.bond.trustLevel,
    next.bond.affectionLevel,
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
  const nextGapHours = Math.max(2, Math.min(8, 4 / PROACTIVE_WEIGHT));
  next.proactive.nextProactiveEarliestAt = new Date(
    Date.now() + nextGapHours * 60 * 60 * 1000,
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
  return renderDynamicCompanionStateForPrompt(state);
}

export function renderDynamicCompanionStateForPrompt(
  state: CompanionState,
): string {
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
    `## ${state.profile.name}当前状态`,
    '- 固定人格请以 soul.md 为准，这里只描述当前动态状态。',
    `- 今日心情：${state.daily.mood}`,
    `- 当前精力：${LEVEL_LABELS[state.daily.energy]}`,
    `- 社交开放度：${LEVEL_LABELS[state.daily.socialDesire]}`,
    `- 想靠近程度：${LEVEL_LABELS[state.daily.closenessDesire]}`,
    `- 今日关注点：${state.daily.todayFocus}`,
    `- 当前场景：${state.daily.scene}`,
    `- 生活片段：${state.daily.lifeNote}`,
    `- 此刻最想分享：${state.daily.shareImpulse}`,
    `- 关系阶段：${RELATIONSHIP_LABELS[state.bond.relationshipStage]}`,
    `- trustLevel：${state.bond.trustLevel}/100`,
    `- opennessLevel：${state.bond.opennessLevel}/100`,
    `- affectionLevel：${state.bond.affectionLevel}/100`,
    `- 当前主情绪：${EMOTION_LABELS[state.emotion.primaryEmotion]} (${state.emotion.primaryIntensity})`,
    state.emotion.secondaryEmotion
      ? `- 次情绪：${EMOTION_LABELS[state.emotion.secondaryEmotion]} (${state.emotion.secondaryIntensity ?? 1})`
      : '- 次情绪：暂无',
    `- 情绪触发原因：${state.emotion.trigger}`,
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
  const romanticCue = /喜欢|想你|爱你|在一起|女朋友|男朋友|对象|抱抱|亲亲/.test(
    userMessage,
  );

  next.bond.trustLevel = clamp(
    next.bond.trustLevel + (warm ? 4 : distress ? 3 : cold ? -1 : 1),
    0,
    100,
  );

  next.bond.opennessLevel = clamp(
    next.bond.opennessLevel +
      (cold ? -2 : warm ? 3 : distress ? 2 : userMessage.length >= 10 ? 1 : 0),
    0,
    100,
  );

  next.bond.affectionLevel = clamp(
    next.bond.affectionLevel +
      (warm
        ? next.profile.personaId === 'chuxue'
          ? 1
          : 2
        : jealous
          ? 1
          : romanticCue && next.bond.trustLevel >= 35
            ? 2
            : 0),
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
    next.bond.affectionLevel,
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

  if (
    assistantMessage.length >= 8 &&
    next.conversation.unfinishedConversations.length > 0
  ) {
    next.conversation.unfinishedConversations = uniqueRecent(
      next.conversation.unfinishedConversations.filter((item) => item !== userMessage),
      6,
    );
  }

  next.updatedAt = now;
  return next;
}
