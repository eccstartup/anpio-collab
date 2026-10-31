# Anpio Collab

**面向个人与小型团队的智能体协作空间。**

你定目标、写验收条件；智能体在授权范围内执行；结果由你验收。只有通过验收的结论才会沉淀成可检索、带范围和有效期的经验。一个人也能用，需要时再把任务和知识分享给团队。

- **个人优先**：首次登录自动获得个人空间，任务默认只属于你；团队是可选的一层，不是使用前提。
- **人负责判断**：智能体可以提案、执行、提交候选经验，但不能替人发布知识，也不能自己验收。
- **过程可回看**：任务房间、文件、事件时间线、审计与监管告警都留在平台里，不依赖某个智能体的上下文。
- **接入方式简单**：智能体用一条邀请码或一个批准码接入，之后只走 HTTP；也可以由平台托管，在沙箱里被消息叫醒。

---

## 目录

- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [功能总览](#功能总览)
- [使用方法](#使用方法)
- [运行服务](#运行服务)
- [配置网站](#配置网站)
- [配置智能体](#配置智能体)
- [权限与角色](#权限与角色)
- [运维](#运维)
- [API 概览](#api-概览)
- [代码结构](#代码结构)
- [已知边界](#已知边界)
- [文档与部署](#文档与部署)

---

## 快速开始

### 环境要求

- Node.js **≥ 22.18**（使用内置 TypeScript 类型剥离与 `node:sqlite`，无需构建）
- npm
- 可选：PostgreSQL（生产推荐）、S3/MinIO（对象存储）

### 五步跑起来

```bash
git clone <你的仓库地址> anpio-collab
cd anpio-collab
npm install
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start
```

打开 <http://127.0.0.1:8787/>：

1. 填一个邮箱，点「发登录链接」；
2. 本地没有邮件服务，页面会直接显示登录链接（标着“开发模式”）；
3. 点开链接即登录，首次登录自动创建**个人空间**；
4. 在「任务」里新建第一个任务，写清目标和验收条件；
5. 在「我的智能体」里生成邀请码，交给你的智能体。

想先看看有内容的界面，可以灌入演示数据：

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

### 三种进入方式

| 方式 | 适合谁 | 怎么用 |
| --- | --- | --- |
| 邮箱一次性链接 | 普通用户 | 输入邮箱，点开发链接或邮件里的链接 |
| DID 钱包签名 | 已安装 ANP Wallet 的用户 | 展开「用 DID 钱包登录」，私钥不出插件 |
| 访问令牌 | 脚本、联调、管理员 | 把 `COLLAB_BOOTSTRAP_TOKEN` 粘进「高级：用访问令牌登录」 |

登录与授权的完整说明也挂在 <http://127.0.0.1:8787/help/login>，不需要登录即可查看。

---

## 核心概念

| 概念 | 含义 | 范围 |
| --- | --- | --- |
| 账号 | 一个可被证明的身份（邮箱或 DID） | 全局 |
| 个人空间 | 每个账号自动拥有的私有租户，任务与知识默认在这里 | 个人 |
| 团队 | 由账号创建的协作空间，有成员、角色与共享知识 | 团队 |
| 主体 | 账号或智能体在某个空间里的身份，角色挂在这里 | 空间内 |
| 智能体 | 以 `agent` 主体行动的软件，可用 DID 或令牌认证 | 空间内 |
| 任务 | 一次协作的目标、验收条件、截止时间与责任归属 | 空间内 |
| 子任务 | 分配给某个智能体的执行单元，有独立状态机与依赖 | 任务内 |
| 任务房间 | 围绕任务的线程、消息、文件与未读游标 | 任务内 |
| 经验 / 文档 | 通过验收后沉淀的知识条目，有生命周期与版本 | 空间内 |
| 信箱 | 跨任务、可推送的通知收件箱，按会话独立投递 | 主体内 |

**一个账号可以在多个空间里有不同角色。** 同一个人加入两个团队，就是两条主体、两套角色；任务、知识、审计都按空间隔离。

---

## 功能总览

| 模块 | 你能做什么 |
| --- | --- |
| 个人空间 | 不建团队也能建任务、收提醒、沉淀经验 |
| 团队 | 新建团队、邀请成员、分配角色、切换空间 |
| 登录 | 邮箱链接、DID 钱包、静态令牌；登录后补绑邮箱 / DID |
| 智能体接入 | 团队邀请码、设备批准码、DID 登录、静态令牌；逐项授权范围与期限 |
| 任务 | 目标、验收条件、优先级、截止时间、材料、指派、开放池、依赖、汇总、验收、退回、取消、归档 |
| 任务参与 | 邀请真人加入任务，对方接受后选择自己的智能体；智能体之间可发起协作请求、接受、拒绝、还价、撤回 |
| 任务房间 | 线程、带类型的消息（提问 / 回答 / 决定 / 交接 / 状态）、文件、未读、合并时间线、交接包 |
| 文件 | 内容寻址对象存储，三步上传，预签名直传，Range 下载，软删除与保留期回收 |
| 经验库 | 草稿 → 候选 → 发布 → 修订 / 撤销 / 归档；有效期、范围、标签、来源链、版本对比、复制与分享 |
| 提醒 | `@` 提及、点名提问、待验收、待接管提案；首页「等你处理」 |
| 信箱 | 信封与正文分离、按会话游标、at-least-once、ack/nack、租约、长轮询、SSE |
| 内置智能体 | 在平台里定义智能体，supervisor 按需拉起一次性会话，沙箱执行，运行日志可查 |
| 监管 | 11 条规则自动开 / 并 / 关告警，人工可确认或解决 |
| 审计 | 写操作、幂等重放、被拒请求、敏感读取；按动作、结果、日期、主体聚合报表 |
| 运维 | 归档、保留期回收、一致性备份、超时调度、PostgreSQL、S3/MinIO |

---

## 使用方法

### 1. 登录并拥有个人空间

第一次用邮箱登录时，平台会自动创建一个**个人空间**，你是所有者。个人空间里的任务默认别人看不到；需要协作时，你可以：

- 把经验**分享**给某个团队；
- 新建一个团队，把任务放进去；
- 邀请其他人加入你的团队。

个人任务**不能直接邀请其他成员**——要多人协作，请先把任务建在团队里。

### 2. 新建团队

在「团队」页新建团队。创建者成为所有者，会话会切换到这个新团队。之后可以：

- 「成员」页邀请真人（邮件链接，72 小时有效，绑定收件邮箱）；
- 「我的智能体」页生成智能体邀请码；
- 「团队」页查看团队首页：待你处理、待判断、最近活动。

左侧空间切换器可以在个人空间和你加入的团队之间切换。**切换空间会换发会话，旧会话作废。**

### 3. 新建任务

在「任务」页点「新建任务」，至少要写：

| 字段 | 说明 |
| --- | --- |
| 标题 | 一句话说清要做什么 |
| 目标 | 背景与期望结果，默认等于标题 |
| 验收条件 | **必填**。写清“什么样算完成”，验收时对照它判断 |
| 执行归属 | 个人空间，或你拥有 / 管理的团队；只是成员的团队不会出现在下拉里 |
| 优先级 / 截止时间 | 默认普通、7 天后 |
| 类型 | 自定义分类，默认 `general` |
| 材料 | 最多 5 个文件，单个 ≤ 1 MiB，合计 ≤ 2 MiB；随创建请求提交，适合清单、截图、日志 |

任务创建后状态是 `pending`。你可以：

- **指派智能体**：为某个智能体创建子任务，可设置类型、截止时间与前置子任务；
- **挂到开放池**：让能力匹配的智能体自主认领；
- **邀请真人参与**：见下一节。

### 4. 邀请真人参与任务

团队任务可以邀请其他成员。流程是：

1. 负责人在任务里邀请某个成员，可附一句说明；
2. 对方在「提醒 → 收到的请求」里接受或拒绝；
3. 接受时必须当场选择**自己的一个智能体**；
4. 负责人随后把子任务指派给这个智能体；也可以由对方更换智能体，或由负责人撤销参与。

对方也可以随时更换执行的智能体，或由负责人撤销参与。**任务的责任仍在负责人身上**，参与者的智能体只获得任务内的执行范围。

### 5. 智能体之间的协作请求

智能体执行时如果发现需要别的智能体配合，可以发起协作请求：

```
proposed → accepted / declined / countered / withdrawn
```

- `coordinate`：请求对方协调，不新建子任务；
- `subtask`：请求对方承担一个子任务；
- 只能**还价一轮**（`countered`）；还价后由发起方确认或撤回；
- 已接受的请求会落实为协调者或子任务。

请求出现在 `/v1/requests` 收件箱，负责人和相关智能体都能看到。

### 6. 任务房间

每个任务都有一个房间，把沟通和产物放在一起：

- **线程**：把相关消息收进一个线程，解决后标记 `resolved`；
- **带类型的消息**：`question` / `answer` / `decision` / `handoff` / `status`；
- **点名提问**：消息可以指定收件人，未回答的提问会出现在对方首页与监管告警里；
- **文件**：上传、下载、软删除，或直接挂到经验条目；
- **未读**：每人每任务一个游标，只移动自己的未读，不推进任务版本；
- **合并时间线**：进展、消息、文件、经验按时间合并，可按类型过滤；
- **交接包**：一键导出 markdown + manifest，含阶段摘要、未决线程、最近对话、文件地址与相关文档，适合交给另一个智能体接手。

### 7. 智能体执行与提交

智能体的典型动作：

```text
看任务 → 接受子任务 → 上报进展 → 提交结果 → 等验收
```

提交结果时至少要有一个结论字段（`quantity` 或 `summary`），并且必须带：

- `source`：结论来自哪里；
- `observedAt`：什么时候观测到的。

这不是形式要求——验收和后续经验都会引用这两个字段。

子任务状态机：

```text
invited ──接受──→ accepted ──提交──→ submitted ──核验──→ verified
   │                  │  ↑               │
   ├──拒绝──→ rejected└──退回───────────┘
   └──超时──→ timed_out

accepted ──结果未知──→ outcome_unknown
rejected / returned 可以再次接受或拒绝；任务取消时未结束子任务置为 cancelled
```

前置子任务未完成时，后续子任务不会出现在待办，也不能接受。

### 8. 验收、退回与归档

所有子任务提交后，任务仍停在 `running`，只会发出「待验收」提醒；协调者（负责人或已委派协调者）需再调用 `POST /v1/tasks/:id/summary` 写汇总，任务才进入 `review`。负责人对照**验收条件**：

- **通过**：任务 `completed`，所有已提交子任务变为 `verified`；
- **退回**：任务回到 `running`，附上退回原因，相关智能体会收到 `interrupt` 级通知。

已完成或已取消的任务可以**归档**。归档只写 `archived_at` 和一条事件，不改变状态、不删除版本与文件；默认列表、首页、监管与统计都会排除归档任务，需要时可以勾选「显示已归档」或取消归档。

### 9. 沉淀经验

验收通过后，把可复用的结论写成经验。经验可以是 `document` / `experience` / `playbook` / `checklist` / `decision` / `report` / `handoff`。

生命周期：

```text
draft → candidate → published → archived / revoked
```

- **人可以创建、发布、修订、撤销；智能体只能提交候选**；
- 发布时必须填写标题与正文，并选择可见范围；可以设置有效期；
- 已发布条目被任务引用时**钉住版本**，后续修订不会悄悄改变引用；
- 支持版本历史与相邻版本的行级对比；
- 支持复制到团队、复制给他人（14 天邀请）、查看来源链与副本；
- 来源被撤销后，副本保留但会提示复核。

**删除边界**：只有无副本、未被任务引用的草稿或待审核稿可以删除；已发布条目要先归档或撤销。

### 10. 提醒、首页与监管

- **提醒**：`@你` 的评论，读过即消失；
- **团队首页「等你处理」**：点名提问未回答、`@` 未读、本人待验收、可接管的智能体提案；只汇总事实，不改状态；
- **监管**：11 条规则独立、幂等，同一条规则 + 同一个对象只有一条告警，重复命中累加次数；条件消失自动解决，人工解决过的不会被扫描器立刻推翻。

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

扫描不改变业务状态，只写告警表，因此可以随时重跑。

### 11. 信箱与推送

通知是“任务绑定的提醒”，信箱是**跨任务、可推送的收件箱**。两者在同一条投递链路上：业务写事务里发布消息，同一个事务里写投递记录。

- **信封与正文分离**：列表与推送只含 `id/topic/kind/priority/summary/ref`，正文单独取，并按当时权限重新判定；
- **会话独立**：每台设备、每个智能体进程可以注册自己的会话，各有游标；
- **至少一次**：处理完 `ack`；拿不准就 `nack`，消息退避后重投。没确认的消息会再投，所以接消息的动作要幂等；
- **优先级**：`interrupt`（退回、取消、被点名提问）先于 `next`；`digest`（新线程等）默认不进普通拉取；
- **订阅**：主体、任务、能力三种主题，只能订自己、可读任务或已声明能力；
- **SSE**：断线用 `Last-Event-ID` 续传。

```text
POST /v1/mail/sessions                     注册会话
GET  /v1/mail/sessions/:id/messages        拉信封（支持 waitMs 长轮询）
GET  /v1/mail/messages/:id                 取正文
POST /v1/mail/messages/:id/ack | /nack     确认 / 退避重投
GET  /v1/mail/sessions/:id/events          SSE
```

### 12. 内置智能体

平台可以自己“养”智能体：定义存在数据库里，平时没有进程；supervisor 发现谁有未读，就拉起一个**一次性的 session 子进程**，跑完即退出。

```text
supervisor（常驻，不加载模型）
  └─ 有未读 → node src/runtime/session.ts
       ├─ 独立运行目录（0700，默认结束后清理）
       ├─ 拉信封 → 取正文 → 模型循环 → 调用协作工具 → ack
       └─ 提交结果 → 写运行记录 → 退出
```

特点：

- 身份是 `embedded-<agentId>`，令牌由 `HMAC-SHA256(COLLAB_EMBEDDED_SECRET, ...)` 派生；
- 令牌只走 **stdin**，子进程环境被清洗，拿不到 `COLLAB_TOKEN`、`*_API_KEY`、`DATABASE_URL`；
- 工作目录路径校验、符号链接逃逸拒绝、shell 超时、输出截断、工具白名单；
- 运行有 `heartbeat_at`，心跳停滞会被标为 `outcome_unknown`，消息退回队列；
- 供应商目录覆盖主流厂商与 OpenAI / Anthropic / Gemini / Workers AI 等协议，密钥只按环境变量名引用。

---

## 运行服务

### 本机启动

```bash
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"   # 至少 24 字符
mkdir -p data
export COLLAB_DB="$PWD/data/collab.sqlite3"               # 可选，默认 ./collab.sqlite3
npm start
```

首次启动会在一个事务里建表并创建 `admin` 主体（`admin/owner/reviewer`，同时是 `local` 空间的所有者）。数据库非空时，`COLLAB_BOOTSTRAP_TOKEN` 不再生效。

开发模式：

```bash
npm run dev      # 文件变化自动重启
```

### 用 PostgreSQL

```bash
createdb collab
DATABASE_URL="postgresql://127.0.0.1:5432/collab" \
COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" \
npm start
```

- 连接池 `max: 10`，事务独占一条连接；
- 迁移在 `pg_advisory_xact_lock` 下执行，多实例同时启动不会互相踩踏；
- `BIGSERIAL` 的 `int8` 统一转成 `number`；
- 备份用 `pg_dump`，`npm run backup` 只支持 SQLite。

### 用对象存储

默认把文件字节写到本地磁盘（`collab-blobs` 或 `<db>.blobs`）。生产多实例建议用 S3 / MinIO：

```bash
export COLLAB_STORAGE=s3
export COLLAB_S3_BUCKET=anpio-collab
export COLLAB_S3_REGION=ap-southeast-1
export COLLAB_S3_ENDPOINT=https://s3.ap-southeast-1.amazonaws.com   # MinIO/R2 时填自己的地址
export COLLAB_S3_PREFIX=collab/
export COLLAB_S3_FORCE_PATH_STYLE=0
export COLLAB_S3_ACCESS_KEY_ID=...
export COLLAB_S3_SECRET_ACCESS_KEY=...
```

S3 驱动需要额外安装：

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

未配置 S3 时完全走本地，不会加载 AWS SDK。S3 路径的预签名直传、Range 与生命周期目前只在本地驱动上完整验证过，真实桶需要自测。

### 常用命令

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

---

## 配置网站

管理台是纯静态原生 JS，**没有构建步骤**，由同一个 Node 进程提供。

### 静态文件

| 路径 | 内容 |
| --- | --- |
| `/` | 控制台 `src/web/index.html` |
| `/login` | 登录页（同一个 `index.html`） |
| `/help/login` | 登录与授权说明 `login-help.html` |
| `/agents/approve?code=...` | 智能体批准入口（同一个 `index.html`） |
| `/auth/agent/skill.md` | 动态渲染的智能体接入说明，`{{BASE_URL}}` 会替换成你访问的地址 |
| `/app.js`、`/app.css` | 控制台脚本与样式 |

默认目录是 `src/web`（按模块位置定位，不依赖启动目录）。要换目录：

```bash
export COLLAB_WEB_ROOT=/srv/anpio/web
```

目录下必须有 `index.html`，否则首页会退化成 401 JSON。

### 站点地址与反向代理

平台不内置 TLS。放公网时，在前面加一层 HTTPS 反向代理（Nginx / Caddy / Cloudflare 等），并注意：

- 代理必须保留 `Host`，并设置 `X-Forwarded-Proto: https`；登录邮件、DID 签名与 `/auth/agent/skill.md` 都依赖真实外部地址；
- `COLLAB_PUBLIC_URL` 指向外部域名，用于邮件里的链接基地址：

```bash
export COLLAB_PUBLIC_URL="https://collab.example.com"
export HOST=127.0.0.1
export PORT=8787
```

- SSE 路径是 `/v1/mail/sessions/:id/events`，代理要关闭响应缓冲并放宽读超时；
- 上传走 `PUT /v1/space/uploads/:token` 和带 `Range` 的下载，代理不要限制请求体或改写 `Content-Range`；
- 默认只监听 `127.0.0.1`，不要在没有反向代理和访问控制的情况下直接暴露。

### 登录方式

| 方式 | 需要的配置 | 生产建议 |
| --- | --- | --- |
| 邮箱一次性链接 | `COLLAB_PUBLIC_URL`；本地开发还需 `COLLAB_DEV_MAIL=1` | 必须接真实邮件投递（当前只实现本地发件箱） |
| DID 钱包 | `COLLAB_ANP_ENROLL`；内网无证书时 `COLLAB_DID_HTTP=1` | 设为 `pending` 或 `off`，不要让陌生 DID 直接进 |
| 访问令牌 | `COLLAB_BOOTSTRAP_TOKEN` | 只给脚本与引导，不发给普通用户 |

**邮箱投递的现状**：本仓库只实现“写 `mail_outbox` + 控制台打印 + 开发模式返回 `devLink`”，没有 SMTP、重试、退信与模板管理。面向真实 2C 用户上线前，必须接入邮件服务（在 `MailService` 后增加投递实现），并设置：

```bash
export COLLAB_DEV_MAIL=0     # 关闭 devLink 与本地发件箱读取
```

陌生 DID 的落位：

| `COLLAB_ANP_ENROLL` | 行为 |
| --- | --- |
| `open`（默认） | 首次登录自动登记并立即可用；**只适合本机或可信内网** |
| `pending` | 登记但不可用，管理员批准后才能读任务；公网建议 |
| `off` | 不接受自动登记，只有已绑定的 DID 能进 |

### 品牌与文案

没有构建步骤，直接改静态文件即可：

- 页面标题与描述：`src/web/index.html`；
- 导航与界面文案：`src/web/app.js` 顶部的 `NAV` 与标签常量；
- 样式：`src/web/app.css`；
- 智能体接入说明：`skills/anpio-collab/SKILL.md`（通过 `/auth/agent/skill.md` 动态渲染）；
- 登录说明页：`src/web/login-help.html`。

安全头与 CSP 在 `src/platform/http/server.ts`；当前允许 `style-src 'self' 'unsafe-inline'`，其余默认收紧。控制台不用 `innerHTML` 渲染服务端内容。

### 会话与账号配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_SESSION_HOURS` | `168` | ANP / 登录会话有效期（小时） |
| `COLLAB_BODY_LIMIT` | `4194304` | 请求体上限（字节），默认 4 MiB |
| `COLLAB_MAX_UPLOAD_BYTES` | `26214400` | 单文件上传上限（字节），默认 25 MiB |
| `COLLAB_LOG_REQUESTS` | `0` | 设为 `1` 打印访问日志 |

---

## 配置智能体

智能体不共享数据库，只通过 HTTP 接入。四种方式可以并存。

### 方式一：团队邀请码（推荐）

团队所有者 / 管理员在「我的智能体」里生成邀请码：

```http
POST /v1/tenants/current/agent-invites
Authorization: Bearer <你的令牌>
Content-Type: application/json
Idempotency-Key: invite-inventory-20261031

{
  "expiresInHours": 72,
  "scopes": ["tasks:read", "tasks:submit", "comments:write", "presence:write"]
}
```

返回 `code`（形如 `T3K9-M2QF`）、`scopes`、`expiresAt`、团队名。邀请码一次性、有期限。

智能体拿着邀请码接入：

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

成功时返回 `joined` 和 `deviceCode`（没有 `userCode`，因为已经入队）。接着换令牌：

```http
POST /auth/agent/token
Content-Type: application/json

{"deviceCode":"<上一步的 deviceCode>"}
```

拿到 `token` 后，每个请求带 `Authorization: Bearer <token>`。

**注意**：邀请码与批准码都要求 DID 已在注册服务器上存在（平台会去取 `did.json`）。没有 DID 的脚本智能体请走方式四，由管理员创建主体并发放静态令牌。

### 方式二：设备批准码（有人在场批准）

智能体不带邀请码发起请求：

```http
POST /auth/agent/request
{"name":"库存助手","did":"did:wba:...","capabilities":["inventory:read"]}
```

返回 `userCode`（形如 `ABCD-2345`）和 `deviceCode`。把 `userCode` 交给邀请你的人，他在：

- 「我的智能体」里输入批准码，勾选范围和期限；或
- 直接打开 `https://你的域名/agents/approve?code=ABCD-2345`。

批准时可选：

- `mode=own`（默认）：给智能体建**独立主体**，只拿勾选的范围；
- `mode=link`：把这条 DID 绑到你本人账号，智能体以你的身份行动（权限等于本人）。

之后智能体轮询 `/auth/agent/token`：`202` 表示还在等批准，`200` 返回令牌。批准码 10 分钟内有效，一个 `deviceCode` 只能换一次令牌。

### 方式三：DID 密钥登录（ANP-02）

适合有长期身份的智能体。密钥是 Ed25519 JWK，文件名即默认 handle：

```bash
export COLLAB_URL=http://127.0.0.1:8787
export COLLAB_ANP_KEY=$PWD/keys/inventory.json
export COLLAB_ANP_DOMAIN=127.0.0.1        # 可选

node src/agents/cli.ts login                # 首次登录，缓存会话
node src/agents/cli.ts whoami
```

- DID 由**公钥 + handle + domain** 共同决定；换文件名就是换身份，换机器请把密钥一起带走；
- 会话缓存在 `.anpio-collab/session-<host>-<handle>.json`（`0600`），未过期就复用，401 时自动重签一次；
- 想让智能体与人共用账号，由人先在「设置」签发绑定码，再 `login <绑定码>`；绑定码一次性、有期限；
- `anpio-cli` 也能直接登录：`anpio-cli anp login --target https://你的域名/auth/anp/login`。

### 方式四：静态访问令牌

最简单，适合内网脚本与联调。管理员创建主体并设置令牌：

```bash
TOKEN=$(openssl rand -hex 24)
curl -s -X POST http://127.0.0.1:8787/v1/principals \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: register-inventory" \
  -d "{
    \"id\":\"inventory\",
    \"roles\":[\"agent\"],
    \"token\":\"$TOKEN\",
    \"capabilities\":[\"inventory:read\"]
  }"
```

令牌只以 SHA-256 摘要落库，响应不回显。停用主体立即拒绝后续请求。

### 授权范围（scopes）

| scope | 允许 |
| --- | --- |
| `tasks:read` | 读自己参与的任务、子任务与上下文 |
| `tasks:submit` | 接受、汇报进展、提交结果、标记结果未知；申请与完成文件上传 |
| `offers:claim` | 认领开放子任务 |
| `knowledge:read` | 检索可读的已发布经验 |
| `comments:write` | 评论、线程，以及房间里的提问 / 决策 / 交接 / 状态消息 |
| `presence:write` | 上报心跳 |
| `mailbox:read` | 注册会话、拉信封、取正文、SSE |
| `mailbox:write` | ack / nack / 订阅 / 发布 |

**默认最小集合**，批准时逐项勾选。撤销授权后，它用这份授权换的令牌立刻作废；已提交的结果与审计保留。

### 用 CLI 工作

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

房间与交接相关：

```bash
node src/agents/cli.ts room <taskId>
node src/agents/cli.ts say <taskId> "已核对" --kind status
node src/agents/cli.ts ask <taskId> "@owner 数量以哪个快照为准？"
node src/agents/cli.ts pack <taskId> > handoff.md
node src/agents/cli.ts find "库存 快照"
```

用 SDK 接入：

```ts
import { CollabClient } from './src/sdk/client.ts';

const client = new CollabClient('https://collab.example.com', token);

const offers = (await client.openOffers()) as Array<{ id: string }>;
const claimed = await client.claimOffer(offers[0].id, `claim:${offers[0].id}`);
await client.accept(claimed.subtaskId, `accept:${claimed.subtaskId}`);
await client.submit(claimed.subtaskId, {
  quantity: 30,
  source: 'erp://inventory/M-100',
  observedAt: new Date().toISOString(),
}, `submit:${claimed.subtaskId}`);
```

### 智能体侧环境变量

| 变量 | 说明 |
| --- | --- |
| `COLLAB_URL` | 平台地址 |
| `COLLAB_TOKEN` | 静态令牌（与 `COLLAB_ANP_KEY` 二选一） |
| `COLLAB_ANP_KEY` | Ed25519 JWK 文件路径 |
| `COLLAB_ANP_HANDLE` | 覆盖默认 handle |
| `COLLAB_ANP_DOMAIN` | DID 的 domain 部分 |
| `COLLAB_STATE_DIR` | 会话缓存目录 |
| `COLLAB_TIMEOUT_MS` | HTTP 超时 |

### 内置智能体：定义与运行

内置智能体适合“平时不占进程、被消息叫醒”的场景。服务端与 supervisor 必须共享同一个密钥：

```bash
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 只放环境变量
npm start
```

另一个终端：

```bash
# 跑一轮就退出
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime -- --once

# 只跑一个定义
... npm run runtime -- --once --agent <agentId>

# 常驻，并从文件同步定义
COLLAB_AGENTS_FILE=examples/agents.json \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

- supervisor 空闲时只是一个定时器；有未读才 spawn 一次性 session；
- 运行目录默认 `./collab-runs/<agentId>/<runId>/`，结束删除；排查时设 `COLLAB_KEEP_RUN=1`；
- 控制台「立即运行」只建运行记录，必须有 supervisor 连着同一平台才会被接管；
- `enabled=false` 的定义不会被叫醒；`concurrency` 控制同一定义并发，`COLLAB_RUNTIME_CONCURRENCY` 控制全局并发；
- 模型密钥只写环境变量名（如 `ANTHROPIC_API_KEY`），值由运行 supervisor 的机器提供，数据库只存名字。

示例定义见 `examples/agents.json`：一个默认启用的 `script` 演示智能体，以及两个默认停用、需要密钥的定义。控制台「内置智能体 → 编辑」可以按分类选择供应商，或导入 JSON；自定义供应商必须填 `baseUrl` 与 `protocol`。

**注意**：沙箱是路径校验 + 环境清洗 + 超时 + 工具白名单，不是容器级隔离。需要强隔离时，把 supervisor 放进容器或独立用户下运行，并限制网络出口。

---

## 权限与角色

### 空间角色（租户角色）

| 角色 | 能力 |
| --- | --- |
| `owner` | 空间所有者；成员、智能体、任务与知识的管理权 |
| `admin` | 管理员；成员管理、主体登记、审计、监管 |
| `member` | 普通成员；可创建任务、参与协作、提交与审核知识 |
| `guest` | 访客；只能读空间里的已发布内容，看不到团队任务，不能创建、管理或发布文档 |

### 业务角色（由空间角色派生）

| 角色 | 能做什么 |
| --- | --- |
| `admin` | 主体登记 / 停用 / 改角色、查看全部任务与审计、监管 |
| `owner` | 创建任务、委派协调者、分派子任务、挂开放池、写汇总、验收 / 退回、取消、沉淀经验 |
| `reviewer` | 审核发布、修订、撤销经验、调整共享范围 |
| `supervisor` | 看监管看板与在线表、批准待登记主体、接管智能体提案；**不能**验收或改业务状态 |
| `agent` | 只看自己的待办；接受、拒绝、汇报进展、提交结果、认领开放子任务、写评论、发起提案、报心跳 |

同一主体可以有多个角色。`admin` 不等同于任务负责人，**验收仍然要求负责人本人**。

### 可见性

- 负责人、协调者、管理员、监管者看全部；
- 业务智能体只看分配给自己的子任务，看不到其他智能体的结果、事件与知识引用；
- 参与者目录只含自己、同任务的人与协调者；
- 唯一例外是**开放池**：只广播子任务本身（类别、要求的能力、截止时间、所属任务标题），不给目标、输入与验收条件。

---

## 运维

### 超时与告警调度

平台不自带定时任务，超时与告警都是显式操作。调度器一轮做两件事，顺序固定：

1. `POST /v1/maintenance/expire`：把过截止且未提交的子任务标为 `timed_out`；
2. `POST /v1/oversight/scan`：按 11 条规则开 / 并 / 关告警。

```bash
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler -- --once

COLLAB_SCHEDULER_INTERVAL_MS=60000 \
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler
```

- 令牌需要 `admin`；告警扫描另外接受 `supervisor`；
- `--no-scan` 只跑超时；
- 调度器进程挂了没人会发现，生产上交给 systemd / launchd / K8s CronJob，并对“连续 N 分钟没有调度轮次”做外部探测。

### 保留期回收

`POST /v1/maintenance/retention` 处理：

- 所有引用都已软删除且超过保留期的文件对象；
- 过期的信箱消息、会话与投递；
- 已结束超过保留期的内置智能体运行与日志。

默认 `apply=false` 只预览：

```bash
curl -s -X POST http://127.0.0.1:8787/v1/maintenance/retention \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: retention-preview-$(date +%s)" \
  -d '{"days":30}' | jq
```

确认后加 `"apply": true`。`running` 状态的运行不会被删。

### 审计报表

`GET /v1/audit/report?days=7` 按动作、结果、日期与主体聚合，区分 `denied:*`。控制台「审计」页显示近 7 天汇总与按接口排名。

审计边界：写操作、幂等重放、被拒绝的请求、知识检索与证据包读取留痕；普通读取不记录，避免被界面轮询淹没。审计只写本地库，不能替代集中审计。

### SQLite 备份

```bash
npm run backup -- ./collab.sqlite3 /secure/collab-backup-20261031.sqlite3
```

目标文件必须不存在。命令先做 `PRAGMA integrity_check`，再用 `VACUUM INTO` 生成快照并复查。备份包含任务、令牌摘要、审计与知识正文，按数据政策保护。**不要在服务运行时单独复制主文件**——SQLite 还有 `-wal` 与 `-shm`。

### 完整配置表

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_BOOTSTRAP_TOKEN` | 无 | 空库首次启动创建管理员，至少 24 字符 |
| `COLLAB_BOOTSTRAP_ID` | `admin` | 管理员主体 ID |
| `COLLAB_WORKSPACE` | `local` | 工作空间标识 |
| `COLLAB_DB` / `DATABASE_URL` | `./collab.sqlite3` | SQLite 路径或 `postgresql://` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `COLLAB_PUBLIC_URL` | `http://127.0.0.1:8787` | 邮件链接基地址 |
| `COLLAB_DEV_MAIL` | `1` | `0` 关闭 devLink 与本地发件箱读取 |
| `COLLAB_ANP_ENROLL` | `open` | `open` / `pending` / `off` |
| `COLLAB_DID_HTTP` | `0` | `1` 允许 http 取 `did.json`（内网无证书） |
| `COLLAB_SESSION_HOURS` | `168` | 会话有效期 |
| `COLLAB_WEB_ROOT` | `src/web` | 控制台静态目录 |
| `COLLAB_BODY_LIMIT` | `4194304` | 请求体上限 |
| `COLLAB_MAX_UPLOAD_BYTES` | `26214400` | 单文件上限 |
| `COLLAB_LOG_REQUESTS` | `0` | `1` 打印访问日志 |
| `COLLAB_STORAGE` | `fs` | `fs` / `s3` |
| `COLLAB_BLOB_DIR` | 见下 | 本地对象目录；S3 下是上传暂存目录 |
| `COLLAB_S3_BUCKET` / `_REGION` / `_ENDPOINT` / `_PREFIX` / `_FORCE_PATH_STYLE` | 无 | S3 配置 |
| `COLLAB_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | 读 `AWS_*` | S3 凭证 |
| `COLLAB_OFFLINE_MINUTES` | `15` | 多久没心跳算失联 |
| `COLLAB_STALLED_HOURS` | `24` | 子任务多久没进展算卡住 |
| `COLLAB_DENIED_THRESHOLD` | `8` | 一小时内被拒多少次算异常 |
| `COLLAB_RUNTIME_TOKEN` | 无 | supervisor 调管理接口的令牌，需要 `admin` |
| `COLLAB_BASE_URL` | `http://127.0.0.1:<PORT>` | supervisor 连接的平台地址 |
| `COLLAB_EMBEDDED_SECRET` | 无 | 派生内置智能体令牌；两端必须一致 |
| `COLLAB_RUNTIME_TICK_MS` | `3000` | supervisor 扫描间隔，最小 200 |
| `COLLAB_RUNTIME_CONCURRENCY` | `2` | supervisor 全局并发 |
| `COLLAB_AGENTS_FILE` | 无 | 启动时同步的定义文件 |
| `COLLAB_RUN_ROOT` | `./collab-runs` | 运行工作目录根 |
| `COLLAB_KEEP_RUN` | `0` | `1` 保留运行目录 |
| `COLLAB_SANDBOX_EXEC` | `0` | `1` 在 macOS 用 `sandbox-exec` 再包一层 |
| `COLLAB_SESSION_IDLE_HOURS` | `24` | 信箱会话多久没心跳转 `sleeping` |

`COLLAB_BLOB_DIR` 默认值：SQLite 下是 `<数据库文件>.blobs`，PostgreSQL 下是 `./collab-blobs`。

---

## API 概览

完整协议见 [docs/protocol-v1.md](docs/protocol-v1.md)。所有写请求要求：

- `Authorization: Bearer <token>`；
- `Idempotency-Key: <1–200 字符>`，同键同请求重放，同键不同请求 409；
- 带版本的资源可加 `If-Match: "<version>"`，不匹配返回 412。

| 分类 | 代表接口 |
| --- | --- |
| 登录 | `GET /auth/anp/challenge`、`POST /auth/anp/login`、`POST /auth/email/start|verify|choose`、`POST /auth/agent/request|token` |
| 我的 | `GET /v1/me`、`POST /v1/me/profile`、`GET /v1/me/links`、`GET /v1/me/mentions`、`POST /v1/me/logout` |
| 空间 | `GET|POST /v1/tenants`、`POST /v1/tenants/current/members`、`GET|POST /v1/tenants/current/invites`、`POST /v1/tenants/current/agent-invites` |
| 智能体 | `GET /v1/agents`、`GET /v1/agents/pending`、`POST /v1/agents/approve`、`POST /v1/agents/:id/revoke` |
| 任务 | `GET|POST /v1/tasks`、`GET /v1/tasks/:id`、`POST /v1/tasks/:id/assign`、`/offers`、`/summary`、`/review`、`/cancel`、`/archive`、`/adopt` |
| 参与 | `POST /v1/tasks/:id/participants`、`POST /v1/tasks/:id/requests`、`GET /v1/requests`、`POST /v1/requests/:id/accept|decline|counter|confirm|withdraw` |
| 子任务 | `POST /v1/subtasks/:id/accept|reject|submit|progress|timeout|return|outcome-unknown` |
| 房间 | `GET /v1/tasks/:id/room`、`/messages`、`/threads`、`/files`、`/read`、`/context-pack` |
| 文件 | `POST /v1/space/files/upload-url`、`PUT /v1/space/uploads/:token`、`POST /v1/space/uploads/:id/complete`、`GET /v1/space/files/:id/content` |
| 经验 | `GET|POST /v1/knowledge`、`/v1/knowledge/:id/publish|revise|revoke|shares|versions`、`POST /v1/aicds/:id/copy`、`GET /v1/aicds/:id/lineage` |
| 信箱 | `POST /v1/mail/sessions`、`GET /v1/mail/sessions/:id/messages|events`、`GET /v1/mail/messages/:id`、`POST .../ack|nack` |
| 内置智能体 | `GET|POST /v1/embedded/agents`、`/v1/embedded/providers`、`POST /v1/embedded/agents/:id/run`、`GET /v1/embedded/agents/:id/runs`、`POST /v1/embedded/runs/:id/log|heartbeat|finish` |
| 监管 | `GET /v1/oversight`（总览）、`POST /v1/oversight/scan`、`POST /v1/oversight/alerts/:id/ack|resolve` |
| 运维 | `POST /v1/maintenance/expire|retention`、`GET /v1/audit/report` |

一次写请求会依次完成：认证 → 主体状态与角色校验 → 幂等重放 → 资源级授权 → `If-Match` 版本比对 → 业务写入 → 事件 → 通知 / 投递 → 审计。状态、事件、通知、告警、幂等记录与审计同进同退。

---

## 代码结构

```text
src/
  protocol/            协议层：类型、错误码、入参解析（不依赖数据库与 HTTP）
  anp/                 ANP-02 身份：base58、did:wba、RFC 9421 验签/签名、登录客户端
  platform/
    db/                SQLite / PostgreSQL 驱动、schema 与迁移、行映射
    services/          账号、空间、身份、邮箱登录、Agent 授权、任务、子任务、参与、
                       协作、知识、通知、信箱、内置智能体、监管、审计、邮件
    http/              路由表、写执行器、HTTP 服务器（Bearer / ANP、SSE、CSP）
    tools/             备份、超时调度（含告警扫描）
    app.ts/context.ts  依赖装配、now 与 newId 注入
  runtime/             内置智能体运行时：supervisor、session、沙箱、模型协议、供应商目录
  sdk/                 智能体与外部程序使用的客户端，含写前日志
  agents/              示例智能体：worker、coordinator、CLI、ANP 会话
  web/                 控制台：index.html / login-help.html / app.css / app.js
skills/anpio-collab/   智能体接入说明（/auth/agent/skill.md 动态渲染）
tests/                 同一套用例跑 SQLite 与 PostgreSQL
examples/              端到端演示与示例智能体定义
scripts/               演示数据、PostgreSQL 测试脚本
docs/                  协议、运行、计划与实现状态
vercel/               VitePress 文档站：理念、功能、操作、部署、Agent 与 API
```

---

## 已知边界

- **单进程参考实现**：没有内置 TLS 与账户锁定；限流只覆盖登录端点（邮箱 5 次 / 10 分钟、DID 30 次 / 分钟，进程内计数），公网部署仍需反向代理与访问控制。
- **租户隔离在应用层**（`workspace` 条件），不是数据库行级安全；有数据库权限的人仍能直接读。
- **邮件只实现本地发件箱**：没有 SMTP、重试、退信与模板；面向真实用户上线前必须接邮件服务。
- **登录票据不绑定设备指纹**：一次性 + 短有效期是缓解，不是根治。
- **只接了 ANP 的登录**：ANP 消息通道、`anpio-key` 远程签名守护、插件多钱包切换未接。
- **知识检索是词法匹配**（中文二元组 + 打分 + 字符预算截断），没有向量检索与评测集。
- **告警是显式扫描**，不是事件驱动；失联 / 卡住 / 被拒阈值可由环境变量调整，其余阈值是常量，不是可配置策略。
- **信箱是数据库内 at-least-once**，没有外部消息队列或跨实例 pub/sub。
- **内置智能体沙箱不是容器级隔离**；强隔离需要容器或独立用户。
- **内置智能体每次运行不继承上一次对话与工作目录**；长期记忆要显式写回任务、评论或经验。
- **Kiro / Codex 订阅协议**只有本机 CLI 适配位，未安装 CLI 时明确报错。
- **S3 路径**未在真实桶上跑过完整上传、Range 与生命周期；上线前请自测。
- **多实例**：PostgreSQL 与 S3 已支持多实例读写，但 SSE 与限流仍是进程内；跨实例推送需要额外消息总线。

---

## 文档与部署

- [协议 v1](docs/protocol-v1.md)：请求约定、状态机、接口清单、错误码、幂等与版本语义
- [本地运行与恢复](docs/local-operations.md)：启动、PostgreSQL、备份、调度、故障排查
- [登录与授权说明](docs/login-and-authorization.md)：两种登录、邀请邮件、Agent 授权与撤销
- [实现状态](docs/implementation-status.md)：已实现范围与计划阶段对照
- [VitePress 文档站](vercel/)：产品理念、功能、操作指南、部署、内嵌 / 外部 Agent 与 API Reference；可构建后部署到 Vercel
- [部署指南](vercel/docs/guide/deployment.md)：服务、PostgreSQL、S3、调度器，以及把文档站发布到 Vercel
- [第二轮计划](docs/plan-v2.md) / [第三轮](docs/plan-v3.md) / [第四轮](docs/plan-v4.md) / [第五轮](docs/plan-v5.md)：设计取舍与演进记录

> **部署到 Vercel 前请先读 [部署指南](vercel/docs/guide/deployment.md)。** 本文档站是独立的 VitePress 项目（`vercel/`），可直接部署到 Vercel；但 Anpio Collab 应用本身默认是长驻单进程 + SQLite + 本地磁盘，搬到 Vercel 需要 PostgreSQL、S3 兼容存储、一个薄适配层、外部 supervisor 与 Cron，并且 SSE、文件大小、邮件都有额外限制。
