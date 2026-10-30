# 实现状态

对照 [plan.md](../plan.md)、[第二轮计划](plan-v2.md)、[第三轮计划](plan-v3.md) 与 [第四轮计划](plan-v4.md)，说明本仓库现在做到了什么、哪些只是本机验证、哪些还没开始。

> 结论先行：**阶段 1（本地协作闭环）、阶段 3（知识闭环）已实现；第二轮的身份、协作、监管三块已实现；第三轮的租户、两种登录与 Agent 授权已实现；第四轮补上"登录后补绑 DID"；第五轮把 DID 准入改成"必须已注册"，并补上反向绑邮箱；上一轮加个人资料；本轮把任务改成"交材料让智能体去做"，并允许受派智能体自提交候选经验。阶段 4/5 未开始。** 通过本机测试不等于企业环境验收。

## 任务材料与智能体经验自提交（本轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 建任务时随请求提交最多 5 个文件（单个 1 MiB、合计 2 MiB），base64 存库 | `services/materials.ts#parseMaterialUploads/insertMaterials`、`schema.ts#task_materials` | `tests/materials.test.ts` |
| 材料目录与正文接口，可见性跟随任务 | `tasks.ts#materials/material`、`routes.ts` | 同上（受派智能体能读、无关账号 404） |
| 非法 base64 / MIME / 超量整单 400 | `materials.ts#parseMaterialUploads` | 同上 |
| 受派智能体提交结果后可自提交候选经验，仍需人审核发布 | `knowledge.ts#createCandidate`、`routes.ts` | 同上（提交前 403、提交后成功、候选带 `authorName`） |
| 任务详情展示材料并可下载；创建对话框改为通用表单 + 文件选择 | `src/web/app.js` | `tests/web.test.ts` + 手工 |
| 执行归属只列个人空间与自己拥有/管理的团队 | `src/web/app.js#openCreateTask` | `tests/web.test.ts`（成员团队不出现） |
| 请求体默认上限提到 4 MiB | `src/platform/config.ts` | 配置表 |

测试合计 109 项（本轮新增 2 项材料用例、1 项智能体自提交用例、1 项归属下拉用例）。SQLite 与 PostgreSQL 跑同一套用例。

## 个人资料

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 本人修改姓名、头像、头衔、简介（`POST /v1/me/profile`） | `principals.ts#updateMyProfile`、`routes.ts` | `tests/profile.test.ts` |
| 资料挂在账号上：同一账号跨租户同步，新建团队直接带上 | `updateMyProfile` 同步 `accounts` 与本人主体；`tenants.ts#createTenant/principalFor` | 同上（建第二个团队后断言） |
| 头像只收 `https` 地址或图片 `data:` URL，长度受限 | `principals.ts#normalizeAvatar` | 同上（`javascript:` 与超长 data URL 均 400） |
| 成员列表与评论作者带头像/头衔 | `tenants.ts#members`、`collab.ts` | 同上（成员列表断言） |
| 设置页「个人资料」卡片与编辑对话框：上传后压到 256px WebP、预览、清除 | `src/web/app.js`、`app.css` | 手工 |
| 无头像时按姓名首字生成色块，不再直接露出 DID handle | `app.js#avatarNode` | 手工 |

测试合计 98 项（本轮新增 2 项个人资料用例）。SQLite 与 PostgreSQL 跑同一套用例。

## 第五轮新增

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| DID 文档解析器：`did:wba` → `did.json`，https/超时/大小/不跟重定向/缓存 | `src/anp/resolver.ts` | `tests/did-resolution.test.ts` |
| 登录与补绑都以解析到的文档验签，未注册的 DID 一律拒绝 | `identity.ts#resolveKey` | 同上 |
| 请求体自带的 `didDocument` 不再被采信（防冒充） | `identity.ts` | 同上（受害者 DID + 攻击者公钥 → 401） |
| Agent 获批前预检 DID 是否已登记，避免写入永远登不进来的身份 | `agentAuth.ts#approve` | `tests/tenant-auth.test.ts` |
| 反向绑定：DID 登录后补邮箱（发信验证、一次性、不换会话） | `emailAuth.ts#startBind`、`/auth/email/verify` | `tests/email-bind.test.ts` |
| `GET /v1/me/links`：账号的登录方式总览 | `accounts.ts#links`、`routes.ts` | 同上 + `tests/web.test.ts` |
| 设置页「登录方式」卡片 + 绑定邮箱对话框 | `src/web/app.js` | `tests/web.test.ts` |
| 老库兼容：`listFor` 用 LEFT JOIN，ANP 首次登记补租户行 | `tenants.ts`、`identity.ts` | `tests/email-bind.test.ts`（同一账号不重复建组织） |

