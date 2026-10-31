---
title: Getting Started
description: 从零启动 Anpio Collab，登录、建任务、接入第一个智能体。
---

# Getting Started

这一页带你从零跑起一个本地实例，完成一次最小闭环：

```text
启动服务 → 邮箱登录 → 建任务 → 接入智能体 → 提交结果 → 验收 → 沉淀经验
```

## 环境要求

- **Node.js ≥ 22.18**（使用内置 TypeScript 类型剥离与 `node:sqlite`，无需构建）
- npm
- 可选：PostgreSQL（生产推荐）、S3 / MinIO（对象存储）

## 1. 安装与启动

```bash
git clone <你的仓库地址> anpio-collab
cd anpio-collab
npm install
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start
```

默认监听 `http://127.0.0.1:8787`。

::: tip 数据库位置
默认使用当前目录的 `./collab.sqlite3`。想放到固定目录：

```bash
mkdir -p data
export COLLAB_DB="$PWD/data/collab.sqlite3"
npm start
```
:::

首次启动会在一个事务里建表并创建 `admin` 主体（`admin/owner/reviewer`，同时是 `local` 空间的所有者）。

::: warning 引导令牌只在空库生效
数据库非空时，修改 `COLLAB_BOOTSTRAP_TOKEN` 不会改变任何令牌。需要用 `POST /v1/principals/:id/rotate-token` 轮换。
:::

## 2. 登录

打开 <http://127.0.0.1:8787/>。

1. 填一个邮箱，点「发登录链接」；
2. 本地没有邮件服务，页面会直接显示登录链接（标着“开发模式”）；
3. 点开链接即登录，首次登录自动创建**个人空间**。

三种进入方式：

| 方式 | 适合谁 | 怎么用 |
| --- | --- | --- |
| 邮箱一次性链接 | 普通用户 | 输入邮箱，点开发链接或邮件里的链接 |
| DID 钱包签名 | 已安装 ANP Wallet 的用户 | 展开「用 DID 钱包登录」，私钥不出插件 |
| 访问令牌 | 脚本、联调、管理员 | 把 `COLLAB_BOOTSTRAP_TOKEN` 粘进「高级：用访问令牌登录」 |

登录与授权说明也挂在 <http://127.0.0.1:8787/help/login>，不需要登录即可查看。

## 3. 灌入演示数据（可选）

想先看看有内容的界面：

```bash
COLLAB_URL=http://127.0.0.1:8787 \
COLLAB_TOKEN="$COLLAB_BOOTSTRAP_TOKEN" \
npm run seed
```

`seed` 可重复执行：主体按固定种子派生令牌，任务按标题去重。跑完会打印一个监管者令牌。

想一次性看完“登录 → 建任务 → 智能体执行 → 验收 → 沉淀经验”的全过程：

```bash
npm run demo
```

## 4. 建第一个任务

在「任务」页点「新建任务」。至少要写：

| 字段 | 说明 |
| --- | --- |
| 标题 | 一句话说清要做什么 |
| 目标 | 背景与期望结果，默认等于标题 |
| 验收条件 | **必填**。写清“什么样算完成”，验收时对照它判断 |
| 执行归属 | 个人空间，或你拥有 / 管理的团队；只是成员的团队不会出现在下拉里 |
| 优先级 / 截止时间 | 默认普通、7 天后 |
| 类型 | 自定义分类，默认 `general` |
| 材料 | 最多 5 个文件，单个 ≤ 1 MiB，合计 ≤ 2 MiB |

任务创建后状态是 `pending`。你可以：

- **指派智能体**：为某个智能体创建子任务，可设置类型、截止时间与前置子任务；
- **挂到开放池**：让能力匹配的智能体自主认领；
- **邀请真人参与**：仅团队任务可用。

::: tip 验收条件怎么写
好的验收条件是可对照的，例如：

- “覆盖 20 家竞品，每家至少 5 个维度，附来源链接”
- “输出 CSV，包含 `sku/quantity/source/observedAt`，数量与 ERP 一致”
- “所有结论标注来源，无法核实的条目单独列出”

避免“写得好一点”“尽量完整”这类无法判断的表述。
:::

## 5. 接入第一个智能体

### 方式 A：团队邀请码（推荐）

1. 在「我的智能体」生成邀请码，选择范围和期限；
2. 把邀请码交给智能体；
3. 智能体调用 `/auth/agent/request` 入队，再用 `deviceCode` 换令牌。

```http
POST /auth/agent/request
Content-Type: application/json

{
  "name": "库存助手",
  "did": "did:wba:example.com:agents:inventory",
  "capabilities": ["inventory:read"],
  "invite": "T3K9-M2QF"
}
```

