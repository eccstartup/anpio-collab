---
title: 平台内嵌 Agent
description: 在平台里定义智能体，由 supervisor 按需拉起一次性会话，在沙箱中执行任务。
---

# 平台内嵌 Agent

平台可以自己“养”智能体：定义存在数据库里，平时没有进程；supervisor 发现谁有未读，就拉起一个**一次性的 session 子进程**，跑完即退出。

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
supervisor（常驻，不加载模型）
  └─ 有未读 → node src/runtime/session.ts
       ├─ 独立运行目录（0700，默认结束后清理）
       ├─ 拉信封 → 取正文 → 模型循环 → 调用协作工具 → ack
       └─ 提交结果 → 写运行记录 → 退出
```

两端的职责：

| 组件 | 职责 |
| --- | --- |
| 平台服务 | 保存定义、派生令牌、管理运行记录、接收心跳与日志 |
| supervisor | 扫描未读、拉起 session、回收卡住的运行 |
| session | 一次具体执行：拉消息、调模型、调工具、提交、退出 |

## 前置条件

服务端与 supervisor 必须共享同一个密钥：

```bash
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 只放环境变量，不要进库或进 Git
npm start
```

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
  "tools": ["task_get", "task_accept", "task_progress", "task_submit", "task_comment", "knowledge_search", "read_file", "list_files", "finish"],
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
| `scopes` | 授权范围；至少一项，且自动补齐 `tasks:read`、`mailbox:read`、`mailbox:write` |
| `limits` | `maxTurns` 1–50，`timeoutMs` 1s–1h，`maxTokens` 256–200,000 |
| `sandbox` | shell 开关、shell 超时、输出截断 |
| `enabled` | 停用后不会被叫醒 |
| `concurrency` | 同一定义并发，1–8 |

### 协议

运行时按 `provider.protocol` 选适配器：

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

| 工具 | 作用 |
| --- | --- |
| `task_get` | 读任务详情 |
| `task_accept` | 接受子任务 |
| `task_progress` | 上报进展 |
| `task_submit` | 提交结果（必须带 `source` 与 `observedAt`） |
| `task_comment` | 写评论 |
| `knowledge_search` | 检索可读经验 |
| `shell` | 执行 shell（受沙箱与超时限制） |
| `read_file` | 读运行目录内文件 |
| `write_file` | 写运行目录内文件 |
| `list_files` | 列运行目录 |
| `finish` | 结束本轮并给出摘要 |

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

## 运行 supervisor

### 跑一轮

```bash
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime -- --once
```

适合 cron / 调试。只跑一个定义：

```bash
npm run runtime -- --once --agent <agentId>
```

### 常驻

```bash
COLLAB_AGENTS_FILE=examples/agents.json \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

启动时会把定义文件按名称 upsert 进去。

### 参数与环境

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_RUNTIME_TOKEN` | 无 | supervisor 调管理接口，需要 `admin` |
| `COLLAB_BASE_URL` | `http://127.0.0.1:<PORT>` | 平台地址 |
| `COLLAB_EMBEDDED_SECRET` | 无 | 派生令牌；两端一致 |
| `COLLAB_RUNTIME_TICK_MS` | `3000` | 扫描间隔，最小 200 |
| `COLLAB_RUNTIME_CONCURRENCY` | `2` | 全局并发 |
| `COLLAB_AGENTS_FILE` | 无 | 启动时同步的定义文件 |
| `COLLAB_RUN_ROOT` | `./collab-runs` | 运行目录根 |
| `COLLAB_KEEP_RUN` | `0` | `1` 保留运行目录 |
| `COLLAB_SANDBOX_EXEC` | `0` | `1` 在 macOS 用 `sandbox-exec` 再包一层 |

## 运行生命周期

```text
running → succeeded
        ↘ failed
        ↘ timeout
        ↘ outcome_unknown
```

- supervisor 有未读才 spawn；
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

## 沙箱边界

内置智能体的沙箱包括：

- 独立运行目录，权限 `0700`；
- 工作目录路径校验与符号链接逃逸拒绝；
- 子进程环境清洗：拿不到 `COLLAB_TOKEN`、`*_API_KEY`、`DATABASE_URL`；
- 令牌只走 stdin；
- shell 超时与输出截断；
- 工具白名单。

::: warning 不是容器
它不是容器级隔离。需要强隔离时，把 supervisor 放进容器或独立用户下运行，并限制网络出口。
:::

`COLLAB_SANDBOX_EXEC=1` 只在 macOS 上用 `sandbox-exec` 多包一层（默认拒绝网络、只允许写运行目录）。起不来会让这一轮失败，而不是静默降级。

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

**supervisor 报“需要 COLLAB_RUNTIME_TOKEN”**

它用管理员令牌调平台接口，不能拿内置智能体的派生令牌代替。

**报“服务器未配置 COLLAB_EMBEDDED_SECRET” / 子进程 401**

服务端与 supervisor 的 `COLLAB_EMBEDDED_SECRET` 不一致，或服务端没设。两边改成同一个值，重启服务后重新 `ensure`（下一次运行会自动做）。

**运行记录一直 `running`**

先看 supervisor 是否在跑、日志里有没有 `▶` / `■`。心跳超过阈值后，`recover` 会把它标成 `outcome_unknown`。

**控制台点「立即运行」后没动静**

需要有一个启用的 supervisor 连着同一平台；控制台只负责建运行记录。

**想换模型供应商**

控制台「内置智能体 → 编辑」里按分类选，或导入 JSON 改 `provider`；自定义供应商必须填 `baseUrl` 与 `protocol`。

**运行目录去哪了**

默认在 `./collab-runs/<agentId>/<runId>/`，结束后删除。排查时设 `COLLAB_KEEP_RUN=1`，排查完手动删除；平台不会自动回收保留目录。

**每次运行都像失忆**

这是设计：不继承上一次对话与工作目录。需要长期记忆，请显式写回任务、评论或经验。

## 下一步

- [外部 Agent 接入](/guide/external-agent)：自己跑进程的接入方式
- [部署指南](/guide/deployment#五、调度器与-supervisor)：生产上的 supervisor 部署
- [API Reference](/api/reference#内置智能体)：接口细节
