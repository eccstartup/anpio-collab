/**
 * Anpio Collab 管理台。
 *
 * 无构建、无框架：一个文件完成登录、路由、渲染和动作。
 * 约定：
 *  - 所有网络请求经过 api()，写请求自动带 Idempotency-Key；
 *  - 只有带版本的资源才带 If-Match，其余写操作不带（服务端会拒绝）；
 *  - 渲染只用 DOM 节点拼接，不用 innerHTML 插入服务端内容；
 *  - 每个动作失败时把服务端的中文错误原样显示，不做二次包装；
 *  - 视图按角色生成：智能体只看自己的事，负责人看任务，监管者看异常。
 */

const API_ROOT = '/v1';
const AUTH_ROOT = '/auth';

const STATUS_LABEL = {
  pending: '待分派',
  running: '执行中',
  review: '待验收',
  completed: '已完成',
  cancelled: '已取消',
  invited: '待接受',
  accepted: '进行中',
  submitted: '已提交',
  verified: '已核验',
  returned: '已退回',
  rejected: '已拒绝',
  timed_out: '已超时',
  outcome_unknown: '结果未知',
  candidate: '待审核',
  published: '已发布',
  revoked: '已撤销',
  open: '开放中',
  claimed: '已认领',
  withdrawn: '已撤回',
};

const STATUS_TONE = {
  pending: 'muted',
  running: 'active',
  review: 'warn',
  completed: 'ok',
  cancelled: 'muted',
  invited: 'active',
  accepted: 'active',
  submitted: 'warn',
  verified: 'ok',
  returned: 'warn',
  rejected: 'danger',
  timed_out: 'danger',
  outcome_unknown: 'danger',
  candidate: 'warn',
  published: 'ok',
  revoked: 'muted',
  open: 'active',
  claimed: 'ok',
  withdrawn: 'muted',
};

const ROLE_LABEL = {
  admin: '管理员',
  owner: '负责人',
  agent: '智能体',
  reviewer: '审核人',
  supervisor: '监管者',
};

const KIND_LABEL = { human: '人', agent: '智能体', service: '服务账号' };

/** 租户角色只管"能不能管这个组织"，与业务角色分开显示，避免混淆。 */
const TENANT_ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员', guest: '访客' };
const TENANT_ROLE_OPTIONS = [
  { value: 'member', label: '成员 · 建任务、验收自己的任务' },
  { value: 'admin', label: '管理员 · 可加人、改角色、管授权' },
  { value: 'guest', label: '访客 · 只读' },
  { value: 'owner', label: '所有者 · 转让所有权（唯一）' },
];

const SCOPE_LABEL = {
  'tasks:read': '读任务',
  'tasks:submit': '提交结果',
  'offers:claim': '认领开放子任务',
  'knowledge:read': '读经验库',
  'comments:write': '写评论',
  'presence:write': '上报在线状态',
};

const SCOPE_OPTIONS = Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label }));

const SEVERITY_LABEL = { critical: '严重', high: '高', normal: '一般', low: '低' };
const SEVERITY_TONE = { critical: 'critical', high: 'danger', normal: 'warn', low: 'muted' };
const SEVERITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

const ALERT_STATUS_LABEL = { open: '未处理', acknowledged: '已确认', resolved: '已解决' };
const ALERT_STATUS_TONE = { open: 'danger', acknowledged: 'warn', resolved: 'ok' };

/** 规则名是给人看的，不是给日志看的。 */
const RULE_LABEL = {
  subtask_overdue: '子任务逾期',
  subtask_stalled: '子任务停滞',
  subtask_unverified: '结果待核验',
  task_stalled: '任务停滞',
  review_backlog: '验收积压',
  agent_offline: '智能体失联',
  agent_task_unadopted: '提案无人接管',
  denied_spike: '拒绝激增',
  knowledge_expiring: '经验即将失效',
};

const PRESENCE_LABEL = { online: '在线', busy: '忙碌', offline: '离线' };
const PRESENCE_TONE = { online: 'ok', busy: 'warn', offline: 'muted' };

const NAV = [
  { id: 'home', label: '工作台', show: () => true },
  { id: 'tasks', label: '任务', show: () => true },
  { id: 'pool', label: '开放池', show: () => hasRole('agent') },
  { id: 'mentions', label: '提醒', show: () => true },
  // 经验库只对同组智能体与团队管理员开放，不是每个人的资料库。
  { id: 'knowledge', label: '经验库', show: () => isAgentSide() || canManageTenant() },
  { id: 'agents', label: '我的智能体', show: () => !isAgentOnly() },
  { id: 'directory', label: '团队', show: () => !isAgentOnly() },
  { id: 'oversight', label: '监管', show: () => canSupervise() },
  { id: 'audit', label: '审计', show: () => hasRole('admin') },
  { id: 'settings', label: '设置', show: () => true },
];

const TITLES = {
  home: ['工作台', '概览与需要你判断的事'],
  tasks: ['任务', '目标、分工、验收与证据'],
  pool: ['开放池', '能力匹配就可以认领，认领即加入'],
  mentions: ['提醒', '有人在评论里提到了你'],
  knowledge: ['经验库', '同组智能体共享的经验'],
  agents: ['我的智能体', '你请进来的智能体，和它们正在做的事'],
  directory: ['团队', '你和谁一起工作'],
  oversight: ['监管', '哪里不对：卡住、失联、积压与被反复拒绝'],
  audit: ['审计', '谁在何时做了什么，结果如何'],
  settings: ['设置', '身份、智能体与会话'],
};

const state = {
  token: '',
  method: '',
  me: null,
  view: 'home',
  tab: 'published',
  tasks: [],
  activity: [],
  taskId: null,
  detail: null,
  taskComments: [],
  taskOffers: [],
  knowledge: [],
  candidates: [],
  pending: [],
  audit: [],
  query: '',
  inbox: [],
  mentions: [],
  offers: [],
  oversight: null,
  presence: [],
  identities: [],
  links: [],
  sessions: [],
  heartbeatAt: '',
  tenants: [],
  tenant: null,
  members: [],
  invites: [],
  grants: [],
  pendingAgents: [],
  pendingCode: '',
  tenantDetail: null,
};

// ---------------------------------------------------------------- 基础工具

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const frag = (...children) => {
  const box = document.createDocumentFragment();
  for (const child of children.flat(Infinity)) if (child) box.append(child);
  return box;
};

const toneBadge = (tone, label) =>
  el('span', { class: 'badge', dataset: { tone: tone ?? 'muted' } }, label);

const badge = (value) => toneBadge(STATUS_TONE[value] ?? 'muted', STATUS_LABEL[value] ?? value);

/** 类别与执行者常常同名，重复显示只会制造噪音。 */
const combo = (agent, kind) => (!agent ? kind : !kind || kind === agent ? agent : `${kind}（${agent}）`);

const formatTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
};

const formatDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('zh-CN');
};

/** 过了多久：监管看板上"3 小时前"比绝对时间有用。 */
function agoText(seconds) {
  if (seconds === null || seconds === undefined) return '从未上报';
  if (seconds < 90) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

const roleText = (roles) => (roles ?? []).map((role) => ROLE_LABEL[role] ?? role).join(' / ') || '—';

function hasRole(...roles) {
  return Boolean(state.me && roles.some((role) => state.me.roles.includes(role)));
}

const isAdmin = () => hasRole('admin');
/** 组织管理权与业务权限分开：租户角色决定能不能管成员。 */
const canManageTenant = () =>
  Boolean(state.me && (state.me.tenantRole === 'owner' || state.me.tenantRole === 'admin'));
const canSupervise = () => hasRole('supervisor', 'admin');
/** 纯智能体账号：没有人的职责，所以不给它全局看板。 */
const isAgentOnly = () => Boolean(state.me && state.me.kind === 'agent' && !hasRole('owner', 'admin', 'supervisor', 'reviewer'));
const isAgentSide = () => Boolean(state.me && (state.me.kind === 'agent' || state.me.kind === 'service'));

function toast(message, tone = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

// ---------------------------------------------------------------- 网络

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`服务返回了无法解析的响应（HTTP ${response.status}）`);
  }
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}` };
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = options.operationId ?? crypto.randomUUID();
  }
  if (options.expectedVersion !== undefined) headers['if-match'] = `"${options.expectedVersion}"`;

  const response = await fetch(`${API_ROOT}/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    if (response.status === 401) signOut('登录状态已失效，请重新连接');
    throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

/** 执行一个动作并刷新当前视图；失败时展示服务端消息。 */
async function act(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage);
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- 对话框

function openDialog({ title, description, fields = [], submitLabel = '确认', onSubmit }) {
  const dialog = document.getElementById('dialog');
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', {}, title));
  if (description) form.append(el('p', { class: 'muted' }, description));

  const inputs = new Map();
  for (const field of fields) {
    if (field.type === 'checkbox-group') {
      const group = el('div', { class: 'stack' });
      group.append(el('span', { class: 'muted' }, field.label));
      const boxes = field.options.map((option) => {
        const input = el('input', {
          type: 'checkbox',
          value: option.value,
          checked: (field.value ?? []).includes(option.value),
        });
        inputs.set(`${field.name}:${option.value}`, input);
        return el('label', { class: 'checkbox' }, input, el('span', {}, option.label));
      });
      group.append(...boxes);
      form.append(group);
      continue;
    }

    const id = `field-${field.name}`;
    let input;
    if (field.type === 'textarea') {
      input = el('textarea', { id, placeholder: field.placeholder ?? '' });
      input.value = field.value ?? '';
    } else if (field.type === 'select') {
      input = el('select', { id });
      for (const option of field.options) {
        const node = el('option', { value: option.value }, option.label);
        if (option.value === field.value) node.selected = true;
        input.append(node);
      }
    } else {
      input = el('input', {
        id,
        type: field.type ?? 'text',
        placeholder: field.placeholder ?? '',
        value: field.value ?? '',
      });
    }
    if (field.required) input.required = true;
    inputs.set(field.name, input);
    form.append(el('label', { class: 'field', for: id }, el('span', {}, field.label), input));
  }

  const actions = el('div', { class: 'dialog-actions' });
  actions.append(el('button', { type: 'button', class: 'ghost', onclick: () => dialog.close() }, '取消'));
  actions.append(el('button', { type: 'submit', class: 'primary' }, submitLabel));
  form.append(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const field of fields) {
      if (field.type === 'checkbox-group') {
        values[field.name] = field.options
          .map((option) => option.value)
          .filter((value) => inputs.get(`${field.name}:${value}`)?.checked);
      } else {
        values[field.name] = inputs.get(field.name).value;
      }
    }
    dialog.close();
    await onSubmit(values);
  });

  dialog.replaceChildren(form);
  dialog.showModal();
}

/** 只用来展示一次性内容（绑定码、版本历史），不提交任何东西。 */
function showPanel(title, description, body) {
  const dialog = document.getElementById('dialog');
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', {}, title));
  if (description) form.append(el('p', { class: 'muted' }, description));
  form.append(body);
  const actions = el('div', { class: 'dialog-actions' });
  actions.append(el('button', { type: 'button', class: 'ghost', onclick: () => dialog.close() }, '关闭'));
  form.append(actions);
  dialog.replaceChildren(form);
  dialog.showModal();
}

// ---------------------------------------------------------------- 钱包登录

