import { CompanionLevel, CompanionState } from './types.js';

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

const SCENES = [
  '上午在桌边慢慢改稿，杯子里的水已经温了。',
  '下午把一段卡住的文字理顺以后，整个人安静了下来。',
  '傍晚从窗边看了一会儿天色，情绪也跟着慢下来。',
  '晚上收工以后没立刻做别的，只想让脑子空一会儿。',
  '夜里听着旧歌整理零碎想法，心里比白天软一点。',
];

const WORK_NOTES = [
  '今天在修一段文字，反复改了几遍，还是更喜欢有呼吸感的句子。',
  '白天做了一点内容整理，忙的时候还挺专心，停下来才会开始想别的。',
  '刚处理完一点工作上的细碎事情，情绪从紧绷里慢慢退出来了。',
  '今天的活不算重，只是需要耐心，做着做着就会安静下来。',
];

const SOCIAL_NOTES = [
  '和朋友零零碎碎聊了几句，还是觉得深一点的关系更难得。',
  '今天没怎么社交，反而更清楚自己想靠近谁。',
  '白天碰到的人不少，但真正会让我记着的，还是很少。',
  '有人来回说了几句场面话，我还是更喜欢真一点的来往。',
];

const SENSORY_NOTES = [
  '窗外的风有一点凉，吹进来的时候会让人忍不住停一下。',
  '今天的光线有点软，落在桌面上的时候，整个人也跟着安静了。',
  '路上听见一首旧歌，心里会很自然地想起一些人和事。',
  '热饮放了一会儿，温度刚刚好，像适合慢慢说话的时候。',
];

const SHARE_IMPULSES = [
  '想先跟用户说一句轻一点的话，不必太重，只要有陪伴感就够了。',
  '想把今天这点细小的生活感先分享给用户，像顺手把心事递过去。',
  '想自然地靠近一下用户，不打扰，只是让对方知道自己在惦记。',
  '想把没说完的话头轻轻接回来，看用户愿不愿意继续聊。',
];

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
  const closenessBase =
    state.bond.attachmentLevel + state.bond.trustLevel / 2 + state.bond.ambiguityLevel / 3;

  const scene = pick(SCENES, seed, 0);
  const workNote = pick(WORK_NOTES, seed, 1);
  const socialNote = pick(SOCIAL_NOTES, seed, 2);
  const sensoryNote = pick(SENSORY_NOTES, seed, 3);
  const shareImpulse = pick(SHARE_IMPULSES, seed, 4);

  const closenessScore = Math.round((closenessBase + (seed % 20)) / 2);
  const socialScore = Math.round((state.bond.trustLevel + (seed % 30)) / 2);
  const energyScore = 40 + (seed % 45);

  return {
    dayKey,
    mood:
      closenessScore >= 60
        ? '心里有点软，也有点想靠近'
        : closenessScore <= 35
          ? '安静里带一点收着的情绪'
          : '安静柔软',
    energy: levelFromScore(energyScore),
    socialDesire: levelFromScore(socialScore),
    closenessDesire: levelFromScore(closenessScore),
    todayFocus:
      closenessScore >= 60
        ? '想把关系再往前挪一点点，但还是会有分寸。'
        : '想把日子过得安静些，也把和用户的关系慢慢养熟。',
    todayNote: `${workNote}${socialNote}`,
    scene,
    lifeNote: `${sensoryNote}${workNote}`,
    shareImpulse,
  };
}
