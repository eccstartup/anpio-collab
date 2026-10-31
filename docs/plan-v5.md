# 第五轮设计：经验文档资产与团队空间

状态：第一阶段已实施（2026-10-31）｜日期：2026-10-31｜承接 [plan-v4.md](plan-v4.md)｜实现记录见 [implementation-status.md](implementation-status.md)

本轮回答两个问题：

1. **经验是独立文档，不是任务验收的副产品**：人可以手动新建、编辑、删除、发布、修订、归档一份经验；智能体仍然只能提交候选，发布权留在人手里。
2. **经验可以复制到团队或个人**：分享是只读实时链接，复制是独立快照；两者分开，来源撤销不会误伤团队里的副本，团队经验也不会被悄悄带出团队。
3. **团队需要一个"任务房间"**：每个任务的进展、智能体之间通过平台说的话、以及过程中产生的文件，都按任务保存下来，人能看、智能体能续接、经验能从里面长出来。

> **名词说明**：AICD 是平台里的**普通文档**：一条记录可以新建、读取、编辑、删除、发布、修订、归档、复制与分享。默认 `kind=document`；`experience/playbook/checklist/decision/report/handoff` 只是可选的用途标签，不附带额外的必填条件或过期规则。长期有效的文档不必设置有效期。若你原本指的是 AIGC（生成内容），数据模型不变，只是增加 `kind=image/video/report`，发布与权限链路完全复用。

---

## 1. 现状与缺口

| 已有 | 位置 | 缺口 |
| --- | --- | --- |
| 任务事件流，单调 `seq`，每次写操作推进 `tasks.version` | `events`、`services/events.ts` | 只服务任务状态，不是"团队空间"的阅读模型 |
| 评论 + `@` 提及，人与人、人与智能体共用 | `task_comments`、`task_mentions` | 没有线程、没有消息类型、没有智能体之间的结构化交接 |
| 任务材料，base64 存库，最多 5 个 / 单个 1 MiB | `task_materials`、`services/materials.ts` | 只能建任务时上传；不能作为中间产物反复追加；不适合大文件 |
| 知识条目（经验库前身）：候选 → 审核 → 发布 → 修订 / 撤销，版本、范围、分享、引用 | `knowledge` 系列表、`services/knowledge.ts` | 必须挂在任务上（`task_id NOT NULL`）；不能手动新建；没有标题/标签/摘要；没有归档态 |
| 任务恢复上下文 | `GET /v1/tasks/:id/context` | 有摘要与最近事件，但没有对话、文件清单与"交接包" |

结论：底层零件都在，缺的是**以任务为容器的统一空间**，以及**不依赖任务的经验手动发布链路**。

---

## 2. 先把词定死

| 概念 | 定义 | 存在范围 |
| --- | --- | --- |
| AICD 文档 | 一份可发布、可引用、可版本化的普通文档；做法、清单、决策记录都只是可选 `kind` | 租户，可复制到个人空间 |
| AICD 列表 | 控制台入口：新建、读取、编辑、删除、发布、复制、归档文档 | 个人空间 / 团队 |
| 团队空间 | 团队租户内所有任务房间的集合；不是网盘目录树 | 租户 |
| 任务房间 | 一个任务的概览、进展、对话、文件、相关经验的统一视图 | 任务 |
| 对话 | 平台内留下的消息流；人、智能体、系统共用一张表，用 `kind` 区分 | 任务 |
| 中间文件 | 智能体或人在任务过程中产生/接收的文件，带来源、版本、哈希 | 任务 |

**不新增第二套权限系统。** 空间可见性仍由 `tenant + principal + agent grant scope` 决定；经验的跨团队可见性只走 `knowledge_shares`（只读实时），跨空间搬运只走"复制"（独立副本；目标团队由用户选择，复制到他人个人空间需对方接受）。

---

## 3. 经验：从"任务副产品"变成"可管理的资产"

### 3.1 生命周期

```text
                 人（个人空间本人 / 团队审核人）
                 ┌──────────────────────────────┐
                 │                              ▼
  draft ──────► candidate ──审核发布──► published ──归档──► archived
    │                │                     │
    │                │                     ├──修订──► draft (version + 1)
    │                │                     └──撤销──► revoked
    │                │
    └──手动发布──────┘（仅限有发布权的人；personal 本人 / reviewer / admin）
```

规则：

- **草稿不产生版本**；发布时写 `knowledge_versions` 快照。修订生成 `version + 1` 的草稿，重新审核前不再对外返回。
- **`archived` 是正常退休**，内容仍可被历史引用追溯；**`revoked` 是判定为错误/有害**，检索与引用立即失效，但证据包仍可审计。两者分开，避免"下架"和"作废"混为一谈。
- **`source` 记录来路**：`task`（任务验收后沉淀）、`manual`（人手动新建）、`agent`（智能体候选）。UI 用徽标显示，不把三者混成同一种可信度。
- **`evidence_level`**：`task_verified`（来自已验收任务）/ `manual`（人工编写）/ `imported`（外部导入）。手动经验允许发布，但必须显示"未经过任务验收"。

