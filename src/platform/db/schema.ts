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
 *  - v7 知识文档与任务房间。
 *  - v8 AICD 视为普通文档：默认 kind=document，版本有效期可空。
 *  - v9 本地对象存储：文件可以脱离任务，上传分三步（申请、直传、确认）。
 *  - v10 房间已读游标：未读按每人每任务记录，不改变任务版本。
 *  - v11 任务归档：归档只加时间戳，不改状态，也不删版本与文件。
 *  - v12 任务参与人与智能体协商：人先入队并选定智能体，分工再由智能体之间协商。
 *
 * 补列必须先于事务探测（只读连接看不到未提交的 DDL），
 * 因此 `ensureColumns` 在事务外查现有列，事务内只做 CREATE 与 ALTER。
 */

import { createHash } from 'node:crypto';

import type { Database, Queryable } from './driver.ts';

const MIGRATION_LOCK = 190106;

/**
 * knowledge 的完整结构。
 *
 * v7 把 `task_id` 放宽为可空（手动经验不绑任务），SQLite 只能靠重建表
 * 才能去掉 NOT NULL，所以这份 DDL 同时服务新库与重建路径，避免两处漂移。
 */
const KNOWLEDGE_TABLE = `CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      content TEXT NOT NULL,
      conditions TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      reviewer_id TEXT,
      expires_at TEXT,
      access_mode TEXT NOT NULL DEFAULT 'restricted',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'document',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'task',
      evidence_level TEXT NOT NULL DEFAULT 'task_verified',
      archived_at TEXT
    )`;

const KNOWLEDGE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS knowledge_workspace_state ON knowledge(workspace, state, expires_at)',
];

/**
 * 发布快照。AICD 是普通文档，expires_at 可空——没有有效期并不等于永久有效，
 * 只是不按时间自动失效；撤销与归档仍然由人决定。
 */
const KNOWLEDGE_VERSIONS_TABLE = `CREATE TABLE IF NOT EXISTS knowledge_versions (
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      conditions TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      expires_at TEXT,
      published_at TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (knowledge_id, version)
    )`;

/**
 * v9：文件不再必须属于任务。AICD 附件可以先独立上传，再挂到文档上。
 * SQLite 只能重建表来去掉 `task_id NOT NULL`，因此这份 DDL 同时服务新库与重建。
 */
const SPACE_FILES_TABLE = `CREATE TABLE IF NOT EXISTS space_files (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      subtask_id TEXT REFERENCES subtasks(id),
      message_id TEXT REFERENCES task_comments(id),
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage TEXT NOT NULL DEFAULT 'inline',
      object_key TEXT NOT NULL,
      data TEXT,
      kind TEXT NOT NULL DEFAULT 'intermediate',
      version INTEGER NOT NULL DEFAULT 1,
      supersedes_id TEXT,
      produced_by TEXT NOT NULL REFERENCES principals(id),
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )`;

const SPACE_FILES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS space_files_task ON space_files(task_id, created_at DESC, id)',
  'CREATE INDEX IF NOT EXISTS space_files_hash ON space_files(workspace, sha256)',
];

/** 依赖 v7 新列的索引必须等补列之后再做：升级库里这些列此刻还不存在，
 * 提前执行会让整次迁移失败。
 */
const POST_COLUMN_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS knowledge_workspace_kind ON knowledge(workspace, kind, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS task_comments_thread ON task_comments(thread_id, created_at)',
];

