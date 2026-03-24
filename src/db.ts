import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import {
  Account,
  CompanionState,
  Memory,
  NewMessage,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      base_url TEXT NOT NULL,
      soul_md_path TEXT NOT NULL,
      get_updates_buf TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 3,
      tags TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      accessed_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memories_account ON memories(account_id);
    CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      account_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, account_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      reminder_type TEXT,
      voice_text TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_account ON scheduled_tasks(account_id);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS companion_state (
      account_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

// =====================
// --- Account accessors ---
// =====================

export function createAccount(account: Account): void {
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, bot_token, base_url, soul_md_path, get_updates_buf, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.user_id,
    account.name,
    account.bot_token,
    account.base_url,
    account.soul_md_path,
    account.get_updates_buf,
    account.enabled,
    account.created_at,
  );
}

export function getAccount(id: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | Account
    | undefined;
}

export function getAllAccounts(): Account[] {
  return db
    .prepare('SELECT * FROM accounts ORDER BY created_at')
    .all() as Account[];
}

export function getEnabledAccounts(): Account[] {
  return db
    .prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY created_at')
    .all() as Account[];
}

export function updateAccount(
  id: string,
  updates: Partial<
    Pick<
      Account,
      | 'name'
      | 'bot_token'
      | 'base_url'
      | 'soul_md_path'
      | 'get_updates_buf'
      | 'enabled'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.bot_token !== undefined) {
    fields.push('bot_token = ?');
    values.push(updates.bot_token);
  }
  if (updates.base_url !== undefined) {
    fields.push('base_url = ?');
    values.push(updates.base_url);
  }
  if (updates.soul_md_path !== undefined) {
    fields.push('soul_md_path = ?');
    values.push(updates.soul_md_path);
  }
  if (updates.get_updates_buf !== undefined) {
    fields.push('get_updates_buf = ?');
    values.push(updates.get_updates_buf);
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteAccount(id: string): void {
  // Delete related data first
  db.prepare('DELETE FROM memories WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM companion_state WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// =====================
// --- Memory accessors ---
// =====================

export function createMemory(memory: Omit<Memory, 'id'>): number {
  const result = db
    .prepare(
      `INSERT INTO memories (account_id, content, importance, tags, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memory.account_id,
      memory.content,
      memory.importance,
      memory.tags,
      memory.created_at,
      memory.accessed_at,
    );
  return result.lastInsertRowid as number;
}

export function getMemoriesForAccount(accountId: string): Memory[] {
  return db
    .prepare(
      'SELECT * FROM memories WHERE account_id = ? ORDER BY created_at DESC',
    )
    .all(accountId) as Memory[];
}

export function searchMemories(
  accountId: string,
  options: { tag?: string; minImportance?: number; limit?: number } = {},
): Memory[] {
  const conditions: string[] = ['account_id = ?'];
  const values: unknown[] = [accountId];

  if (options.tag) {
    conditions.push('tags LIKE ?');
    values.push(`%${options.tag}%`);
  }
  if (options.minImportance !== undefined) {
    conditions.push('importance >= ?');
    values.push(options.minImportance);
  }

  const sql = `
    SELECT * FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `;
  values.push(options.limit ?? 100);

  return db.prepare(sql).all(...values) as Memory[];
}

export function updateMemoryAccessed(id: number): void {
  db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function deleteMemory(id: number): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

// =====================
// --- Message accessors ---
// =====================

export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, account_id, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.account_id,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function clearMessages(): number {
  const result = db.prepare('DELETE FROM messages').run();
  return result.changes;
}

export function getRecentMessages(
  accountId: string,
  limit: number = 50,
): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE account_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(accountId, limit) as NewMessage[];
}

export function getMessagesSince(
  accountId: string,
  sinceTimestamp: string,
  limit: number = 200,
): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE account_id = ? AND timestamp > ? AND is_bot_message = 0
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(accountId, sinceTimestamp, limit) as NewMessage[];
}

// =====================
// --- Task accessors ---
// =====================

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `INSERT INTO scheduled_tasks (id, account_id, prompt, schedule_type, schedule_value, reminder_type, voice_text, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.account_id,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.reminder_type ?? null,
    task.voice_text ?? null,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForAccount(accountId: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE account_id = ? ORDER BY created_at DESC',
    )
    .all(accountId) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'reminder_type'
      | 'voice_text'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.reminder_type !== undefined) {
    fields.push('reminder_type = ?');
    values.push(updates.reminder_type);
  }
  if (updates.voice_text !== undefined) {
    fields.push('voice_text = ?');
    values.push(updates.voice_text);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run`,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE scheduled_tasks
     SET next_run = ?, last_run = ?, last_result = ?,
         status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
     WHERE id = ?`,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// =====================
// --- Companion state ---
// =====================

export function getCompanionState(accountId: string): CompanionState | undefined {
  const row = db
    .prepare(
      'SELECT state_json FROM companion_state WHERE account_id = ?',
    )
    .get(accountId) as { state_json: string } | undefined;

  if (!row) return undefined;
  return JSON.parse(row.state_json) as CompanionState;
}

export function upsertCompanionState(state: CompanionState): void {
  db.prepare(
    `INSERT INTO companion_state (account_id, state_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run(state.accountId, JSON.stringify(state), state.updatedAt);
}
