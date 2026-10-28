# Anpio Collab

企业内多智能体协作的**后端 + 人类控制台**：人定任务与验收条件，协调智能体拆分工，业务智能体在各自授权范围内执行，结果由人验收；只有通过验收的结论才能沉淀为可检索、带范围和有效期的经验。

第三轮把"谁能进来、进来属于谁"讲清楚了：**两种登录**（邮箱一次性链接 / DID 钱包签名）、**租户与成员**（一个账号可以在多个组织里有不同角色）、**智能体授权**（设备批准码，独立主体、最小范围、可单独撤销）。

本仓库是可单机运行的参考实现：一个进程、一个数据库文件、一个无构建的管理台，加上可独立部署的智能体进程。目标与边界见 [plan.md](plan.md)、[第二轮计划](docs/plan-v2.md) 与 [第三轮计划](docs/plan-v3.md)。

## 快速开始

要求 Node.js ≥ 22.18（使用内置的 TypeScript 类型剥离与 `node:sqlite`，无需构建、无需转译）。

```sh
npm install                                   # 唯一的运行时依赖是 pg
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start                                     # 首次启动创建 admin 主体与 local 工作空间
```

浏览器打开 <http://127.0.0.1:8787/>，三种进入方式：

- **邮箱登录（推荐）**：填一个邮箱 → 点「发登录链接」→ 本地没有邮件服务，页面会直接显示那条链接（标着"开发模式"）。点开即完成登录；第一次登录自动创建「个人组织」，你是所有者。
- **钱包登录**：装好 ANP Wallet 插件（`anpio-extension`）并解锁，展开「用 DID 钱包登录」。私钥不出插件，平台只验签。
- **令牌登录**：把 `COLLAB_BOOTSTRAP_TOKEN` 粘进「高级：用访问令牌登录」。

登录前想先弄明白这些关系，看 <http://127.0.0.1:8787/help/login>（不需要登录），或 [登录与授权说明](docs/login-and-authorization.md)。

想直接看到有内容的界面，再灌一份演示数据（四个主体、四条处于不同阶段的任务、一条已发布经验、一条待审核候选，外加逾期子任务、开放子任务、评论与心跳）：

```sh
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN="$COLLAB_BOOTSTRAP_TOKEN" npm run seed
```

`seed` 可重复执行：主体按固定种子派生令牌，任务按标题去重，不会越灌越多。跑完会打印一个 `supervisor`（监管者）令牌，用它登录能看到监管看板。

## 用 DID 登录

登录流程是 ANP-02（RFC 9421 签名 + `did:wba` 身份），**钱包和 CLI 走同一套接口**：

```
GET  /auth/anp/challenge            → { nonce, expiresAt }
POST /auth/anp/login  (签名请求)     → { token, did, principal, sessionExpiresAt }
                                    + Authentication-Info: access_token="..."

GET  /v1/me/identities/challenge    → { nonce, expiresAt }（需登录）
POST /v1/me/identities/bind (签名请求) → { did, primary, existing }（需登录）

GET  /v1/me/links                     → 这个账号的登录方式（邮箱 + DID）
POST /v1/me/emails/start  { email }    → { sent, expiresAt, [devLink] }（需登录）
```

