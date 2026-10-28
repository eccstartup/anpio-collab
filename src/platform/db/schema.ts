/**
 * 数据库结构。
 *
 * 刻意不用"一份 SQLite DDL + 正则翻译成 PostgreSQL"的做法：
 * 那种改写会在字面量、索引和自增列上悄悄出错。这里按语句列表声明结构，
 * 仅在自增主键这类方言差异处做显式分支。
 *
 * 迁移：
 *  - v1 建表；
 *  - v2 新增身份、协作与监管结构，并给既有表补列。
 *
 * 补列必须先于事务探测（只读连接看不到未提交的 DDL），
 * 因此 `ensureColumns` 在事务外查现有列，事务内只做 CREATE 与 ALTER。
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
      kind TEXT NOT NULL DEFAULT 'human',
      handle TEXT,
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
      origin TEXT NOT NULL DEFAULT 'human',
      origin_principal_id TEXT,
      adopted_at TEXT,
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
    `CREATE INDEX IF NOT EXISTS subtask_dependencies_forward ON subtask_dependencies(subtask_id)`,

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

    // ---- v2：ANP 身份 ----
    `CREATE TABLE IF NOT EXISTS anp_nonces (
      nonce TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      issued_to TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS anp_nonces_expiry ON anp_nonces(expires_at)`,

    `CREATE TABLE IF NOT EXISTS anp_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      did TEXT NOT NULL,
      workspace TEXT NOT NULL,
      client TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS anp_sessions_principal ON anp_sessions(workspace, principal_id, revoked_at)`,

    `CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      did TEXT NOT NULL,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      fingerprint TEXT,
      client TEXT NOT NULL DEFAULT 'browser',
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      login_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (workspace, did)
    )`,
    `CREATE INDEX IF NOT EXISTS identities_principal ON identities(workspace, principal_id)`,

    `CREATE TABLE IF NOT EXISTS identity_invites (
      code TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      role TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by_did TEXT
    )`,

    // ---- v2：协作 ----
    `CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author_id TEXT NOT NULL REFERENCES principals(id),
      body TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS task_mentions (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      comment_id TEXT NOT NULL REFERENCES task_comments(id),
      recipient_id TEXT NOT NULL REFERENCES principals(id),
      created_at TEXT NOT NULL,
      read_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS task_mentions_unread ON task_mentions(workspace, recipient_id, read_at)`,

    `CREATE TABLE IF NOT EXISTS task_offers (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      capability TEXT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      subtask_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS task_offers_open ON task_offers(workspace, status, capability)`,

    `CREATE TABLE IF NOT EXISTS agent_presence (
      principal_id TEXT PRIMARY KEY REFERENCES principals(id),
      workspace TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS agent_presence_seen ON agent_presence(workspace, last_seen_at)`,

    // ---- v2：监管 ----
    `CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      rule TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      task_id TEXT,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      acknowledged_by TEXT,
      acknowledged_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      UNIQUE (workspace, rule, subject_type, subject_id)
    )`,
    `CREATE INDEX IF NOT EXISTS alerts_open ON alerts(workspace, status, severity, last_seen_at DESC)`,
  ];
}

/** v2 给既有表补的列。新库在 CREATE 语句里已包含，这里只服务升级路径。 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'principals', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'principals', column: 'handle', definition: 'TEXT' },
  { table: 'tasks', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'tasks', column: 'origin_principal_id', definition: 'TEXT' },
  { table: 'tasks', column: 'adopted_at', definition: 'TEXT' },
];

export const SCHEMA_VERSION = 2;

async function existingColumns(db: Database, table: string): Promise<Set<string> | null> {
  try {
    const exists =
      db.dialect === 'postgres'
        ? await db.read.one(
            `SELECT 1 AS present FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = :table`,
            { table },
          )
        : await db.read.one(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = :table`, {
            table,
          });
    // 表还不存在：CREATE 语句会带上新列，不需要 ALTER。
    if (!exists) return null;
    const rows =
      db.dialect === 'postgres'
        ? await db.read.all<{ name: string }>(
            `SELECT column_name AS name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = :table`,
            { table },
          )
        : await db.read.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return new Set(rows.map(row => String(row.name)));
  } catch {
    return null;
  }
}

/**
 * 建表并记录版本。整个 DDL 在一个事务里完成：PostgreSQL 用咨询锁避免
 * 多实例同时迁移，SQLite 由驱动的写互斥量保证串行。
 */
export async function migrate(db: Database, now: () => string): Promise<void> {
  const list = statements(db.dialect);

  const pending: { table: string; column: string; definition: string }[] = [];
  for (const item of ADDED_COLUMNS) {
    const columns = await existingColumns(db, item.table);
    // 表不存在时 CREATE 语句会带上该列；只有升级既有库才需要 ALTER。
    if (columns && !columns.has(item.column)) pending.push(item);
  }

  await db.transaction(async (tx: Queryable) => {
    if (db.dialect === 'postgres') {
      await tx.one('SELECT pg_advisory_xact_lock(:key) AS locked', { key: MIGRATION_LOCK });
    }
    for (const statement of list) {
      await tx.run(statement);
    }
    for (const item of pending) {
      await tx.run(`ALTER TABLE ${item.table} ADD COLUMN ${item.column} ${item.definition}`);
    }
    const current = await tx.one<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    if (!current) {
      await tx.run('INSERT INTO schema_migrations(version, applied_at) VALUES(:version, :appliedAt)', {
        version: SCHEMA_VERSION,
        appliedAt: now(),
      });
    } else if (Number(current.version) < SCHEMA_VERSION) {
      await tx.run('INSERT INTO schema_migrations(version, applied_at) VALUES(:version, :appliedAt)', {
        version: SCHEMA_VERSION,
        appliedAt: now(),
      });
    }
  });
}
