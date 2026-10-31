# 本地运行与恢复

本说明面向单机开发与内部试用。服务默认只监听 `127.0.0.1`，应用进程、数据库文件与令牌都由本机用户保护；这不是生产部署方案。

## 启动

```sh
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
export COLLAB_DB="$PWD/data/collab.sqlite3"     # 可选，默认 ./collab.sqlite3
npm start
```

首次启动会在同一个事务里建表并创建 `admin` 主体（角色 `admin/owner/reviewer`，同时是该租户的所有者）。

### 登录与本地邮件

- 打开 <http://127.0.0.1:8787/>：填一个邮箱即可登录，首次登录会创建个人组织。
- 本地没有邮件服务：邮件写进 `mail_outbox` 表，同时在控制台打印；接口也会返回 `devLink`，
  登录页会把它显示出来（标着“开发模式”）。
- 生产部署两个必须改的变量：`COLLAB_PUBLIC_URL` 指向真实域名（邮件链接的基地址）、
  `COLLAB_DEV_MAIL=0`（关掉 devLink 与本地发件箱读取接口）。
- 登录页的《登录与授权说明》挂在 `/help/login`，不需要登录；它和
  [login-and-authorization.md](login-and-authorization.md) 讲的是同一件事。
- `COLLAB_MAIL=console` 时只打印不发信；默认 `outbox` 会同时写库，便于本机排查。

> `COLLAB_BOOTSTRAP_TOKEN` 只在**数据库为空**时生效。数据库里已有主体时修改环境变量不会改变任何令牌，需要用 `POST /v1/principals/:id/rotate-token` 轮换。令牌不要进 Git、命令历史或任务内容。

登记智能体时给每个进程单独的随机令牌：

```sh
TOKEN=$(openssl rand -hex 24)
curl -s -X POST http://127.0.0.1:8787/v1/principals \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: register-inventory" \
  -d "{\"id\":\"inventory\",\"roles\":[\"agent\"],\"token\":\"$TOKEN\",\"capabilities\":[\"inventory:read\"]}"
```

令牌只以 SHA-256 摘要落库，响应里不会回显。停用主体立即拒绝其后续请求，已提交的结果与审计保留。

## 数据库迁移

schema 现在到 v13。v2–v6 引入账号、租户、邀请、登录票据、Agent 授权、本地发件箱、
个人空间与经验分享；v7–v12 加入任务房间、对象存储、未读、归档与保留期；v13 新增
`mailbox_messages/sessions/subscriptions/deliveries`、`embedded_agents/runs/run_logs/supervisors`。
迁移在启动时幂等执行：先查现有列，再在同一个事务里 `CREATE TABLE IF NOT EXISTS`
与必要的 `ALTER TABLE`。v13 迁移还会给已有 `agent_grants.scopes` 追加
`mailbox:read`、`mailbox:write`，避免升级后老智能体突然收不到信。

升级既有库时注意两点：

- 旧数据的 `principals.account_id` 为空，第一次用 DID 登录时会自动补建账号并回填；
  没登录过的遗留主体仍然可用，只是看不到跨租户的组织列表。
- `tenant_role` 默认 `member`。迁移会做一次幂等回填：带 `admin` 能力角色的主体补成
  `admin`，每个没有所有者的租户把最早的管理员补成 `owner`（否则升级后没人能管成员）。
  回填在每次启动时都会跑，条件不满足就什么都不做；也可用 `POST /v1/members/:id/role` 手工调整。

## SQLite

- 数据库由三部分组成：`collab.sqlite3`、`-wal`、`-shm`。**不要**在服务运行时单独复制主文件当备份。
- 写事务使用 `BEGIN IMMEDIATE`，进程内串行；读请求走独立的只读连接，因此不会被写事务挡住。
- `:memory:` 不支持：驱动需要一条独立的只读连接，内存库无法跨连接共享。

## 一致性备份

```sh
npm run backup -- ./collab.sqlite3 /secure/collab-backup-20261028.sqlite3
```

目标文件必须不存在。命令先做 `PRAGMA integrity_check`，再用 `VACUUM INTO` 生成快照并复查备份完整性。备份包含任务、令牌摘要、审计与知识正文，按企业数据政策保护；本工具不做加密、异地传输或保留期管理。