### 3.2 手动发布与管理

| 动作 | 谁能做 | 结果 |
| --- | --- | --- |
| 新建草稿 | 任何非访客成员；智能体只能建 `source=agent` 草稿 | `draft`，可关联任务，也可完全不关联 |
| 编辑草稿 | 作者本人；审核人/管理员可编辑任何草稿 | 不产生版本 |
| 提交审核 | 作者 | `candidate`，进入审核列表 |
| 直接发布 | 个人空间本人；团队 `reviewer` / `admin` | `published`，写版本快照 |
| 审核发布 | 团队 `reviewer` / `admin` | `published` |
| 修订 | 有发布权的人 | 新版本草稿，重新走审核 |
| 归档 | 作者或审核人 | `archived`，保留历史 |
| 撤销 | 审核人 / 管理员 | `revoked`，检索与引用失效 |
| 调整范围 / 分享 | 来源空间里有管理权的人 | `workspace` / 指定主体 / 分享到团队 |
| 复制到团队 | 有复制权的人；目标团队必须是其正常团队 | 在目标团队生成独立草稿 |
| 复制给他人 | 有复制权的人；目标成员接受后生效 | 在对方个人空间生成独立草稿 |

**智能体永远不能发布。** 它可以把对话、文件、子任务结果整理成 `source=agent` 的候选，但 `publish` 接口对 `kind=agent` 一律 403。沿用现有 `createCandidate` 的边界，只是放宽"必须来自已验收任务"这一条：手动经验不要求任务。

### 3.3 分享、引用与复制：三种关系，不能混

用户说"经验应该可以复制到他人或者所在的团队里"。这句话必须和现有的"分享"分开，否则会出现"来源一撤销，团队里的副本也没了"或"团队经验被悄悄带出去"的争议。

| 关系 | 语义 | 源修订后 | 源撤销后 | 管理权 |
| --- | --- | --- | --- | --- |
| **引用** `reference` | 任务钉住某个版本作为依据 | 不受影响，仍读快照 | 仍可审计当时依据 | 来源空间 |
| **分享** `share` | 目标团队获得只读、实时的访问 | 目标看到新版本 | 目标立即失去访问 | 来源空间 |
| **复制** `copy` | 在目标空间生成一份独立快照 | 副本不变 | 副本保留，但标注"来源已撤销" | 目标空间 |

复制是**快照分支（fork）**，不是链接。复制完成后：

- 目标空间拥有这份经验的完整管理权：可改、可发布、可修订、可再分享给目标团队内的其他人；
- 来源的后续修订不会自动同步；需要同步时重新复制一次，或改用"分享"；
- 来源撤销不会删除副本，但副本详情必须显示"来源已撤销"，并提示目标审核人复核；
- 副本保留来源链：`copied_from_id`、`copied_from_version`、`source_workspace`、`copied_by`、`copied_at`，以及最初的 `root_knowledge_id`，避免"复制自副本"之后追溯断掉。

#### 谁能复制到哪里

| 来源 | 可复制到 | 条件 |
| --- | --- | --- |
| 个人经验 | 作者加入的团队 | 只有作者本人可以复制；在对话框里选择目标团队 |
| 个人经验 | 同租户他人的个人空间 | 作者发起，目标成员**接受**后落库；不能跨租户 |
| 团队经验 | 用户加入的团队 | 对来源有读权限的成员；可选当前团队或其他已加入的团队 |
| 已复制的经验 | 同左 | 副本是独立条目，复制规则与普通经验相同 |

没有复制策略字段：是否复制由用户在条目上的操作决定——选择目标团队并确认，或直接取消。前提是来源已发布、未过期、复制人对来源有读权限，且是目标团队成员。

**复制给他人为什么需要接受**：个人空间不是收件箱。未经同意的内容直接落进别人的空间，既侵犯边界，也会让"我的经验"变成"别人塞给我的经验"。复制邀请走通知与待办，拒绝不产生数据。

#### 复制时复制什么

- 正文、标题、摘要、适用条件、标签、`kind`、`evidence_level`；
- 版本快照（`knowledge_versions` 中对应版本），保证副本从第一天起可追溯；
- 附件：默认复制；若复制者无权读取某个附件，则跳过并在副本上标注"附件未随复制"；附件在副本里重新登记归属，字节按 sha256 去重，来源删除后副本仍可下载；
- 不复制：来源的分享集合、引用记录、审核意见、使用统计。副本从 `draft` 开始，按目标空间的规则重新发布。

**副本进入目标空间后仍是草稿。** 即使复制者在来源空间有发布权，也不能让副本绕过目标空间的审核；如果复制者在目标空间恰好有发布权，UI 可以提供"复制并发布"一步完成，但服务端仍按目标空间权限判断。

