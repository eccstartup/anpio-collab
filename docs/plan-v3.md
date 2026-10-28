# 第三轮计划：租户、两种登录与智能体授权

状态：已实施（第 1–8 节全部落地，验证结果见 [implementation-status.md](implementation-status.md)）｜日期：2026-10-28｜承接 [plan-v2.md](plan-v2.md)

第二轮解决了"人和智能体用同一套身份体系登录"，但登录页只有钱包一条路，平台只有一个隐式工作空间，谁属于哪个组织、谁能加人、个人能不能带自己的 Agent，都没有答案。本轮把这几件事一次说清并做出来。

## 1. 目标与验收标准

| 目标 | 完成标准（可验证） |
| --- | --- |
| 登录前可见说明 | 未登录状态能从登录页进入 `/help/login`，两种登录方式、五种授权场景、邮件长什么样，都在这一页 |
| 两种登录 | 邮箱一次性链接登录；DID 钱包签名登录。两者落到同一个会话模型，可同时存在 |
| 租户 | 每次登录都落在一个租户里；`GET /v1/me/tenants` 列出我所属的全部租户；切换租户换发会话 |
| 管理员 | 租户所有者/管理员可看成员、发邀请、改角色、移除成员；不能改自己、不能造第二个所有者 |
| 成员是人或 Agent | 成员表区分 `human / agent / service`；Agent 由某个人或组织持有，单独撤销 |
| 个人绑定 Agent | 登录后生成 6 位批准码 → Agent 侧提交 → 人确认范围与期限 → Agent 拿到受限令牌；撤销后立即失效 |
| 邀请链路 | 邮件里的链接同时完成"验证邮箱 + 接受邀请 + 登录"，只能用一次，过期失效，邮箱不匹配即拒绝 |
| 回归 | 原有 61 项测试继续通过；新增租户/邮箱/Agent 授权测试；SQLite 与 PostgreSQL 都跑 |

## 2. 三个概念，先把词定死

这一轮混乱的根源是"用户""成员""主体""智能体"被混着用。定死如下：

| 概念 | 是什么 | 存在范围 | 例子 |
| --- | --- | --- | --- |
| **Account（账号）** | 一个可被证明的身份：邮箱或 DID | 全局 | `alice@acme.com`、`did:wba:...:z6Mk...` |
| **Tenant（租户）** | 一个企业、组织或团队，有独立的成员、任务、知识与审计 | 全局 | "安皮欧科技"、"财务部试点" |
| **Principal（主体）** | 某个账号在某个租户里的身份，角色挂在这里 | 租户内 | 张三在安皮欧是管理员，在李四的公司只是访客 |
| **Agent（智能体）** | 一种主体，`kind=agent`；由某个人或组织持有，有独立 DID | 租户内 | "库存查询 Agent"，属于张三 |

关键推论：

1. **账号是全局的，主体是租户内的**。同一个人加入两个组织，是两条 principal，角色可以完全不同。
2. **任务、知识、审计只认 principal**，永远不认账号。跨租户隔离因此是天然的：所有查询本来就带 `workspace`（= 租户 ID）。
3. **Agent 不是"账号的附属品"，而是租户内的一个主体**，只是它的持有者是人或组织。这样撤掉一个 Agent 不影响任何人登录。

## 3. 登录：两种方式

### 3.1 方式一：邮箱一次性链接（人的默认方式）

```text
用户                    平台                        邮箱
 │  输入 alice@acme.com   │                          │
 ├───────────────────────►│  建一次性票据（15 分钟）   │
 │  202 已发送（不透露是否存在该邮箱）              │
 │                        ├──── 登录链接 ───────────►│
 │  点链接 /login?ticket=… │                          │
 ├───────────────────────►│  票据一次性消费           │
 │                        │  找/建账号 → 找租户        │
 │  0 个租户 → 建"个人组织"，本人是所有者            │
 │  1 个租户 → 直接进                               │
 │  多个租户 → 选一个（30 分钟内有效）               │
 │◄──── 会话令牌 ─────────┤                          │
```

- **票据**：32 字节随机，库内只存 SHA-256；15 分钟；一次性；消费失败不消耗（避免误点毁掉链接）。
- **防枚举**：无论邮箱是否存在，`POST /auth/email/start` 都返回 202 和同样的文案。
- **首次登录**：自动创建**个人组织**（`personal=1`），本人是所有者。这样"先让人进来，再拉人"不卡住。
- **多组织**：返回 `selectionToken`（短期、绑定账号），选完再换会话；选择动作不重新发信。
- **链接落点**：`/login?ticket=…`，前端读查询参数后调 `POST /auth/email/verify`，成功后清掉地址栏参数。
- **已登录时点链接**：仍然按票据处理，换成该票据对应账号的会话（避免"我在 A 账号里点了 B 的链接"这种串号）。

