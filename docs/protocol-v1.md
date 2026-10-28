# 协议 v1

平台对外只有 HTTP + JSON 一种接口。智能体、控制台、运维脚本都用同一套接口，不存在"内部特权通道"。

- 基地址：`http://127.0.0.1:8787`（`HOST`/`PORT` 可改）
- 认证：`Authorization: Bearer <token>`；`/health` 与静态资源除外
- 内容类型：请求与响应均为 `application/json; charset=utf-8`
- 时间：UTC ISO-8601，如 `2026-10-28T09:14:20.539Z`
- 请求体上限：`COLLAB_BODY_LIMIT`，默认 64 KiB

## 请求约定

### 幂等键

所有 `POST` 必须带 `Idempotency-Key`（1–200 字符）。同一个主体重复使用同一个键时：

| 情况 | 结果 |
| --- | --- |
| 键相同、请求内容（方法 + 路径 + 正文 + `If-Match`）相同 | 返回上次的结果，审计记 `replay`；**仍会重新核对授权** |
| 键相同、请求内容不同 | `409 conflict` |
| 键不同 | 视为新请求 |

意图是：智能体在"请求可能已生效但没收到响应"时，可以用同一个键重试，而不必知道上次到底成没成。

### 版本前置条件

带版本的资源支持 `If-Match: "<version>"`：

- 版本一致 → 执行，成功后 `version + 1`
- 版本不一致 → `412 precondition_failed`，调用方应重新读取后再决定
- 对没有版本语义的接口使用 `If-Match` → `400 invalid`

子任务流转另外在 SQL 里带 `WHERE id = :id AND status = :expected AND version = :version`，被并发改写时返回 `409`。

### 错误

失败一律返回 `{"error":{"code":"...","message":"..."}}`，`message` 是可以直接展示给用户的中文说明。

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid` | 400 | 参数缺失、类型不对、时间格式非法、`If-Match` 用错地方 |
| `unauthenticated` | 401 | 缺少令牌、令牌无效、主体已停用、权限在请求期间变更 |
| `forbidden` | 403 | 已认证但无权执行该动作 |
| `not_found` | 404 | 不存在，或存在但对当前主体不可见 |
| `conflict` | 409 | 状态不允许该流转、唯一性冲突、幂等键被复用于不同请求 |
| `precondition_failed` | 412 | `If-Match` 版本不匹配 |
| `payload_too_large` | 413 | 请求体超过上限 |
| `internal` | 500 | 未预期错误；详细信息只写服务端日志 |

ANP 登录另外有两个业务码，出现在 `/auth/anp/login` 的响应体里：

| code | HTTP | 含义 |
| --- | --- | --- |
| `challenge_required` | 401 | 需要（或需要新的）nonce；响应带 `WWW-Authenticate: ANP nonce="..."` |
| `enrollment_pending` | 403 | 身份通过验签，但主体还在等管理员批准；响应带 `principalId` |

## ANP 登录

平台只做验签方（relying party），不托管私钥、不代签。浏览器插件、`anpio-cli`、智能体进程用的是同一条流程。

### 1. 取挑战

```
GET /auth/anp/challenge
→ 200 { "nonce": "b64url…", "expiresAt": "2026-10-28T09:19:20.539Z", "audience": "http://host/auth/anp/challenge" }
```

`nonce` 一次性：验签通过后被消费；验签失败**不**消费（否则失败一次就要重新取挑战）。

### 2. 签名并登录

```
POST /auth/anp/login
Content-Type: application/json
Signature-Input: sig1=("@method" "@target-uri" "@authority" "content-digest");created=…;expires=…;nonce="…";keyid="<did>#key-1"
Signature: sig1=:<base64 ed25519>:
Content-Digest: sha-256=:<base64>

{
  "nonce": "…",
  "did": "did:wba:agents.local:user:alice:e1_<fingerprint>",
  "didDocument": { …内联 DID 文档… },
  "bindCode": "可选：把这条 DID 绑到已有账号",
  "client": "browser | agent"
}
```

- 签名基覆盖 `@method`、`@target-uri`、`@authority`、`content-digest`；`@target-uri` 必须与实际请求地址逐字一致（含 scheme 与端口）。
- 服务器用请求体里的 `didDocument` 解析公钥（`publicKeyMultibase` 或 `publicKeyJwk`），并校验 `doc.id` 与声明一致、`authentication` 引用了该 `keyid`。
- 时间窗口允许 300 秒对时误差；`expires` 之后一律拒绝。

### 3. 令牌投递

成功时**两条通道都给**，客户端取任意一条：

```
200 OK
Authentication-Info: access_token="…", token_type="Bearer"