### 3.4 内容结构

一份经验至少包含：

| 字段 | 说明 |
| --- | --- |
| `title` | 一句话标题，列表与检索首先看它 |
| `summary` | 80–200 字摘要，给人和智能体快速判断 |
| `content` | 正文；任何 kind 都只是文档内容，不强制"做法 + 结论"结构 |
| `conditions` | 可选的适用范围说明；不要求任何 kind 必填 |
| `expires_at` | 可选的有效期；为空表示不按时间自动失效，仍需人撤销或归档 |
| `tags` | 最多 10 个，用于筛选 |
| `kind` | `document / experience / playbook / checklist / decision / report / handoff`，默认 `document` |
| `attachments` | 截图、日志、数据文件，走团队空间的文件存储 |
| `source_task_id` | 可空；手动文档不绑任务 |
| `evidence_level` | 见上 |

### 3.5 数据模型（schema v8）

现有 `knowledge` 表做**增量改造**，不另起一套：

```sql
-- knowledge 增加
ALTER knowledge ADD COLUMN kind TEXT NOT NULL DEFAULT 'document';
ALTER knowledge ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER knowledge ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER knowledge ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';       -- JSON 数组
ALTER knowledge ADD COLUMN source TEXT NOT NULL DEFAULT 'task';   -- task | manual | agent
ALTER knowledge ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'task_verified';
ALTER knowledge ADD COLUMN archived_at TEXT;

-- task_id 改为可空（SQLite 需要重建表；PostgreSQL 直接 DROP NOT NULL）
-- knowledge_versions.expires_at 也改为可空（v8；SQLite 同样重建表）
-- 迁移步骤：建新表 → 复制 → 校验行数 → 换名 → 重建索引。
```

新增：

```sql
CREATE TABLE knowledge_assets (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
  file_id TEXT NOT NULL REFERENCES space_files(id),
  role TEXT NOT NULL DEFAULT 'evidence',   -- evidence | attachment
  created_at TEXT NOT NULL
);

CREATE TABLE knowledge_usage (
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, task_id, version)
);

-- 复制来源链：child 是副本，parent 是被复制的那一版。
CREATE TABLE knowledge_lineage (
  child_id TEXT PRIMARY KEY REFERENCES knowledge(id),
  parent_id TEXT NOT NULL REFERENCES knowledge(id),
  parent_version INTEGER NOT NULL,
  root_id TEXT NOT NULL REFERENCES knowledge(id),
  source_workspace TEXT NOT NULL,
  target_workspace TEXT NOT NULL,
  copied_by TEXT NOT NULL REFERENCES principals(id),
  copied_at TEXT NOT NULL,
  include_assets INTEGER NOT NULL DEFAULT 1,
  UNIQUE (child_id)
);
CREATE INDEX knowledge_lineage_parent ON knowledge_lineage(parent_id, parent_version);

-- 复制给他人：对方接受后才真正落库。
CREATE TABLE knowledge_copy_invites (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
  version INTEGER NOT NULL,
  from_principal TEXT NOT NULL REFERENCES principals(id),
  target_principal TEXT NOT NULL REFERENCES principals(id),
  target_workspace TEXT NOT NULL REFERENCES tenants(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | expired
  accepted_knowledge_id TEXT REFERENCES knowledge(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX knowledge_copy_invites_target ON knowledge_copy_invites(target_principal, status, created_at);
```

去重：同一目标空间里，`parent_id + parent_version` 只允许一个副本；重复复制返回已有副本而不是再建一份（幂等）。

版本表补 `title / summary / tags`，保证修订后仍能还原"当时发布的是什么"。

### 3.6 接口

```text
GET    /v1/aicds?q=&state=&kind=&scope=         列表；分页
POST   /v1/aicds                                新建草稿；kind 默认 document
GET    /v1/aicds/:id                            详情（含来源、附件、复制关系）
POST   /v1/aicds/:id                            更新草稿（If-Match；/edit 同义）
POST   /v1/aicds/:id/submit                     草稿 → 候选
POST   /v1/aicds/:id/publish                    { expiresAt?, audience?, evidenceLevel? }
POST   /v1/aicds/:id/revise                     生成新版本候选
POST   /v1/aicds/:id/archive                    归档
POST   /v1/aicds/:id/revoke                     { reason }
POST   /v1/aicds/:id/access                     调整共享范围
GET    /v1/aicds/:id/versions                   版本历史（含 diff 所需字段）
GET    /v1/aicds/:id/evidence                   当前有效版本的证据包
POST   /v1/aicds/:id/shares                     个人文档分享到团队（整单替换，只读实时）
GET    /v1/aicds/:id/shares                     已分享到的团队
POST   /v1/aicds/:id/copy                       { targetWorkspace }  立即在目标团队生成独立草稿
POST   /v1/aicds/:id/invite                     { targetPrincipal }  邀请他人复制到其个人空间
POST   /v1/aicds/:id/assets                     绑定团队空间文件
GET    /v1/aicds/:id/usage                      被哪些任务引用、引用的是哪一版
GET    /v1/aicds/:id/copies                     被复制到哪些空间（来源空间可见）
GET    /v1/aicds/:id/lineage                    来源链（副本详情里也能看）
GET    /v1/me/copy-invites                      别人复制给我的文档邀请
POST   /v1/me/copy-invites/:id/accept           接受后落为目标个人空间的草稿
POST   /v1/me/copy-invites/:id/decline          拒绝，不产生数据
```

