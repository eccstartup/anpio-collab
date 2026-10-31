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
import { ADMIN_TOKEN, emailLogin, startHarness, type Harness } from './helpers/harness.ts';
import { DomElement, DomNode, DomDocument } from './helpers/dom.ts';

const WEB_ROOT = new URL('../src/web/', import.meta.url);
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 复刻 index.html 的骨架：id 必须与 HTML 一致。 */
function buildPage(document: DomDocument): void {
  const root = document.root;

  const login = document.createElement('section');
  login.setAttribute('id', 'login');
  login.setAttribute('class', 'login');

  const card = document.createElement('div');
  login.append(card);

  const walletForm = document.createElement('form');
  walletForm.setAttribute('id', 'wallet-form');
  const bindCode = document.createElement('input');
  bindCode.setAttribute('id', 'bind-code');
  const walletSubmit = document.createElement('button');
  walletSubmit.setAttribute('id', 'wallet-submit');
  walletSubmit.setAttribute('type', 'submit');
  walletForm.append(bindCode, walletSubmit);
  card.append(walletForm);

  // 「我是智能体」：页面上只有一句话，链接写在话里，旁边一个复制。
  const agentHandoff = document.createElement('p');
  agentHandoff.setAttribute('id', 'agent-handoff');
  const agentLink = document.createElement('a');
  agentLink.setAttribute('id', 'agent-skill-link');
  agentHandoff.append(
    document.createTextNode('读取这个链接里的 SKILL.md，按里面的步骤接入 Anpio Collab：'),
    agentLink,
  );
  const agentCopy = document.createElement('button');
  agentCopy.setAttribute('id', 'agent-skill-copy');
  card.append(agentHandoff, agentCopy);

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
    'wallet-form', 'bind-code', 'wallet-submit',
    'agent-block', 'agent-handoff', 'agent-skill-link', 'agent-skill-copy', 'token-fallback', 'login-form', 'token', 'login-error', 'shell', 'nav',
    'tenant', 'identity', 'logout', 'topbar', 'view', 'toast', 'dialog',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
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

test('智能体 skill 是一个 md 文件：浏览器打开就是正文，地址随当前服务生成', async () => {
  const harness = await startHarness();
  try {
    const response = await realFetch(`${harness.url}/auth/agent/skill.md`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.equal(response.headers.get('content-disposition'), null, '不能是附件，点开要在浏览器里显示');
    const skill = await response.text();
    assert.match(skill, /^---\nname: anpio-collab\n/, 'skill 要有 frontmatter');
    assert.ok(skill.includes(`Base URL: ${harness.url}`), 'skill 里的地址应指向当前服务');
    assert.ok(!skill.includes('{{BASE_URL}}'), '占位符应被替换掉');
    assert.ok(skill.includes('/auth/agent/request'), 'skill 要写清怎么申请接入');
    assert.ok(skill.includes('/auth/agent/token'), 'skill 要写清怎么换令牌');
    assert.ok(skill.includes('邀请码'), 'skill 要告诉智能体邀请码这条路');
    assert.ok(skill.includes('agents/approve'), 'skill 应告诉智能体去哪里批准');

    // 不带 .md 的旧地址仍然可用，内容相同。
    const legacy = await realFetch(`${harness.url}/auth/agent/skill`);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), skill);
  } finally {
    await harness.close();
  }
});

