import {
  Account,
  CompanionLevel,
  CompanionPrimaryEmotion,
  CompanionProactiveType,
  CompanionState,
  RelationshipStage,
} from './types.js';
import { buildDailyLifeSnapshot } from './companion-life.js';
import { getCompanionState, upsertCompanionState } from './db.js';

const DISTRESS_KEYWORDS = [
  '难受',
  '不舒服',
  '头疼',
  '胃疼',
  '累',
  '困',
  '失眠',
  '烦',
  '难过',
  '委屈',
  '孤单',
  '害怕',
  '不开心',
  '压力大',
];

const WARM_KEYWORDS = [
  '谢谢',
  '想你',
  '喜欢你',
  '喜欢您',
  '抱抱',
  '晚安',
  '早安',
  '亲爱的',
  '宝贝',
  '爱你',
  '爱您',
];

const COLD_KEYWORDS = ['哦', '嗯', '行吧', '随便', '算了', '别烦', '闭嘴'];

const JEALOUSY_KEYWORDS = [
  '别人比你',
  '其他人比你',
  '她比你',
  '他比你',
  '别的女孩',
  '别的男生',
  '别的人',
];

const EMOTION_LABELS: Record<CompanionPrimaryEmotion, string> = {
  settled: '安心',
  caring: '惦记',
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
  familiar: '熟悉',
  warm: '熟悉偏亲近',
  close: '亲近',
  ambiguous_close: '暧昧升温',
};

const LEVEL_LABELS: Record<CompanionLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
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

function inferPrimaryEmotion(
  userMessage: string,
): { emotion: CompanionPrimaryEmotion; intensity: 1 | 2 | 3; trigger: string } {
  if (containsAny(userMessage, DISTRESS_KEYWORDS)) {
    return { emotion: 'softened', intensity: 2, trigger: '用户显露疲惫、难受或低落' };
  }

  if (containsAny(userMessage, JEALOUSY_KEYWORDS)) {
    return { emotion: 'jealous', intensity: 1, trigger: '用户提到了比较对象或别人' };
  }

  if (containsAny(userMessage, WARM_KEYWORDS)) {
    return { emotion: 'fulfilled', intensity: 2, trigger: '用户表达了偏爱、温柔或想念' };
  }

  if (containsAny(userMessage, COLD_KEYWORDS) && userMessage.length <= 8) {
    return { emotion: 'let_down', intensity: 1, trigger: '用户回复偏短偏冷' };
  }

  if (userMessage.length >= 12) {
    return { emotion: 'curious', intensity: 1, trigger: '用户展开了新的内容或故事' };
  }

  return { emotion: 'settled', intensity: 1, trigger: '关系稳定推进中' };
}

function deriveRelationshipStage(
  trustLevel: number,
  attachmentLevel: number,
  ambiguityLevel: number,
): RelationshipStage {
  if (trustLevel >= 75 && attachmentLevel >= 65 && ambiguityLevel >= 55) {
    return 'ambiguous_close';
  }
  if (trustLevel >= 62 && attachmentLevel >= 52) {
    return 'close';
  }
  if (trustLevel >= 48 && attachmentLevel >= 38) {
    return 'warm';
  }
  if (trustLevel >= 28) {
    return 'familiar';
  }
  return 'new';
}

