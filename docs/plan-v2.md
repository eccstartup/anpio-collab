# 第二轮计划：ANP 身份接入、协作细化与监管

状态：已实施（第 1–8 节全部落地，验证结果见 [implementation-status.md](implementation-status.md)）｜日期：2026-10-28｜承接 [plan.md](../plan.md)

第一轮交付了"任务—子任务—验收—经验"的闭环，但身份仍是共享密钥，任务只能由人发起，界面是全局面板。本轮把这三处补上，让平台真正成为**人和智能体用同一个身份体系协作**的地方。

## 1. 目标与判断标准

| 目标 | 完成标准（可验证） |
| --- | --- |
| ANP 登录 | 浏览器用钱包插件签名登录；`anpio-cli anp login` 对同一端点登录成功；nonce 单次、过期拒绝、签名错误拒绝 |
| 身份与主体 | DID ↔ 主体绑定；一个主体可绑定多个 DID（人与智能体共用账号）；待批准与停用两条封路 |
| 智能体自发动作 | 智能体可自建任务（提案）、认领开放子任务、写评论、发心跳，全部落事件 |
| 可见性 | 智能体只看自己的任务与子任务；全局看板只对 `supervisor` / `admin` 开放 |
| 监管与报警 | 九条规则由扫描器落到 `alerts`；监管视图能定位"哪里出了问题"，可确认、可解决 |
| 回归 | 原有 30 项测试继续通过；新增身份、协作、监管测试跑通 SQLite 与 PostgreSQL |

## 2. 身份：ANP-02/03 登录

### 2.1 线上契约

平台只做**依赖方（relying party）**，不保管私钥、不代签。

```text
GET  /auth/anp/challenge            → { nonce, expiresAt, audience }
POST /auth/anp/login                → 200 { token, tokenType, principal, did, subject }
        body   { nonce, did, didDocument, [bindCode], [client] }
        header Signature-Input / Signature / Content-Digest
```

- **验签**：解析 `Signature-Input`（不写死覆盖分量），按 RFC 9421 重建 ASCII 签名基，用 `didDocument` 里 `keyid` 指向的 Ed25519 公钥验证 `Signature`；`content-digest` 必须等于实际字节的 SHA-256。
- **nonce**：一次性，5 分钟有效，落库 `anp_nonces`；已消费即拒绝。
- **未带 nonce 或 nonce 失效**：返回 `401` + `WWW-Authenticate: ANP nonce="..."`。这正是 `anpio-cli post_signed` 的挑战语义——它读到新 nonce 后会重签一次，所以**命令行客户端不需要为本平台改一行代码**。
- **成功响应**：token 同时放在 body（`token` / `token_type`）与 `Authentication-Info` 头，兼容两种读法。
- **subprotocol 客户端识别**：body 可选 `client: "browser" | "agent"`，只用于展示与默认角色，不参与授权。

### 2.2 主体落位

- 新 DID：默认按 `COLLAB_ANP_ENROLL` 处理
  - `open`（默认，便于本机验证）：直接建主体，浏览器登录给 `owner`，声明 `agent` 的给 `agent`；
  - `pending`：建主体但 `active=0`，登录返回 403 `enrollment_pending`，管理员在控制台一键批准；
  - `off`：拒绝陌生 DID。
- 已有 DID：直接建会话。
- **共用账号**：已有主体可签发绑定码（`POST /v1/me/identities/invite`）。智能体登录时带 `bindCode`，其 DID 绑到该主体上，于是"人 + 智能体同一个账号"——审计里仍能分辨是哪个 DID 做的。
- `identities` 表保存 DID → 主体、密钥指纹、登录次数；DID 轮换（新 key）不丢主体。

### 2.3 会话

- 会话令牌 32 字节随机，库内只存 SHA-256；`anp_sessions` 记录签发 DID、客户端、过期与撤销。
- `authenticate()` 先查会话再看旧版静态令牌，静态令牌保留给引导与管理脚本。
- 退出即撤销；管理员停用主体，所有会话下一次请求立刻失效（每次请求重新读主体）。

## 3. 协作：让智能体自己动起来

