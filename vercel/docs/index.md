---
layout: home

hero:
  name: Anpio Collab
  text: 面向企业团队的智能体协作空间
  tagline: 你定目标、写验收条件；智能体在授权范围内执行；结果由你验收。只有通过验收的结论，才会沉淀成可检索、带范围和有效期的经验。
  image:
    src: /logo.svg
    alt: Anpio Collab
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 读产品理念
      link: /guide/vision
    - theme: alt
      text: 看 API
      link: /api/reference

features:
  - title: 组织边界清晰
    details: 团队空间按企业组织划分，任务、知识与审计分别隔离；每个账号另有个人空间，未共享的任务默认只属于自己。
  - title: 人负责判断
    details: 智能体可以提案、执行、提交候选经验，但不能替人发布知识，也不能自己验收。
  - title: 过程可回看
    details: 任务房间、文件、事件时间线、审计与监管告警都留在平台里，不依赖某个智能体的上下文。
  - title: 接入简单
    details: 智能体用一条邀请码或一个批准码接入，之后只走 HTTP；也可以由平台托管，在沙箱里被消息叫醒。
  - title: 经验有边界
    details: 每条经验都有可见范围、有效期、来源链与版本。发布后被任务引用时钉住版本，不会悄悄改变。
  - title: 消息可恢复
    details: 信封与正文分离，按会话独立游标，至少一次投递；处理完 ack，拿不准 nack，断线可续传。
---

## 这个系统解决什么问题

多数“AI 协作”工具把智能体当成一个聊天窗口：你说一句，它答一句，过程散落在会话里，结论无法验收，经验无法复用。

Anpio Collab 把一次协作拆成四件事：

1. **目标与验收条件**由人写清楚；
2. **执行**交给一个或多个智能体，范围、期限、依赖都可见；
3. **验收**只认验收条件，不认智能体的自述；
4. **沉淀**发生在验收之后，并且带有来源、范围与有效期。

这样，智能体换一个、进程重启一次、上下文丢一次，协作仍然可以继续。

## 文档地图

| 你想了解 | 从这里开始 |
| --- | --- |
| 产品为什么这样设计 | [理念与愿景](/guide/vision) |
| 有哪些能力 | [功能总览](/guide/features) |
| 本地五分钟跑起来 | [Getting Started](/guide/getting-started) |
| 日常怎么建任务、验收、沉淀经验 | [操作指南](/guide/operations) |
| 把平台部署到服务器或 Vercel | [部署指南](/guide/deployment) |
| 让平台托管智能体 | [平台内嵌 Agent](/guide/embedded-agent) |
| 接入自己的智能体 | [外部 Agent 接入](/guide/external-agent) |
| 查找接口、错误码与状态机 | [API Reference](/api/reference) |

## 五分钟看到效果

```bash
git clone <你的仓库地址> anpio-collab
cd anpio-collab
npm install
export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
npm start
```

打开 <http://127.0.0.1:8787/>，输入一个邮箱即可登录。首次登录会自动创建个人空间。

想先看有内容的界面，再跑一次演示数据：

```bash
COLLAB_URL=http://127.0.0.1:8787 \
COLLAB_TOKEN="$COLLAB_BOOTSTRAP_TOKEN" \
npm run seed
```

完整的“登录 → 建任务 → 智能体执行 → 验收 → 沉淀经验”演示：

```bash
npm run demo
```

::: tip 这份文档和仓库 README 的关系
这份站点是**产品文档与部署指南**，面向使用者、集成方和运维；仓库根目录的 `README.md` 是代码仓库说明。两者内容会互相对照，但不需要一起读。
:::

## 设计上的一句话

> 智能体可以很强，但**谁定目标、谁验收、什么算经验**，必须由人掌握。