测试合计 91 项（新增 5 项解析/未注册用例、4 项反向绑定用例、1 项设置页用例）。SQLite 与 PostgreSQL 跑同一套用例。

## 第四轮新增

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 已登录后补绑 DID：挑战 → 钱包签名 → 挂到当前主体 | `services/identity.ts`、`http/routes.ts`、`http/server.ts` | `tests/identity-bind.test.ts` |
| 双条件校验：会话令牌 + DID 私钥签名，缺一不可 | `identity.ts#bindDid` | 同上（无会话 401、篡改 401） |
| 补绑挑战用途隔离（`purpose=bind`），一次性、不可挪用 | `identity.ts#consumeNonce` | 同上（登录挑战 401） |
| 归属冲突显式拒绝：同组织他人 409、他账号 409，不静默改写 | `identity.ts#bindDid` | 同上 |
| 主体无主 DID 时补绑即设为主身份，并回写 handle | `identity.ts`、`routes.ts` | 同上 + `/v1/me` 断言 |
| 设置页「绑定我的 DID」：钱包探测、置忙、重复绑定提示 | `src/web/app.js` | `tests/web.test.ts` |
| 路由上下文提供 `headers` / `rawBody` / `origin`，签名类接口不必再回落到 `/auth/*` | `http/router.ts`、`http/server.ts` | 上述两组用例 |

测试合计 81 项（新增 8 项补绑用例 + 1 项设置页前端用例）。SQLite 与 PostgreSQL 跑同一套用例。

## 第三轮新增

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 邮箱一次性链接登录（15 分钟、一次性、防枚举） | `services/emailAuth.ts`、`http/server.ts` | `tests/tenant-auth.test.ts` |
| 首次登录自动建个人组织（本人是所有者） | `services/tenants.ts` | 同上 |
| 多组织选择与切换（换发会话、旧会话作废） | `emailAuth.ts`、`routes.ts`、`app.js` | 同上 + 手工 |
| 邀请：邮件链接一次完成验证邮箱、入组、登录 | `tenants.ts`、`emailAuth.ts` | 同上 |
| 邀请邮箱不匹配即拒绝（链接被转发无效） | `tenants.ts#acceptInvite` | 同上 |
| 租户角色 owner/admin/member/guest 及派生业务角色 | `tenants.ts#rolesFor` | 同上 |
| 成员管理：列表、改角色、移除、撤销邀请；不能改自己、所有者唯一 | `tenants.ts`、`routes.ts`、`app.js` | 同上 |
| Agent 设备授权：申请 → 人批准 → 轮询换令牌 → 撤销 | `services/agentAuth.ts` | 同上 |
| 两种 Agent 模式：独立主体 / 绑定本人账号 | `agentAuth.ts` | 同上 |
| 授权范围 scopes 与期限，`/v1/me` 返回实际范围 | `agentAuth.ts`、`routes.ts` | 同上 |
| 登录前可见的说明页 `/help/login` | `src/web/login-help.html` | `tests/web.test.ts` |
| 成员页、我的智能体页、组织切换器 | `src/web/app.js`、`app.css` | `tests/web.test.ts` + 手工 |
| 撤销后可重新授权（同一 DID 复用主体）、智能体不能升管理员 | `services/agentAuth.ts`、`tenants.ts` | `tests/tenant-auth.test.ts` |

测试合计 72 项（新增 10 项租户/登录/授权 + 1 项说明页）。SQLite 与 PostgreSQL 跑同一套用例。（第三轮结束时的数量；当前 81 项。）

