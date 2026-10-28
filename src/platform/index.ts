/**
 * 平台服务入口。
 *
 * 启动顺序：读配置 → 打开数据库 → 建表 → 首次初始化管理员 → 监听回环地址。
 * 监听地址默认 127.0.0.1：这个原型不提供 TLS、企业身份和网络隔离，
 * 不应直接暴露到公网。
 */

import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { openDatabase } from './db/index.ts';
import { createServer } from './http/server.ts';
import { isMain } from './runtime.ts';

export async function start(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.database);
  const app = await createApp(db);

  if (await app.principals.isEmpty()) {
    if (!config.bootstrapToken) {
      throw new Error(
        '首次启动需要设置 COLLAB_BOOTSTRAP_TOKEN（至少 24 个字符），' +
          '例如：export COLLAB_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"',
      );
    }
    await app.principals.bootstrap(config.workspace, {
      id: config.bootstrapId,
      roles: ['admin', 'owner', 'reviewer'],
      token: config.bootstrapToken,
      displayName: '管理员',
      description: '首次启动创建的平台管理员',
    });
    console.log(`已初始化管理员主体 ${config.bootstrapId}（工作空间 ${config.workspace}）`);
  }

  const server = createServer({
    app,
    webRoot: config.webRoot,
    bodyLimit: config.requestBodyLimit,
    logRequests: config.logRequests,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`Anpio Collab 已启动: http://${config.host}:${port}/  (协议 v1)`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在关闭…`);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.ctx.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (isMain(import.meta.url)) {
  start().catch(error => {
    console.error('启动失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
