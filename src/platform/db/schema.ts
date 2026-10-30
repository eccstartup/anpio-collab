/**
 * 数据库结构。
 *
 * 刻意不用"一份 SQLite DDL + 正则翻译成 PostgreSQL"的做法：
 * 那种改写会在字面量、索引和自增列上悄悄出错。这里按语句列表声明结构，
 * 仅在自增主键这类方言差异处做显式分支。
 *
 * 迁移：
 *  - v1 建表；
 *  - v2 新增身份、协作与监管结构，并给既有表补列；
 *  - v3 账号、租户与 Agent 设备授权；
 *  - v4 个人资料：姓名、头像、头衔、简介。
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
      avatar TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      account_id TEXT,
      tenant_role TEXT NOT NULL DEFAULT 'member'
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

    // 任务材料：用户上传的原始文件，随任务一起隔离。内容以 base64 存在 TEXT 里，
    // SQLite 与 PostgreSQL 都能原样备份，不依赖外部对象存储。
    `CREATE TABLE IF NOT EXISTS task_materials (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES principals(id),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS task_materials_task ON task_materials(task_id, created_at, id)`,

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

    // ---- v3：账号、租户与成员 ----
    // 账号是全局的（邮箱/DID），主体是租户内的。这样一个人可以在多个组织里
    // 有不同角色，而任务、知识、审计仍然只认主体，隔离不需要额外条件。
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS account_links (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (kind, value)
    )`,
    `CREATE INDEX IF NOT EXISTS account_links_account ON account_links(account_id)`,

    `CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      personal INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL
    )`,
    // 一个账号只能有一个个人空间；老库若已有重复数据，迁移会在这里失败而不是静默合并。
    `CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_personal
       ON tenants(created_by) WHERE personal = 1 AND created_by IS NOT NULL`,

    // 个人经验分享给团队：只给目标团队读权限，管理权仍在来源空间。
    `CREATE TABLE IF NOT EXISTS knowledge_shares (
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      team_workspace TEXT NOT NULL REFERENCES tenants(id),
      shared_by TEXT NOT NULL REFERENCES principals(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (knowledge_id, team_workspace)
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_shares_team
       ON knowledge_shares(team_workspace, knowledge_id)`,

    `CREATE TABLE IF NOT EXISTS tenant_invites (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'human',
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_principal_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_invites_tenant ON tenant_invites(tenant_id, accepted_at)`,

    `CREATE TABLE IF NOT EXISTS login_tickets (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      invite_id TEXT,
      account_id TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS login_tickets_expiry ON login_tickets(expires_at)`,

    // ---- v3：Agent 设备授权 ----
    // 这里不存明文令牌：device_code 只存摘要，会话令牌在轮询成功时才签发。
    `CREATE TABLE IF NOT EXISTS agent_requests (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code TEXT NOT NULL,
      requested_did TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_principal_id TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS agent_requests_code ON agent_requests(user_code, status)`,

    `CREATE TABLE IF NOT EXISTS agent_grants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_principal_id TEXT NOT NULL REFERENCES principals(id),
      owner_principal_id TEXT NOT NULL REFERENCES principals(id),
      scopes TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS agent_grants_owner ON agent_grants(tenant_id, owner_principal_id, status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_agent ON agent_grants(agent_principal_id)`,

    // 团队邀请智能体的短码：智能体拿着它就能自己入队，不必有人在线批准。
    `CREATE TABLE IF NOT EXISTS agent_invites (
      code TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      created_by TEXT NOT NULL REFERENCES principals(id),
      scopes TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      used_by_did TEXT
    )`,

    // ---- v3：本地邮件投递 ----
    // 生产替换 MailService 即可；这张表只是本地演示与测试的可观测出口。
    `CREATE TABLE IF NOT EXISTS mail_outbox (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS mail_outbox_to ON mail_outbox(to_email, created_at DESC)`,
  ];
}

/** v2 给既有表补的列。新库在 CREATE 语句里已包含，这里只服务升级路径。 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'principals', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'principals', column: 'handle', definition: 'TEXT' },
  { table: 'tasks', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'tasks', column: 'origin_principal_id', definition: 'TEXT' },
  { table: 'tasks', column: 'adopted_at', definition: 'TEXT' },
  { table: 'principals', column: 'account_id', definition: 'TEXT' },
  { table: 'principals', column: 'tenant_role', definition: "TEXT NOT NULL DEFAULT 'member'" },
  // v4 个人资料。老主体保持空值，展示时回落到姓名首字或 DID handle。
  { table: 'principals', column: 'avatar', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'principals', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'principals', column: 'bio', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'avatar', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'bio', definition: "TEXT NOT NULL DEFAULT ''" },
];

export const SCHEMA_VERSION = 6;

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
    // v3 升级回填：老库没有 tenant_role，默认值 'member' 会让原来的管理员
    // 突然管不了成员。按既有能力角色把管理员补回来；每个租户保证有一个所有者。
    await tx.run(
      `UPDATE principals SET tenant_role = 'admin'
       WHERE tenant_role = 'member' AND roles LIKE '%"admin"%'`,
    );
    const orphans = await tx.all<{ workspace: string }>(
      `SELECT workspace FROM principals
       WHERE active = 1
       GROUP BY workspace
       HAVING SUM(CASE WHEN tenant_role = 'owner' THEN 1 ELSE 0 END) = 0`,
    );
    for (const orphan of orphans) {
      const candidate = await tx.one<{ id: string }>(
        `SELECT id FROM principals
         WHERE workspace = :workspace AND active = 1
         ORDER BY CASE WHEN roles LIKE '%"admin"%' THEN 0 ELSE 1 END, created_at, id
         LIMIT 1`,
        { workspace: String(orphan.workspace) },
      );
      if (candidate) {
        await tx.run(`UPDATE principals SET tenant_role = 'owner' WHERE id = :id`, {
          id: String(candidate.id),
        });
      }
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