## 第二轮新增（本轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| ANP-02 登录：`GET /auth/anp/challenge` + 签名 `POST /auth/anp/login` | `src/platform/services/identity.ts`、`src/platform/http/server.ts` | `tests/anp.test.ts` |
| RFC 9421 验签（`@method @target-uri @authority content-digest` + `created/expires/nonce/keyid`） | `src/anp/signature.ts` | `tests/anp.test.ts` |
| `did:wba` 与 e1 profile、multibase 公钥解析、fingerprint 校验 | `src/anp/did.ts`、`src/anp/base58.ts` | `tests/anp.test.ts` |
| nonce 一次性、验签失败不消耗、重放换发新挑战 | `identity.ts` | `tests/anp.test.ts` |
| 401 挑战语义与 `anpio-cli anp login` 互通；`Authentication-Info` 投递令牌 | `server.ts`、`src/anp/client.ts` | `tests/anp.test.ts`「不带 nonce 时返回 401 挑战…」 |
| 会话令牌（只存 SHA-256）、退出登录只撤销当前会话 | `identity.ts` | `tests/anp.test.ts` |
| 绑定码：把另一条 DID 挂到同一账号，一次性、填错不放行 | `identity.ts` | `tests/anp.test.ts`、`tests/agent-session.test.ts` |
| 主体类型 `human / agent / service` 与自动登记落位（`open` / `pending` / `off`） | `identity.ts`、`principals.ts` | `tests/anp.test.ts` |
| 智能体侧 ANP 会话：JWK 载入、令牌缓存、401 自动重签一次 | `src/agents/session.ts` | `tests/agent-session.test.ts` |
| 协作：评论 + `@` 提及、开放子任务与认领、智能体提案与接管、心跳与在线表 | `services/collab.ts`、`tasks.ts` | `tests/collab.test.ts` |
| 监管：九条规则、去重累加、条件消失自动解决、人工结论不被推翻 | `services/oversight.ts` | `tests/oversight.test.ts` |
| 可见性收敛：智能体只看自己的子任务；目录只含自己+同任务+协调者；开放池只广播必要字段 | `tasks.ts`、`principals.ts`、`collab.ts` | `tests/anp.test.ts`「智能体的目录…」、`tests/collab.test.ts` |
| 管理台：钱包登录、按角色生成导航、智能体工作台、开放池、提醒、监管看板、设置 | `src/web/*` | `tests/web.test.ts`（DOM 桩 + 真实 HTTP） |
| 调度器一轮里先超时、再扫描告警 | `src/platform/tools/scheduler.ts` | 手工（`npm run scheduler -- --once`） |

## 之前已完成并有测试覆盖

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 任务生命周期（pending → running → review → completed / cancelled） | `src/platform/services/tasks.ts` | `tests/lifecycle.test.ts` |
| 子任务状态机（invited → accepted → submitted → verified，含拒绝/超时/结果未知/退回） | `src/platform/services/subtasks.ts` | `tests/lifecycle.test.ts` |
| 依赖门控：前置未完成时不出现在待办、不能接受 | `subtasks.ts` | `tests/lifecycle.test.ts` |
| 验收与退回、取消并通知 | `tasks.ts` + `notifications.ts` | `tests/lifecycle.test.ts` |
| 幂等：同键同请求重放、同键不同请求 409 | `src/platform/http/executor.ts` | `tests/idempotency.test.ts` |
| 乐观并发：`If-Match` → 412，子任务条件更新 → 409 | `executor.ts` + `subtasks.ts` | `tests/idempotency.test.ts`、`tests/lifecycle.test.ts` |
| 授权分离：身份 / 平台角色 / 业务资源 | `services/access.ts` + 路由声明 | `tests/authorization.test.ts` |
| 进程重启后状态、事件、令牌仍有效 | SQLite WAL + 写前日志 | `tests/recovery.test.ts` |
| 知识生命周期：候选 → 发布（有效期 + 范围）→ 引用（钉版本）→ 修订/撤销/改范围 | `services/knowledge.ts` | `tests/knowledge.test.ts` |
| 检索：中文二元组 + 打分 + 字符预算截断 + 稳定引用 | `knowledge.ts` | `tests/search.test.ts` |
| 三个智能体跨进程完成闭环（协调 + 两个业务 + 写前日志重放；其中一个用 DID 登录、一个用静态令牌） | `src/agents/*.ts`、`examples/demo.ts` | `tests/agents.test.ts`、`npm run demo` |
| PostgreSQL 方言兼容 | `src/platform/db/postgres.ts` | `npm run test:postgres` |
| 一致性备份 | `src/platform/tools/backup.ts` | 备份后 `integrity_check` |

第二轮测试合计 61 项（当时新增 31 项）。`npm run check` 无类型错误；SQLite（`npm test`）与临时 PostgreSQL 实例（`npm run test:postgres`）各跑一遍；`npm run demo` 端到端跑通（DID 登录 → 闭环 → 经验引用）。

## 与本机验证的边界