/** 重建 knowledge 时，从更老的库读缺失列所用的默认值。 */
const LEGACY_KNOWLEDGE_DEFAULTS: Record<string, string> = {
  reviewer_id: 'NULL',
  expires_at: 'NULL',
  access_mode: "'restricted'",
  kind: "'document'",
  title: "''",
  summary: "''",
  tags: "'[]'",
  source: "'task'",
  evidence_level: "'task_verified'",
  archived_at: 'NULL',
};

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
      archived_at TEXT,
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

    // ---- 知识 / 经验 ----
    KNOWLEDGE_TABLE,
    ...KNOWLEDGE_INDEXES,

    KNOWLEDGE_VERSIONS_TABLE,

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
    `CREATE INDEX IF NOT EXISTS audit_workspace_time ON audit(workspace, recorded_at)`,

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
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      thread_id TEXT,
      reply_to TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      edited_at TEXT
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

    // ---- v7：任务房间 ----
    // 线程是房间里的一等对象；消息仍落在 task_comments，靠 thread_id 归档。
    `CREATE TABLE IF NOT EXISTS task_threads (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_by TEXT NOT NULL REFERENCES principals(id),
      assignee_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS task_threads_open ON task_threads(task_id, status, created_at DESC)`,

    // 房间已读游标：只影响"未读"计数，不推进任务版本，也不产生事件。
    `CREATE TABLE IF NOT EXISTS task_reads (
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      principal_id TEXT NOT NULL REFERENCES principals(id),
      last_read_at TEXT NOT NULL,
      PRIMARY KEY (task_id, principal_id)
    )`,

    // 团队空间文件。内联 base64 仍保留给小文件；更大的文件走对象存储，
    // 同团队同一份内容只保留一个对象。
    SPACE_FILES_TABLE,
    ...SPACE_FILES_INDEXES,

    `CREATE TABLE IF NOT EXISTS space_objects (
      workspace TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      storage TEXT NOT NULL,
      size INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (workspace, sha256, storage)
    )`,
    `CREATE INDEX IF NOT EXISTS space_objects_key ON space_objects(object_key)`,

    // 上传会话：申请地址时确定元数据，PUT 只搬字节，确认时才产生文件记录。
    `CREATE TABLE IF NOT EXISTS space_uploads (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER,
      sha256 TEXT,
      storage TEXT NOT NULL,
      object_key TEXT,
      kind TEXT NOT NULL DEFAULT 'intermediate',
      task_id TEXT REFERENCES tasks(id),
      subtask_id TEXT,
      message_id TEXT,
      supersedes_id TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_file_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS space_uploads_expiry ON space_uploads(status, expires_at)`,

    `CREATE TABLE IF NOT EXISTS knowledge_assets (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      file_id TEXT NOT NULL REFERENCES space_files(id),
      role TEXT NOT NULL DEFAULT 'evidence',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_assets_file ON knowledge_assets(file_id)`,
    `CREATE INDEX IF NOT EXISTS knowledge_assets_target ON knowledge_assets(knowledge_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS knowledge_usage (
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      version INTEGER NOT NULL,
      used_at TEXT NOT NULL,
      PRIMARY KEY (knowledge_id, task_id, version)
    )`,

    // 复制来源链：child 是副本，parent 是被复制的那一版。
    `CREATE TABLE IF NOT EXISTS knowledge_lineage (
      child_id TEXT PRIMARY KEY REFERENCES knowledge(id),
      parent_id TEXT NOT NULL REFERENCES knowledge(id),
      parent_version INTEGER NOT NULL,
      root_id TEXT NOT NULL REFERENCES knowledge(id),
      source_workspace TEXT NOT NULL,
      target_workspace TEXT NOT NULL,
      copied_by TEXT NOT NULL REFERENCES principals(id),
      copied_at TEXT NOT NULL,
      include_assets INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_lineage_parent ON knowledge_lineage(parent_id, parent_version)`,

    // 复制给他人：对方接受后才真正落库。
    `CREATE TABLE IF NOT EXISTS knowledge_copy_invites (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      version INTEGER NOT NULL,
      from_principal TEXT NOT NULL REFERENCES principals(id),
      target_principal TEXT NOT NULL REFERENCES principals(id),
      target_workspace TEXT NOT NULL REFERENCES tenants(id),
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      accepted_knowledge_id TEXT REFERENCES knowledge(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_copy_invites_target
       ON knowledge_copy_invites(target_principal, status, created_at)`,

    //经验审计：手动经验没有任务事件流，动作单独记在这里。
    `CREATE TABLE IF NOT EXISTS knowledge_events (
      seq ${seq},
      id TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL,
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS knowledge_events_target ON knowledge_events(knowledge_id, seq)`,

    // ---- v12：任务参与人与智能体协商 ----
    // 参与人是"人"：任务发起人邀请的是人，被邀请人接受时再选定自己的一个智能体。
    // 同一个人在同一个任务里只有一条参与记录，换智能体改 agent_id 即可。
    `CREATE TABLE IF NOT EXISTS task_participants (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      workspace TEXT NOT NULL,
      human_principal_id TEXT NOT NULL REFERENCES principals(id),
      account_id TEXT NOT NULL,
      invited_by TEXT NOT NULL REFERENCES principals(id),
      status TEXT NOT NULL DEFAULT 'invited',
      agent_id TEXT REFERENCES principals(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      responded_at TEXT,
      UNIQUE (task_id, human_principal_id)
    )`,
    `CREATE INDEX IF NOT EXISTS task_participants_invitee
       ON task_participants(human_principal_id, status, created_at)`,

    // 协商请求：委托协调者（role=coordinate）与分配子任务（role=subtask）
    // 走同一张表，因为两者都是"一个主体把一段工作交给另一个主体"。
    // 接受时 role 决定落成协调者还是子任务；还价通过 counter 暂存，发起方确认后才落库。
    `CREATE TABLE IF NOT EXISTS task_requests (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      from_principal TEXT NOT NULL REFERENCES principals(id),
      to_principal TEXT NOT NULL REFERENCES principals(id),
      role TEXT NOT NULL,
      payload TEXT NOT NULL,
      counter TEXT,
      response_note TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      subtask_id TEXT REFERENCES subtasks(id),
      created_at TEXT NOT NULL,
      responded_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS task_requests_inbox
       ON task_requests(to_principal, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS task_requests_outbox
       ON task_requests(from_principal, status, created_at)`,
  ];
}

