# Anpio Collab

企业内多智能体协作的**后端 + 人类控制台**：人定任务与验收条件，协调智能体拆分工，业务智能体在各自授权范围内执行，结果由人验收；只有通过验收的结论才能沉淀为可检索、带范围和有效期的经验。

本仓库是可单机运行的参考实现：一个进程、一个数据库文件、一个无构建的管理台，加上可独立部署的智能体进程。目标、边界与阶段验收见 [plan.md](plan.md)。

## 快速开始

要求 Node.js ≥ 22.18（使用内置的 TypeScript 类型剥离与 `node:sqlite`，无需构建、无需转译）。

```sh
npm install                                   # 唯一的运行时依赖是 pg
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start                                     # 首次启动创建 admin 主体与 local 工作空间
```

浏览器打开 <http://127.0.0.1:8787/>，粘贴上面那个令牌登录。

想直接看到有内容的界面，再灌一份演示数据（三条处于不同阶段的任务、一条已发布经验、一条待审核候选）：

```sh
COLLAB_TOKEN="$COLLAB_BOOTSTRAP_TOKEN" npm run seed
```

`seed` 可重复执行：主体按固定种子派生令牌，任务按标题去重，不会越灌越多。

## 控制台里有什么

| 视图 | 内容 |
| --- | --- |
| 工作台 | 概览统计、需要你判断的任务、最近活动（跨任务事件流） |
| 任务 | 列表与详情：验收条件、输入、子任务表、汇总、引用经验、事件时间线，以及随状态出现的动作（委派、分派、提交汇总、验收、退回、取消、沉淀经验） |
| 经验库 | 已发布与待审核两个页签；带字符预算的检索、修订、调整共享范围、版本历史、撤销、审核发布 |
| 参与者 | 人与智能体的目录、角色、能力声明、登记与停用 |
| 审计 | 写操作、幂等重放、被拒绝的请求与敏感读取；普通轮询式读取不记录 |

界面是无框架的原生 JS：没有构建步骤，只用 DOM 节点拼装（不用 `innerHTML` 渲染服务端内容），并在 CSP 下运行。

## 代码结构

```
src/
  protocol/            协议层：类型、错误码、入参解析（不依赖数据库与 HTTP）
  platform/
    db/                驱动（SQLite / PostgreSQL）、命名参数编译、schema 与迁移、行映射
    services/          领域服务：主体、任务、子任务、知识、通知、审计
    http/              路由表、写执行器、服务器（认证、CSP、错误映射）
    tools/             备份、超时调度
    app.ts/context.ts  组装依赖、注入 now 与 newId
  sdk/                 供智能体与外部程序使用的客户端，含写前日志
  agents/              示例智能体：worker、coordinator、命令行桥接
  web/                 管理台（index.html / app.css / app.js）
tests/                 30 项端到端测试，同一套用例跑 SQLite 与 PostgreSQL
examples/              一次性纵向演示与示例数据
scripts/               演示数据填充、PostgreSQL 测试脚本
```

## 一次写请求怎么走

1. **认证**：`Authorization: Bearer <token>`，令牌只以 SHA-256 摘要落库；每次请求重新读取主体状态。
2. **路由**：`src/platform/http/routes.ts` 里一行一个接口，`/v1/tasks/:id/...` 在启动时编译成正则，命中即得参数。
3. **事务**：`executeWrite` 在一个事务里依次完成——主体仍然有效 → 幂等重放 → 资源级授权 → `If-Match` 版本比对 → 业务写入 → 事件 → 审计。
4. **事件**：每次业务变更都追加一条事件并推进 `tasks.version`，事件带单调 `seq`，时间线与动态流都读它。
5. **通知**：邀请与退回在**同一个事务**内写入通知，避免"状态变了但没人知道"。

读请求不开写事务，直接用只读连接（SQLite 用独立的只读连接 + WAL，PostgreSQL 用连接池）。

## 平台保证

- **幂等**：所有 POST 必须带 `Idempotency-Key`（1–200 字符）。同键 + 同请求返回上次结果并记 `replay` 审计；同键不同请求返回 409。重放会重新核对授权，但不重放业务写入。
- **乐观并发**：带版本的资源用 `If-Match: "<version>"` 比较，不匹配返回 412；子任务的流转用 `WHERE version = :expected` 条件更新，冲突返回 409。
- **事务一致性**：状态、事件、通知、幂等记录、审计同进同退；服务层嵌套开启事务会加入外层，不会自锁。
- **可见性**：负责人、协调者、管理员看全部；业务智能体只看分配给自己的子任务，看不到其他智能体的结果、事件与知识引用。
- **审计边界**：写操作、重放、拒绝、知识检索与证据包读取留痕；普通读取不记录，否则审计表会被界面轮询淹没。

不保证的部分：本地审计可被有文件权限的人改写，不能替代集中审计；令牌是共享密钥，不是企业身份或 DID；检索是词法匹配，不是语义检索。

## 角色