const wallet = {
  available: () => Boolean(window.anp && window.anp.isAnpWallet),

  /**
   * 走完一次 ANP-02 登录：取身份 → 领 nonce → 签名 → 换令牌。
   * 私钥不出插件，页面只拿到 RFC 9421 签名头。
   */
  async login(bindCode) {
    if (!wallet.available()) {
      throw new Error('没有检测到 ANP 钱包插件。请安装并解锁 ANP Wallet 后刷新本页。');
    }

    const identity = await window.anp.getIdentity();
    if (!identity || !identity.did) throw new Error('钱包里没有可用身份，请先在插件中创建或导入钱包');

    const challenge = await readPayload(await fetch(`${AUTH_ROOT}/anp/challenge`, { headers: { accept: 'application/json' } }));
    if (!challenge?.nonce) throw new Error('服务端没有下发挑战，可能是版本不匹配');

    const body = JSON.stringify({
      nonce: challenge.nonce,
      did: identity.did,
      didDocument: identity.didDocument,
      client: 'browser',
      ...(bindCode ? { bindCode } : {}),
    });
    // 签名目标必须与实际请求地址逐字一致，否则 @target-uri 分量对不上。
    const target = `${location.origin}${AUTH_ROOT}/anp/login`;
    let signed;
    try {
      signed = await window.anp.signAnpLogin({ url: target, method: 'POST', body, nonce: challenge.nonce });
    } catch (error) {
      throw new Error(`钱包签名未完成：${error.message}`);
    }

    const response = await fetch(target, {
      method: 'POST',
      // 插件返回的头大小写不固定，原样透传；body 必须用签名覆盖的那份字节。
      headers: { 'content-type': 'application/json', ...(signed.headers ?? {}) },
      body: signed.body ?? body,
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      const code = payload?.error?.code;
      if (code === 'enrollment_pending') {
        throw new Error(`这条 DID 已登记为「${payload.principalId}」，但还没被批准。请让管理员在「团队」里批准后再登录。`);
      }
      if (code === 'challenge_required') {
        throw new Error('挑战已过期或被用过，请重新点一次登录（每次登录都要新的 nonce）');
      }
      throw new Error(payload?.error?.message ?? `登录失败（HTTP ${response.status}）`);
    }
    if (!payload?.token) throw new Error('服务端没有返回访问令牌');
    return payload;
  },
};

// ---------------------------------------------------------------- 会话

async function signInWithToken(token, method = 'token') {
  state.token = token;
  state.me = await api('me');
  state.method = method;
  sessionStorage.setItem('collab.token', token);
  sessionStorage.setItem('collab.method', method);
  await loadTenants();
  enterApp();
}

/** 邮箱链接与钱包登录最终都走这里：拿到的是同一种令牌。 */
async function signInWithSession(payload, method) {
  await signInWithToken(payload.token, method);
  toast(`已进入「${state.tenant?.name ?? '组织'}」`, 'info');
}

async function loadTenants() {
  state.tenants = await api('me/tenants').catch(() => []);
  state.tenant = state.tenants.find((item) => item.id === state.me.workspace) ?? null;
}

async function signInWithWallet(bindCode) {
  const result = await wallet.login(bindCode);
  await signInWithSession(result, 'wallet');
  toast(`已用 ${result.did.split(':').slice(-1)[0]} 登录`, 'info');
}

// ---------------------------------------------------------------- 邮箱登录

async function requestEmailLink(email, invite) {
  const response = await fetch(`${AUTH_ROOT}/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, ...(invite ? { invite } : {}) }),
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new Error(payload?.error?.message ?? `发送失败（HTTP ${response.status}）`);
  return payload;
}

async function verifyEmailTicket(ticket) {
  const response = await fetch(`${AUTH_ROOT}/email/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const payload = await readPayload(response);
  // 补绑邮箱的票据只确认地址，不换发会话。
  if (payload?.bound) return { bound: payload };
  if (response.status === 409 && payload?.selectionToken) return { selection: payload };
  if (!response.ok) throw new Error(payload?.error?.message ?? `登录失败（HTTP ${response.status}）`);
  return { session: payload };
}

/** 一个邮箱属于多个组织时，让人选一个再进。 */
function chooseTenant(payload) {
  openDialog({
    title: '选择要进入的组织',
    description: '这个邮箱同时在几个组织里，本次会话只属于其中一个，之后可以在侧栏切换。',
    fields: [
      {
        name: 'tenantId',
        label: '组织',
        type: 'select',
        value: payload.tenants[0]?.id,
        options: payload.tenants.map((tenant) => ({
          value: tenant.id,
          label: `${tenant.name}（${TENANT_ROLE_LABEL[tenant.role] ?? tenant.role}）`,
        })),
      },
    ],
    submitLabel: '进入',
    onSubmit: async (values) => {
      const response = await fetch(`${AUTH_ROOT}/email/choose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectionToken: payload.selectionToken, tenantId: values.tenantId }),
      });
      const result = await readPayload(response);
      if (!response.ok) throw new Error(result?.error?.message ?? `进入失败（HTTP ${response.status}）`);
      await signInWithSession(result, 'email');
    },
  });
}

function enterApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('shell').hidden = false;
  state.view = state.pendingCode ? 'agents' : defaultView();
  renderIdentity();
  renderNav();
  refresh();
}

function defaultView() {
  return 'home';
}

async function signOut(message) {
  const token = state.token;
  state.token = '';
  state.me = null;
  state.method = '';
  state.tenants = [];
  state.tenant = null;
  sessionStorage.removeItem('collab.token');
  sessionStorage.removeItem('collab.method');
  document.getElementById('shell').hidden = true;
  document.getElementById('login').hidden = false;
  document.getElementById('login-error').textContent = message ?? '';
  // 会话可能已在服务端失效，撤销失败不需要打扰人。
  if (token) {
    await fetch(`${API_ROOT}/me/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    }).catch(() => {});
  }
}

/** DID 太长，前缀对辨认没用：留 did:wba 与结尾的指纹段。 */
const shortDid = (did) => (did ? `did:wba:…${String(did).slice(-14)}` : '');

function renderIdentity() {
  const box = document.getElementById('identity');
  const did = shortDid(state.me.did) || '未绑定 DID';
  box.replaceChildren(
    el('strong', {}, state.me.displayName || state.me.id),
    el('span', {}, `${state.me.id} · ${KIND_LABEL[state.me.kind] ?? state.me.kind ?? '主体'}`),
    el('span', {}, roleText(state.me.roles)),
    el('span', { class: 'mono', title: state.me.did ?? '' }, did),
  );
  renderTenantSwitch();
}

function renderTenantSwitch() {
  const box = document.getElementById('tenant');
  if (!box) return;
  const name = state.tenant?.name ?? state.me.workspace;
  const role = TENANT_ROLE_LABEL[state.tenant?.role ?? state.me.tenantRole] ?? '成员';
  if (state.tenants.length <= 1) {
    box.replaceChildren(
      el('span', { class: 'tenant-name', title: name }, name),
      el('span', { class: 'tenant-role' }, role),
    );
    return;
  }
  const select = el('select', { class: 'tenant-select', 'aria-label': '切换组织' });
  for (const tenant of state.tenants) {
    const option = el('option', { value: tenant.id }, tenant.name);
    if (tenant.id === state.me.workspace) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', async () => {
    const response = await act(async () => {
      const result = await api('me/switch', { body: { tenantId: select.value } });
      state.token = result.token;
      sessionStorage.setItem('collab.token', result.token);
      state.me = await api('me');
      await loadTenants();
      renderIdentity();
      renderNav();
    }, '已切换组织');
    void response;
  });
  box.replaceChildren(el('span', { class: 'tenant-label' }, '组织'), select);
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...NAV.filter((view) => view.show()).map((view) =>
      el(
        'button',
        {
          type: 'button',
          'aria-current': state.view === view.id ? 'true' : 'false',
          onclick: () => {
            state.view = view.id;
            state.taskId = null;
            renderNav();
            refresh();
          },
        },
        view.label,
      ),
    ),
  );
}

// ---------------------------------------------------------------- 数据加载

async function refresh() {
  try {
    if (state.view === 'home') {
      state.tasks = await api('tasks');
      if (isAgentSide()) {
        state.inbox = await api('inbox').catch(() => []);
        state.mentions = await api('me/mentions').catch(() => []);
        state.offers = await api('offers').catch(() => []);
      } else {
        state.activity = await api('activity?limit=12').catch(() => []);
      }
    }
    if (state.view === 'tasks') {
      state.tasks = await api('tasks');
      if (state.taskId) {
        const id = encodeURIComponent(state.taskId);
        state.detail = await api(`tasks/${id}`);
        state.taskComments = await api(`tasks/${id}/comments`).catch(() => []);
        state.taskOffers = await api(`tasks/${id}/offers`).catch(() => []);
      }
    }
    if (state.view === 'pool') state.offers = await api('offers');
    if (state.view === 'mentions') state.mentions = await api('me/mentions');
    if (state.view === 'knowledge') {
      state.knowledge = await api(`knowledge${state.query ? `?q=${encodeURIComponent(state.query)}` : ''}`);
      if (hasRole('reviewer', 'admin')) state.candidates = await api('knowledge/candidates');
    }
    if (state.view === 'directory') {
      state.tenantDetail = await api('tenants/current').catch(() => null);
      state.members = canManageTenant()
        ? await api('tenants/current/members').catch(() => [])
        : [];
      state.invites = canManageTenant()
        ? await api('tenants/current/invites').catch(() => [])
        : [];
      state.pending = canSupervise()
        ? await api('principals/pending').catch(() => [])
        : [];
    }
    if (state.view === 'oversight') {
      state.oversight = await api('oversight');
      state.presence = await api('agent/presence').catch(() => []);
    }
    if (state.view === 'audit') state.audit = await api('audit');
    if (state.view === 'agents') {
      state.grants = await api('agents');
      state.pendingAgents = canManageTenant() ? await api('agents/pending').catch(() => []) : [];
    }
    if (state.view === 'settings') {
      state.identities = await api('me/identities').catch(() => []);
      state.links = await api('me/links')
        .then((data) => data?.links ?? [])
        .catch(() => []);
      state.sessions = await api('me/sessions').catch(() => []);
      state.grants = await api('agents').catch(() => []);
    }
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- 渲染入口

function render() {
  // 401 会先 signOut 再抛出；这时仍在路上的刷新已经无关紧要，别往登录页里渲染。
  if (!state.me) return;
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const [title, subtitle] = TITLES[state.view] ?? ['工作台', ''];
  topbar.replaceChildren(el('h2', {}, title), el('span', { class: 'sub' }, subtitle));

  let content;
  if (state.view === 'home') content = isAgentSide() ? renderWorkbench() : renderHome();
  else if (state.view === 'tasks') content = state.taskId ? renderTaskDetail() : renderTaskList();
  else if (state.view === 'pool') content = renderPool();
  else if (state.view === 'mentions') content = renderMentions();
  else if (state.view === 'knowledge') content = renderKnowledge();
  else if (state.view === 'directory') content = renderDirectory();
  else if (state.view === 'agents') content = renderAgents();
  else if (state.view === 'oversight') content = renderOversight();
  else if (state.view === 'settings') content = renderSettings();
  else content = renderAudit();

  view.replaceChildren(el('div', { class: 'content' }, content));
}

function openTaskById(taskId) {
  state.view = 'tasks';
  state.taskId = taskId;
  renderNav();
  refresh();
}

function statCard(label, value, hint) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value),
    hint ? el('div', { class: 'muted small' }, hint) : null,
  );
}

// ---------------------------------------------------------------- 人的工作台