- **DID 必须已注册**：登录与绑定都按 `did:wba` 去取 `<host>/<path>/did.json`，取不到就是"未注册"，直接拒绝。请求体里自带的 `didDocument` 不参与判断——否则谁都能编一份带自己公钥的文档来冒充。
- 签名基覆盖 `@method @target-uri @authority content-digest`，参数带 `created/expires/nonce/keyid`；`nonce` 一次性，验签失败不消耗。
- 首次登录自动登记：人 → `kind: human` + `owner`，智能体 → `kind: agent` + `agent`。`COLLAB_ANP_ENROLL=pending` 时先落为待批准，管理员在「参与者」里批准后才能读任何任务。
- **同一个账号**：人先签发绑定码（设置 → 签发绑定码），智能体登录时带上 `bindCode`，两条 DID 就挂同一个主体，共享任务、评论与验收记录。绑定码一次性，填错不会悄悄给新账号。
- **补绑 DID（设置里直接做）**：已经登录的人不用登出再登入——「设置 → 绑定我的 DID」让钱包对一次性挑战签一次名，这条 DID 就挂到当前账号；主体原本没有主 DID 时会顺手设成主身份。绑定码留给智能体、另一台设备或不在电脑前的场景。
- **反向也成立**：钱包先登录的人可以在「设置 → 登录方式 → 绑定邮箱」补一个邮箱，点开确认链接后就能用邮箱登录，进的是同一个账号。只填邮箱不算，必须点链接；绑定不换发会话。
- 绑定必须同时具备**有效会话**和**该 DID 的签名**：只有签名能挂到任意账号上，只有会话能把别人的 DID 抢过来。二者都满足才登记，且只增加归属，不给角色。
- 会话是 32 字节随机令牌，只存 SHA-256；可在「设置 → 会话」里逐个撤销，退出登录只撤销当前这一个。
- 内网部署若没有证书，DID 的 authority 写成 `host%3Aport` 并设 `COLLAB_DID_HTTP=1`；回环地址默认允许 http。

## 登录、租户与智能体授权

三层概念，先分清再谈权限：

| 概念 | 是什么 | 范围 |
| --- | --- | --- |
| 账号 | 一个可被证明的身份（邮箱或 DID） | 全局 |
| 租户 | 一个企业/团队，任务、经验、审计都属于它 | 全局 |
| 主体 | 账号在某个租户里的身份，角色挂在这里 | 租户内 |

推论：同一个人加入两个组织是两条主体、两套角色；任务与审计只认主体，所以跨租户隔离是天然的（所有查询本来就带 `workspace`）。

**登录**

| 方式 | 谁用 | 凭证 | 有效期 |
| --- | --- | --- | --- |
| 邮箱一次性链接 | 人 | 邮箱控制权 | 15 分钟，一次 |
| DID 签名 | 有 ANP 身份的人/智能体 | 私钥 + 已登记的 did.json | 会话 7 天 |
| 访问令牌 | 脚本、引导、联调 | 高熵字符串 | 会话 7 天 |
| 补绑邮箱 | 已登录的人 | 收信并点开确认链接 | 15 分钟，一次 |

**邀请**：管理员填邮箱 → 发一条 72 小时有效的链接。链接里的票据绑定邀请 ID 与收件邮箱，点开同时完成"验证邮箱 + 入组 + 登录"，转发给别人会被拒。**邮件只送达链接，权限来自入组后的角色。**

**Agent 授权**（设备批准码）：

```
Agent  POST /auth/agent/request            → { deviceCode, userCode }（10 分钟）
人     在「我的智能体」输入 userCode，勾范围与期限，点批准
Agent  POST /auth/agent/token { deviceCode } → { token, scopes, expiresAt }
```

默认给 Agent 建**独立主体**，只拿勾选的范围；`mode=link` 才会绑到本人账号（共用身份，权限等于本人）。批准必须发生在已登录会话里，别人拿到批准码也没用。撤销后它用这份授权换的令牌立刻作废。

## 控制台里有什么

导航按角色生成——纯智能体账号只看到自己的事，不会拿到全局看板。

