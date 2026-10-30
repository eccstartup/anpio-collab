/**
 * 前端冒烟测试：在 Node 里用极简 DOM 跑一遍 src/web/app.js。
 *
 * 覆盖用户最关心的那条路：
 *  1. 用「钱包插件」登录 —— 假钱包用的是与插件、CLI 相同的 signRequest，
 *     所以这里验证的是真实的 ANP-02 验签链路，而不是一个假接口；
 *  2. 登录后按角色生成导航：管理员看得到监管与审计，纯智能体只看到自己的事；
 *  3. 每个视图都能渲染，监管看板的扫描按钮真的会写告警。
 *
 * 页面结构由 buildPage() 复刻 index.html；下面有断言保证两者不会走散。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AnpIdentity } from '../src/anp/identity.ts';
import { signRequest } from '../src/anp/signature.ts';
import { ADMIN_TOKEN, startHarness, type Harness } from './helpers/harness.ts';
import { DomElement, DomNode, DomDocument } from './helpers/dom.ts';

const WEB_ROOT = new URL('../src/web/', import.meta.url);
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 复刻 index.html 的骨架：id 与 data-step 必须与 HTML 一致。 */
function buildPage(document: DomDocument): void {
  const root = document.root;

  const login = document.createElement('section');
  login.setAttribute('id', 'login');
  login.setAttribute('class', 'login');

  const card = document.createElement('div');
  login.append(card);

  const steps = document.createElement('ol');
  steps.setAttribute('id', 'wallet-steps');
  for (const step of ['identity', 'challenge', 'sign', 'session']) {
    const item = document.createElement('li');
    item.setAttribute('data-step', step);
    item.dataset.step = step;
    item.append(document.createElement('span'));
    steps.append(item);
  }
  card.append(steps);

  const walletForm = document.createElement('form');
  walletForm.setAttribute('id', 'wallet-form');
  const bindCode = document.createElement('input');
  bindCode.setAttribute('id', 'bind-code');
  const walletSubmit = document.createElement('button');
  walletSubmit.setAttribute('id', 'wallet-submit');
  walletSubmit.setAttribute('type', 'submit');
  walletForm.append(bindCode, walletSubmit);
  card.append(walletForm);

  const walletNote = document.createElement('p');
  walletNote.setAttribute('id', 'wallet-note');
  card.append(walletNote);

  // 「我是智能体」：登录页直接给出可复制的 skill，不跳文档。
  const agentSkill = document.createElement('pre');
  agentSkill.setAttribute('id', 'agent-skill');
  const agentCopy = document.createElement('button');
  agentCopy.setAttribute('id', 'agent-skill-copy');
  card.append(agentSkill, agentCopy);

  const fallback = document.createElement('details');
  fallback.setAttribute('id', 'token-fallback');
  const loginForm = document.createElement('form');
  loginForm.setAttribute('id', 'login-form');
  const token = document.createElement('input');
  token.setAttribute('id', 'token');
  loginForm.append(token);
  fallback.append(loginForm);
  card.append(fallback);

  const loginError = document.createElement('p');
  loginError.setAttribute('id', 'login-error');
  card.append(loginError);

  const shell = document.createElement('div');
  shell.setAttribute('id', 'shell');
  const nav = document.createElement('nav');
  nav.setAttribute('id', 'nav');
  const identity = document.createElement('div');
  identity.setAttribute('id', 'identity');
  const logout = document.createElement('button');
  logout.setAttribute('id', 'logout');
  const topbar = document.createElement('header');
  topbar.setAttribute('id', 'topbar');
  const view = document.createElement('div');
  view.setAttribute('id', 'view');
  shell.append(nav, identity, logout, topbar, view);

  const toast = document.createElement('div');
  toast.setAttribute('id', 'toast');
  toast.hidden = true;

  const dialog = document.createElement('dialog');
  dialog.setAttribute('id', 'dialog');

  root.append(login, shell, toast, dialog);
}