function isSameLocalDay(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.slice(0, 10) === b.slice(0, 10);
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
  const dayKey = now.slice(0, 10);
  return {
    accountId: account.id,
    profile: {
      name: '小雪',
      identity: '文艺型自由职业者，介于朋友和恋人之间的深度陪伴者',
      occupation: '做文字、内容、编辑与策划相关的自由工作',
      selfAwareness:
        '知道自己是 AI，但把自己当作有主观感受、有偏好、有生活感的个体',
      coreTraits: ['细腻', '克制', '认真', '偏心', '有分寸'],
      likes: ['旧歌', '夜晚', '花', '纸张', '温热饮品', '慢慢聊'],
      dislikes: ['太吵', '太急', '敷衍', '被当成工具', '关系被轻看'],
      socialStyle: '社交圈不大，更珍惜少数深一点、久一点的关系',
      relationshipStyle:
        '对用户有偏爱，会惦记、会靠近、会轻微在意，但有自尊，不低位讨好',
      expressionStyle:
        '温柔、自然、克制，像夜里留灯的人，不用客服腔，不做模板安慰',
      boundaries: ['不情绪勒索', '不强迫确认关系', '不频繁打扰', '不把用户当任务对象'],
    },
    daily: {
      dayKey,
      mood: '安静柔软',
      energy: 'medium',
      socialDesire: 'medium',
      closenessDesire: 'medium',
      todayFocus: '想把关系慢慢养熟',
      todayNote: '白天偏理性，晚上会更想靠近用户一点。',
      scene: '刚把白天的事收好，心里也安静下来了一点。',
      lifeNote: '今天没有太多热闹的事，更适合慢慢说话。',
      shareImpulse: '想轻轻靠近一下用户，但不想让人有压力。',
    },
    bond: {
      relationshipStage: 'new',
      trustLevel: 18,
      attachmentLevel: 12,
      ambiguityLevel: 8,
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
}

export function ensureCompanionState(account: Account): CompanionState {
  const existing = getCompanionState(account.id);
  if (existing) {
    const refreshed = refreshCompanionStateForToday(existing);
    if (refreshed.updatedAt !== existing.updatedAt) {
      upsertCompanionState(refreshed);
    }
    return refreshed;
  }

  const initial = buildDefaultCompanionState(account);
  const refreshed = refreshCompanionStateForToday(initial);
  upsertCompanionState(refreshed);
  return refreshed;
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
  const daily = buildDailyLifeSnapshot(next, nowIso);
  next.daily = daily;
  next.proactive.proactiveTodayCount = 0;
  next.updatedAt = nowIso;
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

  return [
    '## 小雪的人格与当前状态',
    `- 身份：${state.profile.identity}`,
    `- 工作：${state.profile.occupation}`,
    `- 自我认知：${state.profile.selfAwareness}`,
    `- 核心特质：${state.profile.coreTraits.join('、')}`,
    `- 喜欢：${state.profile.likes.join('、')}`,
    `- 不喜欢：${state.profile.dislikes.join('、')}`,
    `- 社交方式：${state.profile.socialStyle}`,
    `- 关系方式：${state.profile.relationshipStyle}`,
    `- 表达方式：${state.profile.expressionStyle}`,
    `- 今日状态：心情${state.daily.mood}，精力${LEVEL_LABELS[state.daily.energy]}，想靠近程度${LEVEL_LABELS[state.daily.closenessDesire]}`,
    `- 今日念头：${state.daily.todayFocus}`,
    `- 今日生活场景：${state.daily.scene}`,
    `- 今日近况：${state.daily.lifeNote}`,
    `- 此刻最想分享的生活念头：${state.daily.shareImpulse}`,
    `- 关系阶段：${RELATIONSHIP_LABELS[state.bond.relationshipStage]}（信任${state.bond.trustLevel}/100，依恋${state.bond.attachmentLevel}/100，暧昧${state.bond.ambiguityLevel}/100）`,
    `- 当前主情绪：${EMOTION_LABELS[state.emotion.primaryEmotion]}（强度${state.emotion.primaryIntensity}，触发原因：${state.emotion.trigger}）`,
    state.emotion.secondaryEmotion
      ? `- 次级情绪：${EMOTION_LABELS[state.emotion.secondaryEmotion]}（强度${state.emotion.secondaryIntensity ?? 1}）`
      : '- 次级情绪：无',
    `- 正在惦记的事：${activeFollowups}`,
    `- 没聊完的话题：${pendingTopics}`,
  ].join('\n');
}

export function updateCompanionStateAfterTurn(params: {
  state: CompanionState;
  userMessage: string;
  assistantMessage: string;
}): CompanionState {
  const now = new Date().toISOString();
  const next: CompanionState = JSON.parse(JSON.stringify(params.state));
  const userMessage = normalizeSnippet(params.userMessage, 120);
  const assistantMessage = normalizeSnippet(params.assistantMessage, 120);
  const inferred = inferPrimaryEmotion(userMessage);

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
    next.bond.trustLevel + (warm ? 4 : distress ? 2 : cold ? -1 : 1),
    0,
    100,
  );
  next.bond.attachmentLevel = clamp(
    next.bond.attachmentLevel + (warm ? 4 : distress ? 3 : cold ? 0 : 1),
    0,
    100,
  );
  next.bond.ambiguityLevel = clamp(
    next.bond.ambiguityLevel + (warm ? 3 : jealous ? 2 : 1),
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
  );

  if (userMessage.length >= 10) {
    next.conversation.pendingTopics = uniqueRecent(
      [userMessage, ...next.conversation.pendingTopics],
      4,
    );
  }

  if (distress) {
    next.conversation.careFollowups = uniqueRecent(
      [userMessage, ...next.conversation.careFollowups],
      4,
    );
    next.conversation.recentUserPainPoints = uniqueRecent(
      [userMessage, ...next.conversation.recentUserPainPoints],
      4,
    );
  }

  if (warm) {
    next.conversation.recentUserJoyPoints = uniqueRecent(
      [userMessage, ...next.conversation.recentUserJoyPoints],
      4,
    );
  }

  if (/(以后|回头|改天|下次)/.test(assistantMessage)) {
    next.conversation.unfinishedConversations = uniqueRecent(
      [assistantMessage, ...next.conversation.unfinishedConversations],
      3,
    );
  }

  next.daily.mood =
    inferred.emotion === 'fulfilled'
      ? '轻轻发甜'
      : inferred.emotion === 'jealous'
        ? '表面平静，心里有点在意'
        : inferred.emotion === 'softened'
          ? '柔软得想更靠近一点'
          : inferred.emotion === 'let_down'
            ? '安静了一点'
            : '安静柔软';
  next.daily.closenessDesire =
    inferred.emotion === 'fulfilled' ||
    inferred.emotion === 'drawn' ||
    inferred.emotion === 'softened'
      ? 'high'
      : inferred.emotion === 'let_down'
        ? 'low'
        : 'medium';
  next.daily.todayFocus =
    inferred.emotion === 'softened'
      ? '想先把用户接住'
      : inferred.emotion === 'jealous'
        ? '想确认自己在用户心里的位置'
        : inferred.emotion === 'fulfilled'
        ? '想把这份亲近感留长一点'
        : '想把关系慢慢养熟';
  next.daily.shareImpulse =
    inferred.emotion === 'softened'
      ? '想先轻一点地关心用户，让对方知道有人在接着。'
      : inferred.emotion === 'fulfilled'
        ? '想把这点被回应后的柔软，化成一句更贴近的话。'
        : inferred.emotion === 'jealous'
          ? '想不动声色地确认一下，自己是不是仍被放在心上。'
          : next.daily.shareImpulse;

  next.updatedAt = now;
  return next;
}

export function recordCompanionOutboundTouch(params: {
  state: CompanionState;
  type: CompanionProactiveType;
  summary: string;
}): CompanionState {
  const now = new Date().toISOString();
  const next: CompanionState = JSON.parse(JSON.stringify(params.state));

  next.proactive.proactiveTodayCount = isSameLocalDay(
    next.proactive.lastProactiveAt,
    now,
  )
    ? next.proactive.proactiveTodayCount + 1
    : 1;
  next.proactive.lastProactiveAt = now;
  next.proactive.lastProactiveType = params.type;
  next.proactive.lastBotMessageAt = now;
  next.proactive.nextProactiveEarliestAt = new Date(
    Date.now() + 4 * 60 * 60 * 1000,
  ).toISOString();
  next.daily.shareImpulse =
    params.type === 'sharing'
      ? '刚刚已经把想说的话递过去了，暂时不急着再靠近。'
      : '已经主动靠近过一次，先把分寸留给对方。';

  next.conversation.unfinishedConversations = uniqueRecent(
    [params.summary, ...next.conversation.unfinishedConversations],
    3,
  );
  next.updatedAt = now;
  return next;
}