### 3.2 方式二：DID 钱包签名（有 ANP 身份的人或 Agent）

沿用第二轮实现的 ANP-02：取 DID → 领 nonce → 钱包签名（RFC 9421）→ 换会话。本轮只补两件：

1. 登录成功后，按 DID 反查账号，落到该账号的某个租户；没有就按个人组织规则新建。
2. 保留"绑定码"路径：已登录主体签发绑定码，另一个 DID 登录时带上，就挂到同一主体下（人机共用账号）。

### 3.3 三种方式的关系

| 方式 | 谁用 | 凭证 | 会话 |
| --- | --- | --- | --- |
| 邮箱链接 | 人（默认） | 邮箱控制权 | 同一套 `anp_sessions` |
| DID 签名 | 有 ANP 身份的人或 Agent | 私钥 | 同上，`client=agent` |
| 访问令牌 | 引导、脚本、内网联调 | 高熵字符串 | 同上，保留给运维 |

三者最终都产出 `principal + tenant`，后续授权逻辑完全一致。**不因为登录方式不同而给不同权限。**

## 4. 授权从哪来：五种场景，逐一交代

用户真正问的是"我收到的是邮件还是什么"。答案是：**邮件只负责送达一个链接，授权动作永远发生在登录之后。链接本身不是权限，撤销链接不等于撤销权限。**

| 场景 | 谁发起 | 送达 | 谁批准 | 结果 |
| --- | --- | --- | --- | --- |
| A. 管理员加人 | 租户管理员 | 邮件邀请（72 小时，一次性） | 被邀请人点链接（同时验证邮箱） | 在租户里建 principal，角色按邀请 |
| B. 任命另一个管理员 | 所有者/管理员 | 同上，`role=admin`/`owner` | 被邀请人 | 角色提升；所有者唯一 |
| C. 个人绑定自己的 Agent | 人（已登录） | 页面显示 6 位码，可另发邮件 | 人（当场点"批准"） | 新建 Agent 主体 + 授权，或挂到本人账号 |
| D. Agent 自助接入 | Agent | 显示 user code | 管理员在控制台批准 | 待批准 Agent 主体，归属批准人 |
| E. 撤销 | 管理员/持有者 | 无需送达 | 立即生效 | 主体停用 / 授权撤销 / 会话作废 |

### 4.1 A/B：邀请邮件到底长什么样，点了发生什么

邮件正文（纯文本，避免远程图片与追踪像素）：

```text
主题：[Anpio Collab] 邀请你加入「安皮欧科技」

张三 邀请你以「成员」身份加入「安皮欧科技」。

点此接受（72 小时内有效，仅可使用一次）：
https://collab.example.com/login?ticket=Yl9m...

如果这不是你预期的邀请，忽略这封邮件即可；链接会在 72 小时后失效。

—— 这封邮件由 Anpio Collab 自动发送，请勿回复。
```

点击后：`/login?ticket=…` → 验票据 → **票据里带着邀请 ID 和邮箱** →
- 邮箱与邀请一致 → 建/合并账号 → 加入租户 → 直接进；
- 邮箱不一致（例如管理员转发给了别人）→ 拒绝并提示"该邀请属于另一个邮箱"。

所以：**邀请链接 = 邮箱验证 + 入组 + 登录，三步一次完成**。被邀请人不用先注册、不用记密码。

### 4.2 C：个人绑定自己的 Agent（本轮的核心交互）

不做"填一个绑定码挂到账号上"就完事——那会让人以为 Agent 等于自己，权限收不回来。做成**设备授权码**，OAuth Device Flow 的形态，用户不需要理解这个词：

```text
① 人在控制台点「连接我的智能体」
   → 服务端生成：user_code（如 K7QM-2XPD，10 分钟） + device_code（32 字节，Agent 持有）

② 人把 user_code 交给 Agent（复制、写进配置、或让 Agent 自己显示）

③ Agent 侧：
   POST /auth/agent/request { did, name, capabilities }
   ← { deviceCode, userCode, expiresIn, verificationUri }

④ Agent 轮询：POST /auth/agent/token { deviceCode }
   ← 202 { status: "pending" }（未批准）

⑤ 人在控制台输入 user_code → 看到 Agent 的名字、DID 指纹、请求的能力
   → 选择授权范围与期限 → 点「批准」
      范围默认：tasks:read / tasks:submit / offers:claim / comments:write
      期限默认：30 天（可选 7 / 30 / 90 / 不过期）

⑥ Agent 下一次轮询 → 200 { token, principal, scopes, expiresAt }
```

