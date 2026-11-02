# ANP 收敛收尾计划：文档与兼容说明

- 状态：已实施
- 前置：[ANP 实现收敛到 @anpio-cli/core](anp-convergence-plan.md)（C1–C4 已实施）
- 范围：只改文档与发布说明，不改运行时行为
- 结论：`@anpio-cli/core` 不需要改动；本仓库补齐协议语义、实现状态与兼容性说明

## 背景

C1–C4 已完成并推送（`7396a44`）：

- 服务端 login/bind 的验签改走 core：`Signature-Input` 的 keyid → 远程解析 → `verifyDidDocument` → `resolveVerificationKey` → `verifyHttpSignatureForServer`；
- 自产 DID 文档带 `eddsa-jcs-2022` proof；本地 `src/anp/base58.ts`、`src/anp/signature.ts` 已删除；
- 新增 `tests/anp-verification.test.ts` 8 个负例；全套 163 项测试通过。

但面向使用者的文档仍停留在旧实现：说服务端从请求体 `didDocument` 取公钥、解析失败一律 401，并把验签记在已删除的文件上；收敛计划 §8 要求的发布/兼容说明也不存在。

`@anpio-cli/core` 视为正常：导出 `.` 与 `./advanced`，现有能力足够，本次不需要改动它，也不在它的目录下另写计划。

## 改动

### 1. `docs/protocol-v1.md`（主要）

- **「2. 签名并登录」**：保留请求示例，但把 `didDocument` 标为仅兼容接收、不参与验签；写明
  - keyid 只从 `Signature-Input` 取，且其 DID 段必须等于 `body.did`；body 里若带 `keyid` 必须与 header 一致；
  - 覆盖集至少 `@method`、`@target-uri`、`@authority`、`content-digest`；有请求体必须有 `content-digest`；
  - `created` 必填，`expires` 可选，允许 300 秒对时误差；
  - 公钥来自远程 `did.json`，文档（active `e1_` DID）必须带合法的 `eddsa-jcs-2022` proof。
- **「4. 401 挑战语义」**：改为完整的失败语义表
  - 缺 nonce / nonce 已用 → 401 `challenge_required`（新 nonce，客户端只重签一次）；
  - proof 或签名无效、keyid DID 不匹配、body.keyid 不一致 → 401 `unauthenticated`，不换发挑战；
  - 解析器连不上 / 超时 → 503 `unavailable`，可重试；
  - DID 已停用或被替换 → 409 `did_superseded`，响应顶层带 `requestedDid` / `currentDid`；
  - 文档 404/410 或不可信 → 401。
- **「主体落位」**：把“解析失败一律 401”改成“取不到文档或文档不可信 → 401；解析器不可达 → 503，不进入落位判断”。
- **「DID 文档解析」**：补充 proof 校验与 keyid 来源；错误映射按上面的表拆开。
- **「补绑 DID」**：把“按 `did` + `didDocument` 验签”改成与登录同一条链路（远程文档 + core 验签），再核对会话主体；`purpose=bind` 与一次性语义不变。
- 在 ANP 章节末尾新增 **「兼容性变更」**：写清三项行为变化（文档 proof 必需、覆盖集变严、keyid 以 `Signature-Input` 为准），要求外部客户端先升级；503 应重试，409 不应重签。

### 2. `docs/login-and-authorization.md`

- 2.2 的解析结果表：新增“连不上 / 超时 → 503 暂时无法校验”与“DID 已停用 / 替换 → 409 `did_superseded`”，保留 404/410 → 401。
- 补一句验签要求：文档 proof 合法、覆盖集完整、`created` 必填、keyid 取自 `Signature-Input`。
- 2.3 补绑处只改“取不到就不会写进账号”的措辞，区分 401 与 503。

### 3. `docs/implementation-status.md`

- 顶部结论补一句：本轮把 ANP 验签与身份构造收敛到 `@anpio-cli/core`。
- 新增顶部小节 **「本轮：ANP 验签收敛」**，表格列出 C1–C4：核心 API 接入、proof、keyid 来源、503/409、删除本地 base58/signature、`tests/anp-verification.test.ts`（8 项）；写明测试合计 163 项，并注明 C0 共享向量与 C5 core `verify` 子入口未做（见收敛计划 §11）。
- 修正过时位置：
  - 第二轮表 `src/anp/signature.ts` → `@anpio-cli/core` 的 `verifyHttpSignatureForServer` / `src/platform/services/identity.ts`；
  - `src/anp/base58.ts` → `@anpio-cli/core/advanced` 的 multibase 编码与 core 的解码；
  - 第五轮表 `identity.ts#resolveKey` → `identity.ts#authenticate`。
- 更新「未实现（明确缺口）」里 DID 轮换一行：平台侧**已会**返回 409 `did_superseded`；仍缺的是客户端多钱包切换/轮换。

### 4. `README.md`

- 「代码结构」中 `anp/` 一行改为：did:wba 展示 helper、自产身份与 DID 文档（core 构造 + proof）、登录客户端；验签在 `platform/services/identity.ts` + core。
- 「快速开始」补一条依赖说明：当前 `@anpio-cli/core` 以 `file:../anpio-cli/packages/core` 引入，需同级 checkout；core 发布后改版本号。
- 「方式三：DID 密钥登录」补一句兼容提示，并链接到 `docs/protocol-v1.md` 的「兼容性变更」。

## 不做

- **`anp_nonces.keyid` 列**：只用于观测，会引入 schema v14 迁移，收益低。
- **`tests/vectors/anp/*.json`**：collab 已无本地验签实现，跨仓库向量应落在 core / anpio-agents（C0）。
- **C5 `@anpio-cli/core/verify` 子入口**：core 侧改动，当前不需要。
- **删除 `src/anp/identity.ts` / `client.ts`**：它们是 `src/agents/session.ts` 的生产依赖，不是残留死代码。

## 验证

- `npm run check`（类型检查；文档改动不影响，作为回归确认）。
- `npm test`：163 项全绿（本机需绕过沙箱的端口限制）。
- `git grep -n -E "signature\\.ts|base58|请求体里的 .?didDocument.*解析公钥|解析失败一律|无法连接 DID 注册服务器.*401" -- docs/protocol-v1.md docs/login-and-authorization.md docs/implementation-status.md README.md` 应只剩历史计划文档（`plan-v*.md`、`anp-convergence-plan.md`）的命中。
- 手工检查 `docs/protocol-v1.md` 新增表格的 Markdown 与锚点。

## 实施记录

- `docs/protocol-v1.md`：登录、失败语义、主体落位、文档解析、补绑全部改到 core 链路；新增错误码 `did_superseded` / `unavailable` 与「兼容性变更」。
- `docs/login-and-authorization.md`：解析结果表补 503/409 与 proof、覆盖集、keyid 要求。
- `docs/implementation-status.md`：新增「本轮：ANP 验签收敛」；修正已删除文件与 `resolveKey` 的引用；更新 DID 轮换缺口描述。
- `README.md`：代码结构改为 core 分工；快速开始补同级 checkout 说明；DID 登录段补兼容提示。
- 验证：`npm run check` 通过；`npm test` 163 项全绿。