function renderHome() {
  const mine = state.tasks.filter((task) => task.ownerId === state.me.id);
  const toReview = mine.filter((task) => task.status === 'review');
  const running = state.tasks.filter((task) => task.status === 'running');
  const proposals = state.tasks.filter((task) => task.origin === 'agent' && !task.adopted);
  const attention = [...toReview, ...proposals, ...running.filter((task) => !toReview.includes(task))].slice(0, 6);

  const stats = el(
    'div',
    { class: 'grid' },
    statCard('执行中任务', running.length),
    statCard('待我验收', toReview.length),
    statCard('提案待接管', proposals.length, proposals.length ? '智能体发起的任务，接管后才进入正式流程' : ''),
    statCard('已完成', state.tasks.filter((task) => task.status === 'completed').length),
  );

  const attentionList = attention.length
    ? el('div', { class: 'list' }, attention.map(taskRow))
    : el('div', { class: 'empty' }, '暂时没有需要处理的任务。');

  // 有数据之后不再占着首屏讲道理，把位置留给待处理的事。
  const intro = state.tasks.length
    ? null
    : el('div', { class: 'card' },
      el('h3', {}, '从这里开始'),
      el('p', { class: 'muted', style: 'margin-top:8px' },
        '创建任务并写明验收条件，把工作挂到开放池或直接分派；智能体用 DID 登录后认领、执行、提交，结果由人验收。只有验收通过的任务，结论才能沉淀为经验。'),
      el('div', { class: 'row', style: 'margin-top:14px' },
        hasRole('owner', 'admin')
          ? el('button', { class: 'primary', type: 'button', onclick: () => { state.view = 'tasks'; renderNav(); refresh(); } }, '去创建第一个任务')
          : null,
        hasRole('reviewer', 'admin')
          ? el('button', { type: 'button', onclick: () => { state.view = 'knowledge'; state.tab = 'candidates'; renderNav(); refresh(); } }, '查看待审核经验')
          : null));

  const feedRow = (entry) =>
    el('button', { type: 'button', class: 'feed-row', onclick: () => openTaskById(entry.taskId) },
      el('div', { class: 'feed-main' },
        el('span', { class: 'feed-task' }, entry.taskTitle),
        el('span', { class: 'muted' }, ` · ${EVENT_TEXT[entry.type] ?? entry.type}`)),
      el('div', { class: 'when' }, `${entry.actorId} · ${formatTime(entry.recordedAt)}`));

  const feed = state.activity.length
    ? frag(
      el('div', { class: 'section-title' }, '最近活动'),
      el('div', { class: 'card feed' }, state.activity.map(feedRow)),
    )
    : null;

  return frag(
    intro,
    el('div', { class: 'section-title' }, '概览'),
    stats,
    proposals.length
      ? frag(
        el('div', { class: 'section-title' }, '智能体提案待接管'),
        el('div', { class: 'list' }, proposals.slice(0, 4).map((task) =>
          el('div', { class: 'list-item static' },
            el('div', { class: 'row spread top' },
              el('div', {},
                el('div', { class: 'title' }, task.title),
                el('div', { class: 'meta' },
                  el('span', {}, `由 ${task.ownerName || task.ownerId} 发起`),
                  el('span', {}, `截止 ${formatDate(task.dueAt)}`))),
              el('button', {
                class: 'accent',
                type: 'button',
                onclick: () => act(() => api(`tasks/${task.id}/adopt`, { body: {} }), '已接管，任务进入正式流程'),
              }, '接管'))))),
      )
      : null,
    el('div', { class: 'section-title' }, '需要你判断'),
    attentionList,
    feed,
  );
}

// ---------------------------------------------------------------- 智能体工作台

function renderWorkbench() {
  const overdue = state.inbox.filter((item) => item.dueAt && item.dueAt < new Date().toISOString());

  const stats = el(
    'div',
    { class: 'grid' },
    statCard('待办子任务', state.inbox.length, overdue.length ? `其中 ${overdue.length} 个已过截止` : ''),
    statCard('我的任务', state.tasks.length),
    statCard('开放池', state.offers.length, '能力匹配即可认领'),
    statCard('待读提醒', state.mentions.length),
  );

  const heartbeat = el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '心跳'),
      el('span', { class: 'muted' }, state.heartbeatAt ? `上次 ${formatTime(state.heartbeatAt)}` : '还没上报')),
    el('p', { class: 'muted', style: 'margin-top:6px' },
      '心跳只说明你还在，不说明你做对了。超过 15 分钟没上报，监管看板会把你标成离线。'),
    el('div', { class: 'row', style: 'margin-top:12px' },
      heartbeatButton('online', '报在线'),
      heartbeatButton('busy', '报忙碌'),
      heartbeatButton('offline', '报离线')),
  );

  const inboxRows = state.inbox.length
    ? el('div', { class: 'list' }, state.inbox.map(inboxRow))
    : el('div', { class: 'empty' }, '没有待办。可以在「开放池」里找能力匹配的事。');

  const mentionRows = state.mentions.length
    ? el('div', { class: 'list' }, state.mentions.slice(0, 4).map(mentionRow))
    : el('div', { class: 'empty' }, '没有未读提醒。');

  const poolPreview = state.offers.length
    ? el('div', { class: 'list' }, state.offers.slice(0, 3).map(offerRow))
    : el('div', { class: 'empty' }, '开放池里暂时没有与你能力匹配的事。');

  return frag(
    el('div', { class: 'section-title' }, '概览'),
    stats,
    el('div', { class: 'section-title' }, '我的待办'),
    inboxRows,
    el('div', { class: 'section-title' }, '在线状态'),
    heartbeat,
    el('div', { class: 'section-title' }, '提醒'),
    mentionRows,
    el('div', { class: 'section-title' }, '开放池'),
    poolPreview,
  );
}

function heartbeatButton(value, label) {
  return el('button', {
    type: 'button',
    onclick: () =>
      act(async () => {
        const presence = await api('agent/heartbeat', { body: { state: value, client: 'web', note: `${state.me.id}@web` } });
        state.heartbeatAt = presence.lastSeenAt;
      }, `已上报：${PRESENCE_LABEL[value]}`),
  }, label);
}

function inboxRow(item) {
  return el(
    'div',
    { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', {},
        el('div', { class: 'title' }, item.task.title),
        el('div', { class: 'meta' },
          el('span', {}, item.kind),
          badge(item.status),
          el('span', {}, `截止 ${formatTime(item.dueAt)}`))),
      el('div', { class: 'row' },
        el('button', { class: 'link', type: 'button', onclick: () => openTaskById(item.taskId) }, '打开任务'),
        item.status === 'invited' || item.status === 'returned'
          ? el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => act(() => api(`subtasks/${item.id}/accept`, { body: {}, expectedVersion: item.version }), '已接受'),
          }, '接受')
          : null,
        item.status === 'accepted'
          ? el('button', {
            class: 'accent',
            type: 'button',
            onclick: () => openSubmit(item),
          }, '提交结果')
          : null)),
  );
}

function mentionRow(item) {
  return el(
    'div',
    { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', {},
        el('div', { class: 'statement' }, item.body),
        el('div', { class: 'meta' },
          el('span', {}, `${item.authorName || item.authorId}`),
          el('span', {}, item.taskTitle ?? ''),
          el('span', {}, formatTime(item.createdAt)))),
      el('div', { class: 'row' },
        item.taskTitle ? el('button', { class: 'link', type: 'button', onclick: () => openTaskById(item.taskId) }, '去任务') : null,
        el('button', {
          class: 'link',
          type: 'button',
          onclick: () => act(() => api(`me/mentions/${item.mentionId}/read`, { body: {} }), '已标记已读'),
        }, '已读'))),
  );
}

function offerRow(offer, options = {}) {
  return el(
    'div',
    { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', {},
        el('div', { class: 'title' }, offer.taskTitle || `任务 ${offer.taskId.slice(0, 8)}`),
        el('div', { class: 'meta' },
          el('span', {}, offer.kind),
          offer.capability ? el('span', { class: 'mono' }, `能力 ${offer.capability}`) : el('span', {}, '不限能力'),
          el('span', {}, `截止 ${formatTime(offer.dueAt)}`),
          badge(offer.status))),
      el('div', { class: 'row' },
        offer.description ? el('span', { class: 'muted small' }, offer.description) : null,
        options.claimable
          ? el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => act(() => api(`offers/${offer.id}/claim`, { body: {} }), '已认领，子任务已建立'),
          }, '认领')
          : null,
        options.withdrawable && offer.status === 'open'
          ? el('button', {
            class: 'link',
            type: 'button',
            onclick: () => act(() => api(`offers/${offer.id}/withdraw`, { body: {} }), '已撤回'),
          }, '撤回')
          : null)),
  );
}

// ---------------------------------------------------------------- 任务列表

function taskRow(task) {
  return el(
    'button',
    {
      type: 'button',
      class: 'list-item',
      onclick: () => {
        state.taskId = task.id;
        refresh();
      },
    },
    el(
      'div',
      { class: 'row spread' },
      el('span', { class: 'row', style: 'gap:8px' },
        task.priority === 'high' ? el('span', { class: 'dot', title: '高优先级' }) : null,
        el('span', { class: 'title' }, task.title),
        task.origin === 'agent' && !task.adopted ? toneBadge('warn', '提案待接管') : null),
      badge(task.status),
    ),
    el(
      'div',
      { class: 'meta' },
      el('span', {}, `负责人 ${task.ownerName}`),
      el('span', {}, `截止 ${formatDate(task.dueAt)}`),
      el('span', {}, `子任务 ${task.subtaskDone}/${task.subtaskCount}`),
      el('span', { class: 'mono muted', title: `任务编号 ${task.id}` }, task.id.slice(0, 8)),
    ),
  );
}

function renderTaskList() {
  const filtered = state.tasks.filter((task) => {
    if (!state.query) return true;
    const needle = state.query.toLowerCase();
    return task.title.toLowerCase().includes(needle) || task.type.toLowerCase().includes(needle);
  });

  const search = el('input', {
    type: 'search',
    placeholder: '按标题或类型搜索',
    value: state.query,
    oninput: (event) => {
      state.query = event.target.value;
      render();
    },
  });

  const toolbar = el(
    'div',
    { class: 'row spread', style: 'margin-bottom:16px' },
    el('div', { class: 'search', style: 'margin:0' }, search),
    hasRole('owner', 'admin') || hasRole('agent')
      ? el('button', { class: 'accent', type: 'button', onclick: openCreateTask },
        hasRole('owner', 'admin') ? '新建任务' : '发起提案')
      : null,
  );

  const list = filtered.length
    ? el('div', { class: 'list' }, filtered.map(taskRow))
    : el('div', { class: 'empty' }, '没有符合条件的任务。');

  return frag(toolbar, list);
}

function openCreateTask() {
  const due = new Date(Date.now() + 7 * 86_400_000);
  openDialog({
    title: hasRole('owner', 'admin') ? '新建任务' : '发起任务提案',
    description: hasRole('owner', 'admin')
      ? '验收条件必须可核对；它决定任务能否被接受。'
      : '智能体发起的任务先记为提案，负责人接管后才进入正式流程。',
    submitLabel: '创建',
    fields: [
      { name: 'title', label: '标题', required: true, placeholder: '例如 M-100 缺料分析' },
      { name: 'type', label: '任务类型', value: 'shortage-analysis', placeholder: '通用字符串标识' },
      { name: 'goal', label: '目标', type: 'textarea', placeholder: '要判断或达成什么' },
      { name: 'acceptance', label: '验收条件', type: 'textarea', required: true, placeholder: '例如：数据需带来源与观测时间' },
      { name: 'dueAt', label: '截止时间', type: 'datetime-local', value: toLocalInput(due), required: true },
      {
        name: 'priority',
        label: '优先级',
        type: 'select',
        value: 'normal',
        options: [
          { value: 'low', label: '低' },
          { value: 'normal', label: '普通' },
          { value: 'high', label: '高' },
          { value: 'urgent', label: '紧急' },
        ],
      },
      { name: 'material', label: '输入：物料编号', placeholder: 'M-100' },
      { name: 'quantity', label: '输入：数量', type: 'number', placeholder: '100' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const input = {};
        if (values.material) input.material = values.material;
        if (values.quantity) input.quantity = Number(values.quantity);
        await api('tasks', {
          body: {
            title: values.title,
            type: values.type || 'general',
            goal: values.goal || values.title,
            acceptance: values.acceptance,
            priority: values.priority,
            dueAt: new Date(values.dueAt).toISOString(),
            input,
          },
        });
      }, '任务已创建'),
  });
}

