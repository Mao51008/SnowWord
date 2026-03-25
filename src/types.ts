// --- SnowWord Types ---

export interface Account {
  id: string; // bot_id, e.g. "xxx@im.bot"
  user_id: string; // wechat user id, e.g. "xxx@im.wechat"
  name: string; // display name
  bot_token: string; // iLink bot token
  base_url: string; // iLink API base URL
  soul_md_path: string; // path to soul.md file
  get_updates_buf: string; // iLink long-poll cursor
  enabled: number; // 0 = disabled, 1 = enabled
  created_at: string; // ISO timestamp
}

export interface Memory {
  id: number;
  account_id: string;
  content: string;
  importance: number; // 1-5
  tags: string; // comma-separated
  created_at: string;
  accessed_at: string;
}

export interface AccountSettings {
  account_id: string;
  persona_id: CompanionPersonaId;
  custom_persona_prompt: string;
  updated_at: string;
}

export interface NewMessage {
  id: string;
  account_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  account_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  reminder_type: 'medicine' | 'exercise' | 'water' | 'custom' | null;
  voice_text: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export type CompanionPrimaryEmotion =
  | 'settled'
  | 'caring'
  | 'drawn'
  | 'fulfilled'
  | 'let_down'
  | 'jealous'
  | 'hurt'
  | 'softened'
  | 'curious';

export type RelationshipStage =
  | 'new'
  | 'familiar'
  | 'warm'
  | 'close'
  | 'ambiguous_close';

export type CompanionLevel = 'low' | 'medium' | 'high';
export type CompanionPersonaId = 'xiaoxue' | 'chuxue';

export type CompanionProactiveType =
  | 'checking_in'
  | 'continuing'
  | 'caring'
  | 'sharing';

export interface CompanionProfile {
  personaId: CompanionPersonaId;
  name: string;
  identity: string;
  occupation: string;
  selfAwareness: string;
  coreTraits: string[];
  likes: string[];
  dislikes: string[];
  socialStyle: string;
  relationshipStyle: string;
  expressionStyle: string;
  boundaries: string[];
}

export interface CompanionDailyState {
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
}

export interface CompanionBondState {
  relationshipStage: RelationshipStage;
  trustLevel: number;
  opennessLevel: number;
  affectionLevel: number;
  recentCloseness: number;
  recentDistance: number;
  specialBondMarkers: string[];
}

export interface CompanionEmotionState {
  primaryEmotion: CompanionPrimaryEmotion;
  primaryIntensity: 1 | 2 | 3;
  secondaryEmotion: CompanionPrimaryEmotion | null;
  secondaryIntensity: 1 | 2 | 3 | null;
  trigger: string;
  updatedAt: string;
}

export interface CompanionConversationState {
  pendingTopics: string[];
  careFollowups: string[];
  unfinishedConversations: string[];
  recentUserPainPoints: string[];
  recentUserJoyPoints: string[];
}

export interface CompanionProactiveState {
  lastProactiveAt: string | null;
  lastProactiveType: CompanionProactiveType | null;
  proactiveTodayCount: number;
  lastUserMessageAt: string | null;
  lastBotMessageAt: string | null;
  ignoredProactiveCount: number;
  nextProactiveEarliestAt: string | null;
}

export interface CompanionState {
  accountId: string;
  profile: CompanionProfile;
  daily: CompanionDailyState;
  bond: CompanionBondState;
  emotion: CompanionEmotionState;
  conversation: CompanionConversationState;
  proactive: CompanionProactiveState;
  updatedAt: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