| 角色 | 能做 |
| --- | --- |
| `admin` | 主体登记/停用、查看全部任务与审计、所有 `reviewer` 能力 |
| `owner` | 创建任务、委派协调者、分派子任务、写汇总、验收/退回、取消、沉淀经验 |
| `reviewer` | 审核发布、修订、撤销经验、调整共享范围 |
| `agent` | 只看自己的待办；接受、拒绝、汇报进展、提交结果（带来源与观测时间）、标记结果未知 |

同一主体可以有多个角色；`admin` 不等同于负责人，验收仍然要求负责人本人。

## 智能体接入

三种方式，都是纯 HTTP，不共享数据库：

```sh
# 业务智能体：拉待办 → 接受 → 用本地数据作答 → 提交（含来源与观测时间）
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$INVENTORY_TOKEN \
COLLAB_KIND=inventory COLLAB_DATA=examples/data/inventory.json \
COLLAB_WORKER_DB=/tmp/inventory.sqlite node src/agents/worker.ts

# 协调智能体：一次性分派 + 汇总
COLLAB_URL=... COLLAB_TOKEN=$COORDINATOR_TOKEN COLLAB_TASK=<task-id> \
COLLAB_INVENTORY_AGENT=inventory COLLAB_SUPPLIER_AGENT=supplier \
node src/agents/coordinator.ts

# 人或用户自带的智能体：命令行桥接
node src/agents/cli.ts inbox
node src/agents/cli.ts submit <subtask-id> <operation-id> < result.json
```

业务智能体用 `COLLAB_WORKER_DB` 保存写前日志：请求发出后进程被杀，重启会先重放未确认的操作，因此不会因为"不知道请求有没有生效"而重复提交。它不会自动重试业务动作，遇到权限或状态冲突就停下等人核对。

用代码接入时直接用 SDK：

```ts
import { CollabClient } from './src/sdk/client.ts';

const client = new CollabClient('http://127.0.0.1:8787', token);
const inbox = await client.inbox();
const item = inbox[0];
await client.accept(item.id, `accept:${item.id}`);
await client.submit(item.id, {
  quantity: 30,
  source: 'erp://inventory/M-100',
  observedAt: new Date().toISOString(),
}, `submit:${item.id}`);
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务（`HOST`/`PORT`/`COLLAB_DB` 等见下表） |
| `npm run dev` | 同上，文件变化自动重启 |
| `npm test` | 30 项端到端测试（SQLite，每个用例独立临时库） |
| `npm run test:postgres` | 同一套测试跑在临时 PostgreSQL 实例上，验证方言差异 |
| `npm run check` | `tsc --noEmit` 类型检查 |
| `npm run demo` | 一次性纵向演示：建任务 → 分派 → 两个智能体进程执行 → 汇总 → 验收 → 沉淀经验 → 第二个任务引用 |
| `npm run seed` | 向运行中的实例写入可重复的演示数据 |
| `npm run backup -- <源库> <新文件>` | SQLite 一致性备份（`VACUUM INTO` + 完整性检查） |
| `npm run scheduler -- --once` | 调用一次超时检查；去掉 `--once` 则按 `COLLAB_SCHEDULER_INTERVAL_MS` 轮询 |

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COLLAB_BOOTSTRAP_TOKEN` | 无 | 首次启动时创建管理员的令牌，至少 24 字符；数据库已有主体时不再使用 |
| `COLLAB_BOOTSTRAP_ID` | `admin` | 首次启动创建的主体 ID |
| `COLLAB_WORKSPACE` | `local` | 工作空间标识 |
| `COLLAB_DB` / `DATABASE_URL` | `./collab.sqlite3` | SQLite 文件路径，或 `postgresql://` 连接串 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址；默认只监听回环 |
| `COLLAB_BODY_LIMIT` | `65536` | 请求体上限（字节） |
| `COLLAB_LOG_REQUESTS` | `0` | 设为 `1` 打印访问日志 |
| `COLLAB_WEB_ROOT` | `src/web` | 管理台静态文件目录 |

## 已知边界

- 单进程、单工作空间语义；没有多租户隔离、速率限制、反向代理与 TLS，**不要直接暴露到公网**。
- 知识检索是词法匹配（中文二元组 + 打分 + 字符预算截断），没有向量检索与评测集。
- 超时不自动触发：`/v1/maintenance/expire` 由运维进程显式调用，便于审计。
- 通知是数据库内的拉取式消息，尚未接入 ANP 或外部消息队列。
- 与 `anpio-key`（DID/身份）、`anpio-cli`（ANP 消息）、`anpio-extension` 的对接尚未开始，接口预留了 `did` 字段。
- 数据库迁移只有 v1；升级策略见 [运行说明](docs/local-operations.md)。

## 文档

- [协议 v1](docs/protocol-v1.md)：状态机、接口清单、错误码、幂等与版本语义
- [本地运行](docs/local-operations.md)：配置、备份恢复、PostgreSQL、故障排查
- [实现状态](docs/implementation-status.md)：已实现范围与 plan.md 阶段的对照