{ "ok": true, "token": "…", "tokenType": "Bearer", "did": "…", "enrollment": "auto|bound|existing",
  "sessionExpiresAt": "…", "principal": { "id": "…", "roles": ["agent"], "kind": "agent", … } }
```

### 4. 401 挑战语义（与 `anpio-cli` 互通）

请求没带 `nonce`（或 `nonce` 已失效）时返回：

```
401 Unauthorized
WWW-Authenticate: ANP nonce="<新 nonce>"
{ "error": { "code": "challenge_required", … }, "nonce": "…" }
```

客户端读这个 `nonce` 重签一次即可登录。**只重签一次**：如果新的 `nonce` 与已用过的一样，就当成拒绝（避免无限重试）。这正是 `anpio-cli anp login` 的实现，因此 CLI 无需改动即可登录本平台。

### 主体落位

| 情况 | 结果 |
| --- | --- |
| 这个 DID 已登记 | 复用原主体，`enrollment: "existing"`；若该主体还没有账号，顺手补建并回填 `account_id` |
| 带 `bindCode` 且码有效 | 绑到该码指向的主体，`enrollment: "bound"`；码只能用一次，填错返回 `400` |
| 都不满足且 `COLLAB_ANP_ENROLL=open` | 自动登记：`client: browser` → `kind: human` + `owner`；`client: agent` → `kind: agent` + `agent` |
| `COLLAB_ANP_ENROLL=pending` | 主体落为 `active = 0`，登录返回 `403 enrollment_pending`，管理员批准后才能用 |
| `COLLAB_ANP_ENROLL=off` | `403 forbidden` |

### 会话

- 会话令牌是 32 字节随机值，数据库只存 SHA-256；`COLLAB_SESSION_HOURS` 决定有效期（默认 168 小时）。
- `POST /v1/me/logout` 只撤销当前这一个会话；`/v1/me/sessions` 列出全部，可逐个撤销。
- 已停用的主体：令牌立即失效；`/v1/me/identities/:id/revoke` 解绑 DID 时同时撤销它的会话。

## 邮箱登录、租户与 Agent 授权

### 三层身份

| 概念 | 存在范围 | 说明 |
| --- | --- | --- |
| 账号 `accounts` | 全局 | 邮箱或 DID 证明的身份；一个账号可以有多个凭证 |
| 租户 `tenants` | 全局 | 企业/组织；等于旧称 `workspace` |
| 主体 `principals` | 租户内 | 角色挂在这里；任务、知识、审计只认主体 |

`principals.workspace = tenants.id`，因此所有既有查询天然按租户隔离。

### 邮箱一次性链接

```
POST /auth/email/start   { email, invite? }              → 202 { sent, expiresAt, [devLink] }
POST /auth/email/verify  { ticket }                      → 200 { token, tenant, principal }
                                                         | 409 { selectionToken, tenants }
POST /auth/email/choose  { selectionToken, tenantId }    → 200 { token, tenant, principal }
```

- 无论邮箱是否存在都返回 202，避免枚举。
- 票据 15 分钟、一次性、只存 SHA-256；验证成功才消费。
- 首次登录创建个人租户（`personal=1`），本人 `tenant_role=owner`。
- 账号属于多个租户时返回 409 + 30 分钟有效的 `selectionToken`，选完再换会话（不重新发信）。
- 邀请票据（`purpose=invite`）带 `invite_id`：验证通过即入组，但邮箱必须与邀请一致。

### Agent 设备授权

```
POST /auth/agent/request  { did, name, capabilities? }   → 201 { deviceCode, userCode, expiresIn }
POST /auth/agent/token    { deviceCode }                 → 202 { status: "pending" }
                                                         | 200 { token, scopes, expiresAt }