**恢复演练**：把备份复制到隔离目录，设置 `COLLAB_DB` 指向该副本启动一个**独立实例**，用原令牌核对任务、事件、经验引用与撤权状态。通过后再按停机流程替换生产文件。恢复旧备份会回滚近期任务与撤权，必须先与外部业务系统核对；当前没有防回滚机制。

## PostgreSQL

把 `COLLAB_DB` 换成连接串即可，schema 会自动迁移：

```sh
export DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/collab"
npm start
```

本机 Homebrew PostgreSQL（已在 PostgreSQL 15 上验证）：

```sh
brew services start postgresql@15      # 已在运行则跳过
createdb collab                         # 只需一次；库名可自取
DATABASE_URL="postgresql://127.0.0.1:5432/collab" \
  COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" npm start
```

空库首次启动必须给 `COLLAB_BOOTSTRAP_TOKEN`（至少 24 字符），用来创建管理员主体；之后启动不再需要。schema 会自动迁移；8787 被占用时加 `PORT=8788`。

- 使用连接池（`max: 10`），事务独占一条连接，普通查询各自取连接
- 迁移在 `pg_advisory_xact_lock` 下执行，多实例同时启动不会互相踩踏
- `BIGSERIAL` 的 `int8` 已统一转成 `number`；项目的序号都在安全整数范围内
- 备份请用 `pg_dump`；`npm run backup` 只支持 SQLite，遇到 `postgres://` 会直接报错

验证方言差异：

```sh
npm run test:postgres     # 需要本机已安装 initdb / pg_ctl / createdb
```

脚本会拉起一个临时实例（默认端口 55439），跑完即删。测试文件共用一个库，因此**串行执行**——某个文件开头的 `DROP SCHEMA` 会清掉另一个文件正在用的表。

## 超时调度与告警扫描

平台不自带定时任务：超时与告警都是显式的管理操作，调一次留一次审计。调度器一轮做两件事，**顺序固定**：

1. `POST /v1/maintenance/expire` —— 把"已过截止时间且仍未提交"的子任务标记为 `timed_out`
2. `POST /v1/oversight/scan` —— 按 9 条规则开/并/关告警

先超时后扫描，是为了让同一轮里新产生的逾期当轮就被看见，而不是等下一轮。每轮输出一行 JSON：

```json
{"at":"2026-01-01T00:00:00.000Z","expired":1,"checkedAt":"2026-01-01T00:00:00.000Z","alerts":{"opened":1,"updated":0,"resolved":0,"total":1}}
```

```sh
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler -- --once          # 只跑一次
COLLAB_SCHEDULER_INTERVAL_MS=60000 \
  npm run scheduler                    # 每分钟一次，Ctrl-C 退出
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler -- --once --no-scan   # 只跑超时，不碰告警
```

几个要点：

- 令牌需要 `admin`：超时检查本身就是管理员动作（`POST /v1/maintenance/expire` 对非管理员返回 403）。告警扫描另外还接受 `supervisor`，所以纯监管者可以调 `POST /v1/oversight/scan`，但跑不了完整的一轮调度。`--no-scan` 给"只想推进超时、不想动告警"的场景用（比如告警已有独立节奏）。
- 超时标记只改变协作状态，**不推断业务执行失败**——超时后应先与外部系统核对实际结果，再决定是否退回。事件里记的是 `subtask_timed_out`，与"执行失败"是两类结论。
- 告警扫描是幂等的：按 `(rule, subjectType, subjectId)` 去重累加 `occurrences`，不会一轮刷一堆重复告警；条件消失时自动置 `resolved_by='auto'`，人工确认过的告警**不会**被扫描器重开。
- 调度器进程挂了没人会发现。生产上把它交给 systemd / launchd / K8s CronJob，并给"连续 N 分钟没有调度轮次"单独做外部探测——平台的在线表只反映智能体心跳，不反映自己是否被扫过。

## 信箱与内置智能体

### 服务端准备

内置智能体的令牌由服务端和 supervisor 共享的密钥派生，两边必须一致：

```sh
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 只放环境变量，不要进库或进 Git
npm start
```

管理接口（定义、ensure、运行记录）要求 `admin`；控制台"内置智能体"对 `admin`/`owner` 出现。
**不要**把 `COLLAB_EMBEDDED_SECRET` 传给 shell 子进程：supervisor 启动 session 时已经把它从子进程环境里删掉，只通过 stdin 传派生后的令牌。

### 跑一轮

