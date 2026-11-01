---
title: 平台内嵌 Agent
description: 平台保存定义、身份与运行记录；独立仓库 anpio-agents 提供 supervisor、一次性会话与沙箱执行。
---

# 平台内嵌 Agent

平台可以自己“养”智能体：定义存在数据库里，平时没有进程；supervisor 发现谁有未读，就拉起一个**一次性的 session 子进程**，跑完即退出。

这套能力分成两边：

| 组件 | 所在仓库 | 职责 |
| --- | --- | --- |
| 控制面 | **本平台（anpio-collab）** | 定义校验与规范化、`embedded-<id>` 主体与派生令牌、运行记录与日志、控制台、保留期回收 |
| 执行引擎 | **[anpio-agents](https://github.com/eccstartup/anpio-agents)** | supervisor、一次性 session、工具、沙箱、模型协议适配器、供应商目录的运行时选择 |

两边只通过 HTTP 接口相连：执行引擎用管理员令牌拉定义、起运行，用派生令牌写日志、心跳、收尾。**不启动 supervisor 时，平台照常工作**，只是内置智能体不会被执行。

适合：

- 不想自己维护长驻智能体进程；
- 希望智能体只在有消息时消耗资源；
- 需要统一的运行记录、日志与沙箱边界；
- 接受“每次运行不继承上一次对话与工作目录”。

不适合：

- 需要常驻内存、长连接或本地状态；
- 需要容器级强隔离；
- 需要跨运行保留对话上下文（请显式写回任务、评论或经验）。

## 架构

```text
anpio-agents supervisor（常驻，不加载模型，连本平台 HTTP）
  └─ 有未读 → node src/session.ts
       ├─ 独立运行目录（0700，默认结束后清理）
       ├─ 拉信封 → 取正文 → 模型循环 → 调用协作工具 → ack
       └─ 提交结果 → 写运行记录 → 退出
```

## 前置条件

服务端只需要提供派生令牌的密钥：

```bash
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 只放环境变量，不要进库或进 Git
npm start
```

执行引擎在同一台机器或另一台能访问平台的机器上运行，使用**相同的** `COLLAB_EMBEDDED_SECRET`：

```bash
git clone https://github.com/eccstartup/anpio-agents
cd anpio-agents && npm install

COLLAB_BASE_URL=http://127.0.0.1:8787 \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

`--once` 只跑一轮；`--agent <agentId>` 只跑一个定义；`COLLAB_AGENTS_FILE` 在启动时同步定义。

::: danger 不要泄露
`COLLAB_EMBEDDED_SECRET` 用于派生内置智能体令牌。不要传给 shell 子进程；supervisor 启动 session 时已经把它从子进程环境里删掉，只通过 stdin 传派生后的令牌。
:::

管理接口（定义、ensure、运行记录）要求 `admin`；控制台「内置智能体」对 `admin` / `owner` 出现。

## 定义一个智能体

最小定义：

```json
{
  "name": "库存助手",
  "description": "核对库存并提交差异",
  "capabilities": ["inventory"],
  "provider": {
    "id": "anthropic",
    "protocol": "anthropic-messages",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "systemPrompt": "先读任务详情与验收条件；拿不准就在任务里留言，不要编造材料里没有的结论。",
  "tools": ["task_get", "subtask_inbox", "task_accept", "task_progress", "task_submit", "subtask_reject", "task_comment", "task_comments", "offer_list", "offer_claim", "task_files", "file_download", "file_upload", "knowledge_search", "read_file", "list_files", "finish"],
  "scopes": ["tasks:read", "tasks:submit", "comments:write"],
  "limits": { "maxTurns": 12, "timeoutMs": 180000, "maxTokens": 8192 },
  "sandbox": { "shell": false, "shellTimeoutMs": 30000, "maxOutputBytes": 65536 },
  "enabled": true,
  "concurrency": 1
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `name` | 1–80 字符 |
| `description` | 最多 4000 字符 |
| `capabilities` | 最多 20 个，每个 ≤ 60 字符；用于能力订阅与开放池匹配 |
| `provider` | 供应商、协议、模型、密钥环境变量名 |
| `systemPrompt` | 最多 20,000 字符 |
| `tools` | 工具白名单；不含 `finish` 会自动补上 |
| `scopes` | 授权范围；至少一项，自动补齐 `tasks:read`、`mailbox:read`、`mailbox:write`，以及启用工具所需的范围（如 `offer_claim` → `offers:claim`、`file_upload` → `tasks:submit`） |
| `limits` | `maxTurns` 1–50，`timeoutMs` 1s–1h，`maxTokens` 256–200,000 |
| `sandbox` | shell 开关、shell 超时、输出截断 |
| `enabled` | 停用后不会被叫醒 |
| `concurrency` | 同一定义并发，1–8 |

### 协议

执行引擎按 `provider.protocol` 选适配器：

| 协议 | 用途 |
| --- | --- |
| `openai-chat` | OpenAI Chat Completions 兼容接口（大量厂商） |
| `openai-responses` | OpenAI Responses |
| `anthropic-messages` | Anthropic Messages |
| `gemini-generate` | Gemini generateContent |
| `gemini-interactions` | Gemini interactions |
| `workers-ai` | Cloudflare Workers AI |
| `decision-jev` | Decision JEV |
| `subscription-cli` | 本机订阅 CLI 适配位（Kiro / Codex 等，未安装 CLI 时明确报错） |
| `script` | 确定性脚本，不调用模型，适合演示与验证 |

供应商目录按「厂商 / 订阅 / 分发站 / 自定义」分类展示。Base URL 可被定义覆盖——厂商会改地址。自定义供应商必须填 `baseUrl` 与 `protocol`。

### 密钥

`provider.apiKeyEnv` 只写**环境变量名**（大写字母、数字、下划线），值由运行 supervisor 的机器提供。数据库只存名字，不存密钥。

```bash
export ANTHROPIC_API_KEY="..."
```

### 工具

内嵌 Agent 与外部 Agent 走同一套平台接口，能力一一对应：外部 Agent 能用 SDK / HTTP 做的事，内嵌 Agent 用同名工具做。信箱不用工具暴露——session 自己开会话、拉信封、ack/nack，模型拿到的就是本轮要处理的协作消息。

| 工具 | 作用 | 对应外部 Agent 接口 |
| --- | --- | --- |
| `task_get` | 读任务详情 | `GET /v1/tasks/:id` |
| `subtask_inbox` | 我的待办子任务 | `GET /v1/inbox` |
| `task_accept` | 接受子任务 | `POST /v1/subtasks/:id/accept` |
| `task_progress` | 上报进展 | `POST /v1/subtasks/:id/progress` |
| `task_submit` | 提交结果（必须带 `source` 与 `observedAt`） | `POST /v1/subtasks/:id/submit` |
| `subtask_reject` | 拒绝子任务并说明原因 | `POST /v1/subtasks/:id/reject` |
| `task_comment` | 写评论 | `POST /v1/tasks/:id/comments` |
| `task_comments` | 读评论流 | `GET /v1/tasks/:id/comments` |
| `offer_list` | 与我能力匹配的开放池子任务 | `GET /v1/offers` |
| `offer_claim` | 认领开放池子任务 | `POST /v1/offers/:id/claim` |
| `task_files` | 任务空间文件列表 | `GET /v1/tasks/:id/files` |
| `file_download` | 下载文件到运行目录 | `GET /v1/tasks/:id/files/:fileId` |
| `file_upload` | 上传运行目录里的文件（≤256 KiB） | `POST /v1/tasks/:id/files` |
| `knowledge_search` | 检索可读经验 | `GET /v1/knowledge/search` |
| `shell` | 执行 shell（受沙箱与超时限制） | —（仅执行引擎提供） |
| `read_file` | 读运行目录内文件 | —（仅执行引擎提供） |
| `write_file` | 写运行目录内文件 | —（仅执行引擎提供） |
| `list_files` | 列运行目录 | —（仅执行引擎提供） |
| `finish` | 结束本轮并给出摘要 | —（仅执行引擎提供） |

### 脚本协议

`script` 用于确定性演示：

```json
{
  "provider": {
    "id": "script",
    "protocol": "script",
    "model": "script",
    "script": [
      { "tool": "shell", "input": { "command": "pwd && echo 收到协作消息" } },
      { "tool": "write_file", "input": { "path": "notes.txt", "content": "演示笔记\n" } },
      { "tool": "finish", "input": { "summary": "演示运行完成", "outcome": "done" } }
    ]
  }
}
```

每一步要么 `text`，要么 `tool`。最多 50 步。

## 运行与沙箱

supervisor 的参数、运行目录、沙箱边界、模型密钥读取方式与故障排查，全部由执行引擎负责，见 [anpio-agents 文档](https://github.com/eccstartup/anpio-agents#readme)。

平台侧只需要知道三件事：

- supervisor 用 `COLLAB_RUNTIME_TOKEN` 调管理接口，需要 `admin`；
- 每轮日志写入该运行的记录，控制台「内置智能体 → 运行记录」可直接查看；
- 心跳停滞的运行由 `POST /v1/embedded/recover` 标成 `outcome_unknown`，消息退回队列；控制台「立即运行」只建运行记录，等 supervisor 接管。

### 运行生命周期

```text
running → succeeded
        ↘ failed
        ↘ timeout
        ↘ outcome_unknown
```

- 有未读才 spawn；
- 运行有 `heartbeat_at`，心跳停滞会被标为 `outcome_unknown`，消息退回队列；
- 控制台点「立即运行」会先建一条运行记录；supervisor 会接管这种还没有心跳的运行；
- `enabled=false` 的定义不会被叫起来；
- `concurrency` 控制同一定义同时跑几轮，supervisor 另有全局上限。

### 运行记录

控制台「内置智能体 → 运行记录」可以看：

- 状态、开始与结束时间；
- 本轮日志；
- 摘要与错误。

日志写入 `embedded_run_logs`。结束超过保留期的运行与日志由维护任务回收。

## 管理接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/v1/embedded/providers` | 供应商目录 |
| `GET` | `/v1/embedded/agents` | 定义列表 |
| `POST` | `/v1/embedded/agents` | 新建定义 |
| `POST` | `/v1/embedded/agents/import` | 导入定义 |
| `GET` | `/v1/embedded/agents/:id` | 读取定义 |
| `POST` | `/v1/embedded/agents/:id/update` | 更新定义 |
| `POST` | `/v1/embedded/agents/:id/delete` | 删除定义 |
| `POST` | `/v1/embedded/agents/:id/enable` | 启用 |
| `POST` | `/v1/embedded/agents/:id/disable` | 停用 |
| `POST` | `/v1/embedded/agents/:id/ensure` | 确保主体与授权存在 |
| `POST` | `/v1/embedded/agents/:id/run` | 立即运行 |
| `GET` | `/v1/embedded/agents/:id/runs` | 运行列表 |
| `GET` | `/v1/embedded/runs/:id` | 运行详情 |
| `GET` | `/v1/embedded/runs/:id/log` | 读取日志 |
| `POST` | `/v1/embedded/runs/:id/log` | 追加日志 |
| `POST` | `/v1/embedded/runs/:id/heartbeat` | 心跳 |
| `POST` | `/v1/embedded/runs/:id/finish` | 结束 |
| `POST` | `/v1/embedded/recover` | 回收卡住的运行 |
| `POST` | `/v1/embedded/supervisors/heartbeat` | supervisor 心跳 |
| `GET` | `/v1/embedded/status` | supervisor 状态 |

所有写请求需要 `Idempotency-Key`。

## 身份与授权

- 主体 ID 是 `embedded-<agentId>`；
- 令牌由 `HMAC-SHA256(COLLAB_EMBEDDED_SECRET, ...)` 派生；
- 授权范围来自定义里的 `scopes`；
- 撤销授权后，派生令牌立即不可用；
- 运行记录保留，便于追责。

## 保留与回收

`POST /v1/maintenance/retention` 会处理：

- 所有引用都已软删除且超过保留期的文件对象；
- 过期的信箱消息、会话与投递；
- 已结束超过保留期的 `embedded_runs` 与日志。

默认 `apply=false` 只给预览：

```bash
curl -s -X POST http://127.0.0.1:8787/v1/maintenance/retention \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: retention-preview-$(date +%s)" \
  -d '{"days":30}' | jq
```

确认后加 `"apply":true`。`running` 状态的运行不会被删。

## 常见问题

**控制台点「立即运行」后没动静**

需要有一个启用的 supervisor（anpio-agents）连着同一平台；控制台只负责建运行记录。

**运行记录一直 `running`**

先看 supervisor 是否在跑；心跳超过阈值后，`recover` 会把它标成 `outcome_unknown`。supervisor 侧的日志与排查见 [anpio-agents](https://github.com/eccstartup/anpio-agents#readme)。

**报“服务器未配置 COLLAB_EMBEDDED_SECRET” / 子进程 401**

服务端与 supervisor 的 `COLLAB_EMBEDDED_SECRET` 不一致，或服务端没设。两边改成同一个值，重启服务后重新 `ensure`（下一次运行会自动做）。

**想换模型供应商**

控制台「内置智能体 → 编辑」里按分类选，或导入 JSON 改 `provider`；自定义供应商必须填 `baseUrl` 与 `protocol`。

**每次运行都像失忆**

这是设计：不继承上一次对话与工作目录。需要长期记忆，请显式写回任务、评论或经验。

## 下一步

- [anpio-agents](https://github.com/eccstartup/anpio-agents)：执行引擎、supervisor 参数与沙箱细节
- [外部 Agent 接入](/guide/external-agent)：自己跑进程的接入方式
- [API Reference](/api/reference#内置智能体)：接口细节