| 视图 | 内容 |
| --- | --- |
| 工作台（智能体） | 待办子任务（可直接接受/提交）、心跳上报（在线/忙碌/离线）、未读提醒、能力匹配的开放池摘要 |
| 工作台（人） | 概览统计、智能体提案待接管、需要你判断的任务、最近活动 |
| 任务 | 列表与详情：验收条件、输入、子任务表、开放子任务、评论流（`@` 提及）、汇总、引用经验、事件时间线，以及随状态出现的动作 |
| 开放池 | 与自身能力匹配的开放子任务，认领即建立子任务并加入该任务 |
| 提醒 | 评论里 `@你` 的未读项，读过即消失 |
| 经验库 | 已发布与待审核两个页签；检索、修订、调整共享范围、版本历史、撤销、审核发布 |
| 成员 | 当前组织的人与智能体、租户角色、最近登录；邀请（发邮件链接）、改角色、移除、撤销邀请 |
| 我的智能体 | 批准码批准（选独立主体或共用账号、勾选范围与期限）、授权列表、撤销 |
| 参与者 | 人与智能体的目录、类型、角色、能力声明、登记、批准、改角色、停用 |
| 监管 | 告警（按严重程度）、风险任务、智能体在线表、待批准主体；可一键重新扫描 |
| 设置 | 登录方式（邮箱 + DID）、我的身份、用钱包绑定 DID、绑定邮箱、绑定的 DID、签发绑定码、会话列表与撤销 |
| 审计 | 写操作、幂等重放、被拒绝的请求与敏感读取；普通轮询式读取不记录 |

界面是无框架的原生 JS：没有构建步骤，只用 DOM 节点拼装（不用 `innerHTML` 渲染服务端内容），并在 CSP 下运行。

## 监管与报警

监管者要回答的不是"任务写到哪一步"，而是**哪里不对**。九条规则各自独立、幂等：

| 规则 | 触发 | 严重程度 |
| --- | --- | --- |
| `subtask_overdue` | 子任务过了截止仍未提交 | high |
| `subtask_stalled` | 已接受超过 24 小时没进展 | high |
| `subtask_unverified` | 已提交超过 12 小时没人核验 | normal |
| `task_stalled` | 任务超过 48 小时没有事件 | high |
| `review_backlog` | 待验收超过 24 小时 | normal |
| `agent_offline` | 心跳超过 15 分钟没上报 | normal |
| `agent_task_unadopted` | 智能体提案超过 12 小时没人接管 | normal |
| `denied_spike` | 一小时内被拒请求超过 8 次 | high |
| `knowledge_expiring` | 经验 3 天内到期 | low |

同一条规则 + 同一个对象只有一条告警，重复命中只累加次数；条件消失自动解决（`resolved_by=auto`），条件重现自动重开；**人工解决过的不会被扫描器立刻推翻**——人被叫醒过一次，不该被同一件事反复叫醒。

阈值都能用环境变量覆盖（见下方配置）。扫描不改变任何业务状态，只写 `alerts` 表，因此可以随时重跑。

## 代码结构

```
src/
  protocol/            协议层：类型、错误码、入参解析（不依赖数据库与 HTTP）
  anp/                 ANP-02 身份与签名：base58、did:wba、RFC 9421 验签/签名、登录客户端
  platform/
    db/                驱动（SQLite / PostgreSQL）、命名参数编译、schema 与迁移、行映射
    services/          领域服务：账号、租户、身份、邮箱登录、Agent 授权、任务、子任务、
                       协作、知识、通知、监管、审计、邮件
    http/              路由表、写执行器、服务器（Bearer / ANP 登录、CSP、错误映射）
    tools/             备份、超时调度（含告警扫描）
    app.ts/context.ts  组装依赖、注入 now 与 newId
  sdk/                 供智能体与外部程序使用的客户端，含写前日志
  agents/              示例智能体：worker、coordinator、命令行桥接、ANP 会话
  web/                 管理台（index.html / login-help.html / app.css / app.js）
tests/                 72 项测试，同一套用例跑 SQLite 与 PostgreSQL
examples/              一次性纵向演示与示例数据
scripts/               演示数据填充、PostgreSQL 测试脚本
```

## 一次写请求怎么走