```sh
# 单轮：扫描一次、等本轮结束、退出（适合 cron / 调试）
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime -- --once

# 只跑一个定义
... npm run runtime -- --once --agent <agentId>

# 常驻；启动时把 examples/agents.json 里的定义按名称 upsert 进去
COLLAB_AGENTS_FILE=examples/agents.json \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

- supervisor 空闲时只是一个定时器，不加载模型；每次有未读才 spawn 一个 `session.ts`。
- supervisor 默认连 `http://127.0.0.1:<PORT>`；服务不在 8787 时用 `COLLAB_BASE_URL` 指定平台地址。每轮日志写入该运行的记录，控制台「内置智能体 → 运行记录」可直接查看。
- 运行目录默认在 `./collab-runs/<agentId>/<runId>/`，结束后删除；要排查就设 `COLLAB_KEEP_RUN=1`。保留目录不会被平台自动回收，排查完请手动删。
- 控制台点「立即运行」会先建一条运行记录；supervisor 会接管这种还没有心跳的运行，不需要再点一次。
- 定义里的 `enabled=false` 时不会被叫起来；`concurrency` 控制同一个定义同时跑几轮，supervisor 另有全局上限 `COLLAB_RUNTIME_CONCURRENCY`。
- 模型密钥只写环境变量名（如 `ANTHROPIC_API_KEY`），值由运行 supervisor 的那台机器提供；数据库只存名字。

### 运行记录与回收

`POST /v1/maintenance/retention` 同时处理软删除文件、过期的信箱消息/会话/投递，以及已结束超过保留期的 `embedded_runs` 与日志。默认 `apply=false` 只给预览：

```sh
curl -s -X POST http://127.0.0.1:8787/v1/maintenance/retention \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: retention-preview-$(date +%s)" \
  -d '{"days":30}' | jq
```

确认后再加 `"apply":true`。`running` 状态的运行不会被删；心跳停滞的运行由 supervisor 的 `recover` 先标成 `outcome_unknown`，消息退回队列。

### 沙箱边界

`COLLAB_SANDBOX_EXEC=1` 只在 macOS 上用 `sandbox-exec` 多包一层（默认拒绝网络、只允许写运行目录），起不来会让这一轮失败而不是静默降级。它不是容器：需要强隔离时，把 supervisor 放进容器或独立用户下运行，并限制网络出口。

### 常见问题

**supervisor 报"需要 COLLAB_RUNTIME_TOKEN"**：它用管理员令牌调平台接口，不能拿内置智能体的派生令牌代替。

**报"服务器未配置 COLLAB_EMBEDDED_SECRET" / 子进程 401**：服务端与 supervisor 的 `COLLAB_EMBEDDED_SECRET` 不一致，或服务端没设。两边改成同一个值，重启服务后重新 `ensure`（下一次运行会自动做）。

**运行记录一直 `running`**：先看 supervisor 是否在跑、日志里有没有 `▶`/`■`。心跳超过阈值后，`recover` 会把它标成 `outcome_unknown`。

**控制台点「立即运行」后没动静**：需要有一个启用的 supervisor 连着同一平台；控制台只负责建运行记录。

**想换模型供应商**：控制台「内置智能体 → 编辑」里按分类选，或导入 `examples/agents.json` 改 `provider`；自定义供应商必须填 `baseUrl` 与 `protocol`。

## 智能体密钥与登录

智能体有两种接入方式，可以并存：

**静态令牌**（最简单，适合内网试用）

```sh
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$AGENT_TOKEN \
  node src/agents/cli.ts inbox
```

**DID 密钥**（走 ANP-02，与浏览器钱包同一套签名）

```sh
export COLLAB_URL=http://127.0.0.1:8787
export COLLAB_ANP_KEY=$PWD/keys/inventory.json      # Ed25519 JWK，文件名即 handle
export COLLAB_ANP_DOMAIN=127.0.0.1                   # 可选，DID 的 domain 部分
node src/agents/cli.ts login                          # 首次登录，落一份会话缓存
node src/agents/cli.ts whoami
```

