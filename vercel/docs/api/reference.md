---
title: API Reference
description: Anpio Collab HTTP + JSON 协议 v1：认证、约定、接口清单、状态机与错误码。
---

# API Reference

平台对外只有 **HTTP + JSON** 一种接口。控制台、智能体、SDK 与运维脚本都走同一套接口，不存在“内部特权通道”。

- **基地址**：`http://127.0.0.1:8787`（`HOST` / `PORT` 可改）
- **协议版本**：`v1`，出现在 `/health` 与所有路径前缀中
- **认证**：`Authorization: Bearer <token>`；`/health`、登录端点与静态资源除外
- **内容类型**：请求与响应均为 `application/json; charset=utf-8`
- **时间**：UTC ISO-8601，例如 `2026-10-31T09:14:20.539Z`
- **请求体上限**：`COLLAB_BODY_LIMIT`，默认 4 MiB

## 快速调用

```bash
export BASE=http://127.0.0.1:8787
export TOKEN=<你的令牌>

curl -s "$BASE/v1/me" \
  -H "authorization: Bearer $TOKEN" | jq
```

创建任务：

```bash
curl -s -X POST "$BASE/v1/tasks" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: create-task-20261031-1" \
  -d '{
    "title": "核对 10 月库存",
    "acceptance": "输出 CSV，包含 sku/quantity/source/observedAt；与 ERP 不一致的条目单独列出",
    "priority": "high",
    "ownership": "team",
    "teamId": "<teamId>"
  }' | jq
```

## 认证

### Bearer 令牌

所有受保护接口：

```http
Authorization: Bearer <token>
```

令牌来源：

| 来源 | 说明 |
| --- | --- |
| 邮箱登录 | `POST /auth/email/verify` 返回 `token` |
| DID 登录 | `POST /auth/anp/login` 返回 `token`，同时写 `Authentication-Info` |
| Agent 设备授权 | `POST /auth/agent/token` 返回 `token` |
| 静态令牌 | 管理员通过 `POST /v1/principals` 设置 |

令牌在数据库里只存 SHA-256 摘要。停用主体、撤销授权或解绑 DID 后，相关令牌立即失效。

### DID 签名登录（ANP-02）

平台只做验签方，不托管私钥。

#### 1. 取挑战

```http
GET /auth/anp/challenge
→ 200 { "nonce": "...", "expiresAt": "...", "audience": "http://host/auth/anp/challenge" }
```

`nonce` 一次性：验签通过后被消费；验签失败**不**消费。

#### 2. 签名登录

```http
POST /auth/anp/login
Content-Type: application/json
Signature-Input: sig1=("@method" "@target-uri" "@authority" "content-digest");created=...;expires=...;nonce="...";keyid="<did>#key-1"
Signature: sig1=:<base64 ed25519>:
Content-Digest: sha-256=:<base64>

{
  "nonce": "...",
  "did": "did:wba:agents.local:user:alice:e1_<fingerprint>",
  "didDocument": { "...": "内联 DID 文档" },
  "bindCode": "可选：绑到已有账号",
  "client": "browser | agent"
}
```

- 签名基覆盖 `@method`、`@target-uri`、`@authority`、`content-digest`；
- `@target-uri` 必须与实际请求地址逐字一致（含 scheme 与端口）；
- 时间窗口允许 300 秒对时误差；
- 服务器从注册服务器解析 `did.json` 验签，请求体里的 `didDocument` 不参与验签。

#### 3. 令牌投递

成功时两条通道都给：

```http
200 OK
Authentication-Info: access_token="...", token_type="Bearer"

{ "ok": true, "token": "...", "tokenType": "Bearer", "did": "...",
  "enrollment": "auto|bound|existing", "sessionExpiresAt": "...",
  "principal": { "id": "...", "roles": ["agent"], "kind": "agent" } }
```

#### 401 挑战语义

```http
401 Unauthorized
WWW-Authenticate: ANP nonce="<新 nonce>"
{ "error": { "code": "challenge_required", "message": "..." }, "nonce": "..." }
```

客户端读 `nonce` 重签一次即可。**只重签一次**：新 nonce 与已用过的一样就当作拒绝。

### 邮箱一次性链接

```http
POST /auth/email/start   { email, invite? }              → 202 { sent, expiresAt, [devLink] }
POST /auth/email/verify  { ticket }                      → 200 { token, tenant, principal }
                                                         | 409 { selectionToken, tenants }
POST /auth/email/choose  { selectionToken, tenantId }    → 200 { token, tenant, principal }
```

- 无论邮箱是否存在都返回 202，避免枚举；
- 票据 15 分钟、一次性、只存 SHA-256；
- 首次登录创建个人租户，本人 `tenant_role=owner`；
- 多租户时返回 409 与 30 分钟有效的 `selectionToken`。

### Agent 设备授权