兼容策略：`/v1/knowledge/*` 保留一个版本，内部转调文档服务；控制台与 SDK 先切到 `/v1/aicds`。这样老测试与老客户端不会一夜失效。

### 3.7 界面

知识库改成 **经验库**（控制台导航已直接改名经验）：

- 顶部：搜索、`kind` 筛选、标签、状态（草稿 / 待审核 / 已发布 / 已归档 / 已撤销）。
- 主区：卡片列表，显示标题、摘要、kind、来源徽标（任务验收 / 人工编写 / 智能体候选）、适用范围、有效期、引用次数。
- 右上：**新建经验**（手动发布入口）。
- 详情抽屉：正文、适用条件、附件、版本历史、来源链（复制自谁/哪一版；副本已被复制到哪里）、引用它的任务、分享范围、审计动作。
- 编辑器：标题 / 摘要 / 正文 / 适用条件 / 标签 / 附件 / 关联任务；右侧实时预览"智能体看到的证据包"。
- 发布对话框：范围（本团队 / 指定主体 / 仅自己）、有效期、是否声明"未经任务验收"。
- 详情页动作分成两组，避免混淆：
  - **分享**：只读实时访问，来源管理；用于"让团队看到"。
  - **复制到…**：生成独立副本；用于"把经验带到本团队或某个人的个人空间"。
- 复制对话框：目标（我的某个团队 / 我的个人空间 / 指定成员）、是否带附件、复制后状态（草稿；有发布权时可"复制并发布"）。对话框里用一句话解释："副本独立管理，来源后续修订不会自动同步。"
- 副本卡片带来源徽标：`复制自 张三 · 团队 A · v3`；来源撤销时显示黄色提示"来源已撤销，请复核"；点击可跳到来源（若有权限）。
- 来源详情显示"被复制到 N 个空间"，团队名可见；个人空间只显示数量，不暴露对方名字，兼顾审计与隐私。
- 收到复制邀请的人在"提醒/待办"里看到内容摘要与来源，接受后进入自己的经验草稿箱；拒绝不产生任何数据。

---

## 4. 团队空间：以任务为房间

### 4.1 空间模型

团队空间不是一棵目录树，而是：

```text
团队 (tenant)
└── 任务房间 (task room)
    ├── 概览：目标、验收条件、状态、负责人、参与者、当前阶段
    ├── 进展：事件时间线 + 子任务状态 + 阶段摘要
    ├── 对话：线程化消息，人 / 智能体 / 系统同流
    ├── 文件：输入、中间产物、最终成果、证据
    └── 经验：本任务产出或引用的经验
```

**任务就是容器。** 文件不单独建"项目文件夹"，而是挂在任务、子任务或某条消息上；需要跨任务复用时，把文件"提升"为经验附件或成果。

### 4.2 进展：不另造一张进度表

进度直接从现有事实推导：

- `events`：每次状态变更、提交、评论、经验动作；
- `subtasks`：各子任务状态与截止时间；
- `task_summaries`：当前阶段摘要与未决事项；
- `knowledge_refs`：本任务引用了哪些经验；
- `space_messages` / `space_files`：对话与文件的最近活动。

读取时合并成一条 **activity feed**，按时间排序，带 `type` 过滤。这样不会出现"进度表和事件流各说各话"。

### 4.3 智能体之间的对话

现有 `task_comments` 是扁平的。v7 做增量扩展：

```sql
ALTER task_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';
-- comment | question | answer | handoff | decision | status | system
ALTER task_comments ADD COLUMN thread_id TEXT;
ALTER task_comments ADD COLUMN reply_to TEXT;
ALTER task_comments ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';  -- 结构化字段
ALTER task_comments ADD COLUMN edited_at TEXT;

CREATE TABLE task_threads (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  opened_by TEXT NOT NULL REFERENCES principals(id),
  assignee_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX task_threads_open ON task_threads(task_id, status, created_at DESC);
```

消息类型不是装饰，决定 UI 与通知：

