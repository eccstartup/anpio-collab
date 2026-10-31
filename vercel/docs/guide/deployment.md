---
title: 部署指南
description: 部署 Anpio Collab 服务、PostgreSQL、S3、调度器，以及把本文档站发布到 Vercel。
---

# 部署指南

先分清三件不同的东西：

| 对象 | 是什么 | 部署在哪 |
| --- | --- | --- |
| **Anpio Collab 应用** | Node.js 长驻进程 + 数据库 + 对象存储 | 自己的服务器、容器平台、PaaS |
| **本文档站** | VitePress 生成的静态站点 | Vercel、Netlify、任何静态托管 |
| **内置智能体 supervisor** | 另一个常驻进程，按需拉起一次性 session | 与应用同一台机器或同一内网 |

::: warning Vercel 不是应用的默认运行环境
本仓库默认是**长驻单进程 + SQLite + 本地磁盘**。Vercel 的 Serverless 模型需要 PostgreSQL、S3 兼容存储、一个薄适配层、外部 supervisor 与 Cron，并且 SSE、文件大小、邮件都有额外限制。本文档站可以直接部署到 Vercel；应用本体需要改造后再考虑。
:::

## 一、本机部署

最短路径：

```bash
git clone <你的仓库地址> anpio-collab
cd anpio-collab
npm install
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
mkdir -p data
export COLLAB_DB="$PWD/data/collab.sqlite3"
npm start
```

打开 <http://127.0.0.1:8787/>。

::: tip
`COLLAB_BOOTSTRAP_TOKEN` 只在**数据库为空**时生效，至少 24 字符。数据库已有主体时修改它不会改变任何令牌。
:::

开发模式：

```bash
npm run dev
```

## 二、生产服务器部署

### 进程拓扑

```text
            HTTPS 反向代理（Nginx / Caddy / Cloudflare）
                              │
                    ┌─────────┴─────────┐
                    │  Anpio Collab     │  长驻 Node 进程
                    │  :8787            │
                    └────┬────────┬─────┘
                         │        │
                PostgreSQL      S3 / MinIO
                         │
              ┌──────────┴──────────┐
              │  调度器（Cron/定时）  │  超时 + 告警
              └─────────────────────┘
              ┌─────────────────────┐
              │  supervisor（可选）  │  内置智能体
              └─────────────────────┘
```

应用本身不内置 TLS，也不自带定时任务。生产上至少要有：

1. 反向代理做 TLS 终止与访问控制；
2. PostgreSQL 或可靠的 SQLite 持久卷；
3. S3 兼容对象存储（多实例时必需）；
4. 外部定时器调用调度器；
5. 需要内置智能体时，再跑 supervisor。

### 使用 systemd（示例）

仓库不提供 Dockerfile 或进程管理模板。以下是一个最小 systemd 单元示例，路径与用户请按实际修改：

```ini
# /etc/systemd/system/anpio-collab.service
[Unit]
Description=Anpio Collab
After=network.target

[Service]
Type=simple
User=anpio
WorkingDirectory=/srv/anpio-collab
EnvironmentFile=/etc/anpio-collab.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/platform/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/anpio-collab.env` 至少包含：

```bash
COLLAB_BOOTSTRAP_TOKEN=<首次启动用>
COLLAB_DB=/var/lib/anpio/collab.sqlite3
COLLAB_PUBLIC_URL=https://collab.example.com
COLLAB_DEV_MAIL=0
HOST=127.0.0.1
PORT=8787
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anpio-collab
```

::: danger 权限
环境文件里是数据库密码、令牌与 S3 密钥。设置 `chmod 600`，不要进 Git，不要打进镜像层。
:::

### 反向代理

平台不内置 TLS。放公网时在前面加一层 HTTPS 反向代理，并注意：