- DID 由**公钥 + handle + domain** 共同决定：换文件名就是换身份，换机器请把密钥文件一起带走。
- 会话缓存写在 `.anpio-collab/session-<host>-<handle>.json`（`0600`），含访问令牌。已在 `.gitignore` 里。缓存未过期就直接复用，过期或被撤销时 `withAgentClient` 收到 401 会自动重登一次。
- 陌生 DID 的落位由 `COLLAB_ANP_ENROLL` 决定：
  - `open`（默认）——首次登录自动登记为 `human`/`owner` 或 `agent` 主体并立即可用。**只适合本机或可信内网**。
  - `pending`——登记但 `active=0`，接口返回 `403 enrollment_pending`。CLI 会把 DID 打出来，管理员在"参与者"页批准后即可登录。企业部署应该用这个。
  - `off`——不接受自动登记，只有已绑定的 DID 能进。
- 想让智能体和人共用同一个账号（协作同一个主体的任务与提醒），由人先登录，在"设置"页签发一个绑定码，再让智能体带码登录：

  ```sh
  node src/agents/cli.ts login 8F3K-2QX9
  ```

  绑定码一次性、有有效期。绑定成功后智能体的 DID 挂到该账号的 `identities` 下，读到的任务、评论、提醒与人完全一致。
- `anpio-cli` 也能直接登录（同一套挑战语义，无需改参数）：`anpio-cli anp login --target http://127.0.0.1:8787/auth/anp/login`，身份取自它自己的密钥库（`--agent` / `--profile`）。令牌如何落地由 CLI 决定，平台侧只看 `Authorization: Bearer`。

## 反向代理与端口

默认 `HOST=127.0.0.1`。若要放到内网，请在前面加一层 TLS 终止与访问控制，并注意：

- 没有速率限制与账户锁定，令牌被拿到即可全权使用
- CSP 允许 `style-src 'self' 'unsafe-inline'`（部分内联样式），其余默认收紧
- 审计只写本地库，需另接集中审计才有留存保证

## 常见问题

**启动报"COLLAB_BOOTSTRAP_TOKEN 至少需要 24 个字符"**：令牌太短。用 `openssl rand -hex 32`。

**启动后登录 401**：数据库不是空的，环境变量里的令牌不再生效。用现有管理员令牌轮换，或换一个空的 `COLLAB_DB` 重新开始。

**界面提示"没有检测到 ANP 钱包插件"**：`anpio-extension` 是 MV3 扩展，需要先在 Chrome/Edge 里加载并解锁；页面只探测 `window.anp.isAnpWallet`，装好插件后刷新即可，也可以展开"用访问令牌登录"直接贴管理员给的令牌。

**钱包签名一直 401 `challenge_required`**：客户端只该重签一次。反复 401 通常是签名的 `url` 与真实请求地址不一致（比如页面用 `localhost` 打开、插件按 `127.0.0.1` 签），或者请求体被重新序列化过——插件返回的 `body` 字节必须原样发出。改用一个固定的 host 访问即可。

**登录报 `403 enrollment_pending`**：这是 `COLLAB_ANP_ENROLL=pending` 的正常行为，不是故障。让管理员在"参与者"页批准这个 DID（CLI 会把 DID 打出来）。

**换了密钥之后旧 DID 还能登录吗**：不能。DID 里带着公钥指纹（`e1_<fingerprint>`），换密钥就是另一个 DID、另一个主体；旧的那个请用管理员令牌 `POST /v1/principals/:id/deactivate` 停掉，不要手工改库里的 `did` 字段——历史审计还引用着它。

**绑定码报"无效或不属于当前工作空间"**：码是签发它的那个工作空间里的一次性凭证，跨库无效；已使用或超过 24 小时（默认）也会失效。绑定码只登记"这条 DID 属于谁"，**不会**给主体加角色。

**请求一直 412**：界面或脚本持有旧的 `version`。重新 `GET /v1/tasks/:id` 后再操作。

**同一个 `Idempotency-Key` 报 409**：键被复用于不同请求。幂等键必须与请求内容一一对应；换内容就换键。

**子任务提交报"result 需要 quantity 或 summary 至少一个"**：`result` 里至少要有一个结论字段，并且必须带 `source` 与 `observedAt`。

**审计里看不到读操作**：这是设计如此。只有知识检索与证据包读取会留痕，其余读取不记录，避免被控制台轮询淹没。

**测试卡在端口**：`npm test` 需要能绑定回环端口；`npm run test:postgres` 的默认端口是 55439，可用 `COLLAB_TEST_PG_PORT` 改。

## 数据清理

演示与测试数据都是本地文件，直接删除即可：

```sh
rm -f dev.sqlite3 dev.sqlite3-wal dev.sqlite3-shm
```