- **为什么不是"绑定"**：绑定意味着"Agent 就是我的另一个登录方式"，权限等于本人，无法单独收回。默认给 Agent 建**独立主体**，只拿被勾选的范围；确实想要"人机共用账号"的，选 `mode=link`，那才是真绑定，并在界面上写明后果。
- **为什么要人点批准**：user_code 只证明"有人把这个码给了 Agent"，不证明"Agent 的主人同意"。批准必须发生在**已登录的会话**里。
- **邮件在这里的作用**：如果人不在电脑前，可以勾"把批准链接发到我的邮箱"，邮件里是 `/agents/approve?code=…`。打开后仍要求登录（或走邮箱链接登录），**邮件不构成批准**。

### 4.3 D：Agent 自助接入

Agent 先发起（场景同上第 ③ 步），但没有人给它 user_code。此时 user_code 显示在 Agent 自己的日志里，运维把它交给管理员；管理员在「成员 → 待批准」里看到请求，批准时同时决定归属（挂在哪个成员名下）。适用于"公司统一接入的一批业务 Agent"。

### 4.4 E：撤销链条

| 撤销什么 | 立刻发生 | 不做什么 |
| --- | --- | --- |
| 撤销 Agent 授权 | 该 Agent 的会话全部作废；主体停用 | 不删除它已提交的结果与事件 |
| 移除成员 | 主体停用、会话作废；任务负责人转交提示 | 不删除历史审计 |
| 停用租户 | 该租户所有登录被拒 | 不物理删除数据 |
| 退出登录 | 只撤销当前会话 | 不影响其他设备 |

## 5. 权限矩阵

租户角色四种，与平台能力角色并存（能力角色决定"能干什么业务"，租户角色决定"能不能管这个组织"）：

| 租户角色 | 管成员 | 管 Agent 授权 | 建任务 | 验收 | 看监管/审计 |
| --- | --- | --- | --- | --- | --- |
| `owner`（所有者，唯一） | ✅ 含任命管理员 | ✅ | ✅ | ✅ | ✅ |
| `admin`（管理员） | ✅ 不能动所有者、不能造所有者 | ✅ | ✅ | ✅ | ✅ |
| `member`（成员） | ❌ | 只能管自己的 Agent | ✅ | ✅ 自己负责的 | ❌ |
| `guest`（访客） | ❌ | ❌ | ❌ | ❌ | ❌ |

规则：

- **所有者唯一且必须显式转让**；管理员不能把别人改成 `owner`，也不能移除所有者。
- **不能改自己的角色，不能移除自己**（避免把自己锁在门外）。
- 管理员可以停用成员，但不能停用所有者。
- Agent 主体永远没有租户管理权，即使它的持有者是管理员——**持有者的权限不会传导给 Agent**。

## 6. 接口契约（本轮新增）

### 6.1 无需登录

```text
POST /auth/email/start     { email, invite? }        → 202 { sent, expiresAt, [devLink] }
POST /auth/email/verify    { ticket }                → 200 { token, principal, tenant }
                                                     | 409 { selectionToken, tenants }
POST /auth/email/choose    { selectionToken, tenantId } → 200 { token, principal, tenant }
GET  /auth/anp/challenge                              → 200 { nonce, expiresAt }（已有）
POST /auth/anp/login       （已有）                    → 200 { token, ... }
POST /auth/agent/request   { did, name, capabilities } → 201 { deviceCode, userCode, expiresIn, verificationUri }
POST /auth/agent/token     { deviceCode }             → 202 { status: "pending" }
                                                     | 200 { token, principal, scopes, expiresAt }
                                                     | 410 过期/已消费/已拒绝
```

### 6.2 需要登录

```text
GET  /v1/me                          → 加 tenant / tenantRole / account / scopes
GET  /v1/me/tenants                  → 我所属的租户（跨租户）
POST /v1/me/switch   { tenantId }    → 换发会话（旧会话作废）
GET  /v1/tenants/current             → 当前租户详情与计数
GET  /v1/tenants/current/members     → 成员（人 + Agent）
POST /v1/tenants/current/invites     { email, role, kind } → 邀请（发信）
GET  /v1/tenants/current/invites     → 未接受的邀请
POST /v1/tenants/current/invites/:id/revoke
POST /v1/members/:id/role  { role }  → 改角色
POST /v1/members/:id/remove          → 移除成员
GET  /v1/agents                      → 我授权出去的 Agent
POST /v1/agents/approve  { userCode, mode, scopes, expiresInHours }
POST /v1/agents/:id/revoke
```

