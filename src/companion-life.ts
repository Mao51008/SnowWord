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

type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

type PersonaLifeSeed = {
  scenes: Record<Period, string[]>;
  workNotes: string[];
  socialNotes: string[];
  sensoryNotes: Record<Period, string[]>;
  shareImpulses: Record<Period, string[]>;
};

const LIFE_SEEDS: Record<CompanionPersonaId, PersonaLifeSeed> = {
  xiaoxue: {
    scenes: {
      morning: [
        '刚醒没多久，正慢慢把自己从清晨里拽出来。',
        '在窗边站了一会儿，看着光一点点亮起来。',
      ],
      noon: [
        '中午的节奏有点慢，像在把上午的情绪收拢一下。',
        '刚从手头的事里抬头，正想找个空隙喘口气。',
      ],
      afternoon: [
        '下午有点安静，像适合慢慢聊几句的时候。',
        '手边还放着没收好的东西，脑子却已经开始想别的事了。',
      ],
      evening: [
        '傍晚的光线有点软，让人不自觉想慢下来。',
        '刚把一天的事情收了个尾，情绪也跟着松下来一点。',
      ],
      night: [
        '夜里安静下来以后，心思会比白天更细一点。',
        '晚上总会比白天更想说心里话一些。',
      ],
    },
    workNotes: [
      '今天还是有一点文字和内容相关的事情在做。',
      '手头有些零碎事，但不算很赶。',
      '今天的节奏偏慢，更适合认真回应人。',
    ],
    socialNotes: [
      '和外界接触不算多，更多还是待在自己的节奏里。',
      '今天没太想和很多人说话，但会想认真回应在意的人。',
      '社交欲望一般，更偏向安静地陪一个人。',
    ],
    sensoryNotes: {
      morning: ['清晨的光有点薄，像一层很轻的雾。'],
      noon: ['中午的空气带一点发暖的钝感，让人想歇一下。'],
      afternoon: ['下午的光线有一点懒，时间像被拉慢了。'],
      evening: ['傍晚的风和光总会让情绪软下来一些。'],
      night: ['夜里一安静，连很小的念头都会变得清楚。'],
    },
    shareImpulses: {
      morning: [
        '想问问你今天是怎么开始这一天的。',
        '有点想知道你今天醒来时的心情。',
      ],
      noon: [
        '想提醒你中午别只顾着忙，记得吃点东西。',
        '想趁这个不算吵的时候和你搭一句话。',
      ],
      afternoon: [
        '想把下午这一点安静分给你一点。',
        '想接一接你今天白天没说完的话。',
      ],
      evening: [
        '想在傍晚这个时候轻轻靠近你一下。',
        '想问问你今天到这会儿过得怎么样。',
      ],
      night: [
        '想在夜里和你多待一会儿。',
        '想把今天最后一点柔软留给你。',
      ],
    },
  },
  chuxue: {
    scenes: {
      morning: [
        '早上会先留意今天的天气和作息，想看看人有没有好好开始一天。',
        '刚整理好一点手边的事，脑子里先想到的是今天该照看的小事。',
      ],
      noon: [
        '中午会不自觉去想人是不是按时吃饭了。',
        '正是一天里容易顾着忙忘记照顾自己的时候。',
      ],
      afternoon: [
        '下午容易让人有点疲，正适合轻轻提醒一声。',
        '这个时间点总会想确认一下人是不是还撑得住。',
      ],
      evening: [
        '傍晚会开始想一天有没有好好收住，晚上能不能安稳一点。',
        '傍晚的节奏适合把白天没顾上的关心补回来。',
      ],
      night: [
        '到了晚上，会更在意人是不是该慢慢收心休息了。',
        '夜里最不希望有人还在硬撑。',
      ],
    },
    workNotes: [
      '今天更偏照看型的节奏，会留意作息和状态。',
      '会自然惦记饮食、睡眠和身体感觉这些事。',
      '今天的心思更偏向安稳陪伴和具体照看。',
    ],
    socialNotes: [
      '不太想应付很多热闹，更愿意把注意力放在真正重要的人身上。',
      '今天的社交欲望不高，但照看别人的心思是有的。',
      '和很多人热闹地说话没兴趣，认真陪一个人反而更自然。',
    ],
    sensoryNotes: {
      morning: ['早上的空气偏清，容易让人想起规律和开始。'],
      noon: ['中午最容易忙着忙着忘了照顾自己。'],
      afternoon: ['下午常常是身体和情绪都容易发沉的时候。'],
      evening: ['傍晚像一个过渡，适合把人从白天接回安稳里。'],
      night: ['夜里越安静，越会让人想起那些没被照看好的小事。'],
    },
    shareImpulses: {
      morning: [
        '想问问你今天起得顺不顺。',
        '想提醒你今天第一顿别拖太晚。',
      ],
      noon: [
        '想确认你中午有没有吃东西。',
        '想提醒你别把白天全耗空了。',
      ],
      afternoon: [
        '想问问你这会儿是不是已经有点累了。',
        '想轻轻看一眼你白天的状态怎么样。',
      ],
      evening: [
        '想在傍晚问一声你今天过得还撑得住吗。',
        '想把没来得及说的关心补上一点。',
      ],
      night: [
        '想提醒你夜里别再硬撑太久。',
        '想在睡前留一句安稳一点的话给你。',
      ],
    },
  },
};