POST /v1/agents/approve   { userCode, mode, scopes, expiresInHours? }   （需登录）
```

- `deviceCode` 32 字节，只存摘要；`userCode` 形如 `K7QM-2XPD`，10 分钟有效。
- 批准必须由已登录主体发起；`mode=own` 建独立 Agent 主体（默认、推荐），`mode=link` 把 DID 绑到本人主体。
- `own` 模式撤销时停用 Agent 主体并作废其会话；`link` 模式只作废 `client=agent` 的会话，不影响本人。
- 授权记录在 `agent_grants`，`/v1/me` 对 Agent 返回 `scopes` 与 `grantExpiresAt`。

### 租户与成员

```
GET  /v1/me/tenants                                      → 我所属的租户
POST /v1/me/switch        { tenantId }                   → 换发会话（旧会话作废）
GET  /v1/tenants/current                                 → 详情与计数
POST /v1/tenants/current/rename { name }
GET  /v1/tenants/current/members                         → 人 + Agent
POST /v1/tenants/current/invites { email, role, kind }   → 发邀请
GET  /v1/tenants/current/invites
POST /v1/tenants/current/invites/:id/revoke
POST /v1/members/:id/role { role }
POST /v1/members/:id/remove
```

租户角色：`owner`（唯一，可转让）/ `admin` / `member` / `guest`。业务角色由它派生，但 Agent 永远是 `agent`，不继承主人的管理权。所有者与管理员不能改自己的角色，管理员不能动所有者，也不能邀请第二个所有者。

## 状态机

### 任务

```
pending ──(首个 assign)──> running ──(summary，且子任务全部 submitted)──> review ──(accept)──> completed
   │                          │                                            │
   └──────────(cancel)────────┴───────────────(cancel)──────────────────┴──> cancelled
                                                                 (return) ──> running
```

- `pending`：已创建，还没有子任务
- `running`：至少分派了一个子任务
- `review`：负责人已提交汇总，等待验收
- `completed`：验收通过；此后才能沉淀经验
- `cancelled`：未核验的子任务会一并取消，并给对应智能体发通知

### 子任务

```
invited ──accept──> accepted ──submit──> submitted ──(任务验收)──> verified
   │                   │                    │
   ├──reject──> rejected                    │
   ├──(依赖未满足时不可 accept)              │
   └──timeout──> timed_out <────────────────┘
                    │
       returned <───┴──(负责人退回)
accepted ──outcome-unknown──> outcome_unknown
```

- `invited`：已分派，等待智能体接受；依赖（`dependsOn`）未满足时不出现在待办里，也不能接受
- `submitted`：结果已提交，等待汇总与验收
- `returned`：被负责人退回，可重新接受并提交
- `timed_out` / `outcome_unknown`：协作层面的标记，**不代表业务执行失败**，需人工核对
- 提交结果必须带 `source`（来源）与 `observedAt`（观测时间），并且 `quantity` 与 `summary` 至少有一个

## 授权

授权只回答"这个主体能不能对这个资源做这个动作"，不判断业务结论是否正确；所有判断读数据库当前状态，不信任请求方声明的角色。

| 动作 | 允许的主体 |
| --- | --- |
| 读任务 | 管理员、监管者、负责人、委派协调者、受派智能体（后者只见自己的子任务） |
| 创建任务 / 委派协调者 / 分派 / 汇总 / 阶段摘要 | `owner` 或 `admin`，或该任务的协调者 |
| 验收 / 退回 / 取消 / 引用经验 / 沉淀候选 | 负责人或管理员 |
| 接管智能体提案 | 负责人、监管者或管理员（且提案未接管、任务未终结） |
| 挂开放池 / 撤回开放子任务 | 负责人、该任务协调者或管理员 |
| 认领开放子任务 | `agent` 且能力声明包含该子任务要求的能力 |
| 评论 / 读评论 | 对该任务可见的主体 |
| 提案与评论的 `@提及` 已读 | 被提及的主体本人 |
| 子任务 accept / reject / submit / progress / outcome-unknown | 被分派的那一个智能体（且需要 `agent` 角色） |
| 子任务 timeout / return | 负责人或管理员 |
| 主体登记、停用、轮换令牌、改角色、审计、超时检查 | 管理员 |
| 查看成员、邀请、改成员角色、移除成员 | 租户所有者或管理员 |
| 批准 Agent 授权、撤销自己授权的 Agent | 已登录主体（管理员可撤销本租户任何授权） |
| 批准待登记主体 | 管理员或监管者 |
| 监管总览 / 扫描 / 确认与解决告警 / 在线表 | `supervisor` 或 `admin` |
| 心跳上报 | `kind` 为 `agent` / `service`，或管理员 |
| 经验发布 / 修订 / 撤销 / 调整范围 / 版本 / 待审核列表 | 审核人或管理员 |

监管者刻意拿不到业务写权限：看得到异常，改不了状态。验收仍然必须由负责人本人完成。

## 接口清单

### 登录（无需令牌）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/auth/anp/challenge` | 领取登录挑战 nonce |
| POST | `/auth/anp/login` | 签名登录（RFC 9421） |
| POST | `/auth/email/start` | 发送一次性登录链接 |
| POST | `/auth/email/verify` | 用票据换会话（或多租户选择） |
| POST | `/auth/email/choose` | 选择要进入的租户 |
| POST | `/auth/agent/request` | Agent 申请设备授权 |
| POST | `/auth/agent/token` | Agent 轮询换取令牌 |