- **管理台**用 DOM 桩 + 真实 HTTP 跑通登录与每个视图（`tests/web.test.ts`），但桩只实现用到的 API：布局、样式与实际浏览器行为仍需人工看一遍。
- **钱包插件**在测试里用与插件、CLI 相同的 `signRequest` 代签，等价于验签链路，但不覆盖插件自身的授权弹窗与密钥库。
- **`anpio-cli` 互通**按 CLI 的语义（401 挑战 + 重签一次 + `Authentication-Info`）验证，没有在 CI 里真的跑 Rust 二进制。
- **备份恢复**只验证了"备份文件完整"，没有做过真实故障注入（磁盘满、断电、WAL 损坏）。
- **并发**验证的是单进程内的串行写事务与版本冲突；多进程同时写同一个 SQLite 文件未验证（生产应使用 PostgreSQL）。
- **智能体重放**覆盖了"请求发出后进程退出"的场景，未覆盖"提交成功但响应丢失后重放"的全部分支。

## 未实现（明确缺口）

| 计划项 | 现状 |
| --- | --- |
| ANP 消息通道（`anpio-cli` 的收发、A2A 消息） | 未接。平台只用 ANP 做登录，任务协作仍走自己的 HTTP 接口 |
| `anpio-key` 远程签名守护（`SIGN_HTTP` / `SIGN_ORIGIN_PROOF`） | 未接。平台只做验签方，尚未消费 key daemon 的 grant |
| 插件内多钱包 / 多 DID 切换与 DID 轮换（`did_superseded`） | 平台侧返回 409 `did_superseded` 的语义预留但未产生 |
| 阶段 4：真实业务系统接入 | 未开始。示例智能体读本地 JSON |
| 阶段 5：跨组织协作 | 未开始 |
| 向量检索 / pgvector / 检索评测集 | 未开始。当前是词法匹配 |
| 事件驱动的告警 | 现在是显式扫描（接口或调度器），不是事件触发；阈值是常量 |
| 通知的可恢复投递 | 数据库内存量通知 + 拉取确认；没有退避、没有外部队列 |
| 多租户 | 已实现到应用层：租户、成员、角色、跨租户切换与隔离都有测试；**没有**数据库行级安全（管理员可直接读库） |
| 邮件投递 | 只实现本地发件箱与控制台打印；SMTP、重试、退信、模板管理未做 |
| 邮箱验证之外的登录方式 | 没有密码、SMS、SSO/SAML/SCIM、社交登录 |
| 票据防转发 | 一次性 + 15 分钟是缓解；没有设备指纹或二次确认 |
| 速率限制 / TLS / 集中审计 | 未实现。限流在进程内；当前定位是单机内网参考实现 |

## 截至本轮的关键修复

- **schema 迁移幂等**：`PRAGMA table_info()` 在表不存在时返回空集而不报错，导致所有列都被判为"缺失"并重复 `ALTER TABLE`。改为先查 `sqlite_master` / `information_schema.tables`。
- **读不到自己刚写的数据**：写事务提交前，独立只读连接看不到新行。`acknowledge` / `resolve` / `logout` / `claimOffer` 改为在事务内构造返回值或更新。
- **`claimOffer` 之后看不到任务**：`assign` 会把 `pending` 推到 `running`，而待办只查 `running`；认领改成"加入任务"的动作（`loadTask` 而非 `readTask`，并推进任务状态）。
- **接管提案报无权访问**：提案不在他人可见范围内，`adopt` 改用工作空间级 `loadTask`，授权由角色 + 未接管 + 未终结决定。
- **`readMention` 找不到提醒**：返回的是评论 ID 而非 `task_mentions.id`。查询补 `m.id AS mention_id`。
- **监管扫描对 owner 放行**：`scan(workspace)` 无授权检查，新增 `scanFor(actor)` 供路由使用，保留无主体的 `scan` 给调度器。
- **绑定码填错会悄悄开新账号**：`resolvePrincipal` 在绑定码对不上时继续走自动登记。改为直接拒绝。
- **嵌套事务自锁**：执行器开事务后服务层再开事务会死锁在 SQLite 互斥上。改用 `AsyncLocalStorage` 传递当前事务。
- **登录后主体不显示**：组件的 `display: grid` 覆盖了浏览器默认的 `[hidden]{display:none}`，已加全局兜底规则。
- **PostgreSQL 无法推断裸 NULL 参数**：`(:did IS NOT NULL AND did = :did)` 报 `42P18`，改为按 `did` 是否存在分支查询。
- **演示脚本的 workspace 与身份服务不一致**：`createApp` 按 `COLLAB_WORKSPACE`（默认 `local`）构造身份服务，而 demo 用 `bootstrap('demo', …)` 建主体，绑定码因此在两个 workspace 之间跨不过去。改为显式传 `identity: { workspace: 'demo' }`——这类"隐式默认值 + 显式实参"的错配，只有把登录真的跑一遍才会暴露。
