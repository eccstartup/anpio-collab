import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Store } from '../platform/store.ts';
import { createServer } from '../platform/server.ts';
import { CollabClient } from '../sdk/client.ts';
const dir = mkdtempSync(join(tmpdir(), 'collab-demo-'));
const store = await Store.open(join(dir, 'collab.sqlite'));
const adminToken = randomBytes(32).toString('hex');
await store.bootstrap({ id: 'owner', workspace: 'demo', roles: ['admin', 'owner', 'reviewer'], token: adminToken, active: true });
const server = createServer(store);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const admin = new CollabClient(url, adminToken);
function worker(kind: string, token: string) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['agents-ts/worker.ts'], { env: { ...process.env, COLLAB_URL: url, COLLAB_TOKEN: token, COLLAB_KIND: kind, COLLAB_DATA: `examples/${kind}.json`, COLLAB_WORKER_DB: join(dir, `${kind}.sqlite`) }, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${kind} worker exited ${code}`)));
    });
}
try {
    const tokens: Record<string, string> = {};
    for (const kind of ['inventory', 'supplier']) {
        tokens[kind] = randomBytes(32).toString('hex');
        await admin.request('principals', { id: kind, roles: ['agent'], token: tokens[kind] }, `register-${kind}`);
    }
    const coordinatorToken = randomBytes(32).toString('hex');
    await admin.request('principals', { id: 'coordinator', roles: ['agent'], token: coordinatorToken }, 'register-coordinator');
    const input = { title: '缺料分析', material: 'M-100', quantity: 100, due: '2099-01-01T00:00:00Z', acceptance: '核对库存及供应商数据来源' };
    const task = await admin.request('tasks', input, 'create');
    await admin.request(`tasks/${task.id}/coordinators`, { principal: 'coordinator' }, 'delegate');
    const coordinator = () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['agents-ts/coordinator.ts'], { env: { ...process.env, COLLAB_URL: url, COLLAB_TOKEN: coordinatorToken, COLLAB_TASK: task.id, COLLAB_INVENTORY_AGENT: 'inventory', COLLAB_SUPPLIER_AGENT: 'supplier' }, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`coordinator exited ${code}`)));
    });
    await coordinator();
    await Promise.all(['inventory', 'supplier'].map(kind => worker(kind, tokens[kind])));
    await coordinator();
    await admin.request(`tasks/${task.id}/review`, { decision: 'accept', note: '示例人工验收' }, 'review');
    const knowledge = await admin.request(`tasks/${task.id}/knowledge`, { content: '缺料时核对库存和供应商可供数量，确认交期。', conditions: 'M-100' }, 'candidate');
    await admin.request(`knowledge/${knowledge.id}/publish`, { expiresAt: '2099-01-01T00:00:00Z', audience: 'workspace' }, 'publish');
    const second = await admin.request('tasks', { ...input, title: '第二次缺料分析' }, 'second');
    await admin.request(`tasks/${second.id}/references`, { knowledgeId: knowledge.id }, 'reference');
    console.log(JSON.stringify({ task: await admin.task(task.id), knowledge: await admin.knowledge(), secondTask: await admin.task(second.id) }, null, 2));
}
finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await store.close();
    rmSync(dir, { recursive: true, force: true });
}