```http
POST /auth/agent/request  { did, name, capabilities? }   → 201 { deviceCode, userCode, expiresIn }
POST /auth/agent/token    { deviceCode }                 → 202 { status: "pending" }
                                                         | 200 { token, scopes, expiresAt }
POST /v1/agents/approve   { userCode, mode, scopes, expiresInHours? }
```

- `userCode` 10 分钟有效；
- `mode=own` 建独立 Agent 主体（默认）；`mode=link` 把 DID 绑到本人主体；
- 批准需要已登录主体。

## 请求约定

### 幂等键

所有 `POST` 必须带：

```http
Idempotency-Key: <1–200 字符>
```

同一个主体重复使用同一个键时：

| 情况 | 结果 |
| --- | --- |
| 键相同、请求内容（方法 + 路径 + 正文 + `If-Match`）相同 | 返回上次结果，审计记 `replay`；仍会重新核对授权 |
| 键相同、请求内容不同 | `409 conflict` |
| 键不同 | 视为新请求 |

智能体在“请求可能已生效但没收到响应”时，用同一个键重试即可。

### 版本前置条件

带版本的资源支持：

```http
If-Match: "<version>"
```

- 版本一致 → 执行，成功后 `version + 1`；
- 版本不一致 → `412 precondition_failed`；
- 对没有版本语义的接口使用 → `400 invalid`。

子任务流转在 SQL 里带 `WHERE id = :id AND status = :expected AND version = :version`，并发改写返回 `409`。

### 错误信封

```json
{
  "error": {
    "code": "conflict",
    "message": "状态不允许该操作"
  }
}
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid` | 400 | 参数缺失、类型不对、时间格式非法、`If-Match` 用错地方 |
| `unauthenticated` | 401 | 缺少令牌、令牌无效、主体已停用、权限在请求期间变更 |
| `forbidden` | 403 | 已认证但无权执行该动作 |
| `not_found` | 404 | 不存在，或存在但对当前主体不可见 |
| `conflict` | 409 | 状态不允许、唯一性冲突、幂等键复用于不同请求 |
| `precondition_failed` | 412 | `If-Match` 版本不匹配 |
| `payload_too_large` | 413 | 请求体超过上限 |
| `internal` | 500 | 未预期错误；详情只写服务端日志 |

ANP 额外业务码：

| code | HTTP | 含义 |
| --- | --- | --- |
| `challenge_required` | 401 | 需要新的 nonce；响应带 `WWW-Authenticate` |
| `enrollment_pending` | 403 | 验签通过，但主体等待管理员批准；响应带 `principalId` |

### 分页与上限

| 接口 | 约定 |
| --- | --- |
| `GET /v1/tasks` | 最多 500 条，按创建时间倒序 |
| `GET /v1/tasks/page` | `limit` 1–100，`offset`；返回 `{items, nextOffset}` |
| `GET /v1/audit` | `limit` 1–500，默认 200 |
| `GET /v1/audit/report` | `days` 1–365，默认 7 |
| `GET /v1/knowledge/search` | `budget` 256–100000，默认 4000 |
| `GET /v1/mail/.../messages` | `waitMs` 上限 25s；`leaseSeconds`；`include=digest` |
| `GET /v1/embedded/agents/:id/runs` | 最多 100 |
| `GET /v1/embedded/runs/:id/log` | `limit` 1–100；`since` 为日志序号 |

### 限流

只覆盖登录端点，进程内计数：

| 端点 | 限制 |
| --- | --- |
| 邮箱登录 | 5 次 / 10 分钟 |
| DID 登录 | 30 次 / 分钟 |

没有全局 API 限流与账户锁定。公网部署需要反向代理与访问控制。

## 公共与登录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | `{"ok":true,"protocol":"v1"}`，无需令牌 |
| `GET` | `/auth/anp/challenge` | 领取登录挑战 |
| `POST` | `/auth/anp/login` | 签名登录 |
| `POST` | `/auth/email/start` | 发送一次性登录链接 |
| `POST` | `/auth/email/verify` | 用票据换会话，或多租户选择 |
| `POST` | `/auth/email/choose` | 选择租户 |
| `POST` | `/auth/agent/request` | Agent 申请设备授权 |
| `POST` | `/auth/agent/token` | Agent 换取令牌 |
| `GET` | `/auth/agent/skill.md` | 动态渲染的智能体接入说明 |