/** v2 给既有表补的列。新库在 CREATE 语句里已包含，这里只服务升级路径。 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'principals', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'principals', column: 'handle', definition: 'TEXT' },
  { table: 'tasks', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'human'" },
  { table: 'tasks', column: 'origin_principal_id', definition: 'TEXT' },
  { table: 'tasks', column: 'adopted_at', definition: 'TEXT' },
  { table: 'tasks', column: 'archived_at', definition: 'TEXT' },
  { table: 'principals', column: 'account_id', definition: 'TEXT' },
  { table: 'principals', column: 'tenant_role', definition: "TEXT NOT NULL DEFAULT 'member'" },
  // v4 个人资料。老主体保持空值，展示时回落到姓名首字或 DID handle。
  { table: 'principals', column: 'avatar', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'principals', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'principals', column: 'bio', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'avatar', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'accounts', column: 'bio', definition: "TEXT NOT NULL DEFAULT ''" },
  // v8 文档：旧条目保留原有 kind 语义，新条目默认通用文档。
  { table: 'knowledge', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'document'" },
  { table: 'knowledge', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'knowledge', column: 'summary', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'knowledge', column: 'tags', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'knowledge', column: 'source', definition: "TEXT NOT NULL DEFAULT 'task'" },
  { table: 'knowledge', column: 'evidence_level', definition: "TEXT NOT NULL DEFAULT 'task_verified'" },
  { table: 'knowledge', column: 'archived_at', definition: 'TEXT' },
  { table: 'knowledge_versions', column: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'knowledge_versions', column: 'summary', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'knowledge_versions', column: 'tags', definition: "TEXT NOT NULL DEFAULT '[]'" },
  // v7 任务房间：评论带类型与线程，才能承载提问、交接与决定。
  { table: 'task_comments', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'comment'" },
  { table: 'task_comments', column: 'thread_id', definition: 'TEXT' },
  { table: 'task_comments', column: 'reply_to', definition: 'TEXT' },
  { table: 'task_comments', column: 'payload', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'task_comments', column: 'edited_at', definition: 'TEXT' },
  // v12 协作请求：回应时带一句说明，拒绝与还价都能留下原因。
  { table: 'task_requests', column: 'response_note', definition: 'TEXT' },
];

export const SCHEMA_VERSION = 12;

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
 * SQLite 不支持 `ALTER COLUMN ... DROP NOT NULL`，只能重建 knowledge。
 * 返回 true 表示老表把 task_id 钉死了，或者干脆没有这一列。
 */
async function sqliteNeedsKnowledgeRebuild(db: Database): Promise<boolean> {
  const rows = await db.read.all<{ name: string; notnull: number }>('PRAGMA table_info(knowledge)');
  if (rows.length === 0) return false;
  const taskId = rows.find(row => String(row.name) === 'task_id');
  return !taskId || Number(taskId.notnull) === 1;
}

/**
 * 重建时子表（versions / grants / refs / shares / assets）的 FK 仍指向
 * `knowledge`。legacy_alter_table 让 RENAME 不重写这些引用，foreign_keys=OFF
 * 让 DROP 旧表不触发级联删除。两个 PRAGMA 都必须在事务外设置。
 */