function toLocalInput(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------- 任务详情

function renderTaskDetail() {
  const detail = state.detail;
  if (!detail) return el('div', { class: 'empty' }, '加载中…');
  const task = detail.task;
  const owner = task.ownerId === state.me.id;

  const back = el(
    'button',
    { class: 'link back', type: 'button', onclick: () => { state.taskId = null; refresh(); } },
    '← 返回任务列表',
  );

  const hasGoal = task.goal && task.goal !== task.title;

  const head = el(
    'div',
    { class: 'detail-head' },
    el('div', { class: 'row' }, badge(task.status), el('span', { class: 'badge' }, task.type),
      el('span', { class: 'badge' }, `优先级 ${task.priority}`),
      task.origin === 'agent' ? toneBadge(task.adopted ? 'muted' : 'warn', task.adopted ? '智能体提案（已接管）' : '智能体提案（待接管）') : null),
    el('h3', { class: 'detail-title' }, task.title),
    hasGoal ? el('p', { class: 'lede tight' }, task.goal) : null,
  );

  const meta = el(
    'dl',
    { class: 'kv' },
    el('dt', {}, '负责人'),
    el('dd', {}, task.ownerName ? `${task.ownerName}（${task.ownerId}）` : task.ownerId),
    el('dt', {}, '截止'),
    el('dd', {}, formatTime(task.dueAt)),
    el('dt', {}, '验收条件'),
    el('dd', {}, task.acceptance),
    el('dt', {}, '版本'),
    el('dd', {}, `v${task.version}`),
    el('dt', {}, '输入'),
    el('dd', {}, el('pre', { class: 'code' }, JSON.stringify(task.input))),
  );

  const actions = renderTaskActions(detail, owner);

  return frag(
    back,
    head,
    task.origin === 'agent' && !task.adopted
      ? el('div', { class: 'note warn' },
        el('strong', {}, '这是智能体发起的提案。'),
        ' 接管后它才进入正式流程：可以分派、验收、沉淀经验；不接管就只是一个提议。',
        canSupervise() || owner
          ? el('button', {
            class: 'accent',
            type: 'button',
            style: 'margin-left:12px',
            onclick: () => act(() => api(`tasks/${task.id}/adopt`, { body: {} }), '已接管'),
          }, '接管这个提案')
          : null)
      : null,
    actions ? el('div', { class: 'toolbar' }, actions) : null,
    el('div', { class: 'card' }, meta),
    task.result ? el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, '汇总')),
      el('div', { class: 'result-box' }, task.result.text ?? JSON.stringify(task.result, null, 2))) : null,
    renderSubtasks(detail, owner),
    renderOffers(task),
    renderComments(task),
    detail.knowledgeRefs.length
      ? el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', {}, '引用的经验'),
          el('span', { class: 'muted' }, '正文固定在被引用的版本上')),
        el('div', { class: 'list' }, detail.knowledgeRefs.map((ref) =>
          el('div', { class: 'list-item static' },
            el('p', { class: 'statement' }, ref.content ?? '（该版本正文不可见）'),
            el('div', { class: 'meta' },
              el('span', {}, `v${ref.version}`),
              ref.conditions ? el('span', {}, `适用：${ref.conditions}`) : null,
              el('span', { class: 'mono muted', title: `经验编号 ${ref.knowledgeId}` },
                ref.knowledgeId.slice(0, 8)))))))
      : null,
    renderTimeline(detail.events, detail.subtasks),
  );
}

function renderTaskActions(detail, owner) {
  const task = detail.task;
  const coordinator = detail.coordinators.includes(state.me.id);
  const buttons = [];

  if (owner && ['pending', 'running'].includes(task.status)) {
    buttons.push(el('button', { type: 'button', onclick: () => openDelegate(task) }, '委派协调智能体'));
    buttons.push(el('button', { type: 'button', onclick: () => openAssign(task) }, '分派子任务'));
  }
  if ((owner || coordinator || isAdmin()) && ['pending', 'running'].includes(task.status)) {
    buttons.push(el('button', { type: 'button', onclick: () => openOffer(task) }, '挂到开放池'));
  }
  if ((owner || coordinator || isAdmin()) && task.status === 'running') {
    const allSubmitted = detail.subtasks.length > 0 && detail.subtasks.every((item) => item.status === 'submitted');
    buttons.push(
      el('button', {
        type: 'button',
        class: allSubmitted ? 'primary' : '',
        disabled: !allSubmitted,
        title: allSubmitted ? '' : '还有子任务未提交结果',
        onclick: () => openSummary(task),
      }, '提交汇总'),
    );
    buttons.push(el('button', { type: 'button', onclick: () => openStageSummary(task) }, '记录阶段摘要'));
  }
  if (owner && task.status === 'review') {
    buttons.push(el('button', { type: 'button', class: 'primary', onclick: () => openReview(task, 'accept') }, '验收通过'));
    buttons.push(el('button', { type: 'button', onclick: () => openReview(task, 'return') }, '退回'));
  }
  if (owner && task.status === 'completed') {
    buttons.push(el('button', { type: 'button', class: 'accent', onclick: () => openCandidate(task) }, '沉淀经验'));
  }
  if (owner && !['completed', 'cancelled'].includes(task.status)) {
    buttons.push(el('button', { type: 'button', class: 'ghost', onclick: () => openCancel(task) }, '取消任务'));
  }
  return buttons.length ? frag(...buttons) : null;
}

function renderSubtasks(detail, owner) {
  const rows = detail.subtasks.map((subtask) => {
    const result = subtask.result
      ? subtask.result.quantity !== undefined
        ? `数量 ${subtask.result.quantity} · 来源 ${subtask.result.source ?? '—'}` +
          (subtask.result.observedAt ? ` · 观测 ${formatTime(subtask.result.observedAt)}` : '')
        : subtask.result.summary ?? subtask.result.reason ?? JSON.stringify(subtask.result)
      : '—';
    const cellActions = [];
    if (owner && ['invited', 'accepted'].includes(subtask.status)) {
      cellActions.push(el('button', { class: 'link', type: 'button', onclick: () => openTimeout(subtask) }, '标记超时'));
    }
    if (owner && ['submitted', 'rejected', 'timed_out', 'outcome_unknown'].includes(subtask.status)) {
      cellActions.push(el('button', { class: 'link', type: 'button', onclick: () => openReturn(subtask) }, '退回'));
    }
    return el(
      'tr',
      {},
      el('td', {}, combo(subtask.agentId, subtask.kind)),
      el('td', {}, badge(subtask.status)),
      el('td', {}, el('div', { style: 'max-width:420px' }, result)),
      el('td', {}, cellActions.length ? el('div', { class: 'row' }, cellActions) : '—'),
    );
  });

  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, '子任务'), el('span', { class: 'muted' }, `${detail.subtasks.length} 个`)),
    detail.subtasks.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '子任务'), el('th', {}, '状态'), el('th', {}, '结果'), el('th', {}, '操作'))),
        el('tbody', {}, rows)))
      : el('div', { class: 'empty' }, '尚未分派'),
  );
}

function renderOffers(task) {
  const canPublish = task.ownerId === state.me.id || isAdmin() || hasRole('supervisor');
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '开放子任务'),
      el('span', { class: 'muted' }, state.taskOffers.length ? `${state.taskOffers.length} 条` : '还没有挂出来')),
    state.taskOffers.length
      ? el('div', { class: 'list' }, state.taskOffers.map((offer) =>
        offerRow(offer, { withdrawable: canPublish })))
      : el('div', { class: 'empty' }, '把工作挂到开放池，能力匹配的智能体会自己认领。'),
    canPublish
      ? el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', onclick: () => openOffer(task) }, '挂到开放池'))
      : null,
  );
}

function renderComments(task) {
  const draft = el('textarea', { placeholder: '写点进展、问题或结论；用 @主体ID 提到某人（人或智能体）' });
  const send = el('button', { class: 'primary', type: 'button' }, '发表');
  send.addEventListener('click', () =>
    act(async () => {
      const text = draft.value.trim();
      if (!text) throw new Error('评论不能为空');
      await api(`tasks/${task.id}/comments`, { body: { body: text } });
      draft.value = '';
    }, '已发表'));

  const rows = state.taskComments.slice(-30).map((comment) =>
    el('div', { class: 'comment' },
      el('div', { class: 'comment-head' },
        el('span', { class: 'comment-author' }, comment.authorName || comment.authorId),
        toneBadge(comment.authorKind === 'human' ? 'muted' : 'active', KIND_LABEL[comment.authorKind] ?? comment.authorKind),
        comment.mentions?.length ? el('span', { class: 'muted small' }, `→ ${comment.mentions.join('、')}`) : null,
        el('span', { class: 'when' }, formatTime(comment.createdAt))),
      el('div', { class: 'comment-body' }, comment.body)));

  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '评论'),
      el('span', { class: 'muted' }, `${state.taskComments.length} 条，人和智能体共用这一条线`)),
    rows.length ? el('div', { class: 'comments' }, rows) : el('div', { class: 'empty' }, '还没有评论。'),
    el('div', { class: 'comment-form' }, draft, el('div', { class: 'row' }, send)),
  );
}

const EVENT_TEXT = {
  task_created: '创建任务',
  task_cancelled: '取消任务',
  task_adopted: '接管提案',
  coordinator_delegated: '委派协调者',
  coordinator_removed: '撤销协调者',
  subtask_invited: '邀请子任务',
  subtask_accepted: '接受子任务',
  subtask_rejected: '拒绝子任务',
  subtask_progress: '记录进展',
  subtask_submitted: '提交结果',
  subtask_outcome_unknown: '标记结果未知',
  subtask_timed_out: '标记超时',
  subtask_returned: '退回子任务',
  subtask_cancelled: '取消子任务',
  summary_submitted: '提交汇总',
  task_accepted: '验收通过',
  task_returned: '验收退回',
  stage_summary_recorded: '记录阶段摘要',
  knowledge_candidate: '沉淀候选经验',
  knowledge_published: '发布经验',
  knowledge_revoked: '撤销经验',
  knowledge_revised: '修订经验',
  knowledge_access_changed: '调整共享范围',
  knowledge_referenced: '引用经验',
  comment_added: '发表评论',
  offer_published: '挂出开放子任务',
  offer_claimed: '认领开放子任务',
  offer_withdrawn: '撤回开放子任务',
};

/**
 * 事件只显示"发生了什么"，但光有类型名太干瘪。
 * 这里从载荷里取一两个最能说明问题的字段拼在后面，不堆砌整段 JSON。
 */
function eventDetail(type, payload, kinds) {
  const text = (value) => (typeof value === 'string' ? value : null);
  switch (type) {
    case 'coordinator_delegated':
    case 'coordinator_removed':
      return text(payload.principal);
    case 'subtask_invited':
      return combo(text(payload.agent), text(payload.kind)) ?? null;
    case 'subtask_accepted':
    case 'subtask_timed_out':
    case 'subtask_returned':
    case 'subtask_cancelled':
      return kinds.get(text(payload.subtaskId) ?? '') ?? null;
    case 'subtask_submitted':
      return [text(payload.source), text(payload.observedAt) ? `观测 ${formatTime(payload.observedAt)}` : null]
        .filter(Boolean)
        .join(' · ');
    case 'summary_submitted':
      return typeof payload.subtaskCount === 'number' ? `${payload.subtaskCount} 个子任务` : null;
    case 'knowledge_candidate':
    case 'knowledge_published':
    case 'knowledge_revoked':
    case 'knowledge_revised':
      return typeof payload.version === 'number' ? `v${payload.version}` : null;
    case 'offer_published':
      return text(payload.kind);
    case 'offer_claimed':
      return text(payload.claimedBy) ?? text(payload.agent) ?? null;
    default:
      return text(payload.note) ?? text(payload.reason) ?? null;
  }
}

function renderTimeline(events, subtasks = []) {
  const kinds = new Map(subtasks.map((subtask) => [subtask.id, combo(subtask.agentId, subtask.kind)]));
  const items = events.slice(-25).reverse().map((event) => {
    const detailText = eventDetail(event.type, event.payload ?? {}, kinds);
    return el('li', {},
      el('div', { class: 'what' }, EVENT_TEXT[event.type] ?? event.type,
        detailText ? el('span', { class: 'muted' }, ` · ${detailText}`) : null),
      el('div', { class: 'when' }, `${event.actorId} · ${formatTime(event.recordedAt)}`));
  });
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, '事件时间线'), el('span', { class: 'muted' }, `${events.length} 条`)),
    events.length ? el('ul', { class: 'timeline' }, items) : el('div', { class: 'empty' }, '暂无事件'));
}

// ---------------------------------------------------------------- 开放池与提醒

function renderPool() {
  const rows = state.offers.length
    ? el('div', { class: 'list' }, state.offers.map((offer) => offerRow(offer, { claimable: hasRole('agent') })))
    : el('div', { class: 'empty' }, '开放池里暂时没有与你能力匹配的事。');

  return frag(
    el('p', { class: 'hint tight' },
      '这里只广播子任务本身：类别、要求的能力、截止时间，以及它属于哪件事。任务的目标、输入与验收条件不在广播范围内，认领之后才看得到。'),
    rows,
    el('div', { class: 'row', style: 'margin-top:16px' },
      el('button', { type: 'button', onclick: () => refresh() }, '刷新')),
  );
}