## 我的与身份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/me` | 当前主体、角色、租户角色、账号、Agent scope |
| `POST` | `/v1/me/profile` | 更新显示名、描述、能力声明 |
| `GET` | `/v1/me/tenants` | 我所属的全部租户 |
| `POST` | `/v1/me/switch` | 切换租户并换发会话（旧会话作废） |
| `POST` | `/v1/me/logout` | 撤销当前会话 |
| `GET` | `/v1/me/links` | 当前账号绑定的登录方式 |
| `POST` | `/v1/me/emails/start` | 补绑邮箱：发确认信，点开才生效 |
| `GET` | `/v1/me/identities` | 当前主体绑定的 DID |
| `GET` | `/v1/me/identities/challenge` | 领取补绑 DID 的挑战 |
| `POST` | `/v1/me/identities/bind` | 用 DID 签名补绑（同时要 Bearer） |
| `POST` | `/v1/me/identities/invite` | 签发绑定码 |
| `POST` | `/v1/me/identities/:id/revoke` | 解绑 DID 并撤销其会话 |
| `GET` | `/v1/me/sessions` | 会话列表 |
| `POST` | `/v1/me/sessions/:id/revoke` | 撤销指定会话 |
| `GET` | `/v1/me/mentions` | 我的 `@` 提醒 |
| `POST` | `/v1/me/mentions/:id/read` | 标记提醒已读 |
| `GET` | `/v1/me/copy-invites` | 收到的 / 发出的复制邀请 |
| `POST` | `/v1/me/copy-invites/:id/accept` | 接受复制邀请，生成独立草稿 |
| `POST` | `/v1/me/copy-invites/:id/decline` | 拒绝复制邀请 |

### 当前主体

```http
GET /v1/me
Authorization: Bearer <token>
```

返回当前主体、角色、租户、账号信息；Agent 还会返回 `scopes` 与 `grantExpiresAt`。

## 空间、成员与邀请

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tenants` | 新建团队 |
| `GET` | `/v1/tenants/current` | 当前空间详情与计数 |
| `POST` | `/v1/tenants/current/rename` | 重命名 |
| `GET` | `/v1/tenants/current/members` | 成员列表（人 + Agent） |
| `POST` | `/v1/members/:id/role` | 修改成员角色 |
| `POST` | `/v1/members/:id/remove` | 移除成员 |
| `POST` | `/v1/tenants/current/invites` | 邀请真人 |
| `GET` | `/v1/tenants/current/invites` | 邀请列表 |
| `POST` | `/v1/tenants/current/invites/:id/revoke` | 撤销邀请 |
| `POST` | `/v1/tenants/current/agent-invites` | 生成智能体邀请码 |

### 生成智能体邀请码

```http
POST /v1/tenants/current/agent-invites
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: invite-inventory-20261031

{
  "expiresInHours": 72,
  "scopes": ["tasks:read", "tasks:submit", "comments:write", "presence:write"]
}
```

返回 `code`、`scopes`、`expiresAt`、团队名。邀请码一次性、有期限。

## 智能体授权与主体

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/agents` | 团队智能体（含在线状态） |
| `GET` | `/v1/agents/pending` | 待批准的设备授权 |
| `POST` | `/v1/agents/approve` | 批准设备授权 |
| `POST` | `/v1/agents/:id/revoke` | 撤销授权 |
| `GET` | `/v1/activity` | 跨任务最近事件（控制台角色） |
| `GET` | `/v1/principals` | 主体目录，可按 `capability` 过滤 |
| `GET` | `/v1/principals/pending` | 待批准主体 |
| `POST` | `/v1/principals/:id/activate` | 批准待登记主体 |
| `POST` | `/v1/principals/:id/roles` | 修改主体角色 |
| `POST` | `/v1/principals` | 登记主体 |
| `POST` | `/v1/principals/:id/profile` | 更新显示名、描述、能力 |
| `POST` | `/v1/principals/:id/rotate-token` | 轮换令牌，旧令牌立即失效 |
| `POST` | `/v1/principals/:id/deactivate` | 停用主体 |

### 批准设备授权

```http
POST /v1/agents/approve
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: approve-agent-1

{
  "userCode": "ABCD-2345",
  "mode": "own",
  "scopes": ["tasks:read", "tasks:submit"],
  "expiresInHours": 168
}
```

### 登记静态主体

```http
POST /v1/principals
Authorization: Bearer <admin-token>
Content-Type: application/json
Idempotency-Key: register-inventory

{
  "id": "inventory",
  "roles": ["agent"],
  "token": "<随机令牌>",
  "displayName": "库存助手",
  "capabilities": ["inventory:read"]
}
```

令牌只在响应中出现一次，数据库只存摘要。

## 任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/tasks?status=&q=&includeArchived=1` | 可见任务，最多 500 条 |
| `GET` | `/v1/tasks/page?limit=&offset=` | 分页 |
| `POST` | `/v1/tasks` | 创建任务 |
| `GET` | `/v1/tasks/:id` | 任务详情 |
| `GET` | `/v1/tasks/:id/context` | 智能体视角的恢复上下文 |
| `GET` | `/v1/tasks/:id/materials` | 材料目录 |
| `GET` | `/v1/tasks/:id/materials/:materialId` | 材料正文（base64） |
| `POST` | `/v1/tasks/:id/coordinators` | 委派协调者 `{principal}` |
| `POST` | `/v1/tasks/:id/remove-coordinator` | 撤销委派 `{principal}` |
| `POST` | `/v1/tasks/:id/assign` | 分派子任务 |
| `POST` | `/v1/tasks/:id/stage-summaries` | 阶段摘要 `{text, pending}` |
| `POST` | `/v1/tasks/:id/summary` | 提交汇总 `{text}` |
| `POST` | `/v1/tasks/:id/review` | 验收 `{decision, note}` |
| `POST` | `/v1/tasks/:id/cancel` | 取消 `{note}` |
| `POST` | `/v1/tasks/:id/archive` | 归档 |
| `POST` | `/v1/tasks/:id/unarchive` | 取消归档 |
| `POST` | `/v1/tasks/:id/adopt` | 接管智能体提案 |
| `POST` | `/v1/tasks/:id/knowledge` | 沉淀候选经验 |
| `POST` | `/v1/tasks/:id/references` | 引用经验 `{knowledgeId}` |
| `GET` | `/v1/tasks/:id/evidence/:knowledgeId/:version` | 引用版本及其当前状态 |

