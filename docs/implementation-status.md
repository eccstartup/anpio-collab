# 实现状态

对照 [plan.md](../plan.md)、[第二轮计划](plan-v2.md)、[第三轮计划](plan-v3.md)、[第四轮计划](plan-v4.md) 与 [第五轮计划](plan-v5.md)，说明本仓库现在做到了什么、哪些只是本机验证、哪些还没开始。

> 结论先行：**阶段 1（本地协作闭环）、阶段 3（知识闭环）已实现；第二轮的身份、协作、监管三块已实现；第三轮的租户、两种登录与 Agent 授权已实现；第四轮补上"登录后补绑 DID"；第五轮把 DID 准入改成"必须已注册"，并补上反向绑邮箱；之后依次完成个人资料、任务材料与智能体经验自提交、经验生命周期与任务房间、对象存储/未读/交接包、团队首页/归档/保留期/审计报表；本轮补上信箱与 SSE 推送、内置智能体运行时、模型供应商目录与控制台。语义检索仍未开始。** 通过本机测试不等于企业环境验收。

## 本轮：信箱、内置智能体与模型接入

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 信箱：信封与正文分离、按会话独立游标、at-least-once、ack/nack 退避、租约与长轮询 | `services/mailbox.ts`、`schema.ts`（v13）、`routes.ts` | `tests/mailbox.test.ts`（10 项：游标隔离、信封不含正文、越权 404、ack 幂等、queue 唯一领取、事务回滚等） |
| 自动发布：受派/退回/取消/认领/@/提问/新线程/待验收/协作请求/运行失败，都在业务写事务内 | `services/notifications.ts`、`collab.ts`、`subtasks.ts`、`participation.ts`、`embedded.ts` | `tests/mailbox.test.ts` + `tests/lifecycle.test.ts` |
| SSE 推送：`GET /v1/mail/sessions/:id/events`，`Last-Event-ID` 续传、关闭会话结束、shutdown 不被长连接拖住 | `http/server.ts`、`mailbox.ts#closeStreams` | `tests/stream.test.ts`（4 项） |
| 订阅：主体/任务/能力主题，只允许订自己、可读任务或已声明能力；scope 新增 `mailbox:read|write` | `mailbox.ts#subscribe`、`access.ts`、`protocol/types.ts` | `tests/mailbox.test.ts` + `tests/authorization.test.ts` |
| 保留期：过期消息、会话、已结算投递与结束超过 N 天的运行/日志；默认预览 | `mailbox.ts#retention`、`routes.ts` | `tests/mailbox.test.ts` |
| 内嵌定义与身份：定义校验/规范化、`ensure` 幂等创建 `embedded-<id>` 主体、HMAC 派生令牌 | `runtime/definition.ts`、`services/embedded.ts` | `tests/runtime.test.ts`、`tests/providers.test.ts` |
| supervisor：常驻不加载模型，有未读才 spawn 一次性 session；并发上限、停用不叫醒、接管控制台手动运行、多轮运行日志独立 | `runtime/supervisor.ts`、`services/embedded.ts` | `tests/runtime.test.ts`（5 项，含跨进程 E2E） |
| 一次运行：拉信封 → 取正文 → 模型循环 → 工具调用 → ack/nack → finish；令牌只走 stdin | `runtime/session.ts`、`runtime/tools.ts` | 同上 |
| 沙箱：工作目录 0700、路径与符号链接逃逸拒绝、shell 超时杀进程组、环境清洗、输出截断 | `runtime/sandbox.ts` | `tests/sandbox.test.ts`（4 项） |
| 模型协议：OpenAI Chat/Responses、Anthropic Messages、Gemini Generate、Workers AI、Jev 决策、确定性 script；供应商目录按厂商/订阅/分发/自定义分组 | `runtime/providers.ts`、`runtime/brains/*` | `tests/providers.test.ts`（7 项，mock HTTP，不发真实网络） |
| 控制台：内置智能体列表、分组供应商选择、编辑/启停/立即运行、运行列表与日志轮询 | `src/web/app.js`、`app.css`、`index.html` | `tests/web.test.ts`（新增 1 项） |
| 文档与种子：运行说明、配置、`examples/agents.json`（script 默认启用，需密钥的定义默认停用） | `README.md`、`docs/local-operations.md`、`examples/agents.json` | 手工 |

测试合计 168 项（本轮新增信箱 10、SSE 4、运行时 5、沙箱 4、供应商 7、控制台 1，以及既有套件中随新表/新 scope 调整的用例）。`npm run check` 无类型错误；SQLite 与 PostgreSQL 各 168 项全过。