所有写接口沿用既有约定：必须带 `Idempotency-Key`；带版本的资源才带 `If-Match`。这些接口不带版本，因此不接受 `If-Match`。

## 7. 数据模型（schema v3）

```text
accounts(id, display_name, status, created_at)
account_links(id, account_id, kind[email|did], value, verified_at, created_at)   UNIQUE(kind,value)
tenants(id, name, status, personal, created_at, created_by)
tenant_invites(id, tenant_id, email, role, kind, token_hash, invited_by,
               expires_at, accepted_at, accepted_principal_id, created_at)
login_tickets(id, token_hash, email, purpose[login|invite|select], invite_id,
              account_id, expires_at, consumed_at, created_at, user_agent)
agent_requests(id, device_code_hash, user_code, requested_did, name, capabilities,
               status[pending|approved|denied|consumed], expires_at,
               approved_principal_id, approved_by, created_at)
agent_grants(id, tenant_id, agent_principal_id, owner_principal_id, scopes,
             status[active|revoked], expires_at, created_at, revoked_at)
mail_outbox(id, to_email, subject, body, link, kind, created_at)
principals  + account_id, tenant_role
```

- `principals.workspace` 继续等于租户 ID，所以既有的任务、知识、审计查询一行不用改，跨租户隔离自动成立。
- 老数据没有 `account_id`：登录时按 DID 补建账号并回填；补不上就当作"只有单租户的遗留主体"，不影响使用。
- `mail_outbox` 是本地投递实现。生产接 SMTP 时替换 MailService，不改调用方。

## 8. 界面

### 8.1 登录页（未登录）

三块，顺序就是推荐顺序：

1. **邮箱链接**：输入邮箱 → "发登录链接"→ 提示"去邮箱点链接"（开发模式直接显示链接）。首次来的人走这里。
2. **DID 钱包**：四步进度条（已有），保留。
3. **我是智能体**：输入 user code + 一句说明"由你的主人或管理员生成"。
4. 底部固定一行：**「第一次来？先读登录与授权说明」→ `/help/login`**。这页不需要登录，把本文第 3–5 节讲清楚。

### 8.2 登录后

- 侧栏顶部显示**当前租户**；属于多个租户时是下拉切换器。
- 新增导航：**成员**（owner/admin 可见）、**我的智能体**（人可见）。
- 成员页：人/Agent 分列，显示角色、状态、最近登录；邀请按钮弹出"邮箱 + 角色 + 类型"；待接受邀请可撤销。
- 我的智能体：授权列表（名称、范围、期限、最后活跃）、"连接我的智能体"（生成码）、输入码批准、撤销。
- 监管/审计保持原样，只按租户隔离。

## 9. 安全边界与已知限制

- **邮件是单点依赖**：本地默认写 `mail_outbox` 并在控制台打印；接真实 SMTP 属于部署配置，本轮不实现重试与退信处理。
- **限流是进程内的**：邮箱发送按 `IP + 邮箱` 双键限流（10 分钟 5 次），多实例部署需外部存储。
- **票据不绑定浏览器**：链接可能被转发。缓解手段是一次性 + 15 分钟 + 用后提示"最近登录设备"。真正防转发需要设备指纹或二次确认，本轮不做。
- **租户切换会作废旧会话**：避免一个浏览器里两个租户令牌混用。
- **Agent 授权范围是声明式的**：`scopes` 记录在案并在关键路径（认领、提交、读知识）校验；不是全链路细粒度策略引擎。
- **不做的**：SSO/SAML、SCIM、密码登录、找回密码、邮件退订、跨租户共享任务。

## 10. 落地顺序

1. schema v3：新表 + `principals.account_id/tenant_role`（可重复执行）
2. MailService（outbox + console）
3. AccountService / TenantService：账号解析、租户、成员、邀请
4. EmailAuth：start / verify / choose，会话换发
5. AgentAuth：设备码申请、批准、轮询换令牌、撤销
6. 路由与 `/v1/me` 扩展
7. 前端：登录页改版、`/help/login`、成员页、我的智能体、租户切换
8. 测试（邮箱、邀请、隔离、角色、设备流、前端冒烟）+ 文档 + 演示数据

## 11. 明确不做

- 不做密码、不做 SMS、不做第三方 OAuth 社交登录；
- 不做邮件模板可视化编辑；
- 不把 Agent 的权限做成"继承主人的全部权限"；
- 不做跨租户任务共享（本轮只做隔离与切换）。