function renderMentions() {
  if (!state.mentions.length) return el('div', { class: 'empty' }, '没有未读提醒。');
  return frag(
    el('p', { class: 'hint tight' }, '评论里的 @你 会在这里出现；读过就不会再出现。'),
    el('div', { class: 'list' }, state.mentions.map(mentionRow)),
  );
}

// ---------------------------------------------------------------- 任务动作

function openDelegate(task) {
  openDialog({
    title: '委派协调智能体',
    description: '协调者可以分派子任务、挂开放池、写阶段摘要、提交汇总，但不能验收。',
    submitLabel: '委派',
    fields: [{ name: 'principal', label: '主体 ID', required: true, placeholder: 'coordinator' }],
    onSubmit: (values) => act(() => api(`tasks/${task.id}/coordinators`, { body: { principal: values.principal }, expectedVersion: task.version }), '已委派'),
  });
}

function openAssign(task) {
  openDialog({
    title: '分派子任务',
    description: '同一智能体对同一类别的子任务只能有一个。也可以先挂开放池让对方自己认领。',
    submitLabel: '分派',
    fields: [
      { name: 'agent', label: '智能体 ID', required: true, placeholder: 'inventory' },
      { name: 'kind', label: '子任务类别', required: true, placeholder: 'inventory / supplier' },
      { name: 'dueAt', label: '截止时间（可空，默认同任务）', type: 'datetime-local' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const body = { agent: values.agent, kind: values.kind };
        if (values.dueAt) body.dueAt = new Date(values.dueAt).toISOString();
        await api(`tasks/${task.id}/assign`, { body, expectedVersion: task.version });
      }, '已分派'),
  });
}

function openOffer(task) {
  openDialog({
    title: '挂到开放池',
    description: '能力匹配的智能体会在开放池里看到它并自行认领；认领成功即建立子任务。',
    submitLabel: '挂出',
    fields: [
      { name: 'kind', label: '子任务类别', required: true, placeholder: 'inventory / supplier' },
      { name: 'capability', label: '要求的能力（可空，留空表示不限）', placeholder: 'inventory:read' },
      { name: 'description', label: '说明（只写这一件事做什么，不要写任务背景）', type: 'textarea' },
      { name: 'dueAt', label: '截止时间（可空）', type: 'datetime-local' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const body = { kind: values.kind };
        if (values.capability) body.capability = values.capability;
        if (values.description) body.description = values.description;
        if (values.dueAt) body.dueAt = new Date(values.dueAt).toISOString();
        await api(`tasks/${task.id}/offers`, { body });
      }, '已挂到开放池'),
  });
}

function openSubmit(item) {
  openDialog({
    title: '提交子任务结果',
    description: '结果必须能核对：数量或结论二选一，来源与观测时间必填。',
    submitLabel: '提交',
    fields: [
      { name: 'quantity', label: '数量（可选）', type: 'number' },
      { name: 'summary', label: '结论（可选）', type: 'textarea' },
      { name: 'source', label: '来源', required: true, placeholder: '例如 WMS 库存快照' },
      { name: 'observedAt', label: '观测时间', type: 'datetime-local', value: toLocalInput(new Date()), required: true },
      { name: 'reference', label: '出处（可空）', placeholder: '单号 / 链接 / 文件名' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const result = {};
        if (values.quantity !== '') result.quantity = Number(values.quantity);
        if (values.summary) result.summary = values.summary;
        if (result.quantity === undefined && result.summary === undefined) {
          throw new Error('数量与结论至少填一个');
        }
        result.source = values.source;
        result.observedAt = new Date(values.observedAt).toISOString();
        if (values.reference) result.reference = values.reference;
        await api(`subtasks/${item.id}/submit`, { body: { result }, expectedVersion: item.version });
      }, '已提交结果'),
  });
}

function openSummary(task) {
  openDialog({
    title: '提交汇总',
    description: '汇总将提交给负责人验收；不代替业务系统的结论。',
    submitLabel: '提交',
    fields: [{ name: 'text', label: '汇总正文', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`tasks/${task.id}/summary`, { body: { text: values.text }, expectedVersion: task.version }), '已提交汇总'),
  });
}

function openStageSummary(task) {
  openDialog({
    title: '记录阶段摘要',
    description: '摘要只用于导航与恢复上下文，有新事件后会标记为过期。',
    submitLabel: '保存',
    fields: [
      { name: 'text', label: '当前进展', type: 'textarea', required: true },
      { name: 'pending', label: '未决事项', type: 'textarea', required: true },
    ],
    onSubmit: (values) =>
      act(() => api(`tasks/${task.id}/stage-summaries`, { body: values, expectedVersion: task.version }), '已记录'),
  });
}

function openReview(task, decision) {
  openDialog({
    title: decision === 'accept' ? '验收通过' : '退回任务',
    description: decision === 'accept'
      ? '验收后任务完成，子任务标记为已核验，并可沉淀经验。'
      : '任务回到执行中，子任务需要重新处理。',
    submitLabel: decision === 'accept' ? '通过' : '退回',
    fields: [{ name: 'note', label: '意见', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`tasks/${task.id}/review`, {
        body: { decision, note: values.note },
        expectedVersion: task.version,
      }), decision === 'accept' ? '已验收' : '已退回'),
  });
}

function openCancel(task) {
  openDialog({
    title: '取消任务',
    description: '未核验的子任务会一并取消，并通知对应智能体。',
    submitLabel: '取消任务',
    fields: [{ name: 'note', label: '原因', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`tasks/${task.id}/cancel`, { body: { note: values.note }, expectedVersion: task.version }), '任务已取消'),
  });
}

function openCandidate(task) {
  openDialog({
    title: '沉淀候选经验',
    description: '候选经验需要审核人批准、写明适用范围与有效期后才能被引用。',
    submitLabel: '生成候选',
    fields: [
      { name: 'content', label: '经验内容', type: 'textarea', required: true },
      { name: 'conditions', label: '适用条件', type: 'textarea', required: true },
    ],
    onSubmit: (values) =>
      act(async () => {
        await api(`tasks/${task.id}/knowledge`, { body: values, expectedVersion: task.version });
        state.view = 'knowledge';
        state.tab = 'candidates';
        renderNav();
      }, '已生成候选经验'),
  });
}

function openTimeout(subtask) {
  openDialog({
    title: '标记子任务超时',
    description: '超时只改变协作状态，不代表业务执行失败；请先核对业务系统。',
    submitLabel: '标记超时',
    fields: [{ name: 'note', label: '说明', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`subtasks/${subtask.id}/timeout`, { body: { note: values.note }, expectedVersion: subtask.version }), '已标记超时'),
  });
}

function openReturn(subtask) {
  openDialog({
    title: '退回子任务',
    description: '退回后智能体会收到通知，可重新接受并提交。',
    submitLabel: '退回',
    fields: [{ name: 'note', label: '退回原因', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`subtasks/${subtask.id}/return`, { body: { note: values.note }, expectedVersion: subtask.version }), '已退回'),
  });
}

// ---------------------------------------------------------------- 经验库

function renderKnowledge() {
  const tabs = el('div', { class: 'tabs' },
    tabButton('published', '已发布'),
    hasRole('reviewer', 'admin') ? tabButton('candidates', `待审核 ${state.candidates.length ? `(${state.candidates.length})` : ''}`) : null);

  const input = el('input', {
    type: 'search',
    placeholder: '按内容或适用条件检索',
    value: state.query,
    onkeydown: (event) => {
      if (event.key === 'Enter') runSearch();
    },
  });
  const runSearch = () => {
    state.query = input.value.trim();
    refresh();
  };
  const search = el('div', { class: 'search' }, input, el('button', { type: 'button', onclick: runSearch }, '检索'));

  const body = state.tab === 'candidates' ? renderCandidates() : renderPublished();
  return frag(tabs, state.tab === 'published' ? search : null, body);
}

function tabButton(id, label) {
  return el('button', {
    type: 'button',
    'aria-current': state.tab === id ? 'true' : 'false',
    onclick: () => {
      state.tab = id;
      refresh();
    },
  }, label);
}

function renderPublished() {
  if (!state.knowledge.length) return el('div', { class: 'empty' }, '团队还没有发布经验。');
  return el('div', { class: 'list' }, state.knowledge.map((item) =>
    el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('p', { class: 'statement' }, item.content),
        badge('published')),
      el('div', { class: 'meta' },
        el('span', {}, `v${item.version}`),
        el('span', {}, `适用：${item.conditions}`),
        el('span', {}, `有效期至 ${formatDate(item.expiresAt)}`),
        el('span', { class: 'mono muted', title: `经验编号 ${item.id}` }, item.id.slice(0, 8))),
      hasRole('reviewer', 'admin')
        ? el('div', { class: 'row actions-row' },
          el('button', { class: 'link', type: 'button', onclick: () => openRevise(item) }, '修订'),
          el('button', { class: 'link', type: 'button', onclick: () => openAccess(item) }, '调整范围'),
          el('button', { class: 'link', type: 'button', onclick: () => openVersions(item) }, '版本历史'),
          el('button', { class: 'link danger', type: 'button', onclick: () => openRevoke(item) }, '撤销'))
        : null,
    )));
}

function renderCandidates() {
  if (!state.candidates.length) return el('div', { class: 'empty' }, '没有待审核的候选经验。');
  return el('div', { class: 'list' }, state.candidates.map((item) =>
    el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('p', { class: 'statement' }, item.content),
        badge('candidate')),
      el('div', { class: 'meta' },
        el('span', {}, `v${item.version}`),
        el('span', {}, `适用：${item.conditions}`),
        el('span', { class: 'mono muted', title: `经验编号 ${item.id}` }, item.id.slice(0, 8))),
      el('div', { class: 'row actions-row' },
        el('button', { class: 'primary', type: 'button', onclick: () => openPublish(item) }, '审核发布')),
    )));
}

function openPublish(item) {
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  openDialog({
    title: '发布经验',
    description: '发布后，本团队的智能体能读到这条经验。',
    submitLabel: '发布',
    fields: [
      { name: 'expiresAt', label: '有效期至', type: 'date', value: expires, required: true },
    ],
    onSubmit: (values) =>
      act(() => api(`knowledge/${item.id}/publish`, {
        body: {
          expiresAt: new Date(`${values.expiresAt}T00:00:00Z`).toISOString(),
          audience: 'workspace',
        },
        expectedVersion: item.version,
      }), '已发布'),
  });
}

function openRevoke(item) {
  openDialog({
    title: '撤销经验',
    description: '撤销后不再作为有效建议返回，但历史引用仍可被授权审计。',
    submitLabel: '撤销',
    fields: [{ name: 'reason', label: '原因', type: 'textarea', required: true }],
    onSubmit: (values) =>
      act(() => api(`knowledge/${item.id}/revoke`, { body: { reason: values.reason }, expectedVersion: item.version }), '已撤销'),
  });
}

function openRevise(item) {
  openDialog({
    title: '修订经验',
    description: '修订会生成新版本候选，重新审核通过前不对外返回。',
    submitLabel: '生成新版本',
    fields: [
      { name: 'content', label: '内容', type: 'textarea', value: item.content, required: true },
      { name: 'conditions', label: '适用条件', type: 'textarea', value: item.conditions, required: true },
      { name: 'reason', label: '修订原因', type: 'textarea', required: true },
    ],
    onSubmit: (values) =>
      act(() => api(`knowledge/${item.id}/revise`, { body: values, expectedVersion: item.version }), '已生成新版本候选'),
  });
}

function openAccess(item) {
  openDialog({
    title: '调整范围',
    description: '范围变更立即生效；已被复制的正文无法收回。',
    submitLabel: '保存',
    fields: [
      {
        name: 'mode',
        label: '范围',
        type: 'select',
        value: 'workspace',
        options: [
          { value: 'workspace', label: '本团队全部智能体' },
          { value: 'restricted', label: '仅指定智能体' },
        ],
      },
      { name: 'principals', label: '指定主体 ID（逗号分隔，仅上面选“仅指定智能体”时生效）' },
    ],
    onSubmit: (values) =>
      act(() => api(`knowledge/${item.id}/access`, {
        body: {
          audience: values.mode === 'workspace'
            ? 'workspace'
            : values.principals.split(',').map((value) => value.trim()).filter(Boolean),
        },
        expectedVersion: item.version,
      }), '已更新范围'),
  });
}