## 第三阶段：归档、保留期与审计报表（本轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 任务归档：只有负责人/管理员能归档已完成或已取消的任务；归档只写 `archived_at` 与事件，不改状态、不删版本与文件；可取消归档 | `schema.ts`（v11）、`tasks.ts#archive/unarchive`、`routes.ts`、`src/web/app.js` | `tests/lifecycle.test.ts`（未结束拒绝、非负责人 403、重复归档 409、列表默认隐藏、取消归档恢复） |
| 归档后的可见性：默认任务列表、团队首页「需要你」、监管告警与概览统计都排除归档任务；任务列表可勾选「显示已归档」 | `tasks.ts#buildListSql`、`collab.ts#home`、`oversight.ts`、`src/web/app.js` | 同上 + 既有首页/监管用例 |
| 文件保留期回收：`POST /v1/maintenance/retention`，只处理所有引用文件都已软删除且最后删除时间早于保留期的对象；默认 `apply=false` 只预览，确认后先删对象字节再删对象记录；非管理员 403 | `collab.ts#retention`、`routes.ts` | `tests/storage.test.ts`（刚删除的不在候选、预览不删、确认后对象记录消失、内容仍 404） |
| 审计报表：`GET /v1/audit/report?days=` 按动作、结果、日期与主体聚合，区分 `denied:*`；控制台审计页显示近 7 天汇总与按接口排名 | `audit.ts#report`、`routes.ts`、`src/web/app.js#renderAudit` | `tests/authorization.test.ts`（非管理员 403、按日合计等于总数、拒绝计数非零）；网页仅结构断言，未在浏览器手点 |
| SDK：`archiveTask/unarchiveTask`、`tasks({ includeArchived })`、`auditReport(days)`、`retention(days, apply)` | `src/sdk/client.ts`、`src/sdk/types.ts` | 上述测试全程走 SDK |

测试合计 132 项（本轮新增归档 1 项、保留期 1 项，并把审计报表断言并入既有授权用例）。`npm run check` 无类型错误；SQLite（`npm test`）与本地 PostgreSQL（`npm run test:postgres`）各 132 项全过。

## 第三阶段：团队首页（上一轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 团队首页「需要你」：点名提问未回答、@ 提醒未读、本人待验收任务、可接管的智能体提案，四类合计并按下发时间排序 | `services/collab.ts#home`、`routes.ts`、`app.js#renderHome` | `tests/room.test.ts`（四类各自归位、已读与回答后消失、未参与者看不到） |
| 只汇总事实不改状态：已读只影响提醒，回答只消解提问；已读不等于已回答 | `collab.ts#home` | 同上；PostgreSQL 用例同时断言游标移动后提问仍保留 |
| 首页入口：`GET /v1/space/home`、SDK `home()`、CLI `home`；网页在概览上方列出可点击的「等你处理」 | `routes.ts`、`src/sdk/client.ts`、`src/agents/cli.ts`、`src/web/app.js` | 接口走测试；网页只做结构断言，未在浏览器手点 |
| 文件预览：图片、文本（前 200 KiB）、PDF 走带令牌的 `/content` 读取，图片与 PDF 用对象 URL，关闭对话框即释放；其他类型退回下载 | `src/web/app.js#previewSpaceFile`、`app.css` | 未在浏览器手点；读取路径复用已测的流式下载接口 |
| 知识版本对比：版本历史中相邻两版做行级 LCS 差异，新增/删除行分色；超长正文退回逐行比较 | `src/web/app.js#lineDiff/openVersionDiff`、`app.css` | 仅结构断言，未在浏览器手点 |

测试合计 130 项（本轮新增团队首页 1 项）。`npm run check` 无类型错误；SQLite（`npm test`）与临时 PostgreSQL 实例（`npm run test:postgres`）各 130 项全过；另在本机 PostgreSQL 上用演示数据实际请求过 `/v1/space/home`。

