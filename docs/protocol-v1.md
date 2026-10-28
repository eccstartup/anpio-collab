# 本地 HTTP 协议 v1

此协议是原型接口，可能变化；跨语言 Agent 无需共享数据库。服务仅监听 `127.0.0.1`，使用 JSON 和 `Authorization: Bearer <token>`。所有 POST 必须携带 `Idempotency-Key`：同一主体、同一键与同一请求可安全重放；如果路径或请求内容不同，返回 409。写入及去重结果在同一个 SQLite 事务中提交。错误返回 `{"error":"..."}` 和 HTTP 状态码。请求体上限 64 KiB。UTC 时间使用 `2026-10-28T00:00:00Z` 格式。

| 方法与路径 | 作用 | 主体 |
| --- | --- | --- |
| GET `/health` | 检查进程与协议版本 | 无需令牌 |
| GET `/v1/principals` | 查看工作空间主体目录 | 已认证主体 |
| GET `/v1/audit` | 查询最近 500 条访问与操作记录 | 管理员 |
| POST `/v1/principals` | 登记 `{id, roles, token}` | 管理员 |
| POST `/v1/principals/{id}/deactivate` | 停用主体并立即拒绝其令牌 | 管理员 |
| GET `/v1/tasks` | 列出可见任务 | 已认证主体 |
| POST `/v1/tasks` | 创建 `{title, material, quantity, due, acceptance}` | 负责人或管理员 |
| GET `/v1/tasks/{id}` | 读取授权任务；业务 Agent 只看到自身子任务，委派协调者可读取全部结果 | 负责人、受派 Agent、协调者或管理员 |
| POST `/v1/tasks/{id}/coordinators` | 委派协调 Agent `{principal}` | 负责人或管理员 |
| POST `/v1/tasks/{id}/remove-coordinator` | 撤销协调委派 `{principal}` | 负责人或管理员 |
| POST `/v1/tasks/{id}/assign` | 指派 `{agent, kind}` | 负责人、协调者或管理员 |
| GET `/v1/inbox` | 查看自身待处理子任务 | Agent |
| POST `/v1/subtasks/{id}/accept` | 接受邀请或退回任务，正文 `{}` | 受派 Agent |
| POST `/v1/subtasks/{id}/progress` | 记录已接受任务的进度 `{text}` | 受派 Agent |
| POST `/v1/subtasks/{id}/reject` | 拒绝 `{reason}` | 受派 Agent |
| POST `/v1/subtasks/{id}/submit` | 提交 `{result:{quantity?，summary?，source，observedAt，reference?}}（quantity 或 summary 至少一个）` | 已接受的受派 Agent |
| POST `/v1/subtasks/{id}/timeout` | 人工标记邀请或已接受的子任务超时 `{note}`；不推断业务失败 | 负责人或管理员 |
| POST `/v1/subtasks/{id}/return` | 退回已提交、已拒绝或超时的子任务 `{note}` | 负责人或管理员 |
| POST `/v1/tasks/{id}/summary` | 所有子任务提交后汇总 `{text}` | 负责人、协调者或管理员 |
| POST `/v1/tasks/{id}/stage-summaries` | 保存阶段摘要及未决事项 `{text,pending}`，记录覆盖到的事件序号 | 负责人、协调者或管理员 |
| POST `/v1/tasks/{id}/review` | 验收或退回 `{decision:"accept" 或 "return", note}` | 负责人或管理员 |
| POST `/v1/tasks/{id}/cancel` | 取消 `{note}` | 负责人或管理员 |
| POST `/v1/tasks/{id}/knowledge` | 从已完成任务创建候选 `{content,conditions}` | 负责人或管理员 |
| POST `/v1/knowledge/{id}/publish` | 发布 `{expiresAt, audience}`；audience 为主体 ID 数组或 `"workspace"`，省略时仅审核人和管理员可见 | 审核人或管理员 |
| POST `/v1/knowledge/{id}/access` | 更新共享范围 `{audience}`，立即影响后续读取和引用 | 审核人或管理员 |
| POST `/v1/knowledge/{id}/revoke` | 撤销 `{reason}` | 审核人或管理员 |
| POST `/v1/knowledge/{id}/revise` | 创建新版本候选 `{content,conditions,reason}`，重新审核前不返回有效结果 | 审核人或管理员 |
| GET `/v1/knowledge/{id}/versions` | 查看已发布版本快照 | 审核人或管理员 |
| GET `/v1/knowledge?q=...` | 简单子串检索本工作空间已发布且未过期经验，最多 100 条 | 已认证主体 |
| GET `/v1/knowledge/candidates` | 查询待审核经验 | 审核人或管理员 |
| POST `/v1/tasks/{id}/references` | 引用有效经验 `{knowledgeId}` | 负责人或管理员 |
| GET `/v1/tasks/{id}/evidence/{knowledgeId}/{version}` | 读取该任务已引用的历史发布版本及当前状态；每次重新检查任务和知识授权 | 负责人、协调者或管理员 |

