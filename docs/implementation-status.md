# 实现状态

对照 [plan.md](../plan.md) 的阶段划分，说明本仓库现在做到了什么、哪些只是本机验证、哪些还没开始。

> 结论先行：**阶段 1（本地协作闭环）与阶段 3（知识闭环）已实现并通过自动化测试；阶段 2 的"企业身份与 ANP 通信"未开始；阶段 4/5 未开始。** 通过本机测试不等于企业环境验收。

## 已完成并有测试覆盖

| 能力 | 实现位置 | 验证方式 |
| --- | --- | --- |
| 任务生命周期（pending → running → review → completed / cancelled） | `src/platform/services/tasks.ts` | `tests/lifecycle.test.ts` |
| 子任务状态机（invited → accepted → submitted → verified，含拒绝/超时/结果未知/退回） | `src/platform/services/subtasks.ts` | `tests/lifecycle.test.ts` |
| 依赖门控：前置未完成时不出现在待办、不能接受 | `src/platform/services/subtasks.ts` | `tests/lifecycle.test.ts`「依赖未完成时不能接受子任务」 |
| 验收与退回、取消并通知 | `tasks.ts` + `notifications.ts` | `tests/lifecycle.test.ts` |
| 幂等：同键同请求重放、同键不同请求 409 | `src/platform/http/executor.ts` | `tests/idempotency.test.ts` |
| 乐观并发：`If-Match` → 412，子任务条件更新 → 409 | `executor.ts` + `subtasks.ts` | `tests/idempotency.test.ts`、`tests/lifecycle.test.ts` |
| 授权分离：身份 / 平台角色 / 业务资源 | `services/access.ts` + 路由声明 | `tests/authorization.test.ts` |
| 进程重启后状态、事件、令牌仍有效 | SQLite WAL + 写前日志 | `tests/recovery.test.ts` |
| 知识生命周期：候选 → 发布（有效期 + 范围）→ 引用（钉版本）→ 修订/撤销/改范围 | `src/platform/services/knowledge.ts` | `tests/knowledge.test.ts` |
| 检索：中文二元组 + 打分 + 字符预算截断 + 稳定引用 | `knowledge.ts` | `tests/search.test.ts` |
| 三个智能体跨进程完成闭环（协调 + 两个业务 + 写前日志重放） | `src/agents/*.ts` | `tests/agents.test.ts`、`npm run demo` |
| 管理台：工作台、任务、经验库、参与者、审计 | `src/web/*` | 手工验证（见下） |
| PostgreSQL 方言兼容 | `src/platform/db/postgres.ts` | `npm run test:postgres`（30/30） |
| 一致性备份 | `src/platform/tools/backup.ts` | 备份后 `integrity_check` |

测试合计 30 项，SQLite 与 PostgreSQL 各跑一遍。`npm run check` 无类型错误。

## 与本机验证的边界

- **管理台**没有自动化 UI 测试。当前通过无头浏览器截取各视图 + DOM 断言确认渲染、登录、导航、动作入口正确；交互回归仍需人工点一遍。
- **备份恢复**只验证了"备份文件完整"，没有做过真实故障注入（磁盘满、断电、WAL 损坏）。
- **并发**验证的是单进程内的串行写事务与版本冲突；多进程同时写同一个 SQLite 文件未验证（生产应使用 PostgreSQL）。
- **智能体重放**覆盖了"请求发出后进程退出"的场景，未覆盖"提交成功但响应丢失后重放"的全部分支。

## 未实现（明确缺口）

| 计划项 | 现状 |
| --- | --- |
| 阶段 2：企业身份、DID、ANP 消息、签名授权 | 未开始。接口预留了 `principals.did` 字段，但没有校验、没有密钥管理、没有消息总线 |
| 与 `anpio-key` / `anpio-cli` / `anpio-extension` 的对接 | 未开始，是本仓库之外的工作 |
| 阶段 4：真实业务系统接入 | 未开始。示例智能体读本地 JSON |
| 阶段 5：跨组织协作 | 未开始 |
| 向量检索 / pgvector / 检索评测集 | 未开始。当前是词法匹配，没有召回率与准确率数据 |
| 自动超时调度 | 只有显式接口 `/v1/maintenance/expire` 与 `npm run scheduler`，不内置定时器 |
| 通知的可恢复投递 | 数据库内存量通知 + 拉取确认；没有退避、没有外部队列、没有"投递失败"语义 |
| 多租户 / 速率限制 / TLS / 集中审计 | 未实现。当前定位是单机内网参考实现 |
| 数据库迁移升级路径 | 只有 schema v1；后续版本需要写迁移步骤与回滚说明 |

## 截至本轮的关键修复

- **嵌套事务自锁**：执行器开事务后服务层再开事务会死锁在 SQLite 互斥上。改用 `AsyncLocalStorage` 传递当前事务，内层加入外层。
- **登录后主体不显示**：组件的 `display: grid` 覆盖了浏览器默认的 `[hidden]{display:none}`，切换视图时旧界面没有真正隐藏。已加全局兜底规则。
- **PostgreSQL 无法推断裸 NULL 参数**：主体重名检查里的 `(:did IS NOT NULL AND did = :did)` 在 PG 下报 `42P18`，改为按 `did` 是否存在分支查询。
- **连接池重复关闭**：停机流程与测试清理都会调用 `close()`，`pg` 的 `pool.end()` 只接受一次，改为幂等。
- **审计被读请求淹没**：改为读默认不留痕，仅知识检索与证据包显式标记 `auditRead`。