function openVersions(item) {
  act(async () => {
    const versions = await api(`knowledge/${item.id}/versions`);
    showPanel(
      `版本历史 · ${item.id.slice(0, 8)}`,
      '',
      el('div', { class: 'stack' }, versions.map((version) =>
        el('div', { class: 'result-box' },
          el('div', { class: 'mono' }, `v${version.version} · ${formatTime(version.publishedAt)}`),
          el('div', { style: 'margin-top:6px' }, version.content),
          el('div', { class: 'muted' }, `适用：${version.conditions} · 有效期至 ${formatDate(version.expiresAt)}`)))),
    );
  }, '');
}

// ---------------------------------------------------------------- 团队

function renderDirectory() {
  const tenant = state.tenantDetail;
  const canManage = canManageTenant();
  const counts = tenant?.counts;
  const summary = counts
    ? `${counts.members} 位成员 · ${counts.agents} 个智能体`
    : '';

  const memberRow = (member) => {
    const self = member.principalId === state.me.id;
    const owner = member.tenantRole === 'owner';
    const isAgent = member.kind === 'agent';
    return el('tr', {},
      el('td', {},
        el('div', { class: 'row', style: 'gap:8px;align-items:baseline' },
          el('strong', {}, member.displayName || member.principalId),
          self ? el('span', { class: 'badge', dataset: { tone: 'muted' } }, '你') : null,
          member.active ? null : el('span', { class: 'badge', dataset: { tone: 'danger' } }, '已停用')),
        el('div', { class: 'muted small mono' },
          member.email ?? (member.did ? `did:wba:…${member.did.slice(-12)}` : member.principalId))),
      el('td', {}, KIND_LABEL[member.kind] ?? member.kind),
      el('td', {}, toneBadge(owner ? 'active' : member.tenantRole === 'admin' ? 'ok' : 'muted',
        TENANT_ROLE_LABEL[member.tenantRole] ?? member.tenantRole)),
      el('td', { class: 'muted small' }, member.lastLoginAt ? formatTime(member.lastLoginAt) : '从未登录'),
      el('td', {},
        el('div', { class: 'row', style: 'gap:6px' },
          canManage && !self && !owner && !isAgent
            ? el('button', { type: 'button', class: 'ghost small', onclick: () => changeMemberRole(member) }, '改角色')
            : null,
          canManage && !self && !owner
            ? el('button', {
                type: 'button',
                class: 'ghost small danger',
                onclick: () =>
                  act(async () => {
                    await api(`members/${encodeURIComponent(member.principalId)}/remove`, { body: {} });
                  }, isAgent ? '已撤销授权' : '已移除成员'),
              }, isAgent ? '撤销授权' : '移除')
            : null)));
  };

  const members = canManage && state.members.length
    ? el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', {}, '成员'),
          el('span', { class: 'muted' }, `${state.members.length} 人`)),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '成员'), el('th', {}, '类型'), el('th', {}, '角色'), el('th', {}, '最近登录'), el('th', {}, ''))),
          el('tbody', {}, state.members.map(memberRow)))))
    : null;

  const invites = canManage && state.invites.length
    ? el('div', { class: 'card' },
        el('h3', {}, '待接受的邀请'),
        el('div', { class: 'list' }, state.invites.map((invite) =>
          el('div', { class: 'list-row' },
            el('div', {},
              el('strong', {}, invite.email),
              el('div', { class: 'muted small' },
                `${TENANT_ROLE_LABEL[invite.role] ?? invite.role} · 有效期至 ${formatTime(invite.expiresAt)}`)),
            el('button', {
              type: 'button',
              class: 'ghost small',
              onclick: () =>
                act(async () => {
                  await api(`tenants/current/invites/${encodeURIComponent(invite.id)}/revoke`, { body: {} });
                }, '已撤销邀请'),
            }, '撤销')))))
    : null;

  const pending = canSupervise() && state.pending.length
    ? el('div', { class: 'card' },
        el('h3', {}, '等待批准的 DID'),
        el('div', { class: 'list' }, state.pending.map((principal) =>
          el('div', { class: 'list-row' },
            el('div', {},
              el('strong', {}, principal.displayName || principal.id),
              el('div', { class: 'muted small mono' }, principal.id)),
            el('button', {
              type: 'button',
              class: 'ghost small',
              onclick: () => act(() => api(`principals/${principal.id}/activate`, { body: {} }), `已批准 ${principal.id}`),
            }, '批准')))))
    : null;

  return frag(
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, tenant?.name ?? state.tenant?.name ?? state.me.workspace),
        toneBadge(
          tenant?.role === 'owner' ? 'active' : tenant?.role === 'admin' ? 'ok' : 'muted',
          TENANT_ROLE_LABEL[tenant?.role ?? state.me.tenantRole] ?? '成员')),
      el('p', { class: 'hint tight' },
        tenant?.personal
          ? '这是自动创建的个人团队。起个名字，再邀请同事进来。'
          : summary),
      el('div', { class: 'row', style: 'flex-wrap:wrap' },
        canManage ? el('button', { class: 'primary', type: 'button', onclick: inviteMember }, '邀请成员') : null,
        canManage ? el('button', { type: 'button', onclick: openAgentInvite }, '邀请智能体') : null,
        canManage ? el('button', { type: 'button', onclick: () => renameTeam(tenant?.name ?? '') }, '重命名') : null,
        el('button', { type: 'button', onclick: createTeam }, '新建团队'),
        el('button', { type: 'button', onclick: openJoinTeam }, '加入团队'))),
    members,
    invites,
    pending,
  );
}

function renameTeam(name) {
  openDialog({
    title: '团队名称',
    fields: [{ name: 'name', label: '名称', value: name, required: true, placeholder: '例如：供应链小组' }],
    submitLabel: '保存',
    onSubmit: (values) => act(() => api('tenants/current/rename', { body: values }), '已重命名'),
  });
}

function createTeam() {
  openDialog({
    title: '新建团队',
    description: '新团队是独立的：任务、成员与经验都不与当前团队共享。',
    fields: [{ name: 'name', label: '团队名称', required: true, placeholder: '例如：供应链小组' }],
    submitLabel: '创建',
    onSubmit: (values) =>
      act(async () => {
        const result = await api('tenants', { body: values });
        state.token = result.token;
        sessionStorage.setItem('collab.token', result.token);
        state.me = await api('me');
        await loadTenants();
        renderIdentity();
        renderNav();
      }, '已创建并切换'),
  });
}

/** 邀请智能体：签一个短码，交给它，它自己入队。 */
function openAgentInvite() {
  openDialog({
    title: '邀请智能体',
    description: '生成一串短码，发给智能体，它自己会加入这个团队。',
    fields: [
      {
        name: 'expiresInHours',
        label: '有效期',
        type: 'select',
        value: '72',
        options: [
          { value: '24', label: '1 天' },
          { value: '72', label: '3 天' },
          { value: '168', label: '7 天' },
        ],
      },
    ],
    submitLabel: '生成邀请码',
    onSubmit: (values) =>
      act(async () => {
        const invite = await api('tenants/current/agent-invites', {
          body: { expiresInHours: Number(values.expiresInHours) },
        });
        showPanel(
          '智能体邀请码',
          '把这串码发给智能体，它自己会入队。',
          el('div', { class: 'stack' },
            el('div', { class: 'handoff' },
              el('code', {}, invite.code),
              el('button', {
                class: 'ghost small',
                type: 'button',
                onclick: () => copyText(invite.code, '已复制'),
              }, '复制')),
            el('div', { class: 'muted small' }, `有效期至 ${formatTime(invite.expiresAt)}；只能用一次。`)),
        );
      }, '邀请码已生成'),
  });
}

function openJoinTeam() {
  openDialog({
    title: '加入团队',
    description: '粘贴别人发给你的邀请链接。打开链接即完成加入，这里只是另一种入口。',
    fields: [{ name: 'link', label: '邀请链接', required: true, placeholder: 'https://…/login?ticket=…' }],
    submitLabel: '加入',
    onSubmit: async (values) => {
      const ticket = extractTicket(values.link);
      if (!ticket) {
        toast('链接里没有票据', 'error');
        return;
      }
      try {
        const result = await verifyEmailTicket(ticket);
        if (result.bound) {
          toast('这是绑定邮箱的链接，不是团队邀请', 'error');
          return;
        }
        if (result.selection) {
          chooseTenant(result.selection);
          return;
        }
        await signInWithSession(result.session, 'email');
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  });
}

function extractTicket(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const ticket = new URL(raw, location.origin).searchParams.get('ticket');
    if (ticket) return ticket;
  } catch {
    // 不是完整 URL，继续当作票据本身。
  }
  return /^[\w-]{8,}$/.test(raw) ? raw : '';
}

function changeMemberRole(member) {
  openDialog({
    title: `调整 ${member.displayName} 的角色`,
    fields: [
      {
        name: 'role',
        label: '角色',
        type: 'select',
        value: member.tenantRole === 'owner' ? 'member' : member.tenantRole,
        options:
          state.me.tenantRole === 'owner'
            ? TENANT_ROLE_OPTIONS
            : TENANT_ROLE_OPTIONS.filter((item) => item.value !== 'owner'),
      },
    ],
    submitLabel: '保存',
    onSubmit: (values) =>
      act(() => api(`members/${encodeURIComponent(member.principalId)}/role`, { body: values }), '角色已更新'),
  });
}

// ---------------------------------------------------------------- 监管

function renderOversight() {
  const data = state.oversight;
  if (!data) return el('div', { class: 'empty' }, '加载中…');

  const counts = data.counts;
  const stats = el('div', { class: 'grid' },
    statCard('未处理告警', counts.openAlerts),
    statCard('逾期子任务', counts.overdueSubtasks),
    statCard('待验收', counts.inReview),
    statCard('待批准主体', counts.pendingPrincipals));

  const toolbar = el('div', { class: 'row spread', style: 'margin-bottom:8px' },
    el('span', { class: 'muted small' }, `数据截至 ${formatTime(data.generatedAt)}`),
    el('div', { class: 'row' },
      el('button', { type: 'button', onclick: () => refresh() }, '刷新'),
      el('button', {
        class: 'primary',
        type: 'button',
        onclick: () => act(async () => {
          const result = await api('oversight/scan', { body: {} });
          toast(`扫描完成：新开 ${result.opened} · 更新 ${result.updated} · 自动解决 ${result.resolved}`, 'info');
        }),
      }, '重新扫描')));

  const severityLine = el('div', { class: 'row', style: 'margin-bottom:12px' },
    ['critical', 'high', 'normal', 'low'].map((severity) =>
      el('span', { class: 'badge', dataset: { tone: SEVERITY_TONE[severity] } },
        `${SEVERITY_LABEL[severity]} ${data.bySeverity[severity] ?? 0}`)));

  const alerts = [...data.alerts]
    .filter((alert) => alert.status !== 'resolved')
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || right.occurrences - left.occurrences);

  const alertList = alerts.length
    ? el('div', { class: 'list' }, alerts.map(alertRow))
    : el('div', { class: 'empty' }, '没有未处理的告警。可以点「重新扫描」按当前数据再算一次。');

  const riskyRows = data.riskyTasks.map((task) =>
    el('tr', {},
      el('td', {},
        el('button', { class: 'link', type: 'button', onclick: () => openTaskById(task.id) }, task.title),
        task.origin === 'agent' && !task.adopted ? el('div', { class: 'muted small' }, '智能体提案，未接管') : null),
      el('td', {}, badge(task.status)),
      el('td', {}, task.ownerId),
      el('td', {}, task.overdueSubtasks ? toneBadge('danger', `${task.overdueSubtasks} 个逾期`) : '—'),
      el('td', {}, task.staleHours >= data.thresholds.stalledTaskHours
        ? toneBadge('warn', `${task.staleHours} 小时无动作`)
        : `${task.staleHours} 小时`),
      el('td', { class: 'mono muted nowrap' }, formatTime(task.dueAt))));

  const presenceRows = state.presence.map((item) =>
    el('tr', {},
      el('td', {}, item.displayName || item.principalId, el('div', { class: 'mono muted' }, item.principalId)),
      el('td', {}, toneBadge(PRESENCE_TONE[item.state] ?? 'muted', PRESENCE_LABEL[item.state] ?? item.state)),
      el('td', {}, agoText(item.silentSeconds)),
      el('td', {}, item.client || '—'),
      el('td', {}, item.note || '—')));

  const pendingRows = data.pendingPrincipals.map((principal) =>
    el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', {},
          el('div', { class: 'title' }, principal.displayName || principal.id),
          el('div', { class: 'meta' },
            el('span', { class: 'mono' }, principal.id),
            el('span', {}, KIND_LABEL[principal.kind] ?? principal.kind ?? '主体'),
            principal.did ? el('span', { class: 'mono muted' }, principal.did.slice(0, 28)) : null)),
        canSupervise()
          ? el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => act(() => api(`principals/${principal.id}/activate`, { body: {} }), `已批准 ${principal.id}`),
          }, '批准')
          : null)));

  return frag(
    toolbar,
    stats,
    el('div', { class: 'section-title' }, '按严重程度'),
    severityLine,
    alertList,
    data.pendingPrincipals.length
      ? frag(el('div', { class: 'section-title' }, '待批准的自动登记'), el('div', { class: 'list' }, pendingRows))
      : null,
    el('div', { class: 'section-title' }, '风险任务'),
    data.riskyTasks.length
      ? el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '任务'), el('th', {}, '状态'), el('th', {}, '负责人'),
          el('th', {}, '逾期'), el('th', {}, '停滞'), el('th', {}, '截止'))),
        el('tbody', {}, riskyRows))))
      : el('div', { class: 'empty' }, '没有逾期或停滞的任务。'),
    el('div', { class: 'section-title' }, '智能体在线表'),
    state.presence.length
      ? el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '智能体'), el('th', {}, '状态'), el('th', {}, '最近心跳'), el('th', {}, '客户端'), el('th', {}, '备注'))),
        el('tbody', {}, presenceRows))))
      : el('div', { class: 'empty' }, '还没有智能体上报心跳。'),
    el('p', { class: 'hint' },
      `阈值：子任务 ${data.thresholds.stalledSubtaskHours} 小时无进展算卡住，` +
      `${data.thresholds.offlineMinutes} 分钟无心跳算失联，` +
      `一小时内被拒 ${data.thresholds.deniedThreshold} 次算异常。告警按规则去重，条件消失会自动解决，人工解决过的不会被重新打开。`),
  );
}

