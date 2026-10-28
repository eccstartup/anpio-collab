# 本地运行与恢复

本说明面向单机开发与内部试用。服务默认只监听 `127.0.0.1`，应用进程、数据库文件与令牌都由本机用户保护；这不是生产部署方案。

## 启动

```sh
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
export COLLAB_DB="$PWD/data/collab.sqlite3"     # 可选，默认 ./collab.sqlite3
npm start
```

首次启动会在同一个事务里建表并创建 `admin` 主体（角色 `admin/owner/reviewer`）。

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

- 使用连接池（`max: 10`），事务独占一条连接，普通查询各自取连接
- 迁移在 `pg_advisory_xact_lock` 下执行，多实例同时启动不会互相踩踏
- `BIGSERIAL` 的 `int8` 已统一转成 `number`；项目的序号都在安全整数范围内
- 备份请用 `pg_dump`；`npm run backup` 只支持 SQLite，遇到 `postgres://` 会直接报错

验证方言差异：

```sh
npm run test:postgres     # 需要本机已安装 initdb / pg_ctl / createdb
```

脚本会拉起一个临时实例（默认端口 55439），跑完即删。测试文件共用一个库，因此**串行执行**——某个文件开头的 `DROP SCHEMA` 会清掉另一个文件正在用的表。

## 超时调度

平台不自带定时任务：超时是显式的管理操作，调一次留一次审计。

```sh
COLLAB_URL=http://127.0.0.1:8787 COLLAB_TOKEN=$ADMIN_TOKEN \
  npm run scheduler -- --once          # 只跑一次
COLLAB_SCHEDULER_INTERVAL_MS=60000 \
  npm run scheduler                    # 每分钟一次，Ctrl-C 退出
```

它把"已过截止时间且仍未提交"的子任务标记为 `timed_out`。标记只改变协作状态，**不推断业务执行失败**——超时后应先与外部系统核对实际结果，再决定是否退回。

## 反向代理与端口

默认 `HOST=127.0.0.1`。若要放到内网，请在前面加一层 TLS 终止与访问控制，并注意：

- 没有速率限制与账户锁定，令牌被拿到即可全权使用
- CSP 允许 `style-src 'self' 'unsafe-inline'`（部分内联样式），其余默认收紧
- 审计只写本地库，需另接集中审计才有留存保证

## 常见问题

**启动报"COLLAB_BOOTSTRAP_TOKEN 至少需要 24 个字符"**：令牌太短。用 `openssl rand -hex 32`。

**启动后登录 401**：数据库不是空的，环境变量里的令牌不再生效。用现有管理员令牌轮换，或换一个空的 `COLLAB_DB` 重新开始。

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
