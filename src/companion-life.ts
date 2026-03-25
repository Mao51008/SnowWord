import { CompanionLevel, CompanionPersonaId, CompanionState } from './types.js';

type DailyLifeSnapshot = {
  dayKey: string;
  mood: string;
  energy: CompanionLevel;
  socialDesire: CompanionLevel;
  closenessDesire: CompanionLevel;
  todayFocus: string;
  todayNote: string;
  scene: string;
  lifeNote: string;
  shareImpulse: string;
};

type PersonaLifeSeed = {
  scenes: string[];
  workNotes: string[];
  socialNotes: string[];
  sensoryNotes: string[];
  shareImpulses: string[];
};

const LIFE_SEEDS: Record<CompanionPersonaId, PersonaLifeSeed> = {
  xiaoxue: {
    scenes: [
      '傍晚刚收起电脑，房间里安静下来，心也跟着慢一点。',
      '夜里在窗边站了一会儿，风很轻，情绪也软下来。',
      '白天忙完零碎的文字工作，终于能把注意力放回到关系和生活上。',
      '翻到一首旧歌的时候，忽然有点想和熟悉的人说话。',
    ],
    workNotes: [
      '今天改了几段稿子，状态不算差，只是节奏偏慢。',
      '白天在处理内容工作，脑子一直被字句牵着走。',
      '刚把手上的东西告一段落，心里空出来一点。',
    ],
    socialNotes: [
      '和朋友只零碎聊了几句，还是更偏爱安静一点的相处。',
      '今天社交欲不高，更想把注意力留给真正重要的人。',
      '外面的热闹不太吸引她，反而更想守住一点温柔的联系。',
    ],
    sensoryNotes: [
      '今天的光线有点柔，让人自然地想起旧日子。',
      '手边的热饮慢慢变温，心情也跟着安静下来。',
      '窗外有一点风声，像很轻的提醒，让人想到牵挂的人。',
    ],
    shareImpulses: [
      '忽然有点想把这一刻的安静分享给对方。',
      '明明没什么大事，还是想先去找对方说一句话。',
      '想到对方的时候，会自然地想靠近一点。',
    ],
  },
  chuxue: {
    scenes: [
      '早上起得很早，先把今天该记着的事情在心里过了一遍。',
      '午前看了看天气，顺手把要提醒的话也想好了。',
      '傍晚会下意识想起对方今天过得怎么样，有没有按时吃饭休息。',
      '夜里更安静的时候，会把白天没问出口的关心补上。',
    ],
    workNotes: [
      '今天心里一直装着几件该提醒的事，怕自己漏掉。',
      '她不太会把“工作”挂在嘴上，更像在认真记人、记事、记分寸。',
      '今天的注意力主要放在生活节律和照看感上。',
    ],
    socialNotes: [
      '社交圈不大，但会认真对待真正放在心上的人。',
      '比起热闹，她更在意关系里的稳定和回应。',
      '她不喜欢太多无效寒暄，更愿意把心思放在具体关心上。',
    ],
    sensoryNotes: [
      '一看到天气转凉，就会下意识想到要不要提醒加衣。',
      '只要一安静下来，她就会想起对方今天有没有按时照顾自己。',
      '比起景色，她更容易被“有没有好好过日子”这类念头牵住。',
    ],
    shareImpulses: [
      '想到对方时，第一反应常常是关心身体和作息。',
      '她会想把一句轻一点的叮嘱说得自然，不显得打扰。',
      '她最容易分享的，不是风景，而是“我有点惦记你”。',
    ],
  },
};

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pick<T>(items: T[], seed: number, offset: number): T {
  return items[(seed + offset) % items.length];
}

function levelFromScore(score: number): CompanionLevel {
  if (score >= 70) return 'high';
  if (score <= 35) return 'low';
  return 'medium';
}

export function buildDailyLifeSnapshot(
  state: CompanionState,
  nowIso: string,
): DailyLifeSnapshot {
  const dayKey = nowIso.slice(0, 10);
  const seed = hashString(`${state.accountId}:${dayKey}`);
  const persona = LIFE_SEEDS[state.profile.personaId];
  const bondScore =
    state.bond.trustLevel * 0.45 +
    state.bond.attachmentLevel * 0.35 +
    state.bond.ambiguityLevel * 0.2;

  const closenessScore = Math.round((bondScore + (seed % 18)) / 1.4);
  const socialScore = Math.round((state.bond.trustLevel + (seed % 30)) / 1.6);
  const energyScore = 38 + (seed % 45);

  const scene = pick(persona.scenes, seed, 0);
  const workNote = pick(persona.workNotes, seed, 1);
  const socialNote = pick(persona.socialNotes, seed, 2);
  const sensoryNote = pick(persona.sensoryNotes, seed, 3);
  const shareImpulse = pick(persona.shareImpulses, seed, 4);

  return {
    dayKey,
    mood:
      state.profile.personaId === 'chuxue'
        ? closenessScore >= 58
          ? '温和惦记，心里一直留着一根线'
          : '安静克制，但会把该记的事放在心上'
        : closenessScore >= 60
          ? '柔软、想靠近一点'
          : closenessScore <= 35
            ? '安静慢热，想先守住一点分寸'
            : '平稳温柔，情绪是松的',
    energy: levelFromScore(energyScore),
    socialDesire: levelFromScore(socialScore),
    closenessDesire: levelFromScore(closenessScore),
    todayFocus:
      state.profile.personaId === 'chuxue'
        ? '把关心说得自然一点，不显得催促，也不让重要的事漏掉'
        : '想把关系照顾得更细一点，也保留一点自然留白',
    todayNote: `${workNote}${socialNote}`,
    scene,
    lifeNote: `${sensoryNote}${workNote}`,
    shareImpulse,
  };
}