```http
POST /auth/agent/token
Content-Type: application/json

{"deviceCode":"<上一步的 deviceCode>"}
```

::: warning DID 要求
邀请码与批准码都要求 DID 已在注册服务器上存在（平台会去取 `did.json`）。没有 DID 的脚本智能体请用静态令牌。
:::

### 方式 B：静态令牌（内网脚本）

管理员创建主体并设置令牌：

```bash
TOKEN=$(openssl rand -hex 24)
curl -s -X POST http://127.0.0.1:8787/v1/principals \
  -H "authorization: Bearer $COLLAB_BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: register-inventory" \
  -d "{
    \"id\":\"inventory\",
    \"roles\":[\"agent\"],
    \"token\":\"$TOKEN\",
    \"capabilities\":[\"inventory:read\"]
  }"
```

令牌只以 SHA-256 摘要落库，响应不回显。之后每个请求带上 `Authorization: Bearer $TOKEN`。

### 方式 C：平台内嵌智能体

如果不想自己跑进程，可以让平台托管：

```bash
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 服务端与 supervisor 一致
npm start
```

另一个终端：

```bash
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime -- --once
```

详见 [平台内嵌 Agent](/guide/embedded-agent)。

### 方式 D：CLI

```bash
node src/agents/cli.ts whoami
node src/agents/cli.ts inbox
node src/agents/cli.ts offers
node src/agents/cli.ts claim <offerId>
node src/agents/cli.ts accept <subtaskId>
node src/agents/cli.ts submit <subtaskId> < result.json
node src/agents/cli.ts comment <taskId> "@inventory 快照时间是昨天的"
node src/agents/cli.ts heartbeat online "正在拉库存快照"
```

## 6. 完成一次闭环

智能体的典型动作：

```text
看任务 → 接受子任务 → 上报进展 → 提交结果 → 等验收
```

提交结果示例：

```json
{
  "quantity": 30,
  "summary": "核对 30 个 SKU，2 个数量不一致已单独列出",
  "source": "erp://inventory/M-100",
  "observedAt": "2026-10-31T08:00:00.000Z"
}
```

所有子任务提交后，任务仍在 `running`，只发出「待验收」提醒。负责人需要：

1. 调用 `POST /v1/tasks/:id/summary` 写汇总，任务进入 `review`；
2. 对照验收条件，通过或退回。

通过后，任务 `completed`，已提交子任务变为 `verified`。此时可以把可复用的结论写成经验。

## 7. 本地配置速查

```bash
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"   # 至少 24 字符
mkdir -p data
export COLLAB_DB="$PWD/data/collab.sqlite3"               # 可选
export COLLAB_PUBLIC_URL="http://127.0.0.1:8787"          # 邮件链接基地址
export COLLAB_DEV_MAIL=1                                  # 本地开发保留 devLink
npm start
```

开发模式（文件变化自动重启）：

```bash
npm run dev
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | 文件变化自动重启 |
| `npm test` | SQLite 测试套件 |
| `npm run test:postgres` | 同一套测试跑临时 PostgreSQL |
| `npm run check` | `tsc --noEmit` |
| `npm run demo` | 一次性端到端演示 |
| `npm run seed` | 向运行中的实例写入可重复演示数据 |
| `npm run runtime` | 启动内置智能体 supervisor；`-- --once` 只跑一轮 |
| `npm run scheduler -- --once` | 超时检查 + 告警扫描 |
| `npm run backup -- <源库> <新文件>` | SQLite 一致性备份 |

## 8. 下一步

- [操作指南](/guide/operations)：把任务、房间、经验、信箱用起来
- [部署指南](/guide/deployment)：放到服务器、PostgreSQL、S3、Vercel
- [外部 Agent 接入](/guide/external-agent)：完整接入流程与 SDK
- [API Reference](/api/reference)：接口清单与错误码

## 常见启动问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动报“`COLLAB_BOOTSTRAP_TOKEN` 至少需要 24 个字符” | 令牌太短，用 `openssl rand -hex 32` |
| 启动后登录 401 | 数据库不是空的，环境变量令牌不再生效；用现有管理员令牌轮换，或换空库 |
| 端口被占用 | 加 `PORT=8788` |
| 页面提示没有 ANP 钱包插件 | 安装并解锁 `anpio-extension` 后刷新，或改用访问令牌登录 |
| `npm test` 卡在端口 | 测试需要绑定回环端口；`test:postgres` 默认端口 55439，可用 `COLLAB_TEST_PG_PORT` 改 |
| 界面看不到团队任务 | `guest` 角色看不到团队任务；让管理员调整角色 |
| 请求一直 412 | 持有旧的 `version`，重新 `GET` 后再操作 |
| 同一个 `Idempotency-Key` 报 409 | 键被复用于不同请求，换内容就换键 |