| kind | 用途 | `payload` 示例 |
| --- | --- | --- |
| `question` | 智能体卡住，向人或另一个智能体提问 | `{ to: ["agent:inventory"], blocking: true }` |
| `answer` | 回答某条问题 | `{ replyTo, confidence: "medium" }` |
| `handoff` | 把子任务/上下文交给另一个智能体 | `{ to, subtaskId, expectation, dueAt }` |
| `decision` | 记录一个决定及理由 | `{ decision, rationale, alternatives }` |
| `status` | 进度播报 | `{ percent, note }` |
| `system` | 平台生成（认领、超时、验收） | `{ eventId }` |

**智能体之间怎么"对话"**：在同一个任务房间内，A 发一条 `handoff` 或 `question`，`payload.to` 指向 B；B 的 `/v1/agent/inbox` 与房间未读里出现；B 用 `answer` 回复并 `reply_to`。平台不开放跨任务私聊，避免绕过任务边界。跨任务协作只能通过"引用经验 / 提升文件"完成。

**人怎么介入**：人可以在任何线程里发言、@ 智能体、把线程标记为 `decision` 或 `resolved`；也可以一键"接管"——把线程转成任务、子任务或候选经验。

### 4.4 中间文件

新增统一文件表，替代 `task_materials` 的"只能建任务时上传"：

```sql
CREATE TABLE space_files (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  subtask_id TEXT REFERENCES subtasks(id),
  message_id TEXT REFERENCES task_comments(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage TEXT NOT NULL,            -- inline | fs | s3
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'intermediate',  -- input | intermediate | output | evidence
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  produced_by TEXT NOT NULL REFERENCES principals(id),
  source TEXT NOT NULL,             -- human_upload | agent_upload | tool_output
  status TEXT NOT NULL DEFAULT 'ready',       -- pending | ready | quarantined | deleted
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX space_files_hash ON space_files(workspace, sha256);
CREATE INDEX space_files_task ON space_files(task_id, created_at DESC);
```

要点：

- **内容寻址**：同一团队内相同 `sha256` 只存一份对象；`space_files` 的元数据可以多行（不同文件名/版本），所以按 `(workspace, sha256)` 建普通索引，不建唯一索引。
- **来源可追**：每个文件都能回答"谁在哪个子任务/哪条消息里产生的"。
- **输入与成果分开**：`kind` 区分 `input / intermediate / output / evidence`；只有 `output` 可以被"提升"为文档附件或成果。
- **版本**：同名文件再次上传生成 `version + 1`，`supersedes_id` 指向旧行；旧版本不物理删除。
- **迁移**：v7 把 `task_materials` 复制进 `space_files`（`storage=inline`，`kind=input`），`materials.ts` 改为读新表；旧表保留一个版本用于回滚。

上传流程（本地优先，S3 可选）：

```text
1. POST /v1/space/files/upload-url  { taskId?, name, mime, size, sha256 }
   → 本地驱动：{ fileId, uploadUrl: "/v1/space/uploads/<一次性 token>", expiresAt }
   → S3 驱动：  { fileId, uploadUrl: <预签名 PUT>, expiresAt }
2. 客户端 PUT 到 uploadUrl（本地驱动也走同一个 PUT 契约，可流式接收）
3. POST /v1/space/files/:id/complete { sha256 }
   → { file }                                # 校验大小与哈希，置 ready
4. 发消息时带 fileIds，文件与消息同事务绑定
```

本地驱动默认开启，不需要任何云服务：字节写到 `COLLAB_BLOB_DIR/<workspace>/<sha256 前两位>/<sha256>`，
临时文件 + fsync + rename 原子落盘；元数据仍在 `space_files`（`storage='fs'`）。
`COLLAB_STORAGE=s3` 时才启用 S3/MinIO，并复用同一套 `upload-url → PUT → complete` 接口。
`storage=inline`（≤256 KiB）保留给演示与随库备份的极小文件。

### 4.5 权限

| 主体 | 团队空间 | 任务房间 | 对话 | 文件 | 经验 |
| --- | --- | --- | --- | --- | --- |
| 团队 `owner/admin/member` | 可读团队全部房间 | 可读 | 可读可写 | 可读；上传/删除按任务权限 | 草稿；发布需 reviewer/admin |
| `guest` | 不可见 | 不可见 | 不可见 | 不可见 | 不可见 |
| 智能体（有 grant） | 只看被指派/被提及的任务 | 只看自己的子任务与房间摘要 | 可读自己参与线程；可写 `question/answer/handoff/status` | 可读分配给自己的输入；可上传中间产物 | 只能提交候选 |
| 个人空间 | 只有本人 | 只有本人 | 只有本人 | 只有本人 | 本人可发布 |

这是一次**有意的策略变更**：团队任务对团队成员整体可见（个人任务仍只在个人空间）。理由：团队空间的价值就是共享上下文；如果每个成员只能看到自己负责的任务，空间就退化成私人收件箱。智能体的可见性不跟着放宽。

### 4.6 接口

