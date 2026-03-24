/**
 * HushBay CLI
 *
 * Examples:
 *   npx tsx src/cli.ts login
 *   npx tsx src/cli.ts list
 *   npx tsx src/cli.ts remove 1
 *   npx tsx src/cli.ts state
 *   npx tsx src/cli.ts state 1
 *   npx tsx src/cli.ts state bot_xxx
 */

import { getCompanionState, initDatabase } from './db.js';
import { addAccount, listAccounts, removeAccount } from './index.js';
import { scanLogin } from './ilink.js';

function resolveAccountArg(arg?: string) {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    throw new Error('No accounts found. Run "npx tsx src/cli.ts login" first.');
  }

  if (!arg) {
    return accounts[0];
  }

  const byIndex = parseInt(arg, 10);
  if (!Number.isNaN(byIndex) && byIndex >= 1 && byIndex <= accounts.length) {
    return accounts[byIndex - 1];
  }

  const byId = accounts.find((account) => account.id === arg);
  if (byId) return byId;

  throw new Error(`Account not found: ${arg}`);
}

async function cmdLogin(): Promise<void> {
  initDatabase();

  console.log('开始扫码登录 ClawBot...');
  const result = await scanLogin();
  const name = result.user_id.split('@')[0] ?? 'ClawBot';

  const account = await addAccount(
    name,
    result.user_id,
    result.bot_token,
    result.account_id,
    result.base_url,
  );

  console.log('\n账号创建成功');
  console.log(`  名称: ${account.name}`);
  console.log(`  ID: ${account.id}`);
  console.log('\n然后运行 npm start 启动 HushBay。');
}

async function cmdList(): Promise<void> {
  initDatabase();
  const accounts = listAccounts();

  if (accounts.length === 0) {
    console.log('还没有账号。先运行 "npx tsx src/cli.ts login"。');
    return;
  }

  console.log(`\n当前账号 (${accounts.length}):\n`);
  for (const [index, account] of accounts.entries()) {
    console.log(
      `  ${index + 1}. [${account.enabled ? '启用' : '停用'}] ${account.name} (${account.id})`,
    );
  }
  console.log();
}

async function cmdRemove(arg?: string): Promise<void> {
  initDatabase();
  const account = resolveAccountArg(arg);
  removeAccount(account.id);
  console.log(`已删除账号: ${account.name} (${account.id})`);
}

async function cmdState(arg?: string): Promise<void> {
  initDatabase();
  const account = resolveAccountArg(arg);
  const state = getCompanionState(account.id);

  if (!state) {
    console.log(`账号 ${account.name} (${account.id}) 还没有 companion state。`);
    return;
  }

  console.log(`\n账号: ${account.name} (${account.id})`);
  console.log(`更新时间: ${state.updatedAt}`);
  console.log('');
  console.log('【情绪】');
  console.log(
    `主情绪: ${state.emotion.primaryEmotion} (${state.emotion.primaryIntensity})`,
  );
  console.log(
    `次级情绪: ${state.emotion.secondaryEmotion ?? 'none'}${
      state.emotion.secondaryIntensity != null
        ? ` (${state.emotion.secondaryIntensity})`
        : ''
    }`,
  );
  console.log(`触发原因: ${state.emotion.trigger}`);
  console.log('');
  console.log('【关系】');
  console.log(`阶段: ${state.bond.relationshipStage}`);
  console.log(`trustLevel: ${state.bond.trustLevel}`);
  console.log(`attachmentLevel: ${state.bond.attachmentLevel}`);
  console.log(`ambiguityLevel: ${state.bond.ambiguityLevel}`);
  console.log(`recentCloseness: ${state.bond.recentCloseness}`);
  console.log(`recentDistance: ${state.bond.recentDistance}`);
  console.log('');
  console.log('【今日状态】');
  console.log(`mood: ${state.daily.mood}`);
  console.log(`energy: ${state.daily.energy}`);
  console.log(`socialDesire: ${state.daily.socialDesire}`);
  console.log(`closenessDesire: ${state.daily.closenessDesire}`);
  console.log(`todayFocus: ${state.daily.todayFocus}`);
  console.log(`scene: ${state.daily.scene}`);
  console.log(`lifeNote: ${state.daily.lifeNote}`);
  console.log(`shareImpulse: ${state.daily.shareImpulse}`);
  console.log('');
  console.log('【主动】');
  console.log(`lastProactiveAt: ${state.proactive.lastProactiveAt ?? 'none'}`);
  console.log(
    `lastProactiveType: ${state.proactive.lastProactiveType ?? 'none'}`,
  );
  console.log(`proactiveTodayCount: ${state.proactive.proactiveTodayCount}`);
  console.log(
    `nextProactiveEarliestAt: ${state.proactive.nextProactiveEarliestAt ?? 'none'}`,
  );
  console.log('');
  console.log('【话题线索】');
  console.log(
    `careFollowups: ${
      state.conversation.careFollowups.length > 0
        ? state.conversation.careFollowups.join(' | ')
        : 'none'
    }`,
  );
  console.log(
    `pendingTopics: ${
      state.conversation.pendingTopics.length > 0
        ? state.conversation.pendingTopics.join(' | ')
        : 'none'
    }`,
  );
  console.log(
    `recentUserPainPoints: ${
      state.conversation.recentUserPainPoints.length > 0
        ? state.conversation.recentUserPainPoints.join(' | ')
        : 'none'
    }`,
  );
  console.log(
    `recentUserJoyPoints: ${
      state.conversation.recentUserJoyPoints.length > 0
        ? state.conversation.recentUserJoyPoints.join(' | ')
        : 'none'
    }`,
  );
  console.log('');
}

const cmd = process.argv[2] ?? 'help';
const arg = process.argv[3];

switch (cmd) {
  case 'login':
    await cmdLogin();
    break;
  case 'list':
    await cmdList();
    break;
  case 'remove':
    await cmdRemove(arg);
    break;
  case 'state':
    await cmdState(arg);
    break;
  default:
    console.log(`用法: npx tsx src/cli.ts <command> [arg]

命令:
  login          扫码登录并添加账号
  list           列出账号
  remove <arg>   删除账号，arg 可填序号或 account_id
  state [arg]    查看 companion state，arg 可填序号或 account_id
`);
}