1. **认证**：`Authorization: Bearer <token>`。令牌可能是 ANP 登录换来的会话令牌，也可能是管理员登记的静态令牌；都只存 SHA-256 摘要，每次请求重新读取主体状态。
2. **路由**：`src/platform/http/routes.ts` 里一行一个接口，`/v1/tasks/:id/...` 在启动时编译成正则，命中即得参数。
3. **事务**：`executeWrite` 在一个事务里依次完成——主体仍然有效且角色未变 → 幂等重放 → 资源级授权 → `If-Match` 版本比对 → 业务写入 → 事件 → 审计。
4. **事件**：每次业务变更都追加一条事件并推进 `tasks.version`，事件带单调 `seq`，时间线与动态流都读它。
5. **通知**：邀请与退回在**同一个事务**内写入通知，避免"状态变了但没人知道"。

读请求不开写事务，直接用只读连接（SQLite 用独立的只读连接 + WAL，PostgreSQL 用连接池）。

## 平台保证

- **幂等**：所有 POST 必须带 `Idempotency-Key`（1–200 字符）。同键 + 同请求返回上次结果并记 `replay` 审计；同键不同请求返回 409。重放会重新核对授权，但不重放业务写入。
- **乐观并发**：带版本的资源用 `If-Match: "<version>"` 比较，不匹配返回 412；子任务的流转用 `WHERE version = :expected` 条件更新，冲突返回 409。只有带版本的接口接受 `If-Match`，其余写接口收到它会返回 400。
- **事务一致性**：状态、事件、通知、告警、幂等记录、审计同进同退；服务层嵌套开启事务会加入外层，不会自锁。
- **可见性**：负责人、协调者、管理员、监管者看全部；业务智能体只看分配给自己的子任务，看不到其他智能体的结果、事件与知识引用；连参与者目录也只含自己、同任务的人与协调者。**唯一例外**是开放池：它只广播子任务本身（类别、要求的能力、截止时间、所属任务标题），不给目标、输入与验收条件——否则无法"自主认领"。
- **审计边界**：写操作、重放、拒绝、知识检索与证据包读取留痕；普通读取不记录，否则审计表会被界面轮询淹没。

不保证的部分：本地审计可被有文件权限的人改写，不能替代集中审计；静态令牌是共享密钥，不是企业身份（用 DID 登录才是）；检索是词法匹配，不是语义检索。

## 角色

| 角色 | 能做 |
| --- | --- |
| `admin` | 主体登记/停用/改角色、查看全部任务与审计、监管能力 |
| `owner` | 创建任务、委派协调者、分派子任务、挂开放池、写汇总、验收/退回、取消、沉淀经验 |
| `reviewer` | 审核发布、修订、撤销经验、调整共享范围 |
| `supervisor` | 看监管看板与在线表、批准待登记主体、接管智能体提案；**不能**验收或改业务状态 |
| `agent` | 只看自己的待办；接受、拒绝、汇报进展、提交结果（带来源与观测时间）、标记结果未知；认领开放子任务、写评论、发起提案、报心跳 |

同一主体可以有多个角色；`admin` 不等同于负责人，验收仍然要求负责人本人。

## 智能体接入

三种方式，都是纯 HTTP，不共享数据库。

**1）用 ANP 密钥登录（推荐，私钥留在自己机器上）**

```sh
# 密钥文件是 Ed25519 JWK；文件名就是默认 handle（DID 由公钥 + handle 决定）
COLLAB_URL=http://127.0.0.1:8787 COLLAB_ANP_KEY=./inventory.json \
  node src/agents/cli.ts login [绑定码]
```

登录得到的令牌缓存到 `.anpio-collab/`（可用 `COLLAB_STATE_DIR` 改），未过期就复用；被撤销或过期时，下一次命令会撞 401 并自动重签一次——不需要手动重登。

**2）用 `anpio-cli` 登录**：本平台的 `/auth/anp/login` 与 `anpio-cli anp login` 的语义一致（401 挑战 + `WWW-Authenticate: ANP nonce="..."` + 重签一次 + `Authentication-Info` 投递令牌），因此 CLI 无需改动即可登录；身份取 CLI 自己的密钥库（`--agent` / `--profile`）：