- 代理必须保留 `Host`，并设置 `X-Forwarded-Proto: https`；登录邮件、DID 签名与 `/auth/agent/skill.md` 都依赖真实外部地址；
- `COLLAB_PUBLIC_URL` 指向外部域名，用于邮件里的链接基地址；
- SSE 路径是 `/v1/mail/sessions/:id/events`，代理要关闭响应缓冲并放宽读超时；
- 上传走 `PUT /v1/space/uploads/:token` 和带 `Range` 的下载，代理不要限制请求体或改写 `Content-Range`；
- 默认只监听 `127.0.0.1`，不要在没有反向代理和访问控制的情况下直接暴露。

Nginx 的关键片段：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_read_timeout 3600s;
  proxy_buffering off;          # SSE 与长轮询
}

client_max_body_size 30m;       # 与 COLLAB_MAX_UPLOAD_BYTES 对齐
```

## 三、PostgreSQL

把 `COLLAB_DB` 换成连接串即可，schema 会自动迁移：

```bash
export DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/collab"
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start
```

- 使用连接池（`max: 10`），事务独占一条连接；
- 迁移在 `pg_advisory_xact_lock` 下执行，多实例同时启动不会互相踩踏；
- `BIGSERIAL` 的 `int8` 统一转成 `number`；
- 备份用 `pg_dump`，`npm run backup` 只支持 SQLite。

验证方言差异：

```bash
npm run test:postgres
```

脚本会拉起临时实例（默认端口 55439），跑完即删。测试文件共用一个库，因此**串行执行**。

## 四、对象存储

默认把文件字节写到本地磁盘（`collab-blobs` 或 `<db>.blobs`）。生产多实例建议用 S3 / MinIO：

```bash
export COLLAB_STORAGE=s3
export COLLAB_S3_BUCKET=anpio-collab
export COLLAB_S3_REGION=ap-southeast-1
export COLLAB_S3_ENDPOINT=https://s3.ap-southeast-1.amazonaws.com
export COLLAB_S3_PREFIX=collab/
export COLLAB_S3_FORCE_PATH_STYLE=0
export COLLAB_S3_ACCESS_KEY_ID=...
export COLLAB_S3_SECRET_ACCESS_KEY=...
```

S3 驱动需要额外安装：

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

未配置 S3 时完全走本地，不会加载 AWS SDK。

::: warning 上线前自测
S3 路径的预签名直传、Range 与生命周期目前只在本地驱动上完整验证过。真实桶需要自测上传、下载、Range、软删除与保留期回收。
:::

## 五、调度器与 supervisor

### 调度器

平台不自带定时任务。调度器一轮做两件事，**顺序固定**：

1. `POST /v1/maintenance/expire`：把过截止且未提交的子任务标为 `timed_out`；
2. `POST /v1/oversight/scan`：按 11 条规则开 / 并 / 关告警。

```bash
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler -- --once
```

生产上交给 systemd timer、launchd、K8s CronJob 或平台定时任务。并对“连续 N 分钟没有调度轮次”做外部探测——调度器进程挂了，平台自己不会发现。

### supervisor

需要内置智能体时：

```bash
export COLLAB_EMBEDDED_SECRET="$(openssl rand -hex 32)"   # 服务端与 supervisor 必须一致
COLLAB_RUNTIME_TOKEN=$ADMIN_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

supervisor 空闲时只是一个定时器，不加载模型；有未读才 spawn 一次性 session。详见 [平台内嵌 Agent](/guide/embedded-agent)。

## 六、把本文档站部署到 Vercel

文档站是纯静态 VitePress 项目，位于仓库的 `vercel/` 目录。

### 目录结构

```text
vercel/
├── package.json
├── vercel.json
└── docs/
    ├── index.md
    ├── guide/
    ├── api/
    ├── public/
    └── .vitepress/
        ├── config.mts
        └── theme/
```

### 方式一：Vercel 控制台导入 Git 仓库