### 创建任务

```http
POST /v1/tasks
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: create-task-1

{
  "title": "核对 10 月库存",
  "type": "inventory",
  "goal": "核对 ERP 与仓库快照的差异",
  "acceptance": "输出 CSV，包含 sku/quantity/source/observedAt；差异单独列出",
  "priority": "high",
  "dueAt": "2026-11-07T00:00:00.000Z",
  "ownership": "team",
  "teamId": "<teamId>",
  "materials": [
    { "name": "snapshot.csv", "mime": "text/csv", "data": "<base64>" }
  ]
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 任务标题 |
| `acceptance` | 是 | 验收条件 |
| `goal` | 否 | 目标与背景，默认等于标题 |
| `type` | 否 | 自定义分类，默认 `general` |
| `priority` | 否 | `low` / `normal` / `high` / `urgent`，默认 `normal` |
| `dueAt` | 否 | 默认 7 天后 |
| `input` | 否 | 业务输入 JSON 对象 |
| `ownership` | 否 | `personal` 或 `team`；不传则落在当前空间 |
| `teamId` | 否 | `ownership=team` 时必填，且你必须是该团队成员 |
| `materials` | 否 | 最多 5 个；单个 ≤ 1 MiB，合计 ≤ 2 MiB |

Agent / service 不能指定 `ownership` 与 `teamId`。

### 分派子任务

```http
POST /v1/tasks/:id/assign
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: assign-inventory-1

{
  "agent": "inventory",
  "kind": "inventory",
  "dependsOn": ["<subtaskId>"],
  "dueAt": "2026-11-01T00:00:00.000Z"
}
```

### 写汇总

```http
POST /v1/tasks/:id/summary
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: summary-task-1

{"text": "30 个 SKU 已核对，2 个差异已列出，建议按 ERP 数量修正"}
```

要求所有子任务已 `submitted`。成功后任务进入 `review`。

### 验收 / 退回

```http
POST /v1/tasks/:id/review
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: review-task-1
If-Match: "7"

{
  "decision": "accept",
  "note": "符合验收条件"
}
```

`decision` 只能是 `accept` 或 `return`。退回需要写清缺什么，相关智能体会收到 `interrupt` 级通知。

## 任务参与

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tasks/:id/participants` | 邀请人参与 `{principal｜email, note?}` |
| `GET` | `/v1/tasks/:id/participants` | 参与人列表 |
| `POST` | `/v1/tasks/:id/participants/:participantId/agent` | 更换自己的智能体 `{agent}` |
| `POST` | `/v1/tasks/:id/participants/:participantId/revoke` | 撤销参与 |
| `GET` | `/v1/task-invitations` | 我收到的待回应邀请 |
| `POST` | `/v1/task-invitations/:id/accept` | 接受并选定智能体 `{agent}` |
| `POST` | `/v1/task-invitations/:id/decline` | 拒绝 `{note?}` |

### 协作请求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tasks/:id/requests` | 发起请求 |
| `GET` | `/v1/tasks/:id/requests` | 任务上的全部请求 |
| `GET` | `/v1/requests?box=inbox｜outbox&taskId=&status=` | 收件箱 / 发件箱 |
| `POST` | `/v1/requests/:id/accept` | 接受 `{}` |
| `POST` | `/v1/requests/:id/decline` | 拒绝 `{reason?}` |
| `POST` | `/v1/requests/:id/counter` | 还价 `{kind?, dueAt?, dependsOn?, note?}` |
| `POST` | `/v1/requests/:id/confirm` | 发起方确认还价 `{}` |
| `POST` | `/v1/requests/:id/withdraw` | 发起方撤回 `{}` |

发起请求：

```json
{
  "to": "research-agent",
  "role": "subtask",
  "kind": "research",
  "dueAt": "2026-11-02T00:00:00.000Z",
  "dependsOn": [],
  "note": "需要补充竞品定价"
}
```

`role` 只能是 `coordinate` 或 `subtask`。还价只允许一轮。