```sh
anpio-cli anp login --target http://127.0.0.1:8787/auth/anp/login
```

**3）用静态令牌**：`COLLAB_TOKEN=...`，给不想管密钥的场景。

命令行桥接把协作动作都做成单条命令，重跑同一条命令是安全的：

```sh
node src/agents/cli.ts whoami                # 当前身份来自 ANP 还是令牌
node src/agents/cli.ts inbox                 # 待办
node src/agents/cli.ts offers                # 开放池（只含匹配能力）
node src/agents/cli.ts claim <offerId>       # 认领 → 建立子任务
node src/agents/cli.ts accept <subtaskId>
node src/agents/cli.ts submit <subtaskId> < result.json
node src/agents/cli.ts comment <taskId> "@inventory 快照时间是昨天的"
node src/agents/cli.ts heartbeat online "正在拉库存快照"
```

后台进程式的两条示例：

```sh
# 业务智能体：拉待办 → 接受 → 用本地数据作答 → 提交（含来源与观测时间）
COLLAB_URL=... COLLAB_ANP_KEY=./inventory.json \
COLLAB_KIND=inventory COLLAB_DATA=examples/data/inventory.json \
COLLAB_WORKER_DB=/tmp/inventory.sqlite node src/agents/worker.ts

# 协调智能体：一次性分派 + 汇总
COLLAB_URL=... COLLAB_TOKEN=$COORDINATOR_TOKEN COLLAB_TASK=<task-id> \
COLLAB_INVENTORY_AGENT=inventory COLLAB_SUPPLIER_AGENT=supplier \
node src/agents/coordinator.ts
```

业务智能体用 `COLLAB_WORKER_DB` 保存写前日志：请求发出后进程被杀，重启会先重放未确认的操作，因此不会因为"不知道请求有没有生效"而重复提交。它不会自动重试业务动作，遇到权限或状态冲突就停下等人核对。

用代码接入时直接用 SDK：

```ts
import { CollabClient } from './src/sdk/client.ts';

const client = new CollabClient('http://127.0.0.1:8787', token);
const offers = await client.openOffers();          // 能力匹配的开放子任务
const claimed = await client.claimOffer(offers[0].id, `claim:${offers[0].id}`);
await client.accept(claimed.subtaskId, `accept:${claimed.subtaskId}`);
await client.submit(claimed.subtaskId, {
  quantity: 30,
  source: 'erp://inventory/M-100',
  observedAt: new Date().toISOString(),
}, `submit:${claimed.subtaskId}`);
await client.comment(offers[0].taskId, '数量按昨日 18:00 快照，已复核', `comment:${Date.now()}`);
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务（`HOST`/`PORT`/`COLLAB_DB` 等见下表） |
| `npm run dev` | 同上，文件变化自动重启 |
| `npm test` | 61 项测试（SQLite，每个用例独立临时库） |
| `npm run test:postgres` | 同一套测试跑在临时 PostgreSQL 实例上，验证方言差异 |
| `npm run check` | `tsc --noEmit` 类型检查 |
| `npm run demo` | 一次性纵向演示：智能体 DID 登录 → 建任务 → 分派 → 两个智能体进程执行 → 汇总 → 验收 → 沉淀经验 → 第二个任务引用 |
| `npm run seed` | 向运行中的实例写入可重复的演示数据（含逾期、开放池、评论、心跳、提案） |
| `npm run backup -- <源库> <新文件>` | SQLite 一致性备份（`VACUUM INTO` + 完整性检查） |
| `npm run scheduler -- --once` | 调用一次超时检查 + 告警扫描；去掉 `--once` 则按间隔轮询，加 `--no-scan` 只跑超时 |

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COLLAB_BOOTSTRAP_TOKEN` | 无 | 首次启动时创建管理员的令牌，至少 24 字符；数据库已有主体时不再使用 |
| `COLLAB_BOOTSTRAP_ID` | `admin` | 首次启动创建的主体 ID |
| `COLLAB_WORKSPACE` | `local` | 工作空间标识 |
| `COLLAB_DB` / `DATABASE_URL` | `./collab.sqlite3` | SQLite 文件路径，或 `postgresql://` 连接串 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址；默认只监听回环 |
| `COLLAB_ANP_ENROLL` | `open` | 陌生 DID 首次登录的落位：`open` 直接可用 / `pending` 等批准 / `off` 拒绝 |
| `COLLAB_PUBLIC_URL` | `http://127.0.0.1:8787` | 邮件里链接的基地址；部署到域名后必须改 |
| `COLLAB_DEV_MAIL` | `1` | 设为 `1` 时接口返回 `devLink`、允许读本地发件箱；生产必须设 `0` |
| `COLLAB_MAIL` | `outbox` | 投递方式：`outbox` 写库 / `console` 只打印 |
| `COLLAB_SESSION_HOURS` | `168` | ANP 会话有效期（小时） |
| `COLLAB_OFFLINE_MINUTES` | `15` | 多久没心跳算失联 |
| `COLLAB_STALLED_HOURS` | `24` | 子任务多久没进展算卡住 |
| `COLLAB_DENIED_THRESHOLD` | `8` | 一小时内被拒多少次算异常 |
| `COLLAB_BODY_LIMIT` | `65536` | 请求体上限（字节） |
| `COLLAB_LOG_REQUESTS` | `0` | 设为 `1` 打印访问日志 |
| `COLLAB_WEB_ROOT` | `src/web` | 管理台静态文件目录 |

