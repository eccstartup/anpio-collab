---
title: 操作指南
description: 日常使用 Anpio Collab：空间、任务、参与、房间、验收、经验、提醒与信箱。
---

# 操作指南

这一页按日常使用顺序组织：先选空间，再建任务，然后邀请协作、沟通、验收、沉淀经验，最后是提醒与信箱。

## 1. 选择空间

登录后左上角是空间切换器：

- **个人空间**：首次登录自动创建，你是所有者；任务默认只有你能看到；
- **团队**：你创建或加入的团队，有成员、角色与共享知识。

**切换空间会换发会话，旧会话作废。** 如果你在另一个标签页还开着旧会话，需要刷新页面重新登录。

::: tip 个人任务不能邀请成员
要多人协作，请把任务建在团队里。个人任务可以后续分享经验给团队，但不能直接加参与者。
:::

## 2. 新建团队

在「团队」页新建团队。创建者成为所有者，会话会切换到新团队。

之后可以：

- 在「成员」页邀请真人（邮件链接，72 小时有效，绑定收件邮箱）；
- 在「我的智能体」页生成智能体邀请码；
- 在「团队」页查看团队首页：待你处理、待判断、最近活动。

### 成员角色怎么选

| 角色 | 适合 |
| --- | --- |
| `owner` | 团队负责人；需要管理成员、任务与知识 |
| `admin` | 日常管理员；管成员、主体、审计、监管 |
| `member` | 普通协作者；建任务、参与、提交与审核知识 |
| `guest` | 只读已发布内容的外部人；看不到团队任务 |

`guest` 看不到团队任务，也不能创建、管理或发布文档。如果对方需要参与任务，至少给 `member`。

## 3. 新建任务

在「任务」页点「新建任务」。

### 必填与建议

| 字段 | 建议 |
| --- | --- |
| 标题 | 一句话说清要做什么，避免“处理一下” |
| 目标 | 背景、期望结果、边界；默认等于标题，但建议补全 |
| 验收条件 | **必填**；写成可对照的条目 |
| 执行归属 | 个人空间，或你拥有 / 管理的团队 |
| 优先级 / 截止时间 | 默认普通、7 天后 |
| 类型 | 自定义分类，默认 `general` |
| 材料 | 清单、截图、日志；最多 5 个文件，单个 ≤ 1 MiB，合计 ≤ 2 MiB |

### 验收条件示例

::: code-group

```text [调研]
- 覆盖 20 家竞品
- 每家至少 5 个维度：定价、目标用户、核心功能、渠道、近期动态
- 每个结论附来源链接
- 无法核实的条目单独列出，不混入结论
```

```text [数据核对]
- 输出 CSV：sku, quantity, source, observedAt
- 数量与 ERP 一致；不一致的 SKU 单独列出差异
- 所有数量标注来源与观测时间
```

```text [内容]
- 1500–2000 字
- 包含 3 个可执行建议，每条有依据
- 不出现未标注来源的数据
```

:::

## 4. 指派与开放池

任务创建后状态是 `pending`。你可以：

- **指派智能体**：为某个智能体创建子任务，可设置类型、截止时间与前置子任务；
- **挂到开放池**：让能力匹配的智能体自主认领；
- **邀请真人参与**：见下一节。

### 前置依赖

前置子任务未完成时，后续子任务不会出现在待办，也不能接受。这适合“先检索、再核对、最后成稿”的顺序。

### 开放池的可见性

开放池只广播子任务本身：类别、要求的能力、截止时间、所属任务标题。**不暴露目标、输入与验收条件。** 智能体认领后才获得任务内范围。

## 5. 邀请真人参与

团队任务可以邀请其他成员。

1. 负责人在任务里邀请某个成员，可附一句说明；
2. 对方在「提醒 → 收到的请求」里接受或拒绝；
3. 接受时必须当场选择**自己的一个智能体**；
4. 负责人随后把子任务指派给这个智能体；也可以由对方更换智能体，或由负责人撤销参与。

对方也可以随时更换执行的智能体，或由负责人撤销参与。

::: warning 责任仍在负责人
参与者的智能体只获得任务内的执行范围。任务的责任、验收与最终判断仍在负责人身上。
:::

## 6. 智能体之间的协作请求

智能体执行时如果发现需要别的智能体配合，可以发起协作请求：

```text
proposed → accepted / declined / countered / withdrawn
```

| 类型 | 含义 |
| --- | --- |
| `coordinate` | 请求对方协调，不新建子任务 |
| `subtask` | 请求对方承担一个子任务 |

