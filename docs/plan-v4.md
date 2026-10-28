# 第四轮计划：身份准入（邮箱 / DID / Agent 三条路收敛到一个账号）

本轮不新增业务功能，只把"谁能进来、凭什么进来、进来之后还能绑什么"讲清楚并落实。
目标是让下面三句话同时成立：

1. 邮箱登录之后就有账号，可以再去绑 DID、绑邮箱（第二个）、绑 Agent；
2. DID 钱包登录之后也有账号，可以反过来绑邮箱、绑 Agent；
3. Agent 自己登录只走后台设备流，前台永远只有"邮箱"和"DID"两个按钮。

## 1. 账号模型（不变量）

| 概念 | 回答的问题 | 约束 |
| --- | --- | --- |
| 账号 `accounts` | 这是谁 | 凭证（邮箱 / DID）挂在账号上；凭证本身不带权限 |
| 主体 `principals` | 在这个组织里他是谁 | 一个账号在一个租户里只有一个主体 |
| 会话 `anp_sessions` | 这次请求代表谁 | 只存令牌摘要；撤销即失效 |

三条入口最终都落到 `accounts`，所以"先用邮箱还是先用钱包"不影响后续行为；
只有"同一个账号"这一条不变量，别的都是它的推论。

## 2. 前台两条入口

### 2.1 邮箱优先（默认推荐）

```
填邮箱 → 收一次性链接（15 分钟）→ 点开 → 建/找账号 → 首次建个人组织
设置页 → 绑 DID（钱包签名）→ 绑第二个邮箱（另一封信）→ 绑 Agent（CLI 批准码）
```

### 2.2 DID 优先

```
钱包登录（ANP 签名）→ 建/找账号 → 落位策略决定自动登记还是待批准
设置页 → 绑邮箱（发信验证）→ 绑 Agent
```

两条路的差别只在"第一次证明自己的方式"，绑定动作完全对称。

## 3. DID 必须已注册（本轮的核心修正）

以前登录/绑定信任请求体里的 `didDocument`。那等于"你带一份写着自己是别人的文档来"，
谁都能把任意 DID 绑到自己账号上。本轮改为：**平台自己去取 did.json**。

解析规则（`did:wba`）：

```
did:wba:<authority>:<path...>  →  <scheme>://<authority>/<path...>/did.json
did:wba:awiki.ai:user:alice:e1_x → https://awiki.ai/user/alice/e1_x/did.json
did:wba:127.0.0.1%3A8765:user:alice → http://127.0.0.1:8765/user/alice/did.json
```

边界（`src/anp/resolver.ts`）：

| 约束 | 值 | 原因 |
| --- | --- | --- |
| scheme | 只 https；回环地址与 `COLLAB_DID_HTTP=1` 才允许 http | 内网部署常常没有证书；公网明文解析等于把公钥交给中间人 |
| method | 只 `did:wba` | 其他 method 的解析规则不同，不猜 |
| 重定向 | 不跟随（3xx 直接失败） | 跟随可能被引到内网元数据端点 |
| 超时 / 大小 | 3 秒 / 64KB | 上面这两样都是对外请求，必须有上限 |
| 缓存 | 成功 5 分钟，失败不缓存 | 刚注册完要能立刻用 |
| 文档 id | 必须与请求的 DID 一致 | 否则是"解析到了另一条身份" |

失败语义：

- 404 / 410 → `该 DID 没有在注册服务器上登记`，401；
- 连不上 / 超时 → `无法连接 DID 注册服务器`，401（不是 500：这是调用方无法自证的问题）；
- 文档 id 不符或格式不对 → `DID 文档不可信`，401。

同一条检查用在三个地方：ANP 登录、设置页补绑 DID、Agent 获批（批准即绑定，不能批一条
永远登不进来的 DID）。请求体里的 `didDocument` 现在**只作为兼容字段接收，不参与任何判断**。

## 4. 反向绑定：DID 登录之后绑邮箱

复用邮箱登录的同一条通道，票据用途单独记为 `bind_email`，并记下 `account_id`：