```text
GET    /v1/space/tasks?status=&q=&cursor=       团队任务房间列表
GET    /v1/tasks/:id/room                       房间概览：参与者、计数、最近活动、未读
GET    /v1/tasks/:id/activity?types=&after=     合并事件 / 消息 / 文件 / 经验的时间线
GET    /v1/tasks/:id/threads                    线程列表
POST   /v1/tasks/:id/threads                    开一个线程
POST   /v1/threads/:id/resolve                  标记已解决
GET    /v1/tasks/:id/messages?thread=&after=    消息流（轮询增量）
POST   /v1/tasks/:id/messages                   发消息（kind / replyTo / mentions / fileIds）
POST   /v1/space/files/upload-url               申请上传
POST   /v1/space/files/:id/complete             完成上传
GET    /v1/space/files/:id                      元数据
GET    /v1/space/files/:id/content              下载或预签名
POST   /v1/space/files/:id/promote              提升为经验附件 / 成果
GET    /v1/tasks/:id/context-pack               导出交接包（markdown + manifest）
GET    /v1/space/search?q=&kind=                跨任务检索消息 / 文件 / 经验
```

所有写接口沿用现有约定：`Idempotency-Key` 必带；带版本的资源带 `If-Match`；消息写入同时追加一条 `events`（`type=message_added`），但不推进 `tasks.version`——对话不是状态变更，不能把别人手上的 `If-Match` 打回。

### 4.7 展示：怎么摆比存什么更重要

**任务房间**（三栏）：

```text
┌──────────────┬──────────────────────────────────────────┬────────────────┐
│ 任务列表      │  房间头：标题 · 状态 · 负责人 · 参与者     │  上下文栏       │
│              │  [概览] [进展] [对话] [文件] [经验]        │                │
│ ● 库存核对    │                                          │  当前阶段       │
│ ● 供应商评估  │  09:12  张三 创建任务                     │  未决事项       │
│ ○ 月报生成    │  09:20  协调者 拆成 3 个子任务            │  参与者         │
│              │  09:31  A 智能体 → B 智能体  handoff      │  ─────────     │
│  筛选：       │         "库存快照已上传，请核差异"         │  交接包         │
│  进行中 / 待验收│  09:35  B 智能体  已读，开始核对          │  [复制给智能体] │
│              │  09:48  A 智能体  上传 diff.csv           │                │
│              │  [发言] [提问] [交接] [记录决定]          │                │
└──────────────┴──────────────────────────────────────────┴────────────────┘
```

展示原则：

1. **一个流，多个镜头**。默认显示合并时间线；`进展 / 对话 / 文件` 是过滤器，不是互不相干的世界。
2. **每条内容都带来源**。谁、什么身份、哪个子任务、哪个文件版本、引用了哪条经验。
3. **过程与成果视觉分开**。`intermediate` 用灰色，`output` 用强调色；只有成果能被"提升"为经验。
4. **未读与待办优先**。房间列表按"需要你"排序：被 @、被提问、待验收、文件待确认。
5. **渐进披露**。首屏给摘要与最近 20 条；完整事件、完整文件清单、完整对话按需展开。
6. **给智能体的视图与人不同但同源**。`context-pack` 输出紧凑 markdown：目标、验收条件、当前状态、未决事项、最近对话、文件清单（含哈希与下载链接）、相关经验（钉版本）。智能体不需要看 UI，但看到的是同一批事实。

**团队首页**（空间总览）：

- 进行中任务、待验收、开放问题、最近文件、待审核经验；
- 智能体在线与参与情况；
- "需要人"队列：被提问超过 N 小时、验收积压、文件待确认；
- 不做"全团队文件树"，避免退化成网盘。

---

## 5. 存哪里：数据库与对象存储的分工

这是本轮最容易被做成"把文件塞进数据库"的地方。结论先给：

| 数据 | 存哪里 | 理由 |
| --- | --- | --- |
| 任务、事件、消息、线程、经验、权限 | **PostgreSQL**（单机演示可继续 SQLite） | 有强关系、事务、版本与授权；现有双方言已支持 |
| 文件正文 | **对象存储**（生产：S3 / MinIO / 腾讯云 COS；开发：本地内容寻址目录） | 大文件、流式下载、预签名、生命周期、备份独立 |
| 文件元数据 | PostgreSQL / SQLite | 名称、MIME、大小、sha256、来源、版本、权限 |
| 检索 | 先应用层词法；规模上来后 PostgreSQL FTS（中文用 `zhparser` / `pg_jieba`）或 OpenSearch | 当前 109 项测试的体量不需要独立搜索引擎 |
| 语义检索 | 后续 `pgvector` | 经验与文件片段做 embedding，仍以来源与时效为准 |
| 在线状态 / 队列 | Redis（可选） | 不作为事实来源；丢了可以从 DB 重建 |

### 5.1 为什么不再用 base64 存文件

`task_materials` 现在把文件 base64 存在 TEXT 里，适合演示与"随备份走"，但团队空间会放大它的缺点：

