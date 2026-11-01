# anpio-collab：ANP 实现收敛到 @anpio-cli/core

- 状态：已实施（C1–C4；C0 见文末说明）
- 范围：`anpio-collab` 的 ANP 验签、DID 解析与身份构造
- 前置：`anpio-agents` 的 runtime 计划（其中「与 anpio-collab 的 ANP 收敛」一节的展开）
- 结论：**改 collab，不改 agent 设计**。core 是唯一规范实现；collab 保留抓取策略、挑战状态机、nonce 存储与业务主体逻辑。

## 0. 判断

collab 现在的 `src/anp/*` 是手写的一套：

| 文件 | 现在做什么 |
| --- | --- |
| `base58.ts` | base58 编解码 |
| `did.ts` | RFC 7638 指纹、multibase、`resolveVerificationKey`、DID 展示 helper |
| `resolver.ts` | HTTP 取 did.json：3s、64 KiB、不跟重定向、loopback/`allowInsecureHttp`、SSRF 限制 |
| `signature.ts` | RFC 9421 签名基、`verifySignature`、`signRequest` |
| `identity.ts` | 从 `KeyObject`/JWK 构造 DID 与 DID 文档 |
| `client.ts` | 挑战 → 签名 → 登录 → 401 重试 |

`@anpio-cli/core` 已经实现了同一份规范，而且更严格：文档 proof、覆盖集、keyid 绑定、nonce 消费。两套实现会漂移，测试已经把 collab 更松的行为钉住了。

但**不能**直接端到端调用 core 的两个高层入口：

1. `resolveDidDocument` / 远程 `resolveVerificationKey` 要求非空 `allowedHosts`（`resolveDid.ts:431–443`）；collab 必须接受任意外部 DID 域，不能维护白名单，core 也没有注入开放式 resolver 的口子。
2. `verifyAnpLoginRequest` 要求 `expectedNonce` + `nonceStore`，无法完成「没有 nonce → 先发挑战」这一步；collab 的路由必须先发挑战。
3. core 的 inline DID 文档快路径信任 fingerprint 绑定的文档；collab 的策略是「永远远程解析，不读请求体里的文档」。这是 collab 更强的策略，应保留。

因此结论是：**换底层原语，保留 collab 的 resolver 与路由状态机**。

## 1. 职责边界

| 能力 | 归属 | 说明 |
| --- | --- | --- |
| 文档 id 绑定、e1_ proof、密钥提取、authentication 校验 | core | `verifyDidDocument`、`resolveVerificationKey`、`decodeMultibaseKey`、`didFingerprint` |
| RFC 9421 覆盖集、content-digest、时间窗、nonce 消费 | core | `verifyHttpSignatureForServer`、`parseSignatureInput`、`NonceStore` |
| 错误词汇与「验不了 vs 证明坏」的区分 | core | `AnpLoginFailure`、`anpErrorForResolveFailure` |
| 抓取策略：3s、64 KiB、不跟重定向、loopback、私网 | collab | 保留 `src/anp/resolver.ts` |
| 挑战签发、路由状态 | collab | `/auth/anp/challenge`、`/auth/anp/login`、bind 路由不变 |
| nonce 落库与用途区分（login / bind） | collab | `anp_nonces` + `NonceStore` 适配器 |
| 主体、登记、绑定、会话、token | collab | 业务逻辑不动 |

不做的事：不 fork core；不把 collab 的 `src/anp/*` 复制进 agents；不让 collab 依赖 anpio-agents。

## 2. 目标登录链路

```text
POST /auth/anp/login
  1. 解析 body；isDid(body.did)；client/bindCode 照旧
  2. 从 Signature-Input 取 keyid（不再信 body.keyid）
     - keyid 缺失 → 400 / request_malformed
     - keyid 的 DID 段 !== body.did → 401 invalid_did
  3. collab resolver 远程取 did.json（策略不变，忽略 body.didDocument）
  4. core verifyDidDocument(document, did)          ← 文档 id + e1_ proof
  5. core resolveVerificationKey(keyid, document)   ← keyid 必须属于该文档且被 authentication 授权
  6. core verifyHttpSignatureForServer({
       method, authority, path, search, targetUri,
       headers, body: rawBody, key,
       expectedNonce: body.nonce,
       nonceStore: adapter(purpose: 'login'),
     })
  7. 失败映射见 §4；成功后才做 resolvePrincipal / enrollment
```