外部 Agent 可用任意语言实现上述 HTTP 接口；`sdk/client.ts` 和 `agents-ts/worker.ts` 是示例。进程收到任务后应持久保存操作 ID 和待提交的完整内容，重试时保持二者不变；超时后查询状态，不能把超时视为业务失败。示例 worker 读取静态模拟数据，以 `COLLAB_WORKER_DB` 指定独立的本地 SQLite 请求日志，重启时重放未确认请求；权限或状态冲突会停止处理并保留记录，须人工核对。这不证明任意故障下的可靠恢复或真实业务操作安全重试。

令牌是本机演示的共享密钥，不代表企业身份或 DID。知识可按主体或整个工作空间共享；审核人和管理员拥有治理访问权。旧数据库中没有范围记录的知识保持原有工作空间共享行为，需审核人主动收紧；修订后发布必须重新指定范围，省略时不向普通主体共享。范围限制知识查询、引用及任务详情中的知识事件和引用元数据，不能收回已经读出或复制的信息。不得将本原型直接暴露公网，也不能把它当作企业隔离验证。提供命令行桥接供用户操作的 Agent 调用；Claude Code、Codex 的专用适配和端到端验收尚未完成。

## 用户自带 Agent 的命令行桥接

用户可将 `COLLAB_URL` 和由管理员分配的 `COLLAB_TOKEN` 放在 Agent 的受控运行环境中，调用 `node agents-ts/cli.ts inbox` 查询任务，`node agents-ts/cli.ts accept SUBTASK_ID OP_ID` 接受，再以 `node agents-ts/cli.ts submit SUBTASK_ID OP_ID < result.json` 提交。JSON 可包含 `summary`、`source`、`observedAt` 和可选 `reference`；示例缺料任务也使用 `quantity`。操作 ID 与待提交的完整 JSON 必须由调用方持久保存，重试保持一致，避免重复或冲突。该桥接不自动启动、配置或授权 Claude Code / Codex，也不读取其私有会话；对应产品的完整接入仍需单独验收。

审计记录保存主体、路径、结果和时间，不保存请求正文或令牌。成功写入的审计与业务操作同事务；认证后拒绝和读取操作单独记录。此本地 SQLite 审计不具备防篡改或远程保留保证，认证失败和进程崩溃也不保证完整记录，不可替代生产审计。

旧数据库首次升级时，从当前已发布或撤销的知识记录补建版本快照；旧格式未保存的历史版本无法补回，补建快照的时间使用旧记录的创建时间。

当前知识检索是 SQLite 子串匹配，无语义检索、中文分词、相关性排序或截断标记；不能作为计划中混合检索及评测的完成证明。

超时目前由负责人手动标记，不执行定时调度；超时后应先与外部系统核对实际状态，再决定是否退回重新处理。

## 分页与恢复上下文

`GET /v1/tasks/page?limit=20&offset=0` 返回 `{items,nextOffset}`；limit 为 1–100，offset 为非负整数。排序为创建时间及 ID，分页期间有新任务进入时可能移动位置，长期同步应按任务 ID 去重。

`GET /v1/tasks/{id}/context` 返回任务状态和版本、验收条件、截止时间、可见子任务、未决状态、结果、引用和最近 20 个可见事件；`eventsTruncated` 表示事件是否截断。负责人、协调者或管理员可读取最新阶段摘要，摘要保存版本、作者、时间和覆盖的事件序号；有新事件时 `stale` 为 true。摘要由提交者编写，仅用于导航，不能替代事件或原始证据。业务 Agent 看不到其他 Agent 的结果、事件和阶段摘要。该接口尚不提供历史时间点查询。

SDK 提供 `context(id)` 和 `tasksPage(limit,offset)`；用户 Agent 桥接支持 `node agents-ts/cli.ts context TASK_ID`。

## 持久通知

`GET /v1/notifications` 返回当前 Agent 最早的 100 条未确认通知；邀请和退回与业务状态在同一事务写入。`POST /v1/notifications/{id}/ack` 确认收到通知，需幂等键；仅接收者可确认。重复读取会返回相同 ID，重复确认安全。确认不会接受任务或改变业务状态；处理前仍须查询当前任务，旧通知可能对应已经取消或完成的任务。通知保存在平台数据库中并随备份恢复；当前采用 HTTP 拉取，不代表已接入 ANP 或外部消息服务。SDK 提供 `notifications()` 和 `acknowledge(id, op)`。