## 第二阶段：对象存储、未读与交接包（本轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 本地对象存储：内容寻址 `<sha256前两位>/<sha256>`，临时文件 + `fsync` + 原子改名；同一团队同一内容只落一个对象 | `src/platform/storage.ts`、`app.ts` | `tests/storage.test.ts`（落盘、去重、软删除后字节保留） |
| 可选 S3：按环境变量动态加载，未配置时完全走本地；上传令牌可换成预签名 PUT | `storage.ts` | 本地驱动全测；S3 路径未在真实桶上跑过 |
| 三步上传：`POST /v1/space/files/upload-url` → `PUT /v1/space/uploads/:token` → `POST /v1/space/uploads/:id/complete`；令牌一次有效、过期清理、哈希与大小校验 | `services/storage.ts`、`routes.ts` | `tests/storage.test.ts`（重放、哈希不符、令牌复用） |
| 文件可脱离任务：`space_files.task_id` 可空（schema v9 重建表），文档附件先独立上传再挂到文档 | `db/schema.ts`、`storage.ts` | `tests/storage.test.ts`「独立附件不绑任务也能上传」 |
| 二进制流式读取：`GET /v1/space/files/:id/content`、`GET /v1/tasks/:id/files/:fileId/content`，支持 `Range`；网页下载不再走 base64 JSON | `routes.ts`、`src/web/app.js` | 同上 + `tests/aicd.test.ts` 房间下载；网页改动仅结构测试，未在浏览器手点 |
| 房间未读：`task_reads` 每人每任务游标（schema v10），`GET /room` 返回 `unread.messages/questions/mentions`；`POST /v1/tasks/:id/read` 只移动游标，不推进任务版本 | `db/schema.ts`、`collab.ts#unreadFor/markRead` | `tests/room.test.ts`（版本不变、自己的消息不算未读） |
| 点名提问：消息 `payload.to` 接受字符串或数组，校验收件人后与正文 `@` 合并；`GET /v1/agent/questions` 返回点名问我且未回答的问题 | `collab.ts#addComment/questionsFor`、`routes.ts` | 同上（回答后不再追问、不存在的收件人 400） |
| 交接包：`GET /v1/tasks/:id/context-pack` 同时返回 markdown 与 manifest，含阶段摘要、未决线程、最近对话、文件下载地址与相关文档 | `collab.ts#contextPack` | 同上（markdown/manifest/下载地址/无权访问） |
| 跨任务检索：`GET /v1/space/search?q=` 搜消息、文件名与已发布文档，可见性与任务读取规则一致 | `collab.ts#search` | 同上（未参与的任务不出现、空检索 400） |
| SDK 与 CLI：上传/确认/下载、房间、消息、线程、已读、提问、交接包、检索；CLI 增加 `room/say/ask/handoff/thread/resolve/read/questions/pack/find/upload/download` | `src/sdk/client.ts`、`src/agents/cli.ts` | `tests/room.test.ts` 全程走 SDK；CLI 未做端到端脚本测试 |
| 监管扩展到 11 条：提问超过 4 小时无人回答、@ 提醒超过 4 小时未读；回答或已读后自动解决 | `services/oversight.ts` | `tests/oversight.test.ts`（超时形成告警、回答与已读后解决） |

测试合计 129 项（本轮新增存储 6 项、房间/交接包/检索 4 项、监管 1 项；其余为既有用例）。`npm run check` 无类型错误；SQLite（`npm test`）与临时 PostgreSQL 实例（`npm run test:postgres`）各 129 项全过。

## 经验与任务房间（本轮）

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| schema v7：`knowledge` 增 `kind/title/summary/tags/source/evidence_level/archived_at`，`task_id` 可空；新增 `knowledge_lineage`、`knowledge_copy_invites`、`knowledge_assets`、`task_threads`、`space_files`；`task_comments` 增 `kind/thread_id/reply_to/payload`；旧 `task_materials` 回填进 `space_files` | `db/schema.ts` | `tests/aicd.test.ts` + 迁移用例；SQLite 与 PostgreSQL 各跑一遍 |
| 手动经验：草稿、编辑、提交审核、发布（有效期）、修订、归档、撤销、删除、详情/列表、附件绑定（证据/参考）；默认类型为经验 | `knowledge.ts`、`routes.ts` | 同上（草稿可编辑、缺有效期 400、归档后列表隐藏、删除后 404） |
| 删除边界：只有无副本、未被任务引用的草稿/待审核稿可删；已发布稿返回 409，需先归档或撤销 | `knowledge.ts#delete` | 同上 |
| 发布权留在人手里：智能体只能提交候选，创建、发布、撤销一律 403 | `knowledge.ts`、`access.ts` | 同上 |
| 复制到团队：用户在条目上选择自己加入的团队（或取消），直接生成独立 `draft`，保留来源链；复制到他人个人空间需对方接受邀请 | `knowledge.ts#copy` | 同上（`copiedFrom` 带空间名与版本、未选目标团队 400、非成员团队 403） |
| 复制给他人：7 天邀请—接受，对方接受后才落库；拒绝与过期由邀请状态体现 | `knowledge.ts#invite/accept/decline` | 同上（直接塞副本 403、接受后生成草稿） |
| 来源治理：`lineage` / `copies` / `copiedFrom`、来源撤销后副本保留但提示复核 | `knowledge.ts`、`app.js` | 同上（撤销后 `sourceRevoked=true`） |
| 任务房间：概览、线程（可解决）、带类型消息（question/answer/decision/handoff/status）、文件上传/下载/软删除/挂到经验、进展/消息/文件/经验合并时间线并按类型过滤 | `collab.ts`、`routes.ts`、`app.js` | `tests/aicd.test.ts` 房间用例 + 手工 |
| 权限：团队任务对真人成员可见、访客 403；智能体仍按子任务与 grant 范围；房间按任务工作空间隔离 | `access.ts`、`collab.ts` | 同上 |
| 控制台：经验分区（列表、详情、复制、来源链、邀请接受/拒绝）、任务「房间」页 | `src/web/app.js`、`app.css` | `tests/web.test.ts` 结构断言 + 手工 |