async function rebuildSqliteKnowledge(tx: Queryable): Promise<void> {
  const columns = new Set(
    (await tx.all<{ name: string }>('PRAGMA table_info(knowledge)')).map(row => String(row.name)),
  );
  const target = [
    'id',
    'workspace',
    'task_id',
    'content',
    'conditions',
    'state',
    'version',
    'author_id',
    'reviewer_id',
    'expires_at',
    'access_mode',
    'created_at',
    'updated_at',
    'kind',
    'title',
    'summary',
    'tags',
    'source',
    'evidence_level',
    'archived_at',
  ];
  const values = target.map(column =>
    columns.has(column) ? column : (LEGACY_KNOWLEDGE_DEFAULTS[column] ?? 'NULL'),
  );
  await tx.run('ALTER TABLE knowledge RENAME TO knowledge_v6_rebuild');
  await tx.run(KNOWLEDGE_TABLE);
  await tx.run(
    `INSERT INTO knowledge (${target.join(', ')}) SELECT ${values.join(', ')} FROM knowledge_v6_rebuild`,
  );
  await tx.run('DROP TABLE knowledge_v6_rebuild');
  for (const statement of KNOWLEDGE_INDEXES) await tx.run(statement);
}

async function postgresTaskIdNullable(db: Database): Promise<boolean> {
  const row = await db.read.one<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'knowledge' AND column_name = 'task_id'`,
  );
  return !row || String(row.is_nullable) === 'YES';
}

/**
 * v8：知识条目已经允许没有有效期，但 SQLite 改不了列约束，
 * 旧库的 knowledge_versions.expires_at NOT NULL 只能靠重建去掉。
 */
async function sqliteNeedsVersionsRebuild(db: Database): Promise<boolean> {
  const rows = await db.read.all<{ name: string; notnull: number }>('PRAGMA table_info(knowledge_versions)');
  if (rows.length === 0) return false;
  const expiresAt = rows.find(row => String(row.name) === 'expires_at');
  return !expiresAt || Number(expiresAt.notnull) === 1;
}

async function rebuildSqliteKnowledgeVersions(tx: Queryable): Promise<void> {
  await tx.run('ALTER TABLE knowledge_versions RENAME TO knowledge_versions_v7_rebuild');
  await tx.run(KNOWLEDGE_VERSIONS_TABLE);
  await tx.run(
    `INSERT INTO knowledge_versions(knowledge_id, version, content, conditions, reviewer_id,
                                    expires_at, published_at, title, summary, tags)
     SELECT knowledge_id, version, content, conditions, reviewer_id,
            expires_at, published_at, title, summary, tags
     FROM knowledge_versions_v7_rebuild`,
  );
  await tx.run('DROP TABLE knowledge_versions_v7_rebuild');
}

async function postgresVersionsExpiryNullable(db: Database): Promise<boolean> {
  const row = await db.read.one<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'knowledge_versions'
       AND column_name = 'expires_at'`,
  );
  return !row || String(row.is_nullable) === 'YES';
}

/** v9：space_files.task_id 允许为空，独立附件不再伪造一个任务。 */
async function sqliteNeedsSpaceFilesRebuild(db: Database): Promise<boolean> {
  const rows = await db.read.all<{ name: string; notnull: number }>('PRAGMA table_info(space_files)');
  if (rows.length === 0) return false;
  const taskId = rows.find(row => String(row.name) === 'task_id');
  return !taskId || Number(taskId.notnull) === 1;
}

async function rebuildSqliteSpaceFiles(tx: Queryable): Promise<void> {
  await tx.run('ALTER TABLE space_files RENAME TO space_files_v8_rebuild');
  await tx.run(SPACE_FILES_TABLE);
  await tx.run(
    `INSERT INTO space_files(id, workspace, task_id, subtask_id, message_id, name, mime, size, sha256,
                             storage, object_key, data, kind, version, supersedes_id, produced_by,
                             source, status, created_at, deleted_at)
     SELECT id, workspace, task_id, subtask_id, message_id, name, mime, size, sha256,
            storage, object_key, data, kind, version, supersedes_id, produced_by,
            source, status, created_at, deleted_at
     FROM space_files_v8_rebuild`,
  );
  await tx.run('DROP TABLE space_files_v8_rebuild');
  for (const statement of SPACE_FILES_INDEXES) await tx.run(statement);
}