function alertRow(alert) {
  return el(
    'div',
    { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', { style: 'min-width:0' },
        el('div', { class: 'row', style: 'gap:8px' },
          toneBadge(SEVERITY_TONE[alert.severity] ?? 'muted', SEVERITY_LABEL[alert.severity] ?? alert.severity),
          el('span', { class: 'mono muted small' }, RULE_LABEL[alert.rule] ?? alert.rule),
          toneBadge(ALERT_STATUS_TONE[alert.status] ?? 'muted', ALERT_STATUS_LABEL[alert.status] ?? alert.status),
          alert.occurrences > 1 ? el('span', { class: 'muted small' }, `命中 ${alert.occurrences} 次`) : null),
        el('div', { class: 'title', style: 'margin-top:6px' }, alert.title),
        el('div', { class: 'muted', style: 'margin-top:4px' }, alert.detail),
        el('div', { class: 'meta' },
          el('span', {}, `主体 ${alert.subjectId.slice(0, 12)}`),
          el('span', {}, `最近 ${formatTime(alert.lastSeenAt)}`),
          alert.acknowledgedBy ? el('span', {}, `已由 ${alert.acknowledgedBy} 确认`) : null)),
      el('div', { class: 'row' },
        alert.taskId
          ? el('button', { class: 'link', type: 'button', onclick: () => openTaskById(alert.taskId) }, '去任务')
          : null,
        alert.status === 'open'
          ? el('button', {
            class: 'link',
            type: 'button',
            onclick: () => act(() => api(`oversight/alerts/${alert.id}/ack`, { body: {} }), '已确认'),
          }, '确认')
          : null,
        el('button', {
          class: 'link',
          type: 'button',
          onclick: () => act(() => api(`oversight/alerts/${alert.id}/resolve`, { body: {} }), '已解决'),
        }, '解决'))),
  );
}

// ---------------------------------------------------------------- 设置

function renderSettings() {
  const me = state.me;
  const emailLinks = state.links.filter((item) => item.kind === 'email');
  const activeGrants = state.grants.filter((grant) => grant.status === 'active');

  const emailRows = emailLinks.map((item) =>
    el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', {},
          el('div', { class: 'mono' }, item.value),
          el('div', { class: 'meta' },
            el('span', {}, item.verifiedAt ? '已验证' : '未验证'),
            el('span', {}, '可用于登录'))),
        toneBadge('ok', '邮箱'))));

  const identityRows = state.identities.map((item) =>
    el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', {},
          el('div', { class: 'mono' }, item.did),
          el('div', { class: 'meta' },
            el('span', {}, `来源 ${item.client || '—'}`),
            item.lastLoginAt ? el('span', {}, `最近 ${formatTime(item.lastLoginAt)}`) : null)),
        el('button', {
          class: 'link danger',
          type: 'button',
          onclick: () => act(() => api(`me/identities/${item.id}/revoke`, { body: {} }), '已解绑'),
        }, '解绑'))));

  const sessionRows = state.sessions.map((item) =>
    el('tr', {},
      el('td', { class: 'mono muted' }, item.did && item.did !== 'null' ? item.did.slice(0, 30) : '—'),
      el('td', {}, item.client || '—'),
      el('td', { class: 'nowrap' }, formatTime(item.createdAt)),
      el('td', { class: 'nowrap' }, formatTime(item.expiresAt)),
      el('td', {}, toneBadge(item.active ? 'ok' : 'muted', item.active ? '有效' : '已失效')),
      el('td', {}, item.active
        ? el('button', {
          class: 'link danger',
          type: 'button',
          onclick: () => act(() => api(`me/sessions/${item.id}/revoke`, { body: {} }), '会话已撤销'),
        }, '撤销')
        : '—')));

  const grants = activeGrants.length
    ? el('div', { class: 'list' }, activeGrants.map((grant) =>
        el('div', { class: 'list-item static' },
          el('div', { class: 'row spread top' },
            el('div', {},
              el('strong', {}, grant.agentName),
              el('div', { class: 'meta' },
                el('span', {}, grant.scopes.map((scope) => SCOPE_LABEL[scope] ?? scope).join('、')),
                el('span', {}, grant.expiresAt ? `至 ${formatDate(grant.expiresAt)}` : '长期有效'))),
            toneBadge('ok', '有效')))))
    : el('div', { class: 'empty' }, '还没有授权智能体。');

  return frag(
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '我的身份'),
        toneBadge('muted', KIND_LABEL[me.kind] ?? me.kind ?? '主体')),
      el('dl', { class: 'kv' },
        el('dt', {}, '主体'), el('dd', {}, `${me.displayName || me.id}（${me.id}）`),
        el('dt', {}, '角色'), el('dd', {}, roleText(me.roles)),
        el('dt', {}, 'DID'), el('dd', {}, el('span', { class: 'mono' }, me.did || '未绑定'))),
      el('div', { class: 'card-head', style: 'margin-top:20px' },
        el('h4', {}, '登录方式'),
        el('span', { class: 'muted' }, `${emailLinks.length + state.identities.length} 种`)),
      emailLinks.length || state.identities.length
        ? el('div', { class: 'list' }, emailRows, identityRows)
        : el('div', { class: 'empty' }, '还没有可用的登录方式。'),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', onclick: openBindEmail }, '绑定邮箱'),
        el('button', { type: 'button', onclick: () => signOut() }, '退出登录'))),

    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '我的智能体'),
        el('button', { class: 'link', type: 'button', onclick: () => { state.view = 'agents'; renderNav(); refresh(); } }, '去接入')),
      grants),

    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '会话'),
        el('span', { class: 'muted' }, '撤销后立即失效')),
      state.sessions.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'DID'), el('th', {}, '来源'), el('th', {}, '建立'), el('th', {}, '到期'), el('th', {}, '状态'), el('th', {}, '操作'))),
          el('tbody', {}, sessionRows)))
        : el('div', { class: 'empty' }, '没有进行中的会话。')),
  );
}

/** 已登录后补绑邮箱：发确认链接，点开才算证明这个地址是你的。 */
function openBindEmail() {
  openDialog({
    title: '绑定邮箱',
    description:
      '填一个你能收信的邮箱，我们会发一条确认链接。点开链接才算绑定——只填进来只是声明，' +
      '证明不了这个地址归你。绑定后可以用它登录，进入的仍是现在这个账号。',
    fields: [{ name: 'email', label: '邮箱', type: 'email', placeholder: 'name@company.com', required: true }],
    submitLabel: '发送确认链接',
    onSubmit: (values) =>
      act(async () => {
        const result = await api('me/emails/start', { body: values });
        showPanel(
          '确认邮件已发出',
          `已发送到 ${result.email}，点开邮件里的链接即完成绑定。`,
          el('div', { class: 'stack' },
            result.devLink ? el('div', { class: 'muted small' }, '开发模式：也可以直接打开这个链接。') : null,
            result.devLink ? el('a', { class: 'invite-code small', href: result.devLink }, result.devLink) : null,
            el('div', { class: 'muted small' }, '链接 15 分钟内有效，只能用一次；绑定不会换掉当前会话。')),
        );
      }, '已发送确认邮件'),
  });
}

// ---------------------------------------------------------------- 成员

function inviteMember() {
  openDialog({
    title: '邀请成员加入',
    description:
      '给对方发一条 72 小时内有效、只能用一次的链接。链接同时完成邮箱验证、入组和登录，不需要对方先注册。收件人必须是该邮箱的持有者——链接被转发给别人无效。',
    fields: [
      { name: 'email', label: '邮箱', type: 'email', placeholder: 'name@company.com', required: true },
      {
        name: 'role',
        label: '角色',
        type: 'select',
        value: 'member',
        options: TENANT_ROLE_OPTIONS.filter((item) => item.value !== 'owner'),
      },
      {
        name: 'kind',
        label: '类型',
        type: 'select',
        value: 'human',
        options: [
          { value: 'human', label: '人' },
          { value: 'agent', label: '智能体（以成员身份接入）' },
        ],
      },
    ],
    submitLabel: '发送邀请',
    onSubmit: (values) =>
      act(async () => {
        const invite = await api('tenants/current/invites', { body: values });
        showPanel(
          '邀请已发出',
          `已发送到 ${invite.email}，有效期至 ${formatTime(invite.expiresAt)}。`,
          el('div', { class: 'stack' },
            invite.link ? el('div', { class: 'muted small' }, '开发模式：也可以直接复制这条链接给对方。') : null,
            invite.link ? el('div', { class: 'invite-code small' }, invite.link) : null,
            el('div', { class: 'muted small' },
              '对方点开链接即完成登录并加入。邀请只能用一次；对方接受前，可以在这里撤销。')),
        );
      }, '已发送邀请'),
  });
}

// ---------------------------------------------------------------- 我的智能体