- WAL 与备份体积随文件线性增长，`VACUUM INTO` 会越来越慢；
- 每次读都要把整个文件读进内存，不能 Range 请求、不能断点续传；
- 无法独立设置生命周期、加密、CDN、病毒扫描；
- 数据库连接被大对象占用，影响正常事务。

所以：**≤256 KiB 的证据可以内联；超过就走对象存储。** 这条线放在 `space_files.storage` 里，接口对调用方一致。

### 5.2 推荐部署组合

| 场景 | 组合 |
| --- | --- |
| 本机演示 / 单节点 | SQLite（WAL）+ `COLLAB_BLOB_DIR` 本地目录 |
| 小团队内网 | PostgreSQL 16 + MinIO（S3 兼容） |
| 企业云 | PostgreSQL（托管）+ COS / OSS / S3 + KMS 加密 + 跨区备份 |
| 规模更大 | 上述 + 读副本、事件表按月分区、OpenSearch、CDN |

不推荐：

- **只用 MongoDB 存一切**：消息的 JSONB 很合适，但任务、权限、版本、引用是强关系，迁过去会丢掉现有事务与约束。
- **把对象存储当数据库**：列表、权限、检索仍需元数据表；对象存储只负责字节。
- **把大文件塞进 PostgreSQL `bytea`**：能跑，但备份、复制、内存与连接池都会付出代价。

### 5.3 备份与一致性

- 数据库备份 + 对象存储清单（`sha256, size, key`）一起做；
- 恢复时先恢复数据库，再按清单校验对象是否存在、哈希是否一致；
- 删除文件是软删除（`status=deleted`, `deleted_at`），对象保留 N 天后再由清理任务移除；
- 任务归档不删除文件；租户停用也不物理删除。

---

## 6. WorkBuddy 的"云空间"是怎么回事

严格说，腾讯在 2026-10-29 全球数字生态大会上发布的是 **腾讯网盘**，定位为 **WorkBuddy 办公套件的统一存储底座**、"Agent 时代的记忆空间"；"云空间"是同一件事的产品化叫法。公开信息里能确认的要点：

- **统一存储**：为 WorkBuddy、腾讯文档、腾讯会议、ima 知识库、腾讯设计等提供统一存放与调用空间；
- **统一账号 / 积分池 / 数据池**：Buddy One 体系下跨应用调用，减少反复上传与交代背景；
- **Agent 接入**：通过 CLI、MCP 连接各类 Agent，在授权范围内检索和调用资料；
- **企业能力**：依托腾讯云 COS，全链路加密、异地容灾、VPC 部署、精细化权限与人员交接；
- **协作范式**：从"围绕文件流转"转向"围绕任务推进"；团队提需求 → 模型生成 → Agent 整合 → 团队验收 → 沉淀到知识库；
- **容量口径**：WorkBuddy 企业版每席 5GB 升到 50GB；Buddy One VIP 含 1TB 共享存储（这是商业包装，不是架构要求）。

### 6.1 值得借鉴的六点

| WorkBuddy 的做法 | 落到本平台 |
| --- | --- |
| 任务为中心，而不是文件夹为中心 | 团队空间用**任务房间**组织，文件挂在任务/子任务/消息上 |
| 统一上下文，Agent 可续接 | 任务房间 + `context-pack`，智能体换一个进程也能接着做 |
| 文件承载上下文，不只是字节 | 每个文件带来源、版本、哈希、所属子任务与相关对话 |
| CLI / MCP 接入 | SDK/CLI 先支持 `room / say / ask / handoff / upload / pull`，后续提供 MCP server |
| 精细化权限与交接 | 沿用 tenant / principal / grant scopes；人员离开时任务与经验可转交 |
| 成果沉淀为组织资产 | 中间文件可"提升"为经验附件；经验经审核发布后进入团队库 |

### 6.2 不该照搬的三点

| 不照搬 | 原因 |
| --- | --- |
| 网盘式目录树与容量套餐 | 我们的核心是任务与验收，不是同步盘；容量不是差异化 |
| 跨应用全家桶整合 | 本平台是独立协作后端，先把任务房间做深，不追求套件覆盖 |
| "先存后治理" | 我们的经验有验收、有效期、证据与审计；存储必须服从治理，而不是反过来 |

### 6.3 一句话定位

> WorkBuddy 的云空间是"Agent 的记忆盘"；本平台的团队空间应当是"**带验收与证据的任务房间**"。前者解决"文件在哪、上下文能不能续"，后者还要回答"这一步谁负责、做到什么算完成、结论凭什么可信"。

---

## 7. 实施分期

### 第一阶段：经验手动发布 + 任务房间骨架（已实施）