### 身份与主体

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/me` | 当前主体、角色、租户角色、账号、Agent 授权范围 |
| GET | `/v1/me/tenants` | 我所属的全部租户（跨租户） |
| POST | `/v1/me/switch` | 切换租户并换发会话 |
| GET | `/v1/principals?capability=` | 主体目录，可按能力过滤 |
| POST | `/v1/principals` | 登记主体 `{id, roles, token, displayName?, capabilities?, did?}`；令牌只在响应中出现一次 |
| POST | `/v1/principals/:id/profile` | 更新显示名、描述、能力声明 |
| POST | `/v1/principals/:id/rotate-token` | 轮换令牌，旧令牌立即失效 |
| POST | `/v1/principals/:id/deactivate` | 停用主体，其令牌立即被拒 |
| GET | `/v1/activity?limit=` | 跨任务最近事件（负责人、审核人、管理员） |

`/v1/activity` 只对控制台角色开放：业务智能体没有控制台，而事件正文可能包含其他智能体的结果。

### 任务

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/tasks?status=&q=` | 可见任务（最多 500 条），按创建时间倒序 |
| GET | `/v1/tasks/page?limit=&offset=` | 分页 `{items, nextOffset}`，limit 1–100 |
| POST | `/v1/tasks` | 创建 `{title, type?, goal?, acceptance, priority?, dueAt?, input?}` |
| GET | `/v1/tasks/:id` | 任务详情：任务、子任务、协调者、事件、知识引用、`unrestricted` |
| GET | `/v1/tasks/:id/context` | 智能体视角的恢复上下文（见下） |
| POST | `/v1/tasks/:id/coordinators` | 委派协调者 `{principal}` |
| POST | `/v1/tasks/:id/remove-coordinator` | 撤销委派 `{principal}` |
| POST | `/v1/tasks/:id/assign` | 分派子任务 `{agent, kind, dependsOn?, dueAt?}` |
| POST | `/v1/tasks/:id/stage-summaries` | 阶段摘要 `{text, pending}`，记录覆盖到的事件序号 |
| POST | `/v1/tasks/:id/summary` | 提交汇总 `{text}`；要求所有子任务已 `submitted` |
| POST | `/v1/tasks/:id/review` | 验收 `{decision: "accept"｜"return", note}` |
| POST | `/v1/tasks/:id/cancel` | 取消 `{note}` |
| POST | `/v1/tasks/:id/knowledge` | 从已验收任务沉淀候选 `{content, conditions}` |
| POST | `/v1/tasks/:id/references` | 引用有效经验 `{knowledgeId}`（固定到当前版本） |
| GET | `/v1/tasks/:id/evidence/:knowledgeId/:version` | 该任务引用过的历史版本及其当前状态 |