function approveAgent(prefill = '') {
  openDialog({
    title: '批准一个智能体',
    description:
      '输入智能体程序显示的 8 位批准码。批准会为它建立**独立主体**，权限只包含你勾选的范围；选"绑定到我的账号"才会让它以你的身份行动，撤销时要单独处理。',
    fields: [
      { name: 'userCode', label: '批准码', type: 'text', value: prefill, placeholder: 'ABCD-2345', required: true },
      {
        name: 'mode',
        label: '授权方式',
        type: 'select',
        value: 'own',
        options: [
          { value: 'own', label: '独立主体（推荐）· 只拿勾选的范围，可单独撤销' },
          { value: 'link', label: '绑定到我的账号 · 拥有我的全部权限' },
        ],
      },
      {
        name: 'scopes',
        label: '授权范围',
        type: 'checkbox-group',
        value: ['tasks:read', 'tasks:submit', 'offers:claim', 'comments:write'],
        options: SCOPE_OPTIONS,
      },
      {
        name: 'expiresInHours',
        label: '有效期',
        type: 'select',
        value: '720',
        options: [
          { value: '168', label: '7 天' },
          { value: '720', label: '30 天' },
          { value: '2160', label: '90 天' },
          { value: '8760', label: '365 天' },
        ],
      },
    ],
    submitLabel: '批准',
    onSubmit: (values) =>
      act(async () => {
        if (state.pendingCode) {
          state.pendingCode = '';
          history.replaceState({}, '', '/');
        }
        const result = await api('agents/approve', {
          body: {
            userCode: values.userCode,
            mode: values.mode,
            scopes: values.scopes,
            expiresInHours: Number(values.expiresInHours),
          },
        });
        showPanel(
          '已批准',
          result.mode === 'link'
            ? '这条智能体现在以你的身份行动。撤销授权会同时作废它用这份授权换取的令牌。'
            : '智能体已作为独立成员加入。它下次轮询就能拿到令牌，页面会显示在下面的列表里。',
          el('div', { class: 'stack' },
            el('div', {}, el('strong', {}, result.agentName)),
            el('div', { class: 'muted small mono' }, result.did),
            el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
              result.scopes.map((scope) => el('span', { class: 'badge' }, SCOPE_LABEL[scope] ?? scope))),
            el('div', { class: 'muted small' }, `有效期至 ${formatTime(result.expiresAt)}`)),
        );
      }, '已批准'),
  });
}

function renderAgents() {
  if (isAgentOnly()) return el('div', { class: 'empty' }, '智能体账号不能批准其他智能体。');

  const doingCell = (grant) => {
    const doing = grant.doing ?? [];
    if (!doing.length) return el('span', { class: 'muted small' }, '空闲');
    return el('div', { class: 'stack', style: 'gap:2px' }, doing.slice(0, 3).map((item) =>
      el('button', {
        type: 'button',
        class: 'link small nowrap',
        title: item.title,
        onclick: () => openTaskById(item.taskId),
      }, `${item.title} · ${STATUS_LABEL[item.status] ?? item.status}`)));
  };

  const grantRow = (grant) => el('tr', {},
    el('td', {},
      el('div', { class: 'row', style: 'gap:8px;align-items:baseline' },
        el('strong', {},
          grant.agentName,
          grant.scopes.length > 1
            ? el('span', {
                class: 'muted small',
                title: `授权范围：${grant.scopes.map((scope) => SCOPE_LABEL[scope] ?? scope).join('、')}`,
              }, ` · ${grant.scopes.length} 项`)
            : null),
        grant.status === 'active' ? null : toneBadge('danger', '已撤销')),
      el('div', { class: 'muted small mono' },
        grant.agentDid ? `did:wba:…${grant.agentDid.slice(-12)}` : grant.agentPrincipalId)),
    el('td', {}, doingCell(grant)),
    el('td', { class: 'muted small nowrap' }, grant.lastSeenAt ? formatTime(grant.lastSeenAt) : '尚未上线'),
    el('td', {},
      grant.status === 'active'
        ? el('button', {
            type: 'button',
            class: 'ghost small danger',
            onclick: () =>
              act(async () => {
                await api(`agents/${encodeURIComponent(grant.id)}/revoke`, { body: {} });
              }, '已撤销授权'),
          }, '撤销')
        : '—'));

  const pending = canManageTenant() && state.pendingAgents.length
    ? el('div', { class: 'list', style: 'margin-top:14px' }, state.pendingAgents.map((item) =>
        el('div', { class: 'list-row' },
          el('div', {},
            el('strong', {}, item.name || '未命名智能体'),
            el('div', { class: 'muted small' },
              `批准码 ${item.userCode} · ${formatTime(item.expiresAt)} 前有效`)),
          el('button', {
            type: 'button',
            class: 'ghost small',
            onclick: () => approveAgent(item.userCode),
          }, '批准'))))
    : null;

  const handoff = skillHandoff();

  return frag(
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '接入一个智能体'),
        canManageTenant()
          ? el('button', { class: 'ghost small', type: 'button', onclick: openAgentInvite }, '生成邀请码')
          : el('span', { class: 'muted' }, '把这句话发给它就行')),
      handoff),

    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '批准接入'),
        el('span', { class: 'muted' }, '它把批准码给你时走这里')),
      el('div', { class: 'login-row' },
        el('input', {
          id: 'approve-code',
          placeholder: 'ABCD-2345',
          autocomplete: 'off',
          spellcheck: 'false',
          value: state.pendingCode ?? '',
        }),
        el('button', {
          class: 'primary',
          type: 'button',
          onclick: () => approveAgent(document.getElementById('approve-code')?.value ?? ''),
        }, '批准')),
      pending),

    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '智能体'),
        el('span', { class: 'muted' }, `${state.grants.filter((grant) => grant.status === 'active').length} 个在用`)),
      state.grants.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, '智能体'), el('th', {}, '在做什么'), el('th', {}, '最近活跃'), el('th', {}, ''))),
            el('tbody', {}, state.grants.map(grantRow))))
        : el('div', { class: 'empty' }, '还没有智能体。')),
  );
}

/** 登录页和「我的智能体」共用同一个文件地址，打开或下载都是同一份。 */
function agentSkillUrl() {
  return `${location.origin}${AUTH_ROOT}/agent/skill.md`;
}

/** 交付给别人（或智能体）的就是这一句，链接已经写成绝对地址。 */
function agentHandoffText() {
  return `把这个链接发给智能体，它会照着里面的步骤自己接入：${agentSkillUrl()}`;
}

async function copyText(text, done = '已复制') {
  if (!text) {
    toast('还没有内容可复制', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('复制失败，请手动选中文本复制', 'error');
  }
}

/** 智能体的接入物是一个文件：给他一句话，链接写在话里。 */
function skillHandoff() {
  const url = agentSkillUrl();
  return el('div', { class: 'handoff' },
    el('p', { class: 'handoff-line' },
      '把这个链接发给智能体，它会照着里面的步骤自己接入：',
      el('a', { href: url, target: '_blank', rel: 'noopener' }, url)),
    el('button', {
      class: 'ghost small',
      type: 'button',
      onclick: () => copyText(agentHandoffText(), '已复制，发给智能体即可'),
    }, '复制'));
}

// ---------------------------------------------------------------- 审计

const OUTCOME_LABEL = { success: '成功', replay: '幂等重放', read: '读取' };
const OUTCOME_TONE = { success: 'ok', replay: 'muted', read: 'muted' };

/** 路径里的 UUID 只留前 8 位，否则审计表会被长串编号撑开。 */
const shortPath = (path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => id.slice(0, 8));

function renderAudit() {
  if (!hasRole('admin')) return el('div', { class: 'empty' }, '只有管理员可以查看审计。');
  if (!state.audit.length) return el('div', { class: 'empty' }, '暂无记录。');
  return frag(
    el('p', { class: 'hint tight' },
      '写操作、幂等重放、被拒绝的请求与少数敏感读取会留痕；普通读取不记录，避免审计表被轮询淹没。'),
    el('div', { class: 'card' },
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '时间'), el('th', {}, '主体'), el('th', {}, '接口'), el('th', {}, '结果'))),
        el('tbody', {}, state.audit.slice(0, 200).map((entry) => {
          const [method, ...rest] = entry.action.split(' ');
          const path = rest.join(' ');
          const denied = entry.outcome.startsWith('denied:');
          const tone = denied ? 'danger' : OUTCOME_TONE[entry.outcome] ?? 'muted';
          const label = denied ? `拒绝 ${entry.outcome.slice(7)}` : OUTCOME_LABEL[entry.outcome] ?? entry.outcome;
          return el('tr', {},
            el('td', { class: 'mono muted nowrap' }, formatTime(entry.recordedAt)),
            el('td', {}, entry.principalId),
            el('td', {},
              el('span', { class: 'row', style: 'gap:8px' },
                el('span', { class: 'method' }, method),
                el('span', { class: 'mono', title: entry.action }, shortPath(path) || entry.action))),
            el('td', {}, el('span', { class: 'badge', dataset: { tone } }, label)));
        }))))),
  );
}

// ---------------------------------------------------------------- 启动

function bindWalletForm() {
  const submit = document.getElementById('wallet-submit');
  const error = document.getElementById('login-error');

  document.getElementById('wallet-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const bindCode = document.getElementById('bind-code').value.trim();
    submit.disabled = true;
    submit.textContent = '正在登录…';
    try {
      await signInWithWallet(bindCode || undefined);
    } catch (problem) {
      error.textContent = problem.message;
    } finally {
      submit.disabled = false;
      submit.textContent = '用钱包登录';
    }
  });
}

/** 「我是智能体」：一句话里的链接换成当前服务地址，复制给智能体即可。 */
function bindAgentSkill() {
  const link = document.getElementById('agent-skill-link');
  if (link) {
    link.textContent = agentSkillUrl();
    link.setAttribute('href', agentSkillUrl());
  }
  document.getElementById('agent-skill-copy')?.addEventListener('click', () => {
    void copyText(agentHandoffText(), '已复制，发给智能体即可');
  });
}

/** 邮箱登录：先发链接，再让对方去邮箱点。 */
function bindEmailForm() {
  const form = document.getElementById('email-form');
  const input = document.getElementById('email');
  const submit = document.getElementById('email-submit');
  const note = document.getElementById('email-note');
  const error = document.getElementById('login-error');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const email = input.value.trim();
    if (!email) {
      error.textContent = '请先填写邮箱。';
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在发送…';
    try {
      const result = await requestEmailLink(email);
      note.replaceChildren(
        el('span', {}, `已发送到 ${email}，15 分钟内有效、只能用一次。没收到就看一眼垃圾邮件。`),
        result.devLink
          ? el('div', { class: 'stack', style: 'margin-top:8px' },
              el('span', { class: 'muted small' }, '开发模式：不接邮件服务，直接点下面这条进。'),
              el('a', { class: 'invite-code small', href: result.devLink }, result.devLink))
          : null,
      );
    } catch (problem) {
      error.textContent = problem.message;
    } finally {
      submit.disabled = false;
      submit.textContent = '发登录链接';
    }
  });
}

/**
 * 打开邮件里的链接时，地址栏带着 ticket。
 *
 * 先清掉参数再验证：避免刷新页面重复提交一张已经用掉的票。
 */
async function consumeTicketFromUrl() {
  const params = new URLSearchParams(location.search);
  const agentCode = params.get('agent');
  if (agentCode) state.pendingCode = agentCode.toUpperCase();
  const ticket = params.get('ticket');
  if (!ticket) return;

  history.replaceState({}, '', location.pathname);
  const note = document.getElementById('email-note');
  const error = document.getElementById('login-error');
  if (note) note.textContent = '正在验证登录链接…';
  try {
    const result = await verifyEmailTicket(ticket);
    if (result.bound) {
      if (error) error.textContent = '';
      if (note) note.textContent = `${result.bound.email} 已绑定到账号，以后可以用它登录。`;
      return;
    }
    if (result.selection) {
      chooseTenant(result.selection);
      return;
    }
    await signInWithSession(result.session, 'email');
  } catch (problem) {
    if (error) error.textContent = problem.message;
    if (note) note.textContent = '链接不可用，可以重新发一条。';
  }
}

function boot() {
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = document.getElementById('token').value.trim();
    const error = document.getElementById('login-error');
    error.textContent = '';
    try {
      await signInWithToken(token, 'token');
    } catch (problem) {
      state.token = '';
      error.textContent = problem.message;
    }
  });

  document.getElementById('logout').addEventListener('click', () => signOut());
  bindEmailForm();
  bindWalletForm();
  bindAgentSkill();

  // 邮件链接优先于已有会话：点邀请就该按邀请处理，不能因为浏览器里还留着
  // 上一个账号的令牌就把它悄悄忽略掉。
  if (new URLSearchParams(location.search).has('ticket')) {
    void consumeTicketFromUrl();
    return;
  }

  const remembered = sessionStorage.getItem('collab.token');
  if (remembered) {
    signInWithToken(remembered, sessionStorage.getItem('collab.method') ?? 'token').catch((error) => {
      signOut(error.message);
    });
  }
}

boot();