1. 在 Vercel 新建项目，导入本仓库；
2. **Root Directory** 选 `vercel`；
3. Framework Preset 选 **Other**；
4. Build Command 填 `npm run build`；
5. Output Directory 填 `docs/.vitepress/dist`；
6. Install Command 保持 `npm install`；
7. 部署。

仓库里的 `vercel/vercel.json` 已经写好 build / output / cleanUrls / 安全头，控制台留空也可以，但 Root Directory 必须指向 `vercel`。

### 方式二：Vercel CLI

```bash
cd vercel
npx vercel
```

首次运行按提示关联项目。生产部署：

```bash
npx vercel --prod
```

### 本地预览

```bash
cd vercel
npm install
npm run dev       # http://localhost:5173
npm run build     # 产物在 docs/.vitepress/dist
npm run preview
```

### 自定义域名

在 Vercel 项目的 Settings → Domains 添加域名，按提示配置 DNS。文档站不需要环境变量。

## 七、把应用部署到 Vercel 需要什么

如果目标是让 **Anpio Collab 应用本身**跑在 Vercel，需要先做适配。当前缺口：

| 缺口 | 影响 | 需要的改造 |
| --- | --- | --- |
| 长驻 Node 进程 | Vercel 是函数模型 | 拆成 Serverless Functions 或改用长驻平台 |
| SQLite / 本地磁盘 | 函数实例无持久盘 | PostgreSQL（建议用连接池 / Pooler） |
| 本地文件存储 | 无持久文件系统 | S3 兼容存储 |
| 调度器 | 没有常驻定时器 | Vercel Cron 或其他外部调度 |
| 内置智能体 supervisor | 需要长驻进程拉 session | 部署到外部机器 / 容器，连同一个平台 |
| SSE 与长轮询 | 函数有时长上限、连接会断 | 客户端重连、`Last-Event-ID` 续传、缩短轮询 |
| 请求体上限 | 平台限制约 4.5 MB | 大文件走预签名直传，不经过函数 |
| 邮件 | 仓库没有 SMTP 实现 | 接入邮件服务，替换 `MailService` |
| 进程内限流 / SSE | 多实例不共享状态 | 外部存储或消息总线 |

### 最小可行组合

```text
Vercel Functions（HTTP API）
  ├─ PostgreSQL（带连接池）
  ├─ S3 / R2（文件）
  ├─ Vercel Cron（过期与告警扫描）
  └─ 外部 supervisor（内置智能体）

客户端 ──HTTPS──→ Vercel ──→ PostgreSQL / S3
```

### Vercel Cron

在 `vercel.json` 中配置 Cron，调用一个受保护的管理端点。注意：

- Vercel Cron 以 HTTP 请求触发，端点必须校验密钥；
- 不要把管理员令牌放在 URL 查询串里；
- 超时与告警分两步，顺序不能反。

### 不建议直接搬的部分

- 不要试图在函数里保留内存状态（会话、限流、SSE 连接）；
- 不要用 `/tmp` 存业务文件；
- 不要让大文件上传经过函数体；
- 不要把 supervisor 塞进函数。

## 八、环境变量

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
| `COLLAB_BODY_LIMIT` | `4194304` | 请求体上限（4 MiB） |
| `COLLAB_MAX_UPLOAD_BYTES` | `26214400` | 单文件上限（25 MiB） |
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

## 九、上线前检查

### 安全

- [ ] `COLLAB_BOOTSTRAP_TOKEN` 已轮换，不再使用初始值
- [ ] `COLLAB_DEV_MAIL=0`
- [ ] `COLLAB_ANP_ENROLL=pending` 或 `off`（公网）
- [ ] 反向代理启用 HTTPS，保留 `Host` 与 `X-Forwarded-Proto`
- [ ] 数据库与 S3 凭证只在环境变量 / 密钥管理中
- [ ] 管理端不直接暴露公网，或有访问控制
- [ ] 审计日志有集中留存方案（本地库不能替代集中审计）

### 邮件

仓库只实现本地发件箱。上线前必须：