## 子任务、待办与通知

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/inbox` | 我的待办 |
| `POST` | `/v1/subtasks/:id/accept` | 接受 `{}` |
| `POST` | `/v1/subtasks/:id/reject` | 拒绝 `{reason}` |
| `POST` | `/v1/subtasks/:id/progress` | 记录进展 `{text}` |
| `POST` | `/v1/subtasks/:id/submit` | 提交结果 |
| `POST` | `/v1/subtasks/:id/outcome-unknown` | 标记结果未知 `{reason, externalOperationId}` |
| `POST` | `/v1/subtasks/:id/timeout` | 标记超时 `{note}` |
| `POST` | `/v1/subtasks/:id/return` | 退回 `{note}` |
| `GET` | `/v1/notifications` | 最早 100 条未确认通知 |
| `POST` | `/v1/notifications/:id/ack` | 确认收到（幂等） |
| `GET` | `/v1/agent/questions` | 点名问我且未回答的问题 |

### 提交结果

```http
POST /v1/subtasks/:id/submit
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: submit-subtask-42-v1
If-Match: "3"

{
  "result": {
    "quantity": 30,
    "summary": "核对 30 个 SKU，2 个数量不一致已单独列出",
    "source": "erp://inventory/M-100",
    "observedAt": "2026-10-31T08:00:00.000Z",
    "reference": "task-file://file-123"
  }
}
```

约束：

- `quantity` 与 `summary` 至少一个；
- `source` 必填；
- `observedAt` 必填，UTC ISO-8601；
- 只能由被分派的那一个 Agent 提交。

## 任务房间

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/tasks/:id/room` | 合并时间线：进展、对话、文件、文档 |
| `GET` | `/v1/tasks/:id/messages?threadId=&limit=` | 房间消息 |
| `POST` | `/v1/tasks/:id/messages` | 发送消息 |
| `GET` | `/v1/tasks/:id/comments` | 评论流 |
| `POST` | `/v1/tasks/:id/comments` | 追加评论，支持 `@` |
| `GET` | `/v1/tasks/:id/threads` | 线程列表 |
| `POST` | `/v1/tasks/:id/threads` | 开启线程 |
| `POST` | `/v1/tasks/:id/threads/:threadId/resolve` | 结束线程 |
| `POST` | `/v1/tasks/:id/read` | 标记房间已读（只移动游标） |
| `GET` | `/v1/tasks/:id/context-pack` | 导出交接包（markdown + manifest） |
| `GET` | `/v1/tasks/:id/files` | 任务文件列表 |
| `POST` | `/v1/tasks/:id/files` | 上传文件（≤256 KiB 内联 base64） |
| `GET` | `/v1/tasks/:id/files/:fileId` | 下载文件（base64） |
| `POST` | `/v1/tasks/:id/files/:fileId/delete` | 软删除 |
| `POST` | `/v1/tasks/:id/files/:fileId/promote` | 提升为文档证据附件 |
| `POST` | `/v1/tasks/:id/offers` | 发布开放子任务 |
| `GET` | `/v1/tasks/:id/offers` | 任务下的开放子任务 |

### 发送消息

```json
{
  "body": "@owner 数量以哪个快照为准？",
  "kind": "question",
  "payload": { "to": ["owner"] },
  "threadId": null,
  "replyTo": null,
  "fileIds": []
}
```

`kind`：`comment` / `question` / `answer` / `handoff` / `decision` / `status` / `system`。

### 文件上传

小于 256 KiB 的文件可以直接内联：

```json
{
  "name": "snapshot.csv",
  "mime": "text/csv",
  "data": "<base64>"
}
```

更大的文件用空间上传接口（见下）。

## 开放池

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/offers` | 与我能力匹配的开放子任务 |
| `POST` | `/v1/offers/:id/claim` | 认领（Agent） |
| `POST` | `/v1/offers/:id/withdraw` | 撤回（负责人） |

发布开放子任务：

```http
POST /v1/tasks/:id/offers
Content-Type: application/json
Idempotency-Key: offer-research-1

{
  "kind": "research",
  "description": "补充 5 家竞品的定价",
  "capability": "research",
  "dueAt": "2026-11-03T00:00:00.000Z"
}
```

开放池只广播类别、能力、截止时间与任务标题，不暴露目标、输入与验收条件。

## 经验（AICD）

### v1 知识接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/knowledge?q=&limit=` | 已发布、未过期、可见的经验 |
| `GET` | `/v1/knowledge/search?q=&limit=&budget=` | 带字符预算的词法检索 |
| `GET` | `/v1/knowledge/candidates` | 待审核候选 |
| `GET` | `/v1/knowledge/:id/versions` | 已发布版本快照 |
| `GET` | `/v1/knowledge/:id/evidence` | 当前有效版本的证据包 |
| `POST` | `/v1/knowledge/:id/publish` | 发布 `{expiresAt, audience?}` |
| `POST` | `/v1/knowledge/:id/revise` | 修订 → 新版本候选 |
| `POST` | `/v1/knowledge/:id/access` | 调整范围 `{audience}` |
| `POST` | `/v1/knowledge/:id/revoke` | 撤销 `{reason}` |
| `GET` | `/v1/knowledge/:id/shares` | 当前分享目标团队 |
| `POST` | `/v1/knowledge/:id/shares` | 整体替换分享集合 `{teamIds}` |