### 子任务与通知

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/inbox` | 我的待办：依赖已满足的邀请、进行中、被退回 |
| POST | `/v1/subtasks/:id/accept` | 接受（`{}`） |
| POST | `/v1/subtasks/:id/reject` | 拒绝 `{reason}` |
| POST | `/v1/subtasks/:id/submit` | 提交 `{result:{quantity?｜summary?, source, observedAt, reference?}}` |
| POST | `/v1/subtasks/:id/progress` | 记录进展 `{text}`，不改变状态 |
| POST | `/v1/subtasks/:id/outcome-unknown` | 标记结果未知 `{reason, externalOperationId}` |
| POST | `/v1/subtasks/:id/timeout` | 标记超时 `{note}` |
| POST | `/v1/subtasks/:id/return` | 退回 `{note}` |
| GET | `/v1/notifications` | 我最早的 100 条未确认通知 |
| POST | `/v1/notifications/:id/ack` | 确认收到（幂等） |

邀请与退回在同一事务内写通知，因此不会出现"状态变了但没人知道"。确认通知不改变业务状态，旧通知可能对应已经取消的任务，处理前仍应查询当前状态。

### 经验

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/knowledge?q=&limit=` | 已发布、未过期、对当前主体可见的经验 |
| GET | `/v1/knowledge/search?q=&limit=&budget=` | 带字符预算的词法检索（`budget` 256–100000，默认 4000） |
| GET | `/v1/knowledge/candidates` | 待审核候选 |
| GET | `/v1/knowledge/:id/versions` | 已发布版本快照 |
| GET | `/v1/knowledge/:id/evidence` | 当前有效版本的证据包（内容、条件、审核人、来源任务、有效期） |
| POST | `/v1/knowledge/:id/publish` | 发布 `{expiresAt, audience?}`；省略 `audience` 时仅审核人与管理员可见 |
| POST | `/v1/knowledge/:id/revise` | 修订 → 新版本候选 `{content, conditions, reason}` |
| POST | `/v1/knowledge/:id/access` | 调整范围 `{audience}` |
| POST | `/v1/knowledge/:id/revoke` | 撤销 `{reason}` |

`audience` 是 `"workspace"` 或主体 ID 数组。范围变更立即影响后续读取与引用，**无法收回已经被读走或复制的内容**。

### 运维

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | `{"ok":true,"protocol":"v1"}`，无需令牌 |
| POST | `/v1/maintenance/expire` | 把过期未提交的子任务标记超时（管理员）；由调度器调用 |
| GET | `/v1/audit?limit=` | 最近审计（管理员，最多 500） |

## 任务上下文

`GET /v1/tasks/:id/context` 是给智能体用的"我该干什么"视图，比详情更窄：

```json
{
  "task": { "id": "...", "title": "...", "status": "running", "version": 4, "acceptance": "...", "dueAt": "..." },
  "subtasks": [{ "id": "...", "kind": "inventory", "agentId": "inventory", "status": "invited", "version": 1, "dueAt": "..." }],
  "pending": [{ "id": "...", "status": "invited", "kind": "inventory" }],
  "result": null,
  "references": [{ "knowledgeId": "...", "version": 1 }],
  "stageSummary": { "version": 2, "text": "...", "pending": "...", "throughSeq": 17, "stale": true, "authorId": "coordinator", "createdAt": "..." },
  "events": [ ... 最近 20 条可见事件 ... ],
  "eventsTruncated": true
}
```

- 业务智能体只看得到自己的子任务、自己的结果与事件
- `stageSummary.stale` 为 `true` 表示摘要之后又有了新事件，需要重新阅读
- `eventsTruncated` 表示事件被截断，完整历史在任务详情里

## 审计语义

审计记录 `主体 + 方法 + 路径 + 结果 + 时间`，不含请求正文与令牌。

| 结果 | 写入方式 |
| --- | --- |
| `success` | 与业务写入同事务，业务回滚则审计也不存在 |
| `replay` | 幂等重放时记录，与重放读取同事务 |
| `denied:<status>` | 认证后、授权或校验失败时单独记录 |
| `read` | 仅 `auditRead` 标记的敏感读取（知识检索、证据包） |

普通读取（`/v1/tasks`、`/v1/me` 等）**不记录**：控制台会持续轮询，全量记录只会把审计表变成噪音。

本地 SQLite 审计不具备防篡改能力，也不能保证认证失败或进程崩溃时的完整性，不能替代企业集中审计。

## 客户端

`src/sdk/client.ts` 是参考客户端，覆盖全部接口并带类型：

```ts
const client = new CollabClient(baseUrl, token);
await client.createTask({ title, acceptance, input }, 'create-1');
await client.assign(taskId, { agent: 'inventory', kind: 'inventory' }, 'assign-1', currentVersion);
```

- 不自动重试：传输层失败抛出 `CollabError`，其 `uncertain` 为 `true`，表示请求可能已经生效
- 幂等键与 `If-Match` 由调用方传入，SDK 不隐式生成业务操作 ID
- 需要"进程重启后继续"的场景用 `src/sdk/journal.ts`：写前日志记录待发请求，重启后按原键重放

## 兼容性

协议版本号 `v1` 出现在 `/health` 与所有路径前缀中。当前没有并行版本，接口变更会同时修改 `docs/`、测试与 SDK；数据库 schema 版本记录在 `schema_migrations` 表。