- schema v7：`knowledge` 增列（含 `kind/title/summary/tags/source/evidence_level`）与 `task_id` 可空；`knowledge_lineage`；`knowledge_copy_invites`；`task_comments` 增 `kind/thread/reply/payload`；`task_threads`；`space_files`；`task_materials` 回填。
- 经验：手动草稿、编辑、提交、发布、修订、归档、撤销、删除；列表与详情；附件绑定。默认类型为经验。
- 复制：用户在条目上选择目标团队直接复制、复制给他人（邀请—接受）、来源链展示、来源撤销提示。
- 任务房间：概览、合并时间线、线程化对话、文件列表与下载；轮询刷新。
- 权限：团队任务对成员可见；智能体仍按子任务与 grant 范围。
- 测试：经验生命周期、手动发布权限、复制目标选择、复制邀请接受/拒绝、复制到非成员团队拒绝、消息可见性、文件鉴权、迁移回填；SQLite 与 PostgreSQL 各跑一遍。

实施说明：以上均已完成，验收见 `tests/aicd.test.ts`。两条边界留在第二阶段：手动经验的附件目前只能引用任务产出文件（`space_files.task_id` 非空），尚无独立上传；合并时间线的类型过滤在客户端完成。

### 第二阶段：对象存储与智能体协作

- S3/MinIO 预签名上传、sha256 校验、去重、软删除、生命周期；
- 文件预览（图片 / 文本 / PDF 首页）、版本对比；
- SDK/CLI：房间、发言、提问、交接、上传、拉取上下文包；
- 未读、@ 提醒、被提问超时提醒接入监管规则。

### 第三阶段：检索、交接包与团队首页

- 跨任务检索消息 / 文件 / 经验；
- 来源链视图：一份经验被复制到哪里、副本又派生了什么；
- `context-pack` 导出（markdown + manifest + 预签名链接）；
- 团队空间首页与"需要人"队列；
- 任务归档、文件保留策略、审计报表。

### 第四阶段：语义与开放接入

- `pgvector` 语义检索与重排（仍以来源、时效、验收状态为准）；
- MCP server，让外部 Agent 以最小 scope 接入任务房间；
- 跨团队经验分享的细粒度策略与到期回收。

---

## 8. 验收标准

| 能力 | 完成标准 |
| --- | --- |
| 手动经验 | 不建任务也能新建草稿；个人空间本人可发布；团队需 reviewer/admin；智能体发布一律 403 |
| 删除 | 无副本、未被任务引用的草稿或待审核稿可删除；已发布稿拒绝，需先归档或撤销 |
| 版本与证据 | 发布写快照；修订生成新版本；历史引用钉住旧版本；归档与撤销语义分开 |
| 复制 | 用户选择自己加入的目标团队后复制；复制给他人需对方接受后落库；目标不是自己加入的团队时 403 |
| 副本治理 | 副本是独立 `draft`，不带来源的分享/引用/审核；显示"复制自 谁 · 哪个空间 · 哪一版"；来源撤销后副本保留但告警；复制规则随用户操作，不再有复制策略字段 |
| 任务房间 | 一个页面看到概览、进展、对话、文件、相关经验；合并时间线可按类型过滤 |
| 智能体对话 | 支持 question / answer / handoff / decision；线程可解决；被提问方能在 inbox 看到 |
| 中间文件 | 上传、下载、版本、哈希、来源、软删除；未授权主体拿不到元数据与正文 |
| 存储 | 生产可切 S3/MinIO；开发可本地目录；数据库只存元数据 |
| 迁移 | 老 `task_materials` 与 `knowledge` 数据完整回填；SQLite 与 PostgreSQL 测试全绿 |
| 展示 | 首屏不出现全团队文件树；房间按"需要你"排序；每条内容有来源 |

---

## 9. 本轮不做（明确记下来）

| 项目 | 为什么现在不做 |
| --- | --- |
| WebSocket / 实时协同编辑 | 轮询足够；先把数据结构与权限做对 |
| 视频转码 / 在线 Office 预览 | 需要额外服务；先做图片、文本、PDF 首页 |
| 病毒扫描 | 预留 `quarantined` 状态与扫描钩子，接入企业杀毒后再启用 |
| 跨租户团队空间 | 现有隔离是天然边界；跨团队只走经验分享 |
| 跨租户复制 | 不允许。个人空间之间的复制也限定在同一租户内，走"邀请—接受"；不提供任何跨租户搬运通道 |
| 语义检索 | 本阶段不做；第四阶段用 `pgvector` 做可选召回/重排，词法结果始终保留 |
| 自动把对话变成经验 | 先保留"人一键转候选经验"，不让模型自动发布 |

---

## 参考

- [腾讯网盘发布：为 Agent 而生的统一存储底座（InfoQ）](https://www.infoq.cn/article/k0c4BhNdeyLaxeobqENz)
- [腾讯汤道生：WorkBuddy 将开放架构，支持企业自建 Agent 网络（证券时报）](https://stcn.com/article/detail/4285994.html)
- [腾讯发布 Buddy One 套件（量子位）](https://hub-assets-cache.baai.ac.cn/view/59173)
