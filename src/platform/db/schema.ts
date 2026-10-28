/**
 * 数据库结构。
 *
 * 刻意不用"一份 SQLite DDL + 正则翻译成 PostgreSQL"的做法：
 * 那种改写会在字面量、索引和自增列上悄悄出错。这里按语句列表声明结构，
 * 仅在自增主键这类方言差异处做显式分支。
 *
 * 迁移以 schema_migrations.version 记录；当前只有 v1。
 */

import type { Database, Queryable } from './driver.ts';

const MIGRATION_LOCK = 190106;

function statements(dialect: 'sqlite' | 'postgres'): string[] {
  const seq = dialect === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,

    // ---- 主体与目录 ----
    `CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      roles TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      did TEXT,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS principals_workspace ON principals(workspace, id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS principals_did ON principals(workspace, did)`,

    // ---- 任务 ----
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      priority TEXT NOT NULL,
      due_at TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES principals(id),
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS tasks_workspace_created ON tasks(workspace, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id, status)`,

    `CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL REFERENCES principals(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      due_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, agent_id, kind)
    )`,
    `CREATE INDEX IF NOT EXISTS subtasks_task ON subtasks(task_id)`,
    `CREATE INDEX IF NOT EXISTS subtasks_agent ON subtasks(agent_id, status)`,

    `CREATE TABLE IF NOT EXISTS subtask_dependencies (
      subtask_id TEXT NOT NULL REFERENCES subtasks(id),
      depends_on TEXT NOT NULL REFERENCES subtasks(id),
      PRIMARY KEY (subtask_id, depends_on),
      CHECK (subtask_id <> depends_on)
    )`,
    `CREATE INDEX IF NOT EXISTS subtask_dependencies_reverse ON subtask_dependencies(depends_on)`,

    `CREATE TABLE IF NOT EXISTS task_coordinators (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      principal_id TEXT NOT NULL REFERENCES principals(id),
      PRIMARY KEY (task_id, principal_id)
    )`,

    `CREATE TABLE IF NOT EXISTS events (
      seq ${seq},
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      actor_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id, seq)`,

    `CREATE TABLE IF NOT EXISTS task_summaries (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      pending TEXT NOT NULL,
      through_seq INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, version)
    )`,

    // ---- 幂等 ----
    `CREATE TABLE IF NOT EXISTS operations (
      principal_id TEXT NOT NULL,
      op_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (principal_id, op_key)
    )`,
    `CREATE INDEX IF NOT EXISTS operations_created ON operations(created_at)`,

    // ---- 知识 ----
    `CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      content TEXT NOT NULL,
      conditions TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      reviewer_id TEXT,
      expires_at TEXT,
      access_mode TEXT NOT NULL DEFAULT 'restricted',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_workspace_state ON knowledge(workspace, state, expires_at)`,

    `CREATE TABLE IF NOT EXISTS knowledge_versions (
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      conditions TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (knowledge_id, version)
    )`,

    `CREATE TABLE IF NOT EXISTS knowledge_grants (
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      principal_id TEXT NOT NULL REFERENCES principals(id),
      PRIMARY KEY (knowledge_id, principal_id)
    )`,

    `CREATE TABLE IF NOT EXISTS knowledge_refs (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      version INTEGER NOT NULL,
      PRIMARY KEY (task_id, knowledge_id, version)
    )`,

    // ---- 通知与审计 ----
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      recipient_id TEXT NOT NULL REFERENCES principals(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      subtask_id TEXT NOT NULL REFERENCES subtasks(id),
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(workspace, recipient_id, acknowledged_at, created_at)`,

    `CREATE TABLE IF NOT EXISTS audit (
      seq ${seq},
      workspace TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS audit_workspace ON audit(workspace, seq DESC)`,
  ];
}

export const SCHEMA_VERSION = 1;

/**
 * 建表并记录版本。整个过程在一个事务里完成：PostgreSQL 用咨询锁避免
 * 多实例同时迁移，SQLite 由驱动的写互斥量保证串行。
 */
export async function migrate(db: Database, now: () => string): Promise<void> {
  const list = statements(db.dialect);
  await db.transaction(async (tx: Queryable) => {
    if (db.dialect === 'postgres') {
      await tx.one('SELECT pg_advisory_xact_lock(:key) AS locked', { key: MIGRATION_LOCK });
    }
    for (const statement of list) {
      await tx.run(statement);
    }
    const current = await tx.one<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    if (!current) {
      await tx.run('INSERT INTO schema_migrations(version, applied_at) VALUES(:version, :appliedAt)', {
        version: SCHEMA_VERSION,
        appliedAt: now(),
      });
    }
  });
}