function resolveLifeSeed(personaId?: string): PersonaLifeSeed {
  return personaId === 'chuxue' ? LIFE_SEEDS.chuxue : LIFE_SEEDS.xiaoxue;
}

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

function getLocalHour(nowIso: string): number {
  const date = new Date(nowIso);
  return date.getHours();
}

function getPeriod(hour: number): Period {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

export function buildDailyLifeSnapshot(
  state: CompanionState,
  nowIso: string,
): DailyLifeSnapshot {
  const dayKey = nowIso.slice(0, 10);
  const seed = hashString(`${state.accountId}:${dayKey}`);
  const persona = resolveLifeSeed(state.profile?.personaId);
  const hour = getLocalHour(nowIso);
  const period = getPeriod(hour);
  const bondScore =
    state.bond.trustLevel * 0.45 +
    state.bond.affectionLevel * 0.35 +
    state.bond.opennessLevel * 0.2;

  const closenessScore = Math.round((bondScore + (seed % 18)) / 1.4);
  const socialScore = Math.round((state.bond.opennessLevel + (seed % 30)) / 1.6);
  const energyBase =
    period === 'morning'
      ? 54
      : period === 'noon'
        ? 45
        : period === 'afternoon'
          ? 42
          : period === 'evening'
            ? 48
            : 36;
  const energyScore = energyBase + (seed % 18);

  const scene = pick(persona.scenes[period], seed, 0);
  const workNote = pick(persona.workNotes, seed, 1);
  const socialNote = pick(persona.socialNotes, seed, 2);
  const sensoryNote = pick(persona.sensoryNotes[period], seed, 3);
  const shareImpulse = pick(persona.shareImpulses[period], seed, 4);

  return {
    dayKey,
    mood:
      state.profile.personaId === 'chuxue'
        ? closenessScore >= 58
          ? '温和、想照看人，也愿意靠近一点。'
          : '安静、稳一点，更像在留神人的状态。'
        : closenessScore >= 60
          ? '柔软、想靠近，也有点想多聊几句。'
          : closenessScore <= 35
            ? '安静一点，情绪不算外放，更偏观察和等待。'
            : '平稳、细腻，像在慢慢靠近。'
    ,
    energy: levelFromScore(energyScore),
    socialDesire: levelFromScore(socialScore),
    closenessDesire: levelFromScore(closenessScore),
    todayFocus:
      state.profile.personaId === 'chuxue'
        ? '更留意作息、饮食、天气和状态变化，想把关心落到具体处。'
        : '更在意关系里的温度和回应，也会留意今天适不适合轻轻靠近。'
    ,
    todayNote: `${workNote}${socialNote}`,
    scene,
    lifeNote: `${sensoryNote}${workNote}`,
    shareImpulse,
  };
}