关键修正：**keyid 必须来自 `Signature-Input`**。collab 现在用 `body.keyid ?? '#key-1'`，而 core 的验证器只按调用方给的 key 验签，不会替你比较 header 里的 keyid；这会让「header 声明 A 密钥、body 用 B 密钥」的请求蒙混过去。新链路把 keyid 的 DID 段与 `body.did` 绑定，再由 core 把它与文档、公钥绑定。

bind 链路（`bindDid`）同样处理，只把 `nonceStore` 的 purpose 换成 `bind`。

## 3. 文件级改动

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/anp/resolver.ts` | 保留 | 输出 `{document, url}` 直接喂 core；不换成 core resolver |
| `src/anp/did.ts` | 收缩 | `isDid`、`didShortId`、`handleFromDid` 保留（展示/业务用）；`fingerprintOfRawKey` 改调 `didFingerprint(key.curve, key.bytes)`；删除本地 `resolveVerificationKey`，调用点改调 core 的 `(keyid, document)` 并用 `didFingerprint` 补回 `resolvePrincipal` 需要的 fingerprint |
| `src/anp/base58.ts` | 删除 | multibase 解码用 core `decodeMultibaseKey`；编码用 `@anpio-cli/core/advanced` 的 `encodeMultibaseEd25519` |
| `src/anp/signature.ts` | 收缩 | 服务端 `verifySignature` / `buildSignatureBase` 删除，改调 `verifyHttpSignatureForServer`；`signRequest` 先在 C4 前保留，供 client 与测试使用 |
| `src/anp/identity.ts` | 改造 | 保留 JWK/KeyObject 载入与 `exportPrivateJwk`；DID 与文档改用 `identityDid` + `buildBaseDidDocument`，并**补 `doc.proof = signDidDocumentProofSync(...)`** |
| `src/anp/client.ts` | 改造（C4） | 保留 challenge → sign → login → 401 重试；`signRequest` 换成 core `signAnpLoginRequest` |
| `src/platform/services/identity.ts` | 改造 | `resolveKey` 改为「header keyid → resolver → core verifyDidDocument → core resolveVerificationKey」；`verifySignature` 改为 `verifyHttpSignatureForServer`；nonce 消费改为 `NonceStore` 适配 |
| `src/platform/db/schema.ts` | 可选 | `anp_nonces` 增加 `keyid` 列用于观测；唯一键仍用 nonce（现表已是 global unique） |
| `tests/*` | 更新 | 所有构造登录请求的 fixture 补 DID 文档 proof；新增负例见 §6 |

`src/anp/identity.ts` 目前**不生成 `proof`**（`src/anp/identity.ts:64–74`），而 core 对 active 的 `e1_` 文档在 `lenient` 下也要求 proof（`resolveDid.ts:1154–1171`）。所以 C1 必须先给自身身份与测试夹具补 proof，C2 才能打开 core 验签，否则 collab 自己的 agent 和测试会登录失败。这是本次最大的兼容性变化。

## 4. 必须同时修的行为差异

| 差异 | collab 现在 | core | 处理 |
| --- | --- | --- | --- |
| 文档 proof | 不校验 | active `e1_` 必须有合法 `eddsa-jcs-2022` proof | C1 给自产文档补 proof；C2 开始强制；外部客户端需升级，发布说明写清 |
| 覆盖集 | 不检查最小集合 | 必须有 `@method`、`@target-uri`，有 body 时必须有 `content-digest` | 自有客户端已满足；负例测试覆盖 |
| 时间窗 | `created`/`expires` 至少一个 | `created` 必填 | 自有客户端已带；文档写明 |
| keyid 来源 | body.keyid 或默认 `#key-1` | 调用方传入的 key；keyid 只用于 nonce 键 | 改为从 `Signature-Input` 取，并与 body.did 绑定 |
| nonce | `anp_nonces`，按 nonce 全局唯一 | `NonceStore.consume(keyid, nonce)`，验签通过后才消费 | 写适配器，保留 `purpose`；`unverifiable` 不能当成 401 |
| 错误语义 | 统一 401 | `'unverifiable'` = 我们查不了；`'did_deactivated'` = 409 | `unverifiable` → 503/可重试；`did_deactivated` → 409 `did_superseded`；其余 → 401 + `WWW-Authenticate` |

nonce 适配器：

```ts
const nonceStore = {
  async consume(keyid: string, nonce: string) {
    return await db.tx(async tx => {
      const row = await tx.one(
        'SELECT consumed_at, expires_at FROM anp_nonces WHERE nonce = :nonce AND purpose = :purpose',
        { nonce, purpose },
      );
      if (!row || row.consumed_at || row.expires_at <= nowIso()) return false;
      await tx.run('UPDATE anp_nonces SET consumed_at = :at WHERE nonce = :nonce', { at: nowIso(), nonce });
      return true;
    });
  },
};
```

`keyid` 当前表里没有列，适配器可以只用于日志；不要为了「看起来对称」改唯一键，nonce 本身已全局唯一。

## 5. 身份与客户端

`identity.ts` 的目标写法：

```ts
import { identityDid } from '@anpio-cli/core';
import { buildBaseDidDocument, encodeMultibaseEd25519, signDidDocumentProofSync } from '@anpio-cli/core/advanced';

// priv 从 JWK 的 d 解出；pub 从 JWK 的 x 解出（现有 rawPublicKey 可复用）
const did = identityDid(host, undefined, undefined, {
  curve: 'ed25519',
  publicKey: pub,
  path: ['user', handle],
});
const keyid = `${did}#key-1`;
const doc = buildBaseDidDocument({ did, keyid, publicKeyMultibase: encodeMultibaseEd25519(pub) });
doc.proof = signDidDocumentProofSync(doc, keyid, priv);
```

- DID 字符串形状不变：`did:wba:<domain>:user:<handle>:e1_<fingerprint>`。
- core 目前没有「从已有私钥构造身份」的公开入口（`createAnpIdentity` 总是随机生成）；上面的 `advanced` 组合可以不改 core 完成。若希望 collab 不碰 noble/编码细节，可在 core 增加 `createAnpIdentityFromKey(host, { privateKey, path, service })`，但不作为本次前置。
- `client.ts` 的 `signRequest` 换成 core 的 `signAnpLoginRequest` 后，`body` 形状与 `sig1` 覆盖集由 core 统一；`AnpLoginError` / `enrollment_pending` / 401 重试逻辑保留。`signAnpLoginRequest` 是 async，测试调用点要加 `await`。

## 6. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **C0 一致性向量** | 用 core 生成 golden vectors：DID 文档 → 解析结果、合法/非法登录签名、multibase、nonce 重放 | 两仓库跑同一组 JSON 向量；collab 当前实现通过它应通过的部分，差异逐条记录 |
| **C1 自产文档补 proof** | `identity.ts` 用 core 的文档构造 + proof；测试夹具同步；仍用旧验签 | 现有测试全绿；所有自产 DID 文档带合法 proof |
| **C2 服务端验签切换** | `identity.ts` 服务的 login/bind 改用 core 的 document/key/signature；保留 resolver、挑战、nonce 表、主体逻辑 | 登录/绑定测试全绿；新增负例：keyid 不匹配、覆盖集缺失、缺 proof、重放、`unverifiable` |
| **C3 身份/编码收敛** | 删除 base58 与重复的 multibase/DID 构造；`did.ts` 只留业务 helper | 身份测试全绿；DID 与文档字节稳定 |
| **C4 客户端签名收敛** | `client.ts` 与测试改用 `signAnpLoginRequest`；删除 `signRequest` | `anp.test.ts`、`web.test.ts` 全绿；retry/enrollment 行为不变 |
| **C5 可选收尾** | core 增加 `@anpio-cli/core/verify` 子入口（只导出验签面）；collab 删除不再使用的 `src/anp/*` | `git grep` 不再有本地 `verifySignature` 定义；依赖面清晰 |

顺序：C0 → C1 → C2 是必须的；C3/C4 可以并行或延后。C2 之前不能打开 core 的文档 proof 校验。

## 7. 测试

现有会受影响的文件（都 import `src/anp/*`）：

- `tests/anp.test.ts`、`tests/did-resolution.test.ts`、`tests/identity-bind.test.ts`、`tests/email-bind.test.ts`、`tests/tenant-auth.test.ts`、`tests/web.test.ts`、`tests/agent-session.test.ts`、`tests/helpers/harness.ts`。

新增负例：

- 文档缺 proof / proof 签名错误 → `invalid_verification_method`；
- `Signature-Input` 的 keyid 属于另一个 DID → `invalid_did`；
- body.keyid 与 header keyid 不一致 → 401；
- 覆盖集缺 `@target-uri`，或 body 存在但缺 `content-digest` → `request_malformed`；
- 同一 `(keyid, nonce)` 重放 → challenge / 401；
- resolver 超时/白名单外 → `unverifiable` → 503，而不是 401；
- 已停用 DID → 409 `did_superseded`（有 successor 时带 `currentDid`）。

共享向量放 `tests/vectors/anp/*.json`，`anpio-agents` 的 `tests/anp-identity.test.ts` 读同一组。

## 8. 兼容性与发布

- core 是 `0.0.0` 未发布；collab 用 `file:` 或 `npm pack` 的 tarball 引入，等发布后改版本号。
- 没有运行时阻碍：collab 是 ESM、Node ≥22.18；core 是 ESM+CJS、Node ≥22.12、纯 JS 依赖；collab 直接跑 TS，能解析 package exports。
- 发布说明必须写清三项行为变化：文档 proof 成为必需、覆盖集变严、keyid 以 `Signature-Input` 为准。
- 外部客户端迁移窗口：C1 先发布「自产文档带 proof」；C2 再强制。注意 `documentProof: 'lenient'` 对 active 的 `e1_` 文档仍然是 required（`resolveDid.ts:1167–1169`），所以没有「服务端放宽」这条退路；宽限期只能靠客户端先升级。

## 9. 不做

- 不改 `/auth/anp/challenge`、`/auth/anp/login`、bind 路由的路径与响应形状（错误码更精确除外）。
- 不把 collab 改成 ANP-09 消息服务；那是另一件事。
- 不让 collab 依赖 anpio-agents。
- 不复制 core 的 resolver；保留 collab 的 3s / 64 KiB / 不跟重定向 / loopback 策略。
- 不用 `verifyAnpLoginRequest` 端到端替换登录路由：它不能发挑战，且默认信任 inline 文档。

## 10. 验收

- `npm test`、`npm run check` 全绿。
- collab 自产身份（带 proof）能通过新验签登录。
- 同一组 golden vectors 在 `anpio-agents` 与 `anpio-collab` 都通过。
- `git grep "function verifySignature"` 在 collab 中不再命中；`src/anp/*` 只剩 resolver 与展示 helper。
- 拒绝路径符合 §4 的错误语义：`unverifiable` 不会变成 401。

## 11. 实施记录

- C1：`src/anp/identity.ts` 改用 core 的 `identityDid` / `buildBaseDidDocument` /
  `signDidDocumentProofSync`，自产文档带 `eddsa-jcs-2022` proof，并保留 `priv` 原始字节。
- C2：`IdentityService.authenticate` 统一 login/bind 的验签链路：`Signature-Input`
  的 keyid → 远程解析 → `verifyDidDocument` → `resolveVerificationKey` →
  `verifyHttpSignatureForServer`；nonce 经 `NonceStore` 适配器在验签通过后消费。
  `unverifiable` → 503 `unavailable`；`did_deactivated` / `did_superseded` → 409，
  并在响应体顶层带 `requestedDid` / `currentDid`；其余 → 401。
- C3：删除 `src/anp/base58.ts`；`src/anp/did.ts` 只留展示/业务 helper 与
  `fingerprintOfRawKey`（改调 core 的 `didFingerprint`）。
- C4：`src/anp/client.ts` 改用 core 的 `signAnpLoginRequest`；删除
  `src/anp/signature.ts`；测试改用 `tests/helpers/anp-sign.ts`（core 覆盖集 +
  Node `crypto.sign`，可签任意请求体与伪造用例）。
- 新增 `tests/anp-verification.test.ts`：缺 proof、proof 被篡改、keyid 跨 DID、
  body.keyid 与 header 不一致、覆盖集缺 `@target-uri` / `content-digest`、
  解析器不可达（503）、DID 已替换（409）。
- C0（共享 golden vectors）未做：collab 本地实现已删除，向量应落在 core /
  `anpio-agents` 侧，不在本仓库的写入范围内。