async function postgresSpaceFilesTaskNullable(db: Database): Promise<boolean> {
  const row = await db.read.one<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'space_files' AND column_name = 'task_id'`,
  );
  return !row || String(row.is_nullable) === 'YES';
}

/** v7 回填：把旧 task_materials 搬进 space_files，字节不丢、来源可追。 */
async function backfillSpaceFiles(tx: Queryable): Promise<void> {
  const rows = await tx.all<Record<string, unknown>>(
    `SELECT m.*, t.workspace AS workspace FROM task_materials m JOIN tasks t ON t.id = m.task_id`,
  );
  for (const row of rows) {
    const id = `sf_${String(row.id)}`;
    const exists = await tx.one('SELECT 1 AS present FROM space_files WHERE id = :id', { id });
    if (exists) continue;
    const data = String(row.data ?? '');
    const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    await tx.run(
      `INSERT INTO space_files(id, workspace, task_id, subtask_id, message_id, name, mime, size, sha256,
                               storage, object_key, data, kind, version, supersedes_id, produced_by,
                               source, status, created_at, deleted_at)
       VALUES(:id, :workspace, :taskId, NULL, NULL, :name, :mime, :size, :sha256,
              'inline', :objectKey, :data, 'input', 1, NULL, :producedBy,
              'human_upload', 'ready', :createdAt, NULL)`,
      {
        id,
        workspace: String(row.workspace),
        taskId: String(row.task_id),
        name: String(row.name),
        mime: String(row.mime),
        size: Number(row.size),
        sha256,
        objectKey: `inline:${sha256}`,
        data,
        producedBy: String(row.uploaded_by),
        createdAt: String(row.created_at),
      },
    );
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
  const rebuildKnowledge = db.dialect === 'sqlite' && (await sqliteNeedsKnowledgeRebuild(db));
  const rebuildVersions = db.dialect === 'sqlite' && (await sqliteNeedsVersionsRebuild(db));
  const rebuildSpaceFiles = db.dialect === 'sqlite' && (await sqliteNeedsSpaceFilesRebuild(db));
  const dropNotNull = db.dialect === 'postgres' && !(await postgresTaskIdNullable(db));
  const dropVersionsNotNull = db.dialect === 'postgres' && !(await postgresVersionsExpiryNullable(db));
  const dropSpaceFilesNotNull = db.dialect === 'postgres' && !(await postgresSpaceFilesTaskNullable(db));

  if (db.dialect === 'sqlite') {
    await db.exec('PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF');
  }
  try {
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
      if (dropNotNull) {
        await tx.run('ALTER TABLE knowledge ALTER COLUMN task_id DROP NOT NULL');
      }
      if (dropVersionsNotNull) {
        await tx.run('ALTER TABLE knowledge_versions ALTER COLUMN expires_at DROP NOT NULL');
      }
      if (dropSpaceFilesNotNull) {
        await tx.run('ALTER TABLE space_files ALTER COLUMN task_id DROP NOT NULL');
      }
      if (db.dialect === 'postgres') {
        await tx.run("ALTER TABLE knowledge ALTER COLUMN kind SET DEFAULT 'document'");
      }
      if (rebuildKnowledge) await rebuildSqliteKnowledge(tx);
      if (rebuildVersions) await rebuildSqliteKnowledgeVersions(tx);
      if (rebuildSpaceFiles) await rebuildSqliteSpaceFiles(tx);
      for (const statement of POST_COLUMN_STATEMENTS) {
        await tx.run(statement);
      }
      // v7 回填：旧条目没有标题时，用正文开头补一个，列表不至于全是空白。
      await tx.run(`UPDATE knowledge SET title = substr(content, 1, 60) WHERE title = ''`);
      await tx.run(
        `UPDATE knowledge_versions SET title = (
           SELECT k.title FROM knowledge k WHERE k.id = knowledge_versions.knowledge_id
         ) WHERE title = ''`,
      );
      await backfillSpaceFiles(tx);
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
  } finally {
    if (db.dialect === 'sqlite') {
      await db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON');
    }
  }
  if (db.dialect === 'sqlite' && (rebuildKnowledge || rebuildVersions || rebuildSpaceFiles)) {
    const broken = await db.read.all<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (broken.length > 0) {
      throw new Error(`knowledge 重建后存在外键不一致：${JSON.stringify(broken.slice(0, 5))}`);
    }
  }
}