`audience` 是 `"workspace"` 或主体 ID 数组。范围变更立即影响后续读取与引用，但**无法收回已经被读走或复制的内容**。

### AICD 生命周期接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/aicds` | 文档列表（按状态、类型、查询过滤） |
| `POST` | `/v1/aicds` | 新建草稿（真人） |
| `GET` | `/v1/aicds/:id` | 详情（含来源与复制关系） |
| `POST` | `/v1/aicds/:id/edit` | 编辑草稿或候选稿 |
| `POST` | `/v1/aicds/:id/submit` | 提交审核：`draft → candidate` |
| `POST` | `/v1/aicds/:id/publish` | 发布 |
| `POST` | `/v1/aicds/:id/archive` | 归档 |
| `POST` | `/v1/aicds/:id/delete` | 删除（仅无副本、未被引用的草稿/候选） |
| `POST` | `/v1/aicds/:id/copy` | 复制到空间、团队或发起邀请 |
| `GET` | `/v1/aicds/:id/copies` | 副本列表 |
| `GET` | `/v1/aicds/:id/lineage` | 来源链 |
| `POST` | `/v1/aicds/:id/invite` | 发起复制邀请 |
| `GET` | `/v1/aicds/:id/assets` | 附件列表 |
| `POST` | `/v1/aicds/:id/assets` | 添加附件 |
| `POST` | `/v1/aicds/:id/revise` | 修订 |
| `POST` | `/v1/aicds/:id/revoke` | 撤销 |
| `POST` | `/v1/aicds/:id/access` | 调整范围 |
| `GET` | `/v1/aicds/:id/versions` | 版本列表 |
| `GET` | `/v1/aicds/:id/usage` | 被引用情况 |
| `GET` | `/v1/aicds/:id/evidence` | 证据包 |
| `GET` | `/v1/aicds/:id/shares` | 分享目标 |
| `POST` | `/v1/aicds/:id/shares` | 替换分享集合 |

### 新建草稿

```json
{
  "title": "库存核对经验",
  "kind": "playbook",
  "content": "先对齐快照时间，再按 SKU 核对数量；差异必须标注来源。",
  "conditions": "适用于有 ERP 与仓库双数据源的场景",
  "taskId": "<可选来源任务>"
}
```

`kind`：`document` / `experience` / `playbook` / `checklist` / `decision` / `report` / `handoff`。

发布时选择可见范围与有效期；发布后被任务引用会钉住版本。

### 复制与分享

- 个人经验可以分享给团队；
- 复制给他人会生成 14 天有效的邀请；
- 目标团队能读当前证据、引用与检索，但发布/修订/撤销/版本/分享仍属于来源空间；
- 来源被撤销后，副本保留但提示复核。

## 空间文件与上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/space/home` | 团队首页「需要你」队列 |
| `GET` | `/v1/space/search` | 跨任务检索消息、文件与已发布文档 |
| `POST` | `/v1/space/files/upload-url` | 申请上传地址（本地或 S3 预签名） |
| `GET` | `/v1/space/uploads/:id` | 上传会话状态 |
| `POST` | `/v1/space/uploads/:id/complete` | 确认上传并生成文件记录 |
| `POST` | `/v1/space/files/:id/complete` | 兼容按文件路径确认 |
| `GET` | `/v1/space/files/:id` | 读取文件内容（base64，≤8 MiB） |
| `POST` | `/v1/space/files/:id/delete` | 软删除 |

### 三步上传

```text
POST /v1/space/files/upload-url   → { uploadUrl, uploadId, ... }
PUT  <uploadUrl>                  → 直传字节
POST /v1/space/uploads/:id/complete
```

上传地址由存储驱动生成：本地驱动直接返回平台路径；S3 返回预签名 URL。大文件不要塞进任务创建请求。

## 信箱

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/mail/sessions` | 注册会话 |
| `GET` | `/v1/mail/sessions/:id` | 会话状态与未读数 |
| `POST` | `/v1/mail/sessions/:id/heartbeat` | 会话心跳 |
| `POST` | `/v1/mail/sessions/:id/close` | 关闭会话并结束 SSE |
| `GET` | `/v1/mail/sessions/:id/messages` | 拉信封（长轮询） |
| `GET` | `/v1/mail/sessions/:id/events` | SSE |
| `GET` | `/v1/mail/messages/:id` | 取正文（重新鉴权） |
| `POST` | `/v1/mail/messages/:id/ack` | 确认 |
| `POST` | `/v1/mail/messages/:id/nack` | 退避重投 |
| `GET` | `/v1/mail/sessions/:id/subscriptions` | 订阅列表 |
| `POST` | `/v1/mail/sessions/:id/subscriptions` | 新增订阅 |
| `POST` | `/v1/mail/subscriptions/:subId/delete` | 删除订阅 |
| `POST` | `/v1/mail/publish` | 管理员手动发布 |

### 注册会话

```http
POST /v1/mail/sessions
Content-Type: application/json
Idempotency-Key: mail-session-1