test('登录页只给一句话：话是念给智能体听的，链接随当前服务生成', async () => {
  const harness = await startHarness();
  const mounted = await mount({ url: harness.url });
  try {
    const url = `${harness.url}/auth/agent/skill.md`;
    const handoff = element(mounted.document, 'agent-handoff');
    await waitFor(
      () => text(handoff).includes(url),
      `登录页没给出 skill 链接：${text(handoff)}`,
    );
    assert.ok(text(handoff).startsWith('读取这个链接里的 SKILL.md'), `交付语不对：${text(handoff)}`);
    const link = element(mounted.document, 'agent-skill-link');
    assert.equal(text(link), url);
    assert.equal(link.getAttribute('href'), url);
    assert.ok(!text(element(mounted.document, 'login')).includes('/auth/agent/request'), '页面不该铺 skill 正文');
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
    assert.ok(!text(login).includes('读取钱包身份'), '登录页不应再展开钱包分步说明');
    assert.deepEqual(navLabels(mounted.document), [], '未登录不应有导航');

    await element(mounted.document, 'wallet-form').fire('submit');

    await waitFor(() => element(mounted.document, 'shell').hidden === false, `登录未完成：${text(element(mounted.document, 'login-error'))}`);

    // 服务端真的把这条 DID 绑到了主体上：用会话令牌回查一次。
    const token = await (globalThis as unknown as { sessionStorage: { getItem(k: string): string | null } }).sessionStorage.getItem('collab.token');
    assert.ok(token, '缺少会话令牌');
    const me = await (await realFetch(`${harness.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { did: string; kind: string; roles: string[] };
    assert.equal(me.did, identity.did);
    assert.equal(me.kind, 'human');
    assert.deepEqual(me.roles, ['owner'], '人类钱包首次登录应按 owner 自动登记');

    // 纯负责人没有监管与审计，导航必须如实反映权限。
    assert.deepEqual(navLabels(mounted.document), ['工作台', '任务', '提醒', '经验库', '我的智能体', '团队', '设置']);

    // 侧栏只留姓名与角色：主体 ID 与 DID 的细节在设置页，不在左下角堆五行。
    const who = text(element(mounted.document, 'identity'));
    assert.ok(who.includes('负责人'), `侧栏缺少角色：${who}`);
    assert.ok(!who.includes('did:wba'), `侧栏不该显示 DID：${who}`);
    assert.ok(!/p_[0-9a-f]{8}/.test(who), `侧栏不该显示主体 ID：${who}`);

    for (const label of ['工作台', '任务', '提醒', '经验库', '我的智能体', '团队', '设置']) {
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

test('新建任务对话框：默认执行归属是个人空间', async () => {
  const harness = await startHarness();
  const mounted = await mount({ url: harness.url, wallet: fakeWallet(harness.did.identity('owner-personal')) });
  try {
    await element(mounted.document, 'wallet-form').fire('submit');
    await waitFor(
      () => element(mounted.document, 'shell').hidden === false,
      `登录未完成：${text(element(mounted.document, 'login-error'))}`,
    );

    await visit(mounted.document, '任务');
    await buttonByText(mounted.document, '新建任务').fire('click');

    const dialog = element(mounted.document, 'dialog');
    const body = text(dialog);
    assert.ok(body.includes('执行归属'), `对话框缺少执行归属：${body.slice(0, 300)}`);
    assert.ok(body.includes('个人空间（只属于你）'), '执行归属缺少个人空间选项');
    const personal = dialog.querySelector('#field-ownership option[value="personal"]');
    assert.ok(personal, '默认归属不是个人空间');
    assert.equal(personal.selected, true, '默认应选中个人空间');
    assert.ok(body.includes('材料（可选'), `对话框缺少材料上传：${body.slice(0, 400)}`);
    assert.ok(dialog.querySelector('input[type="file"]'), '材料字段不是文件选择框');
    assert.equal(
      dialog.querySelector('#field-type')?.value,
      'general',
      '任务类型默认值应改成通用标识',
    );
    assert.ok(!body.includes('物料编号'), '任务创建不应再固定成缺料分析字段');
  } finally {
    await sleep(80);
    mounted.dispose();
    await harness.close();
  }
});

test('新建任务对话框：只列自己拥有或管理的团队，成员团队不出现', async () => {
  const harness = await startHarness();
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const bob = await emailLogin(harness, 'bob@example.com');
    const created = await fetch(`${harness.url}/v1/tenants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'create-member-team',
        authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({ name: '只让 alice 当成员' }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const team = (await created.json()) as { tenant: { id: string } };

    // alice 在这个团队里只是普通成员：可以进去做事，但不能以团队名义建任务。
    const me = await (await fetch(`${harness.url}/v1/me`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })).json() as { accountId: string };
    const principalId = `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await harness.db.run(
      `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                              avatar, title, bio, description, capabilities, active, created_at, account_id, tenant_role)
       VALUES(:id, :workspace, '["member"]', :hash, NULL, 'human', NULL, 'alice',
              '', '', '', '', '[]', 1, :at, :account, 'member')`,
      {
        id: principalId,
        workspace: team.tenant.id,
        hash: 'unused',
        at: new Date().toISOString(),
        account: me.accountId,
      },
    );

    const mounted = await mount({ url: harness.url });
    try {
      element(mounted.document, 'token').value = alice.token;
      await element(mounted.document, 'login-form').fire('submit');
      await waitFor(() => element(mounted.document, 'shell').hidden === false, '令牌登录未完成');
      await visit(mounted.document, '任务');
      await buttonByText(mounted.document, '新建任务').fire('click');

      const dialog = element(mounted.document, 'dialog');
      const values = Array.from(dialog.querySelectorAll('#field-ownership option')).map((node) => node.value);
      assert.deepEqual(values, ['personal'], '成员团队不应出现在执行归属里');
      assert.ok(!text(dialog).includes('只让 alice 当成员'));
    } finally {
      await sleep(80);
      mounted.dispose();
    }
  } finally {
    await harness.close();
  }
});

test('智能体用访问令牌登录：只看到自己的事，没有全局看板', async () => {
  const harness = await startHarness();
  const { agentToken, taskId } = await seed(harness);
  const mounted = await mount({ url: harness.url });
  try {
    // 没有插件时按钮照样可点，错误落在登录错误区里，不再常驻一整段说明。
    await element(mounted.document, 'wallet-form').fire('submit');
    await waitFor(
      () => text(element(mounted.document, 'login-error')).includes('没有检测到'),
      `无插件时应给出提示：${text(element(mounted.document, 'login-error'))}`,
    );
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