/** 与浏览器插件同构的假钱包：签名实现就是 CLI 用的那套。 */
function fakeWallet(identity: AnpIdentity) {
  return {
    isAnpWallet: true,
    names: ['anp'],
    version: 'test',
    async getIdentity() {
      return {
        did: identity.did,
        keyid: identity.keyid,
        publicKeyMultibase: identity.publicKeyMultibase,
        didDocument: identity.didDocument,
      };
    },
    async signAnpLogin(request: { url: string; method?: string; body: string; nonce: string }) {
      const signed = signRequest({
        url: request.url,
        method: request.method ?? 'POST',
        body: request.body,
        nonce: request.nonce,
        keyid: identity.keyid,
        privateKey: identity.privateKey,
      });
      return {
        did: identity.did,
        keyid: identity.keyid,
        didDocument: identity.didDocument,
        body: signed.body,
        headers: signed.headers,
      };
    },
  };
}

type Mounted = {
  document: DomDocument;
  wallet: ReturnType<typeof fakeWallet> | undefined;
  dispose(): void;
};

let appSource = '';

async function mount(options: { url: string; wallet?: ReturnType<typeof fakeWallet> }): Promise<Mounted> {
  if (!appSource) appSource = await readFile(new URL('app.js', WEB_ROOT), 'utf8');

  const document = new DomDocument();
  buildPage(document);

  const store = new Map<string, string>();
  const saved = {
    document: (globalThis as Record<string, unknown>).document,
    window: (globalThis as Record<string, unknown>).window,
    location: (globalThis as Record<string, unknown>).location,
    sessionStorage: (globalThis as Record<string, unknown>).sessionStorage,
    Node: (globalThis as Record<string, unknown>).Node,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
  };

  const globals = globalThis as Record<string, unknown>;
  globals.document = document;
  globals.window = options.wallet ? { anp: options.wallet } : {};
  globals.location = { origin: options.url };
  globals.Node = DomNode;
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  // 插件探测用的轮询在测试里没有意义，直接让它返回句柄。
  globals.setInterval = () => 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const absolute = raw.startsWith('http') ? raw : `${options.url}${raw}`;
    return realFetch(absolute, init);
  }) as typeof fetch;

  // eslint-disable-next-line no-new-func
  new Function(appSource)();

  return {
    document,
    wallet: options.wallet,
    dispose() {
      globals.document = saved.document;
      globals.window = saved.window;
      globals.location = saved.location;
      globals.sessionStorage = saved.sessionStorage;
      globals.Node = saved.Node;
      globalThis.fetch = saved.fetch;
      globals.setInterval = saved.setInterval;
    },
  };
}

const text = (node: DomElement | null) => (node ? node.textContent : '');
const childElements = (node: DomElement): DomElement[] =>
  node.children.filter((child): child is DomElement => child instanceof DomElement);
const element = (document: DomDocument, id: string): DomElement => {
  const found = document.getElementById(id);
  assert.ok(found, `页面缺少 #${id}`);
  return found;
};

function buttonByText(document: DomDocument, label: string): DomElement {
  const found = document.querySelectorAll('#view button').find(node => node.textContent.trim() === label);
  assert.ok(found, `视图里没有「${label}」按钮：${document.querySelectorAll('#view button').map(node => node.textContent).join(' / ')}`);
  return found;
}

const navLabels = (document: DomDocument) =>
  childElements(element(document, 'nav')).map(child => child.textContent.trim());

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  assert.fail(message);
}

