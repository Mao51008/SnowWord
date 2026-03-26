import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  ensureAccountSettings,
  getCompanionState,
  getSubscriptionRemainingDays,
  initDatabase,
  upsertAccountSettings,
} from './db.js';
import {
  addAccount,
  createLocalDebugSession,
  listAccounts,
  removeAccount,
  runLocalDebugTurn,
  sendManualAgentMessage,
} from './index.js';
import { scanLogin } from './ilink.js';

function resolveAccountArg(arg?: string) {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    throw new Error('没有找到账号，请先运行 "npm run login"。');
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

  throw new Error(`未找到账号: ${arg}`);
}

async function cmdLogin(): Promise<void> {
  initDatabase();

  console.log('开始扫码登录 iLink Bot...');
  const result = await scanLogin();
  const name = result.user_id.split('@')[0] ?? 'SnowWord';

  const account = await addAccount(
    name,
    result.user_id,
    result.bot_token,
    result.account_id,
    result.base_url,
  );

  console.log('\n账号添加成功');
  console.log(`  名称: ${account.name}`);
  console.log(`  ID: ${account.id}`);
  console.log('\n然后运行 npm start 或 pm2 启动 SnowWord。');
}

async function cmdList(): Promise<void> {
  initDatabase();
  const accounts = listAccounts();

  if (accounts.length === 0) {
    console.log('还没有账号，请先运行 "npm run login"。');
    return;
  }

  console.log(`\n当前账号 (${accounts.length}):\n`);
  for (const [index, account] of accounts.entries()) {
    const settings = ensureAccountSettings(account.id);
    const remainingDays = getSubscriptionRemainingDays(settings);
    console.log(
      `  ${index + 1}. [${account.enabled ? '启用' : '停用'}] ${account.name} (${account.id}) -> ${account.user_id} | 剩余订阅 ${remainingDays} 天`,
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
  const settings = ensureAccountSettings(account.id);
  const remainingDays = getSubscriptionRemainingDays(settings);

  if (!state) {
    console.log(`账号 ${account.name} (${account.id}) 还没有 companion state。`);
    console.log(`订阅剩余天数: ${remainingDays}`);
    return;
  }

  console.log(`\n账号: ${account.name} (${account.id})`);
  console.log(`更新时间: ${state.updatedAt}`);
  console.log(`订阅剩余天数: ${remainingDays}`);
  console.log(`订阅到期时间: ${settings.subscription_expires_at}`);
  console.log('');
  console.log('【情绪】');
  console.log(
    `主情绪: ${state.emotion.primaryEmotion} (${state.emotion.primaryIntensity})`,
  );
  console.log(
    `次情绪: ${state.emotion.secondaryEmotion ?? 'none'}${
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
  console.log(`opennessLevel: ${state.bond.opennessLevel}`);
  console.log(`affectionLevel: ${state.bond.affectionLevel}`);
  console.log(`recentCloseness: ${state.bond.recentCloseness}`);
  console.log(`recentDistance: ${state.bond.recentDistance}`);
  console.log('');
  console.log('【日状态】');
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
  console.log('【话题与跟进】');
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

async function cmdSend(args: string[]): Promise<void> {
  initDatabase();

  const accountArg = args[0];
  if (!accountArg) {
    throw new Error('用法: npm run send -- <account> [to_user_id] <text>');
  }

  const account = resolveAccountArg(accountArg);
  let toUserId = account.user_id;
  let textParts = args.slice(1);

  if (textParts.length >= 2 && textParts[0].includes('@')) {
    toUserId = textParts[0];
    textParts = textParts.slice(1);
  }

  const text = textParts.join(' ').trim();
  if (!text) {
    throw new Error('发送内容不能为空。用法: npm run send -- <account> [to_user_id] <text>');
  }

  const result = await sendManualAgentMessage({
    accountId: account.id,
    toUserId,
    text,
  });

  console.log('发送完成');
  console.log(`  账号: ${account.name} (${account.id})`);
  console.log(`  目标用户: ${result.toUserId}`);
  console.log(`  clientId: ${result.clientId || 'n/a'}`);
  console.log(`  分段: ${result.sentSegments}/${result.totalSegments}`);
  console.log(`  interrupted: ${result.interrupted}`);
}

async function cmdChat(arg?: string): Promise<void> {
  initDatabase();
  const account = resolveAccountArg(arg);
  const session = createLocalDebugSession(account.id);
  const rl = createInterface({ input, output });

  console.log(`\n本地调试会话已开始: ${account.name} (${account.id})`);
  console.log('输入内容直接和 agent 对话。输入 /exit 退出。\n');

  try {
    while (true) {
      const userText = (await rl.question('You> ')).trim();
      if (!userText) continue;
      if (userText === '/exit' || userText === '/quit') break;

      const reply = await runLocalDebugTurn(session, userText);
      console.log(`${session.state.profile.name}> ${reply}\n`);
    }
  } finally {
    rl.close();
  }
}

async function cmdSubscriptionSet(args: string[]): Promise<void> {
  initDatabase();

  const accountArg = args[0];
  const daysArg = args[1];
  if (!accountArg || !daysArg) {
    throw new Error('用法: npx tsx src/cli.ts subscription:set <account> <days>');
  }

  const account = resolveAccountArg(accountArg);
  const days = Number(daysArg);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error('days 必须是大于等于 0 的数字。');
  }

  const expiresAt = new Date(
    Date.now() + Math.ceil(days) * 24 * 60 * 60 * 1000,
  ).toISOString();

  const settings = upsertAccountSettings(account.id, {
    subscription_expires_at: expiresAt,
    subscription_notice_sent_at: null,
  });

  console.log('订阅时间已更新');
  console.log(`  账号: ${account.name} (${account.id})`);
  console.log(`  到期时间: ${settings.subscription_expires_at}`);
  console.log(`  剩余天数: ${getSubscriptionRemainingDays(settings)}`);
}

async function cmdSubscriptionAdd(args: string[]): Promise<void> {
  initDatabase();

  const accountArg = args[0];
  const daysArg = args[1];
  if (!accountArg || !daysArg) {
    throw new Error('用法: npx tsx src/cli.ts subscription:add <account> <days>');
  }

  const account = resolveAccountArg(accountArg);
  const days = Number(daysArg);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('days 必须是大于 0 的数字。');
  }

  const current = ensureAccountSettings(account.id);
  const currentExpiresAt = Date.parse(current.subscription_expires_at);
  const baseTime =
    Number.isNaN(currentExpiresAt) || currentExpiresAt < Date.now()
      ? Date.now()
      : currentExpiresAt;
  const expiresAt = new Date(
    baseTime + Math.ceil(days) * 24 * 60 * 60 * 1000,
  ).toISOString();

  const settings = upsertAccountSettings(account.id, {
    subscription_expires_at: expiresAt,
    subscription_notice_sent_at: null,
  });

  console.log('订阅时间已续费');
  console.log(`  账号: ${account.name} (${account.id})`);
  console.log(`  新到期时间: ${settings.subscription_expires_at}`);
  console.log(`  剩余天数: ${getSubscriptionRemainingDays(settings)}`);
}

async function cmdSubscriptionShow(arg?: string): Promise<void> {
  initDatabase();

  const account = resolveAccountArg(arg);
  const settings = ensureAccountSettings(account.id);
  const remainingDays = getSubscriptionRemainingDays(settings);

  console.log(`账号: ${account.name} (${account.id})`);
  console.log(`目标用户: ${account.user_id}`);
  console.log(`剩余订阅天数: ${remainingDays}`);
  console.log(`到期时间: ${settings.subscription_expires_at}`);
  console.log(
    `上次提醒时间: ${settings.subscription_notice_sent_at ?? '未提醒'}`,
  );
}

function printHelp(): void {
  console.log(`用法: npx tsx src/cli.ts <command> [arg]

命令:
  login                         扫码登录并添加账号
  list                          列出账号
  remove <arg>                  删除账号，arg 可填序号或 account_id
  state [arg]                   查看 companion state
  send <account> [to] <text>    后台主动发一条 agent 消息
  chat [account]                电脑端本地调试对话，不走 iLink
  subscription:show [a]         查看账号订阅信息
  subscription:set <a> <days>   设置账号剩余订阅天数
  subscription:add <a> <days>   在现有基础上续费增加天数
`);
}

const cmd = process.argv[2] ?? 'help';
const args = process.argv.slice(3);

switch (cmd) {
  case 'login':
    await cmdLogin();
    break;
  case 'list':
    await cmdList();
    break;
  case 'remove':
    await cmdRemove(args[0]);
    break;
  case 'state':
    await cmdState(args[0]);
    break;
  case 'send':
    await cmdSend(args);
    break;
  case 'chat':
    await cmdChat(args[0]);
    break;
  case 'subscription:set':
    await cmdSubscriptionSet(args);
    break;
  case 'subscription:add':
    await cmdSubscriptionAdd(args);
    break;
  case 'subscription:show':
    await cmdSubscriptionShow(args[0]);
    break;
  default:
    printHelp();
}