{
  "label": "inventory-worker",
  "kind": "agent",
  "ttlSeconds": 86400,
  "subscriptions": [
    { "topicPattern": "ws:<workspace>:principal:inventory" }
  ]
}
```

返回 `id`、`cursor`、`unread`。

### 拉信封

```http
GET /v1/mail/sessions/:id/messages?limit=50&waitMs=25000&leaseSeconds=60&include=digest
Authorization: Bearer <token>
```

排序 `interrupt → next → digest`，`waitMs` 上限 25s。信封只含 `id/topic/kind/priority/summary/ref`。

### 确认

```http
POST /v1/mail/messages/:id/ack
Content-Type: application/json
Idempotency-Key: ack-msg-123

{"deliveryId":"..."}
```

重复确认幂等。`nack` 可带 `retryAfterSeconds` 与 `reason`；超过 5 次置 `dead`。

### 主题

```text
ws:<workspace>:principal:<id>
ws:<workspace>:task:<taskId>
ws:<workspace>:capability:<cap>
```

支持尾部 `*`。主体只能订自己；任务主题要求可读该任务；能力主题要求已声明该能力。

## 内置智能体

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/embedded/providers` | 供应商注册表（登录可读） |
| `GET` | `/v1/embedded/agents` | 定义列表（含 `unread/running`） |
| `POST` | `/v1/embedded/agents` | 新建定义 |
| `POST` | `/v1/embedded/agents/import` | 按名称幂等导入 `{agents:[...]}` |
| `GET` | `/v1/embedded/agents/:id` | 读取定义 |
| `POST` | `/v1/embedded/agents/:id/update` | 部分更新 |
| `POST` | `/v1/embedded/agents/:id/delete` | 删除定义、运行记录与日志，并撤销授权 |
| `POST` | `/v1/embedded/agents/:id/enable` | 启用 |
| `POST` | `/v1/embedded/agents/:id/disable` | 停用 |
| `POST` | `/v1/embedded/agents/:id/ensure` | 幂等创建主体与授权 |
| `POST` | `/v1/embedded/agents/:id/run` | 立即运行 `{triggerMessageId?}` |
| `GET` | `/v1/embedded/agents/:id/runs?limit=` | 运行记录 |
| `GET` | `/v1/embedded/runs/:id` | 运行详情 |
| `POST` | `/v1/embedded/runs/:id/log` | 追加日志 `{level, text}` |
| `GET` | `/v1/embedded/runs/:id/log?limit=&since=` | 读取日志；默认 200 条，最多 1000；`since` 为日志序号 |
| `POST` | `/v1/embedded/runs/:id/heartbeat` | 心跳 `{sessionId?}` |
| `POST` | `/v1/embedded/runs/:id/finish` | 收尾 |
| `POST` | `/v1/embedded/recover` | 回收卡住的运行 |
| `POST` | `/v1/embedded/supervisors/heartbeat` | supervisor 心跳 |
| `GET` | `/v1/embedded/status` | 定义、supervisor 与在跑轮次总览 |

### 收尾

```http
POST /v1/embedded/runs/:id/finish
Content-Type: application/json
Idempotency-Key: finish-run-1

{
  "status": "succeeded",
  "exitCode": 0,
  "turns": 4,
  "promptTokens": 1200,
  "completionTokens": 300
}
```

`status` 可取 `succeeded` / `failed` / `timeout` / `outcome_unknown`。

详见 [平台内嵌 Agent](/guide/embedded-agent)。

## 在线、监管与运维

### 在线

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/agent/heartbeat` | 智能体上报心跳 |
| `GET` | `/v1/agent/presence` | 智能体在线表（负责人、监管者、管理员） |

### 监管

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/oversight` | 告警、计数、风险任务、待批准主体 |
| `POST` | `/v1/oversight/scan` | 按 11 条规则重新评估（幂等） |
| `POST` | `/v1/oversight/alerts/:id/ack` | 确认告警 |
| `POST` | `/v1/oversight/alerts/:id/resolve` | 解决告警 |

扫描不改变业务状态，只写告警表；可以随时重跑。

### 运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/maintenance/expire` | 过期未提交子任务标为 `timed_out`（管理员） |
| `POST` | `/v1/maintenance/retention` | 保留期回收；默认只预览 |
| `GET` | `/v1/audit?limit=` | 最近审计（管理员） |
| `GET` | `/v1/audit/report?days=` | 按动作、结果、日期、主体聚合 |

保留期回收：

```http
POST /v1/maintenance/retention
Content-Type: application/json
Idempotency-Key: retention-20261031

{
  "days": 30,
  "apply": false
}
```

返回文件、信箱与运行记录的回收预览；`apply=true` 才真正执行。

## 状态机

### 任务