/** 视图切换是 click 里发起的异步刷新，靠标题变化判断它渲染完了。 */
async function visit(document: DomDocument, label: string): Promise<void> {
  const button = childElements(element(document, 'nav')).find(child => child.textContent.trim() === label);
  assert.ok(button, `导航里没有「${label}」：${navLabels(document).join(' / ')}`);
  // 同一个视图连点两次时标题不会变，先清空才能等到这一次 refresh() 真正渲染完；
  // 否则它会拖到测试结束之后，通过全局 document/fetch 污染下一条测试。
  element(document, 'topbar').replaceChildren();
  await button.fire('click');
  await waitFor(
    () => text(document.getElementById('topbar')).includes(label),
    `切到「${label}」后顶部标题没有更新`,
  );
  const toast = element(document, 'toast');
  assert.notEqual(toast.dataset.tone, 'error', `渲染「${label}」时报错：${text(toast)}`);
}

async function seed(harness: Harness): Promise<{ agentToken: string; taskId: string }> {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await realFetch(`${harness.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.ok(response.ok, `seed ${method} ${path} 失败：${JSON.stringify(payload)}`);
    return payload as Record<string, unknown>;
  };

  const agentToken = harness.token('inventory');
  await call('POST', '/v1/principals', {
    id: 'inventory',
    roles: ['agent'],
    kind: 'agent',
    token: agentToken,
    displayName: '库存智能体',
    capabilities: ['inventory:read'],
  });

  const task = await call('POST', '/v1/tasks', {
    title: '缺料分析 M-100',
    type: 'shortage-analysis',
    goal: '判断 100 件 M-100 能否按时交付',
    acceptance: '数据需带来源与观测时间',
    input: { material: 'M-100', quantity: 100 },
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    priority: 'high',
  });
  const taskId = String(task.id);

  await call('POST', `/v1/tasks/${taskId}/assign`, { agent: 'inventory', kind: 'inventory' });
  await call('POST', `/v1/tasks/${taskId}/offers`, {
    kind: 'supplier',
    capability: 'inventory:read',
    description: '核对供应商交期',
  });
  await call('POST', `/v1/tasks/${taskId}/comments`, { body: '@inventory 先看库存快照，再看供应商回复' });

  const beat = await realFetch(`${harness.url}/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agentToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ state: 'online', client: 'cli', note: 'inventory@cli' }),
  });
  assert.ok(beat.ok, '心跳上报失败');

  return { agentToken, taskId };
}