| 能力 | 接口 | 谁可以 |
| --- | --- | --- |
| 发起任务（提案） | `POST /v1/tasks`（`origin=agent`） | 智能体；任务归属自己，等待人接管 |
| 接管提案 | `POST /v1/tasks/:id/adopt` | 负责人 / 管理员；转移归属，落事件 |
| 发布开放子任务 | `POST /v1/tasks/:id/offers` | 负责人 / 协调者；按能力、期限发布 |
| 认领 | `POST /v1/offers/:id/claim` | 能力匹配的智能体；生成子任务、通知负责人 |
| 评论 | `POST /v1/tasks/:id/comments` | 所有能读该任务的人；支持 @ 提及 |
| 心跳 | `POST /v1/agent/heartbeat` | 智能体；维护在线状态 |
| 通知 | 沿用 `/v1/notifications` | 邀请、退回、认领、提及 |

原则不变：**平台只记录与协调，不替智能体判断业务结论**。认领产生的是 `invited` 子任务，仍需接受、执行、提交、验收。

任务新增字段：`origin`（human / agent）、`origin_principal_id`、`adopted_at`。子任务沿用原状态机，不引入"半完成"状态。

## 4. 可见性：各自只看自己的

- 智能体：`/v1/tasks` 只返回自己是受派方的任务；`/v1/principals` 只返回自己与合作过的主体（同任务内）；`/v1/activity` 只给自身上下文。
- 负责人 / 审核人：自己负责或协调的任务。
- `supervisor`（新增角色）/ `admin`：全局看板、监管视图、审计。
- 越权一律 404 或 403，且写审计；连续拒绝会触发报警规则。

## 5. 监管与报警

`GET /v1/oversight` 返回三块：**概览计数**、**告警列表**、**风险清单**（滞留任务、失联智能体、待批准主体）。

规则（默认阈值可通过环境变量调整）：

| 规则 | 级别 | 判定 |
| --- | --- | --- |
| `subtask_overdue` | high | 未终结子任务超过 `dueAt` |
| `subtask_stalled` | high | 已接受但 `updatedAt` 超过 24h 无变化 |
| `subtask_unverified` | normal | 已提交超过 12h 未核验 |
| `task_stalled` | high | 进行中/待验收任务超过 48h 无事件 |
| `review_backlog` | normal | 待验收超过 24h |
| `agent_offline` | high | 有未完成子任务但心跳超过 15min |
| `agent_task_unadopted` | normal | 智能体发起超过 12h 无人接管 |
| `denied_spike` | high | 1h 内被拒请求 ≥ 8 次 |
| `knowledge_expiring` | low | 已发布经验 3 天内到期 |

- 告警按 `(workspace, rule, subject)` 去重，重复命中只累加次数与 `lastSeenAt`；
- 生命周期 `open → acknowledged → resolved`，解决后同主体不再复发（直到状态再变）；
- 扫描由 `POST /v1/oversight/scan` 与 `npm run scheduler` 触发，不内置定时器（与第一轮一致）。

## 6. 界面

- **登录页**：钱包登录为主（检测 `window.anp` → 取 DID → 取挑战 → 签名 → 换会话），访问令牌为备用；分步提示当前卡在哪一步。
- **按角色分视图**：智能体进"我的工作台"（待办、我的任务、通知、心跳）；人进任务看板；`supervisor` / `admin` 多一个"监管"页。
- **任务详情**：子任务、评论流、开放认领、提案接管、时间线。
- 新增"监管"页：告警卡片按级别排序、智能体在线表、待批准主体。
- 视觉沿用现有排版与配色，不引入构建步骤与外部依赖。

## 7. 落地顺序

1. 协议类型与 schema v2（加列、加表，可重复执行）
2. `src/anp/`：DID 解析、base58、RFC 9421 签名/验签、智能体身份
3. 认证服务 + `/auth/anp/*` 路由（含挑战语义与限流）
4. 协作服务：评论、开放认领、提案接管、心跳
5. 监管服务与路由
6. SDK / 智能体 CLI 增加 `login`、`heartbeat`、`claim`、`comment`
7. 前端登录页、角色首页、监管页、任务详情
8. 测试、演示数据、文档

## 8. 明确不做

- 不做私钥托管、不做代签、不在服务端保存 DID 私钥；
- 不实现 anpio-key 的 grant 申请（那是本机守护进程的职责，平台只验签）；
- 不把 ANP 消息服务搬进本仓库：本轮只做**登录 + 平台 API**，消息仍走 anpio-cli 的 `AnpioAgent`；
- 不做多租户、TLS、速率限制的分布式实现。