测试合计 117 项（本轮新增 `tests/aicd.test.ts` 5 项：生命周期与权限、团队复制矩阵、邀请复制与来源撤销、房间合并时间线、团队任务可见性）。SQLite 与 PostgreSQL 跑同一套用例。

第一阶段边界：手动经验的附件只能从任务产出文件里挑（`space_files.task_id` 非空），经验侧独立上传与对象存储留到第二阶段；时间线过滤在前端完成，房间仍靠轮询刷新。（第二阶段已补齐独立附件、对象存储与未读；房间仍是轮询。）

## 任务材料与智能体经验自提交（上一轮）

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

- **管理台**用 DOM 桩 + 真实 HTTP 跑通登录与每个视图（`tests/web.test.ts`），包括内置智能体的定义列表、启停与日志渲染；但桩只实现用到的 API：布局、样式与实际浏览器行为仍需人工看一遍。
- **对象存储**只在本地驱动上验证；S3 分支按接口实现并有预签名路径，但没有连真实桶跑过上传、Range 与生命周期。
- **模型供应商**只用本地 mock HTTP 验证了 URL、请求头/体与工具调用解析，没有对真实厂商发过请求；供应商 URL 会随厂商调整，定义里均可覆盖。
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
| 通知的可恢复投递 | 信箱已做到数据库内 at-least-once、退避与 SSE；仍**没有**外部消息队列、跨实例 pub/sub 或 exactly-once |
| 内置智能体的强隔离 | 沙箱是路径 + 环境清洗 + 超时 + 工具白名单；`COLLAB_SANDBOX_EXEC=1` 只是 macOS `sandbox-exec` 的额外一层。没有容器、cgroup 或独立用户 |
| 跨运行记忆 | 每次运行只带本次消息，不继承上次对话与工作目录；长期记忆要显式写回任务/评论/经验 |
| Kiro / Codex 订阅协议 | 只有本机 CLI 适配位；未安装 CLI 时明确报错，没有逆向私有协议 |
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
- **PostgreSQL 无法推断裸 NULL 参数**：`(:did IS NOT NULL AND did = :did)` 报 `42P18`，改为按 `did` 是否存在分支查询。参与校验里同样的 `:account IS NOT NULL` 也改成按账号有无分支，否则"人替自己的智能体回应请求"在 PostgreSQL 上返回 500。
- **运行日志每次从 1 开始会撞主键**：`embedded_run_logs.seq` 是全局自增主键，但写入时按 `run_id` 取 `MAX(seq)+1`，第二条运行的日志会与第一条冲突。改为由数据库分配 `seq`，并补一条两轮运行日志的用例。
- **子进程退出会丢最后几条日志**：日志经接口异步写入，`process.exit` 不等待挂起请求。为日志队列加 `flush()`，收尾时先等它清空；同时去掉 stderr 回显，避免 supervisor 转发后每条日志出现两遍。
- **演示脚本的第一步是纯文本**：模型循环把"没有工具调用"当作最终回答，脚本因此第一轮就结束、消息被退回。示例定义改成以 shell 步骤开头。
- **演示脚本的 workspace 与身份服务不一致**：`createApp` 按 `COLLAB_WORKSPACE`（默认 `local`）构造身份服务，而 demo 用 `bootstrap('demo', …)` 建主体，绑定码因此在两个 workspace 之间跨不过去。改为显式传 `identity: { workspace: 'demo' }`——这类"隐式默认值 + 显式实参"的错配，只有把登录真的跑一遍才会暴露。