智能体侧：`COLLAB_URL`、`COLLAB_ANP_KEY`（JWK 文件）或 `COLLAB_TOKEN`、`COLLAB_ANP_HANDLE`（覆盖默认 handle）、`COLLAB_STATE_DIR`（会话缓存目录）、`COLLAB_TIMEOUT_MS`。

## 已知边界

- 单进程；没有 TLS 与反向代理配置，**不要直接暴露到公网**。
- 租户隔离在应用层（`workspace` 条件），不是数据库行级安全；管理员仍可直接读库。
- 邮件只实现"写本地发件箱 + 打印"，没有 SMTP 重试与退信处理；限流在进程内。
- 登录票据不绑定浏览器指纹，链接被转发仍可能被用掉（一次性 + 短有效期是缓解，不是根治）。
- 只接了 ANP 的**登录**：ANP 消息服务（`anpio-cli` 的收发通道）、`anpio-key` 的远程签名守护、插件里的多钱包切换都还没接。
- 心跳靠智能体自己上报，平台不主动探活；"在线"只表示它还在，不表示它做对了。
- 知识检索是词法匹配（中文二元组 + 打分 + 字符预算截断），没有向量检索与评测集。
- 告警由显式扫描产生（`/v1/oversight/scan` 或调度器），不是事件驱动；阈值是常量而非可调策略。
- 通知是数据库内的拉取式消息，尚未接入外部消息队列。
- 数据库迁移到 v3（新增账号、租户、邀请、登录票据、Agent 授权、本地发件箱，以及 `principals.account_id/tenant_role`）；升级策略见 [运行说明](docs/local-operations.md)。

## 文档

- [协议 v1](docs/protocol-v1.md)：状态机、接口清单、错误码、幂等与版本语义、ANP 登录
- [本地运行](docs/local-operations.md)：配置、备份恢复、PostgreSQL、调度、故障排查
- [实现状态](docs/implementation-status.md)：已实现范围与计划阶段的对照
- [登录与授权说明](docs/login-and-authorization.md)：两种登录、邀请邮件、Agent 授权与撤销（也挂在 `/help/login`）
- [第二轮计划](docs/plan-v2.md)：身份、协作、监管三块的设计取舍
- [第三轮计划](docs/plan-v3.md)：租户模型、邮箱登录、设备授权码的完整设计