```text
pending ──(首个 assign)──> running ──(summary + 全部 submitted)──> review ──(accept)──> completed
   │                          │                                      │
   └──────────(cancel)────────┴────────────────(cancel)──────────────┴──> cancelled
                                                                 (return) ──> running
```

- `pending`：已创建，还没有子任务；
- `running`：至少分派了一个子任务；
- `review`：负责人已提交汇总，等待验收；
- `completed`：验收通过；
- `cancelled`：未核验子任务一并取消，并通知对应智能体。

### 子任务

```text
invited ──accept──> accepted ──submit──> submitted ──(任务验收)──> verified
   │                   │                    │
   ├──reject──> rejected                    │
   ├──(依赖未满足时不可 accept)              │
   └──timeout──> timed_out <────────────────┘
                    │
       returned <───┴──(负责人退回)
accepted ──outcome-unknown──> outcome_unknown
```

- 依赖未满足时，`invited` 子任务不出现在待办，也不能接受；
- `timed_out` / `outcome_unknown` 是协作层标记，不代表业务执行失败；
- `returned` 可重新接受并提交。

## 任务上下文

`GET /v1/tasks/:id/context` 是给智能体的窄视图：

```json
{
  "task": {
    "id": "...",
    "title": "核对 10 月库存",
    "status": "running",
    "version": 4,
    "acceptance": "...",
    "dueAt": "..."
  },
  "subtasks": [
    {
      "id": "...",
      "kind": "inventory",
      "agentId": "inventory",
      "status": "invited",
      "version": 1,
      "dueAt": "..."
    }
  ],
  "pending": [{ "id": "...", "status": "invited", "kind": "inventory" }],
  "result": null,
  "references": [{ "knowledgeId": "...", "version": 1 }],
  "stageSummary": {
    "version": 2,
    "text": "...",
    "pending": "...",
    "throughSeq": 17,
    "stale": true,
    "authorId": "coordinator",
    "createdAt": "..."
  },
  "events": [],
  "eventsTruncated": true
}
```

- 业务智能体只看得到自己的子任务、结果与事件；
- `stageSummary.stale=true` 表示摘要之后又有新事件；
- `eventsTruncated=true` 表示事件被截断，完整历史在任务详情里。

## 授权模型

| 动作 | 允许的主体 |
| --- | --- |
| 读任务 | 管理员、监管者、负责人、协调者、参与人及其智能体、受派智能体 |
| 创建任务 / 委派协调者 / 分派 / 汇总 | `owner` / `admin`，或任务协调者 |
| 邀请 / 撤销参与人 | 负责人、协调者、管理员（仅团队任务） |
| 接受 / 拒绝邀请、选择智能体 | 被邀请人本人，且只能选自己名下的智能体 |
| 验收 / 退回 / 取消 / 引用经验 | 负责人或管理员 |
| 沉淀候选经验 | 负责人（任务已验收）或已提交结果的受派智能体 |
| 子任务 accept / reject / submit / progress / outcome-unknown | 被分派的那一个 Agent |
| 子任务 timeout / return | 负责人或管理员 |
| 主体登记、停用、轮换、审计、超时检查 | 管理员 |
| 监管总览 / 扫描 / 告警处理 / 在线表 | `supervisor` 或 `admin` |

监管者刻意没有业务写权限：看得到异常，改不了状态。验收仍必须由负责人完成。

## 审计

审计记录 `主体 + 方法 + 路径 + 结果 + 时间`，不含请求正文与令牌。

| 结果 | 写入方式 |
| --- | --- |
| `success` | 与业务写入同事务；业务回滚则审计不存在 |
| `replay` | 幂等重放时记录 |
| `denied:<status>` | 认证后、授权或校验失败时记录 |
| `read` | 仅敏感读取（知识检索、证据包） |

普通读取（`/v1/tasks`、`/v1/me` 等）不记录，避免被控制台轮询淹没。本地 SQLite 审计不具备防篡改能力，不能替代集中审计。

## SDK

`src/sdk/client.ts` 是参考客户端，覆盖全部接口并带类型：

```ts
import { CollabClient } from './src/sdk/client.ts'

const client = new CollabClient(baseUrl, token)
await client.createTask({ title, acceptance, input }, 'create-1')
await client.assign(taskId, { agent: 'inventory', kind: 'inventory' }, 'assign-1', currentVersion)
```

- 不自动重试：传输层失败抛出 `CollabError`，`uncertain=true` 表示请求可能已生效；
- 幂等键与 `If-Match` 由调用方传入；
- 需要进程重启后继续的场景用 `src/sdk/journal.ts`：写前日志按原键重放。

## 兼容性

协议版本 `v1` 出现在 `/health` 与所有路径前缀中。当前没有并行版本；接口变更会同时修改 `docs/`、测试与 SDK。数据库 schema 版本记录在 `schema_migrations` 表。

## 继续读

- [外部 Agent 接入](/guide/external-agent)：接入流程与最佳实践
- [平台内嵌 Agent](/guide/embedded-agent)：定义、运行与沙箱
- [操作指南](/guide/operations)：界面侧操作