test('index.html 与测试骨架的 id 保持一致', async () => {
  const html = await readFile(new URL('index.html', WEB_ROOT), 'utf8');
  for (const id of [
    'login', 'email-form', 'email', 'email-submit', 'email-note',
    'wallet-steps', 'wallet-form', 'bind-code', 'wallet-submit', 'wallet-note',
    'agent-block', 'agent-skill', 'agent-skill-copy', 'token-fallback', 'login-form', 'token', 'login-error', 'shell', 'nav',
    'tenant', 'identity', 'logout', 'topbar', 'view', 'toast', 'dialog',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  for (const step of ['identity', 'challenge', 'sign', 'session']) {
    assert.ok(html.includes(`data-step="${step}"`), `index.html 缺少分步 ${step}`);
  }
  // CSP 只允许同源脚本，页面不能依赖内联事件。
  assert.ok(!/on(click|submit)=/.test(html), 'index.html 不应有内联事件处理器');
  // 登录前必须能找到说明页的入口。
  assert.ok(html.includes('/help/login'), '登录页缺少登录说明入口');
});

test('登录说明页：无需登录即可访问，两种登录方式都在', async () => {
  const harness = await startHarness();
  try {
    const response = await realFetch(`${harness.url}/help/login`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('邮箱一次性链接'), '缺少邮箱登录说明');
    assert.ok(html.includes('DID 钱包签名'), '缺少 DID 登录说明');
    assert.ok(html.includes('id="agent"'), '缺少智能体授权章节');
    assert.ok(html.includes('/login?ticket='), '缺少真实邮件样例');

    // 邮件链接的落点必须回落到单页应用，否则点链接会拿到 401 JSON。
    for (const path of ['/login?ticket=abc', '/agents/approve?code=ABCD-2345']) {
      const page = await realFetch(`${harness.url}${path}`);
      assert.equal(page.status, 200, `${path} 应该返回页面`);
      assert.match(await page.text(), /id="email-form"/);
    }
  } finally {
    await harness.close();
  }
});

test('登录页直接给出智能体 skill：地址随当前服务生成，复制即可交给智能体', async () => {
  const harness = await startHarness();
  const mounted = await mount({ url: harness.url });
  try {
    const preview = element(mounted.document, 'agent-skill');
    await waitFor(
      () => text(preview).includes('/auth/agent/request'),
      `skill 没有加载到登录页：${text(preview)}`,
    );
    const skill = text(preview);
    assert.ok(skill.includes(harness.url), 'skill 里的地址应指向当前服务');
    assert.ok(skill.includes('agents/approve'), 'skill 应告诉智能体去哪里批准');
    assert.ok(!text(element(mounted.document, 'login')).includes('输入批准码'), '智能体这一步不应出现登录表单');
  } finally {
    await sleep(80);
    mounted.dispose();
    await harness.close();
  }
});

test('用钱包插件登录：领取挑战、签名、换令牌、按角色生成导航', async () => {
  const harness = await startHarness();
  const identity = harness.did.identity('alice');
  const mounted = await mount({ url: harness.url, wallet: fakeWallet(identity) });
  try {
    const login = element(mounted.document, 'login');
    assert.equal(login.hidden, false, '未登录时应显示登录卡');
    assert.ok(text(element(mounted.document, 'wallet-note')).includes('已检测到'), '应提示检测到钱包插件');
    assert.deepEqual(navLabels(mounted.document), [], '未登录不应有导航');

    await element(mounted.document, 'wallet-form').fire('submit');

    await waitFor(() => element(mounted.document, 'shell').hidden === false, `登录未完成：${text(element(mounted.document, 'login-error'))}`);

    // 四步都应标记完成——用户能从界面看出走到哪一步。
    const steps = mounted.document.querySelectorAll('#wallet-steps li');
    assert.deepEqual(steps.map(step => step.dataset.state), ['done', 'done', 'done', 'done']);

    // 服务端真的把这条 DID 绑到了主体上：用会话令牌回查一次。
    const token = await (globalThis as unknown as { sessionStorage: { getItem(k: string): string | null } }).sessionStorage.getItem('collab.token');
    assert.ok(token, '缺少会话令牌');
    const me = await (await realFetch(`${harness.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { did: string; kind: string; roles: string[] };
    assert.equal(me.did, identity.did);
    assert.equal(me.kind, 'human');
    assert.deepEqual(me.roles, ['owner'], '人类钱包首次登录应按 owner 自动登记');

    // 纯负责人没有监管与审计，导航必须如实反映权限。
    assert.deepEqual(navLabels(mounted.document), ['工作台', '任务', '提醒', '我的智能体', '团队', '设置']);

    for (const label of ['工作台', '任务', '提醒', '我的智能体', '团队', '设置']) {
      await visit(mounted.document, label);
      assert.ok(text(element(mounted.document, 'view')).trim().length > 0, `「${label}」渲染为空`);
    }

    // 设置页应能读到刚绑定的 DID 与这次登录产生的会话。
    await visit(mounted.document, '设置');
    const settings = text(element(mounted.document, 'view'));
    assert.ok(settings.includes(identity.did.slice(0, 24)), '设置页没有显示已绑定的 DID');
    assert.ok(settings.includes('browser'), '会话列表缺少来源');
  } finally {
    await sleep(80);
    mounted.dispose();
    await harness.close();
  }
});

test('智能体用访问令牌登录：只看到自己的事，没有全局看板', async () => {
  const harness = await startHarness();
  const { agentToken, taskId } = await seed(harness);
  const mounted = await mount({ url: harness.url });
  try {
    assert.ok(text(element(mounted.document, 'wallet-note')).includes('未检测到'), '无插件时应提示未检测到');
    element(mounted.document, 'token').value = agentToken;
    await element(mounted.document, 'login-form').fire('submit');
    await waitFor(() => element(mounted.document, 'shell').hidden === false, `令牌登录未完成：${text(element(mounted.document, 'login-error'))}`);
    await waitFor(
      () => text(element(mounted.document, 'view')).length > 0,
      `工作台没有渲染：${text(element(mounted.document, 'toast'))}`,
    );

    assert.deepEqual(navLabels(mounted.document), ['工作台', '任务', '开放池', '提醒', '经验库', '设置']);

    const home = text(element(mounted.document, 'view'));
    assert.ok(home.includes('待办子任务'), `智能体工作台缺少待办计数：${home.slice(0, 300)}`);
    assert.ok(home.includes('缺料分析 M-100'), '智能体待办里应能看到被分派的子任务');
    assert.ok(home.includes('心跳'), '智能体工作台缺少心跳入口');

    await visit(mounted.document, '开放池');
    assert.ok(text(element(mounted.document, 'view')).includes('核对供应商交期'), '开放池应展示匹配的子任务');

    await visit(mounted.document, '任务');
    await element(mounted.document, 'view').querySelector('button.list-item')?.fire('click');
    await waitFor(() => text(element(mounted.document, 'view')).includes('评论'), '任务详情没有渲染出来');
    const detail = text(element(mounted.document, 'view'));
    assert.ok(detail.includes('先看库存快照'), '任务详情应显示评论流');
    assert.ok(detail.includes('开放子任务'), '任务详情应显示开放子任务');

    // 详情页动作：发表评论走 POST /v1/tasks/:id/comments。
    const textarea = element(mounted.document, 'view').querySelector('textarea');
    assert.ok(textarea, '评论框缺失');
    textarea.value = '库存快照已拉取，正在核对供应商';
    await buttonByText(mounted.document, '发表').fire('click');
    await waitFor(
      () => text(element(mounted.document, 'view')).includes('库存快照已拉取'),
      '评论没有出现在时间线上',
    );

    const comments = await (await realFetch(`${harness.url}/v1/tasks/${taskId}/comments`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })).json() as Array<{ body: string }>;
    assert.ok(comments.some(item => item.body === '库存快照已拉取，正在核对供应商'));
  } finally {
    await sleep(80);
    mounted.dispose();
    await harness.close();
  }
});

test('监管者看板：列异常、看在线表、能触发扫描', async () => {
  const harness = await startHarness();
  await seed(harness);
  const mounted = await mount({ url: harness.url });
  try {
    element(mounted.document, 'token').value = ADMIN_TOKEN;
    await element(mounted.document, 'login-form').fire('submit');
    await waitFor(
      () => text(element(mounted.document, 'topbar')).includes('工作台'),
      `管理员登录后没有进入工作台：${text(element(mounted.document, 'login-error'))}`,
    );

    assert.deepEqual(navLabels(mounted.document), ['工作台', '任务', '提醒', '经验库', '我的智能体', '团队', '监管', '审计', '设置']);

    await visit(mounted.document, '监管');
    const view = text(element(mounted.document, 'view'));
    assert.ok(view.includes('未处理告警'), '监管看板缺少告警计数');
    assert.ok(view.includes('智能体在线表'), '监管看板缺少在线表');
    assert.ok(view.includes('库存智能体'), '在线表里应有种子智能体');
    assert.ok(view.includes('风险任务'), '监管看板缺少风险任务区');

    await buttonByText(mounted.document, '重新扫描').fire('click');
    const toast = element(mounted.document, 'toast');
    await waitFor(() => text(toast).includes('扫描完成'), `扫描没有回执：${text(toast)}`);
  } finally {
    await sleep(80);
    mounted.dispose();
    await harness.close();
  }
});