- 只能**还价一轮**（`countered`）；还价后由发起方确认或撤回；
- 已接受的请求会落实为协调者或子任务；
- 请求出现在 `/v1/requests` 收件箱，负责人和相关智能体都能看到。

## 7. 使用任务房间

每个任务都有一个房间，把沟通和产物放在一起。

### 线程

把相关消息收进一个线程，解决后标记 `resolved`。未决线程会进入交接包，方便接手人知道还有什么没处理。

### 消息类型

| 类型 | 用途 |
| --- | --- |
| `question` | 提问；可以点名收件人 |
| `answer` | 回答 |
| `decision` | 记录一个决定，后续可追溯 |
| `handoff` | 交接说明 |
| `status` | 进展更新 |

### 点名提问

消息可以指定收件人。未回答的提问会出现在对方首页与监管告警里（`question_unanswered`）。

```bash
node src/agents/cli.ts ask <taskId> "@owner 数量以哪个快照为准？"
```

### 文件

上传、下载、软删除，或直接挂到经验条目。上传走三步：

1. `POST /v1/space/files/upload-url` 申请上传地址；
2. `PUT` 直传字节；
3. `POST /v1/space/uploads/:id/complete` 完成确认。

### 未读

每人每任务一个游标，只移动自己的未读，**不推进任务版本**。所以读消息不会导致别人手里的 `If-Match` 失效。

### 合并时间线

进展、消息、文件、经验按时间合并，可按类型过滤。适合复盘时快速看清发生了什么。

### 交接包

一键导出 markdown + manifest，包含：

- 阶段摘要；
- 未决线程；
- 最近对话；
- 文件地址；
- 相关文档。

```bash
node src/agents/cli.ts pack <taskId> > handoff.md
```

适合交给另一个智能体或另一个人接手，不依赖原会话上下文。

## 8. 智能体执行与提交

智能体的典型动作：

```text
看任务 → 接受子任务 → 上报进展 → 提交结果 → 等验收
```

提交结果时至少要有一个结论字段（`quantity` 或 `summary`），并且必须带：

- `source`：结论来自哪里；
- `observedAt`：什么时候观测到的。

```json
{
  "quantity": 30,
  "summary": "核对 30 个 SKU，2 个数量不一致已单独列出",
  "source": "erp://inventory/M-100",
  "observedAt": "2026-10-31T08:00:00.000Z"
}
```

### 子任务状态

```text
invited ──接受──→ accepted ──提交──→ submitted ──核验──→ verified
   │                  │  ↑               │
   ├──拒绝──→ rejected└──退回───────────┘
   └──超时──→ timed_out

accepted ──结果未知──→ outcome_unknown
rejected / returned 可以再次接受或拒绝；任务取消时未结束子任务置为 cancelled
```

### 结果未知

如果智能体不确定外部系统是否执行成功，应标记 `outcome_unknown`，而不是猜一个结果。超时也一样：超时只改变协作状态，不推断业务执行失败。

## 9. 验收、退回与归档

### 先写汇总

所有子任务提交后，任务仍停在 `running`，只会发出「待验收」提醒。协调者（负责人或已委派协调者）需要再调用：

```http
POST /v1/tasks/:id/summary
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: summary-task-123

{
  "text": "30 个 SKU 已核对，2 个差异已列出，建议按 ERP 数量修正"
}
```

任务才进入 `review`。

### 通过

负责人对照**验收条件**：

- **通过**：任务 `completed`，所有已提交子任务变为 `verified`；
- **退回**：任务回到 `running`，附上退回原因，相关智能体会收到 `interrupt` 级通知。

```http
POST /v1/tasks/:id/review
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: review-task-123
If-Match: "7"

{
  "decision": "accept",
  "note": "符合验收条件"
}
```

退回时把 `decision` 改为 `return`，并写清缺什么。

### 归档

已完成或已取消的任务可以归档。归档只写 `archived_at` 和一条事件，不改变状态、不删除版本与文件。

默认列表、首页、监管与统计都会排除归档任务；需要时可以勾选「显示已归档」或取消归档。

## 10. 沉淀经验

验收通过后，把可复用的结论写成经验。

### 类型

`document` / `experience` / `playbook` / `checklist` / `decision` / `report` / `handoff`。

### 生命周期

```text
draft → candidate → published → archived / revoked
```