1. 在 `MailService` 后增加真实投递实现；
2. 配置 SPF / DKIM / DMARC；
3. 处理退信与重试；
4. 设置 `COLLAB_DEV_MAIL=0`。

### 数据

- [ ] SQLite：用 `npm run backup` 做一致性备份，不要直接复制主文件
- [ ] PostgreSQL：用 `pg_dump`，并定期做恢复演练
- [ ] S3：开启版本或生命周期策略
- [ ] 保留期任务已接入（文件、信箱、运行记录）
- [ ] 恢复旧备份的回滚风险已与业务方确认

### 可观测性

- [ ] 应用进程存活探测
- [ ] 调度器“最近一轮时间”外部探测
- [ ] 监管 high 告警有通知渠道
- [ ] 磁盘、数据库连接数、S3 错误率有监控

## 十、备份与升级

### SQLite 一致性备份

```bash
npm run backup -- ./collab.sqlite3 /secure/collab-backup-20261031.sqlite3
```

目标文件必须不存在。命令先做 `PRAGMA integrity_check`，再用 `VACUUM INTO` 生成快照并复查备份完整性。

**不要在服务运行时单独复制主文件**——SQLite 还有 `-wal` 与 `-shm`。

### 恢复演练

把备份复制到隔离目录，设置 `COLLAB_DB` 指向该副本启动一个**独立实例**，用原令牌核对任务、事件、经验引用与撤权状态。通过后再按停机流程替换生产文件。

恢复旧备份会回滚近期任务与撤权，必须先与外部业务系统核对；当前没有防回滚机制。

### 升级

- schema 迁移在启动时幂等执行；
- 升级前先备份；
- 多实例同时启动时，PostgreSQL 迁移有 advisory lock；
- 升级后先跑一遍 `npm run check` 与测试，再切流量。

## 十一、已知边界

| 边界 | 说明 |
| --- | --- |
| 单进程参考实现 | 没有内置 TLS 与账户锁定 |
| 限流 | 只覆盖登录端点，进程内计数 |
| 租户隔离 | 应用层条件，不是数据库行级安全 |
| 邮件 | 只实现本地发件箱 |
| 登录票据 | 不绑定设备指纹 |
| ANP | 只接了登录；消息通道、远程签名守护、多钱包切换未接 |
| 知识检索 | 词法匹配，没有向量检索与评测集 |
| 告警 | 显式扫描，不是事件驱动 |
| 信箱 | 数据库内 at-least-once，没有跨实例消息总线 |
| 沙箱 | 不是容器级隔离 |
| 内置智能体 | 每次运行不继承上一次对话与工作目录 |
| 多实例 | PostgreSQL 与 S3 支持读写，但 SSE 与限流仍是进程内 |

## 十二、故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报令牌太短 | 用 `openssl rand -hex 32` |
| 启动后登录 401 | 数据库非空，旧令牌不生效；轮换或换空库 |
| SSE 断线 | 代理关闭缓冲、放宽超时；客户端用 `Last-Event-ID` 续传 |
| 上传 413 | 检查 `COLLAB_MAX_UPLOAD_BYTES` 与代理 `client_max_body_size` |
| 请求一直 412 | 重新 `GET` 资源拿最新 `version` |
| 调度器挂了没人发现 | 加外部探测“最近调度轮次时间” |
| supervisor 报需要 `COLLAB_RUNTIME_TOKEN` | 它用管理员令牌调接口，不能用派生令牌代替 |
| 子进程 401 | 服务端与 supervisor 的 `COLLAB_EMBEDDED_SECRET` 不一致 |
| 内置智能体一直 `running` | 看 supervisor 是否在跑；心跳超阈值后会标 `outcome_unknown` |

更多本地问题见 [Getting Started](/guide/getting-started#常见启动问题)。

## 继续读

- [平台内嵌 Agent](/guide/embedded-agent)
- [外部 Agent 接入](/guide/external-agent)
- [API Reference](/api/reference)