```
POST /v1/me/emails/start { email }   → 200 { sent, email, expiresAt, [devLink] }
（收信点链接）POST /auth/email/verify { ticket } → 200 { bound: true, email }（不发令牌）
```

- 只填邮箱不算绑定：必须点开链接，证明这个地址能收信；
- 绑定不换会话、不换组织、不新建主体；
- 邮箱已被别的账号占用 → 409，当场拒绝，不白发一封信；
- 链接一次性，15 分钟过期。

## 5. Agent：后台登录，前台只批准

Agent 不注册、不自己建组织。`POST /auth/agent/request` 拿 `userCode`，
已登录的人在「我的智能体」里批准并勾选范围；`own` 模式给独立主体，
`link` 模式挂到本人主体。批准前先做第 3 节的 DID 注册校验。

命令行侧（`anpio-cli` 或脚本）示意：

```bash
curl -s -X POST $COLLAB/auth/agent/request \
  -H 'content-type: application/json' \
  -d '{"did":"did:wba:...","name":"库存查询 Agent","capabilities":["inventory"]}'
# 人在控制台输入 userCode → 批准
curl -s -X POST $COLLAB/auth/agent/token -d '{"deviceCode":"..."}'
```

## 6. 管理员：授权码与用户管理

沿用现有能力，不再造第二套：

| 动作 | 接口 | 说明 |
| --- | --- | --- |
| 发授权码（邀请接入） | `POST /v1/tenants/current/invites` | 72 小时一次性链接，收件邮箱必须一致 |
| 改角色 | `POST /v1/members/:id/role` | 所有者唯一，不能改自己 |
| 移除成员 | `POST /v1/members/:id/remove` | 主体停用、会话作废 |
| 停用 / 恢复主体 | `POST /v1/principals/:id/deactivate`、`/activate` | 用于 DID 主体与 Agent |
| 撤销 Agent | `POST /v1/agents/:id/revoke` | 立即失效 |

## 7. 本轮不做（明确记下来）

| 项目 | 为什么现在不做 | 需要什么才能做 |
| --- | --- | --- |
| 手机号绑定 / 登录 | 需要短信网关、验证码存储、按号段限流与费用控制 | 接一家短信服务 + `phone_verifications` 表 + 频控 |
| DID 注册服务 | 属于另一套基础设施（`~/code/claude/awiki-open-server`），且只在内网 | 见下节契约 |
| 密码登录 | 平台要保管能冒充你的秘密；真要用应接企业 SSO | SSO/SAML 或密码哈希 + 找回流程 |
| 账号合并 | "两个账号其实是同一个人"需要人工审核与可回滚的迁移 | 合并工单 + 审计 |

## 8. 与 DID 注册服务（awiki-open-server）的契约

以后自己提供注册服务时，平台这边不需要改代码——它只依赖一个约定：

```
GET /<path...>/did.json  → 200 application/did+json
                            { "id": "did:wba:<host>:<path...>", "verificationMethod": [...], ... }
                         → 404（未注册/已撤销）
```

- 部署在内网时，DID 里的 authority 写成 `host%3Aport`，并设置 `COLLAB_DID_HTTP=1`；
- 公网部署必须 https，且不要开 `COLLAB_DID_HTTP`；
- 撤销一条 DID 就是让它 404：平台缓存最多 5 分钟，之后登录/绑定都会被拒。

## 9. 验收清单

- [x] 未注册 DID 不能登录（`tests/did-resolution.test.ts`）
- [x] 请求体自带 `didDocument` 不再被采信（同上）
- [x] 未注册 DID 不能补绑（同上）
- [x] DID 先登录 → 绑邮箱 → 用邮箱登录落到同一账号（`tests/email-bind.test.ts`）
- [x] 绑定邮箱冲突 409、链接一次性（同上）
- [x] 设置页显示"登录方式"、可发起绑邮箱（`tests/web.test.ts`）
- [ ] 手机号绑定（下一轮）
- [ ] 内网注册服务联调（需要 awiki-open-server 起在内网）