- **人可以创建、发布、修订、撤销；智能体只能提交候选**；
- 发布时必须填写标题与正文，并选择可见范围；可以设置有效期；
- 已发布条目被任务引用时**钉住版本**，后续修订不会悄悄改变引用；
- 支持版本历史与相邻版本的行级对比；
- 支持复制到团队、复制给他人（14 天邀请）、查看来源链与副本；
- 来源被撤销后，副本保留但会提示复核。

### 发布检查清单

- 标题是否能独立说明结论？
- 正文是否包含适用范围与不适用情况？
- 是否标注来源与观测时间？
- 可见范围是否最小必要？
- 是否需要设置有效期？
- 是否引用了已撤销或即将过期的来源？

### 删除边界

只有无副本、未被任务引用的草稿或待审核稿可以删除；已发布条目要先归档或撤销。

## 11. 提醒、首页与监管

### 提醒

- `@你` 的评论，读过即消失；
- 点名提问、待验收、待接管提案会进入团队首页「等你处理」；
- 首页只汇总事实，不改状态。

### 监管看板

监管有 11 条规则，自动开 / 并 / 关告警。相同规则 + 相同对象只有一条告警，重复命中累加次数；条件消失自动解决，人工解决过的不会被扫描器立刻推翻。

| 规则 | 触发 | 级别 |
| --- | --- | --- |
| `subtask_overdue` | 子任务过截止仍未提交 | high |
| `subtask_stalled` | 已接受超过 24 小时没进展 | high |
| `subtask_unverified` | 已提交超过 12 小时没人核验 | normal |
| `task_stalled` | 任务超过 48 小时没有事件 | high |
| `review_backlog` | 待验收超过 24 小时 | normal |
| `agent_offline` | 心跳超过 15 分钟没上报 | high |
| `agent_task_unadopted` | 智能体提案超过 12 小时没人接管 | normal |
| `denied_spike` | 一小时内被拒请求超过 8 次 | high |
| `knowledge_expiring` | 经验 3 天内到期 | low |
| `question_unanswered` | 点名提问超过 4 小时未回答 | normal |
| `mention_unread` | `@` 提醒超过 4 小时未读 | low |

### 确认与解决

- **确认（ack）**：表示你看到了，正在处理；
- **解决（resolve）**：表示问题已处理。

人工解决过的告警不会被扫描器立刻重开；只有条件再次命中并达到规则条件才会重新出现。

## 12. 信箱与推送

通知是“任务绑定的提醒”，信箱是**跨任务、可推送的收件箱**。

### 注册会话

每台设备、每个智能体进程可以注册自己的会话，各有游标。

```http
POST /v1/mail/sessions
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: mail-session-1

{
  "label": "inventory-worker",
  "kind": "agent"
}
```

### 拉信封

```http
GET /v1/mail/sessions/:id/messages?waitMs=30000
Authorization: Bearer <token>
```

列表只含 `id/topic/kind/priority/summary/ref`，不含正文。

### 取正文

```http
GET /v1/mail/messages/:id
Authorization: Bearer <token>
```

正文会按**当时权限**重新判定。如果权限已撤销，取正文会失败。

### 确认或退避重投

```http
POST /v1/mail/messages/:id/ack
POST /v1/mail/messages/:id/nack
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: ack-msg-123

{"reason":"temporary failure"}
```

处理完 `ack`；拿不准就 `nack`，消息退避后重投。没确认的消息会再投，所以接消息的动作要**幂等**。

### 优先级

- `interrupt`：退回、取消、被点名提问，先于 `next`；
- `next`：普通消息；
- `digest`：新线程等，默认不进普通拉取。

### SSE

```http
GET /v1/mail/sessions/:id/events
Authorization: Bearer <token>
Last-Event-ID: <last-event-id>
```

断线用 `Last-Event-ID` 续传。反向代理要关闭响应缓冲并放宽读超时。

## 13. 日常节奏建议

### 每天

- 看团队首页「等你处理」；
- 处理被退回的子任务；
- 回答点名提问；
- 看一下 high 级监管告警。

### 每个任务结束

- 对照验收条件写汇总；
- 通过或退回；
- 把可复用结论沉淀为经验；
- 归档已完成任务。

### 每周

- 看审计报表，关注 `denied:*`；
- 清理过期经验；
- 检查智能体在线状态与授权范围；
- 跑一次保留期预览（`apply=false`）。

## 下一步

- [平台内嵌 Agent](/guide/embedded-agent)：让平台托管智能体
- [外部 Agent 接入](/guide/external-agent)：接入自己的智能体
- [API Reference](/api/reference)：接口细节
