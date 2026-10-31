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
  proposed: '待回应',
  declined: '已拒绝',
  countered: '已还价',
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
  proposed: 'warn',
  declined: 'muted',
  countered: 'warn',
};

const REQUEST_ROLE_LABEL = { coordinate: '委托协调', subtask: '分配子任务' };

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

const AICD_KIND_LABEL = {
  experience: '经验',
  playbook: '做法',
  checklist: '清单',
  decision: '决策记录',
  report: '报告',
  handoff: '交接说明',
};

const AICD_STATE_LABEL = {
  draft: '草稿',
  candidate: '待审核',
  published: '已发布',
  archived: '已归档',
  revoked: '已撤销',
};
const AICD_STATE_TONE = {
  draft: 'muted',
  candidate: 'warn',
  published: 'ok',
  archived: 'muted',
  revoked: 'danger',
};

const EVIDENCE_LABEL = {
  task_verified: '任务验收沉淀',
  manual: '人工编写',
  imported: '从副本导入',
};

const MESSAGE_KIND_LABEL = {
  comment: '普通消息',
  question: '提问',
  answer: '回答',
  handoff: '交接',
  decision: '决定',
  status: '进展',
  system: '系统',
};
const MESSAGE_KIND_TONE = {
  comment: 'muted',
  question: 'warn',
  answer: 'ok',
  handoff: 'active',
  decision: 'active',
  status: 'muted',
  system: 'danger',
};
const MESSAGE_KIND_OPTIONS = Object.entries(MESSAGE_KIND_LABEL)
  .filter(([value]) => value !== 'system')
  .map(([value, label]) => ({ value, label }));

const SPACE_FILE_KIND_LABEL = {
  input: '输入',
  intermediate: '中间产物',
  output: '成果',
  evidence: '证据',
};
const SPACE_FILE_KIND_OPTIONS = Object.entries(SPACE_FILE_KIND_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const NEED_KIND_LABEL = {
  question: '提问',
  mention: '提醒',
  review: '待验收',
  proposal: '提案',
};

const NAV = [
  { id: 'home', label: '工作台', show: () => true },
  { id: 'tasks', label: '任务', show: () => true },
  { id: 'pool', label: '开放池', show: () => hasRole('agent') },
  { id: 'mentions', label: '提醒', show: () => true },
  // 经验库对所有人开放：普通成员要能看到团队经验，也才能看到分享进来的个人经验。
  { id: 'knowledge', label: '经验库', show: () => isAgentSide() || !isGuest() },
  { id: 'agents', label: '我的智能体', show: () => !isAgentOnly() },
  { id: 'embedded', label: '内置智能体', show: () => hasRole('admin', 'owner') },
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
  knowledge: ['经验库', '经验可手动编写、审核、发布与复制；复制时选择目标团队'],
  agents: ['我的智能体', '你请进来的智能体，和它们正在做的事'],
  embedded: ['内置智能体', '平台自己养着的智能体：睡着、被消息叫醒、跑一轮就退出'],
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
  tab: 'aicds',
  tasks: [],
  includeArchived: false,
  activity: [],
  taskId: null,
  taskTab: 'detail',
  detail: null,
  room: null,
  roomThread: '',
  roomStream: '',
  replyTo: '',
  taskComments: [],
  taskOffers: [],
  participants: [],
  taskRequests: [],
  invitations: [],
  requestInbox: [],
  myAgents: [],
  knowledge: [],
  aicds: [],
  aicdState: '',
  aicdInvites: [],
  candidates: [],
  pending: [],
  audit: [],
  auditReport: null,
  query: '',
  inbox: [],
  mentions: [],
  offers: [],
  oversight: null,
  presence: [],
  identities: [],
  links: [],
  sessions: [],
  home: null,
  heartbeatAt: '',
  tenants: [],
  tenant: null,
  members: [],
  invites: [],
  grants: [],
  pendingAgents: [],
  pendingCode: '',
  tenantDetail: null,
  embeddedStatus: null,
  embeddedProviders: [],
  embeddedAgentId: '',
  embeddedRunId: '',
  embeddedRun: null,
  embeddedRuns: [],
  embeddedLogs: [],
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
const isGuest = () => Boolean(state.me && state.me.tenantRole === 'guest' && !isAgentSide());
/** 个人空间沿用租户存储名，界面上只显示「个人空间」。 */
const tenantLabel = (tenant) => (tenant ? (tenant.personal ? '个人空间' : tenant.name) : '组织');

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
    } else if (field.type === 'files') {
      input = el('input', { id, type: 'file', multiple: true });
      if (field.accept) input.accept = field.accept;
    } else if (field.type === 'select') {
      input = el('select', { id });
      const addOption = (option) => {
        const node = el('option', { value: option.value }, option.label);
        if (option.value === field.value) node.selected = true;
        input.append(node);
      };
      if (field.groups) {
        for (const group of field.groups) {
          const node = el('optgroup', { label: group.label });
          for (const option of group.options) {
            const optionNode = el('option', { value: option.value }, option.label);
            if (option.value === field.value) optionNode.selected = true;
            node.append(optionNode);
          }
          input.append(node);
        }
      } else {
        for (const option of field.options ?? []) addOption(option);
      }
      // 浏览器里 select.value 取的是选中项；测试用的极简 DOM 不会自己同步，
      // 这里显式赋一次，保证提交时读到的是界面上看到的值。
      if (field.value !== undefined) input.value = field.value;
      else {
        const first = field.groups?.[0]?.options?.[0] ?? field.options?.[0];
        if (first) input.value = first.value;
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
      } else if (field.type === 'files') {
        values[field.name] = Array.from(inputs.get(field.name).files ?? []);
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
  toast(`已进入「${tenantLabel(state.tenant)}」`, 'info');
}

async function loadTenants() {
  state.tenants = await api('me/tenants').catch(() => []);
  state.tenant = state.tenants.find((item) => item.id === state.me.workspace) ?? null;
}

function applySession(result) {
  state.token = result.token;
  sessionStorage.setItem('collab.token', result.token);
}

async function switchTenant(tenantId) {
  const result = await api('me/switch', { body: { tenantId } });
  applySession(result);
  state.me = await api('me');
  await loadTenants();
  renderIdentity();
  renderNav();
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
          label: `${tenantLabel(tenant)}（${TENANT_ROLE_LABEL[tenant.role] ?? tenant.role}）`,
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

/** 没有头像时用姓名首字；色相由名字决定，同一个人在哪一页都是同一种颜色。 */
const avatarHue = (name) => {
  let hue = 0;
  for (const character of String(name || '')) hue = (hue * 31 + character.codePointAt(0)) % 360;
  return hue;
};
const initialOf = (name) => {
  const text = String(name || '').trim();
  return text ? Array.from(text)[0].toUpperCase() : '?';
};

function avatarNode(name, url, size = 'md') {
  if (url) {
    return el('img', { class: `avatar avatar-${size}`, src: url, alt: name || '头像', loading: 'lazy' });
  }
  return el(
    'span',
    { class: `avatar avatar-${size} avatar-fallback`, style: `--hue:${avatarHue(name)}`, 'aria-hidden': 'true' },
    initialOf(name),
  );
}

function renderIdentity() {
  const box = document.getElementById('identity');
  const name = state.me.displayName || state.me.id;
  const roles = roleText(state.me.roles);
  // 侧栏只留一眼要认得出的：头衔优先，没有头衔就用业务角色。
  const secondary = state.me.title || (roles === '—' ? '' : roles);
  box.replaceChildren(
    el('button', {
      type: 'button',
      class: 'identity-main',
      title: '查看个人资料',
      onclick: () => {
        state.view = 'settings';
        state.taskId = null;
        renderNav();
        refresh();
      },
    },
      avatarNode(name, state.me.avatar, 'md'),
      el('div', { class: 'identity-text' },
        el('strong', { title: name }, name),
        secondary ? el('span', { class: 'identity-title', title: secondary }, secondary) : null),
    ),
  );
  renderTenantSwitch();
}

function renderTenantSwitch() {
  const box = document.getElementById('tenant');
  if (!box) return;
  const name = tenantLabel(state.tenant ?? { name: state.me.workspace });
  const role = TENANT_ROLE_LABEL[state.tenant?.role ?? state.me.tenantRole] ?? '成员';
  if (state.tenants.length <= 1) {
    box.replaceChildren(
      el('div', { class: 'tenant-line' },
        el('span', { class: 'tenant-name', title: name }, name),
        el('span', { class: 'tenant-role' }, role)),
    );
    return;
  }
  const select = el('select', { class: 'tenant-select', 'aria-label': '切换组织' });
  for (const tenant of state.tenants) {
    const option = el('option', { value: tenant.id }, tenantLabel(tenant));
    if (tenant.id === state.me.workspace) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    act(() => switchTenant(select.value), '已切换空间');
  });
  box.replaceChildren(el('span', { class: 'tenant-label' }, '空间'), select);
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...NAV.filter((view) => view.show()).map((view) =>
      el(
        'button',
        {
          type: 'button',
          id: `nav-${view.id}`,
          'aria-current': state.view === view.id ? 'true' : 'false',
          onclick: () => {
            state.view = view.id;
            state.taskId = null;
            state.taskTab = 'detail';
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
    if (!isAgentSide()) {
      state.myAgents = await api('agents')
        .then((items) => items.filter((item) => item.status === 'active'))
        .catch(() => []);
    }
    if (state.view === 'home') {
      state.tasks = await api('tasks');
      state.home = await api('space/home').catch(() => null);
      // 邀请与协作请求没有子任务可挂通知，只能从收件箱读。
      if (!isAgentSide()) {
        state.invitations = await api('task-invitations').catch(() => []);
      }
      state.requestInbox = await api('requests?box=inbox&status=proposed').catch(() => []);
      if (isAgentSide()) {
        state.inbox = await api('inbox').catch(() => []);
        state.mentions = await api('me/mentions').catch(() => []);
        state.offers = await api('offers').catch(() => []);
      } else {
        state.activity = await api('activity?limit=12').catch(() => []);
      }
    }
    if (state.view === 'tasks') {
      state.tasks = await api(state.includeArchived ? 'tasks?includeArchived=1' : 'tasks');
      if (state.taskId) {
        const id = encodeURIComponent(state.taskId);
        state.detail = await api(`tasks/${id}`);
        state.participants = await api(`tasks/${id}/participants`).catch(() => []);
        state.taskRequests = await api(`tasks/${id}/requests`).catch(() => []);
        if (state.taskTab === 'room') {
          state.room = await api(`tasks/${id}/room`);
        } else {
          state.taskComments = await api(`tasks/${id}/comments`).catch(() => []);
          state.taskOffers = await api(`tasks/${id}/offers`).catch(() => []);
        }
      }
    }
    if (state.view === 'pool') state.offers = await api('offers');
    if (state.view === 'mentions') state.mentions = await api('me/mentions');
    if (state.view === 'knowledge') {
      if (state.tab === 'published') {
        state.knowledge = await api(`knowledge${state.query ? `?q=${encodeURIComponent(state.query)}` : ''}`);
      }
      if (state.tab === 'aicds') {
        state.aicds = await api(`aicds${state.aicdState ? `?state=${encodeURIComponent(state.aicdState)}` : ''}`);
      }
      if (hasRole('reviewer', 'admin')) state.candidates = await api('knowledge/candidates');
      state.aicdInvites = await api('me/copy-invites').catch(() => []);
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
    if (state.view === 'audit') {
      state.audit = await api('audit');
      state.auditReport = await api('audit/report?days=7').catch(() => null);
    }
    if (state.view === 'agents') {
      state.grants = await api('agents');
      state.pendingAgents = canManageTenant() ? await api('agents/pending').catch(() => []) : [];
    }
    if (state.view === 'embedded') {
      state.embeddedProviders = await api('embedded/providers').catch(() => []);
      state.embeddedStatus = await api('embedded/status');
      const agents = state.embeddedStatus.agents ?? [];
      if (!agents.some((agent) => agent.id === state.embeddedAgentId)) {
        state.embeddedAgentId = agents[0]?.id ?? '';
        state.embeddedRunId = '';
      }
      if (state.embeddedAgentId) {
        const id = encodeURIComponent(state.embeddedAgentId);
        state.embeddedRuns = await api(`embedded/agents/${id}/runs?limit=20`).catch(() => []);
        if (!state.embeddedRuns.some((run) => run.id === state.embeddedRunId)) {
          state.embeddedRunId = state.embeddedRuns[0]?.id ?? '';
        }
      } else {
        state.embeddedRuns = [];
        state.embeddedRunId = '';
      }
      if (state.embeddedRunId) {
        const runId = encodeURIComponent(state.embeddedRunId);
        state.embeddedRun = await api(`embedded/runs/${runId}`).catch(() => null);
        state.embeddedLogs = await api(`embedded/runs/${runId}/log?limit=100`).catch(() => []);
      } else {
        state.embeddedRun = null;
        state.embeddedLogs = [];
      }
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
  if (state.view !== 'embedded') stopEmbeddedPolling();
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
  else if (state.view === 'embedded') content = renderEmbedded();
  else if (state.view === 'oversight') content = renderOversight();
  else if (state.view === 'settings') content = renderSettings();
  else content = renderAudit();

  view.replaceChildren(el('div', { class: 'content' }, content));
}

function openTaskById(taskId) {
  state.view = 'tasks';
  state.taskId = taskId;
  state.taskTab = 'detail';
  state.room = null;
  state.roomThread = '';
  state.roomStream = '';
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

  const needs = state.home?.needsYou ?? [];
  const needsBlock = needs.length
    ? frag(
      el('div', { class: 'section-title' }, '等你处理'),
      el('div', { class: 'list' }, needs.map(item =>
        el('button', {
          type: 'button',
          class: 'list-item',
          onclick: () => openTaskById(item.taskId),
        },
          el('div', { class: 'row spread top' },
            el('div', {},
              el('div', { class: 'title' }, item.title),
              el('div', { class: 'meta' },
                el('span', {}, NEED_KIND_LABEL[item.kind] ?? item.kind),
                el('span', {}, item.taskTitle))),
            el('div', { class: 'when' }, formatTime(item.at)))))),
    )
    : null;

  return frag(
    intro,
    renderPendingWork(),
    needsBlock,
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
    renderPendingWork(),
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
        task.origin === 'agent' && !task.adopted ? toneBadge('warn', '提案待接管') : null,
        task.archivedAt ? toneBadge('muted', '已归档') : null),
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
    el('div', { class: 'row', style: 'gap:12px;align-items:center' },
      el('label', { class: 'row', style: 'gap:6px;font-size:12.5px;color:var(--muted)' },
        el('input', {
          type: 'checkbox',
          checked: state.includeArchived,
          onchange: (event) => {
            state.includeArchived = event.target.checked;
            refresh();
          },
        }),
        '显示已归档'),
      hasRole('owner', 'admin') || hasRole('agent')
        ? el('button', { class: 'accent', type: 'button', onclick: openCreateTask },
          hasRole('owner', 'admin') ? '新建任务' : '发起提案')
        : null),
  );

  const list = filtered.length
    ? el('div', { class: 'list' }, filtered.map(taskRow))
    : el('div', { class: 'empty' }, '没有符合条件的任务。');

  return frag(toolbar, list);
}

const MAX_MATERIALS = 5;
const MAX_MATERIAL_BYTES = 1024 * 1024;
const MAX_TOTAL_MATERIAL_BYTES = 2 * 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 把选择的文件读成接口要求的材料结构；先在本地挡掉超限上传。 */
async function filesToMaterials(files) {
  const list = Array.from(files ?? []);
  if (list.length > MAX_MATERIALS) throw new Error(`最多上传 ${MAX_MATERIALS} 个文件`);
  let total = 0;
  const materials = [];
  for (const file of list) {
    if (file.size > MAX_MATERIAL_BYTES) throw new Error(`${file.name} 超过 1 MB`);
    total += file.size;
    if (total > MAX_TOTAL_MATERIAL_BYTES) throw new Error('材料总大小超过 2 MB');
    materials.push({
      name: file.name || '未命名材料',
      mime: file.type || 'application/octet-stream',
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  return materials;
}

function openCreateTask() {
  const due = new Date(Date.now() + 7 * 86_400_000);
  const canChooseOwner = Boolean(state.me?.accountId) && !isAgentSide();
  const ownerOptions = canChooseOwner
    ? [
        { value: 'personal', label: '个人空间（只属于你）' },
        ...state.tenants
          .filter((tenant) => !tenant.personal && ['owner', 'admin'].includes(tenant.role))
          .map((tenant) => ({
            value: tenant.id,
            label: `${tenant.name}（${TENANT_ROLE_LABEL[tenant.role] ?? tenant.role}）`,
          })),
      ]
    : [];
  openDialog({
    title: hasRole('owner', 'admin') ? '新建任务' : '发起任务提案',
    description: hasRole('owner', 'admin')
      ? '验收条件必须可核对；它决定任务能否被接受。个人任务只在你的个人空间，团队看不到，之后可以把经验分享给团队。'
      : '智能体发起的任务先记为提案，负责人接管后才进入正式流程。',
    submitLabel: '创建',
    fields: [
      { name: 'title', label: '标题', required: true, placeholder: '例如 仓库现场巡检与问题上报' },
      { name: 'type', label: '任务类型', value: 'general', placeholder: '通用字符串标识' },
      { name: 'goal', label: '要做什么', type: 'textarea', placeholder: '把材料和目标交给智能体：它可以检查、核对或处理什么' },
      { name: 'acceptance', label: '验收条件', type: 'textarea', required: true, placeholder: '例如：逐项报告现状，遇到问题写明原因与处理结果' },
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
      ...(canChooseOwner
        ? [{ name: 'ownership', label: '执行归属', type: 'select', value: 'personal', options: ownerOptions }]
        : []),
      { name: 'files', label: '材料（可选，最多 5 个，单个不超过 1 MB）', type: 'files' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const materials = await filesToMaterials(values.files);
        const body = {
          title: values.title,
          type: values.type || 'general',
          goal: values.goal || values.title,
          acceptance: values.acceptance,
          priority: values.priority,
          dueAt: new Date(values.dueAt).toISOString(),
          input: {},
          ...(materials.length ? { materials } : {}),
        };
        if (canChooseOwner) {
          if (values.ownership === 'personal') body.ownership = 'personal';
          else if (values.ownership) {
            body.ownership = 'team';
            body.teamId = values.ownership;
          }
        }
        const result = await api('tasks', { body });
        let notice = '任务已创建';
        if (result.workspace && result.workspace !== state.me.workspace) {
          try {
            await switchTenant(result.workspace);
          } catch (error) {
            notice = `任务已创建，但未能切换空间：${error.message}`;
          }
        }
        state.view = 'tasks';
        state.taskId = result.id;
        renderNav();
        toast(notice, notice === '任务已创建' ? 'info' : 'error');
      }, ''),
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
    { class: 'link back', type: 'button', onclick: () => { state.taskId = null; state.taskTab = 'detail'; refresh(); } },
    '← 返回任务列表',
  );

  const hasGoal = task.goal && task.goal !== task.title;

  const tabs = el(
    'div',
    { class: 'tabs' },
    taskTabButton('detail', '任务'),
    taskTabButton('room', '房间'),
  );

  const head = el(
    'div',
    { class: 'detail-head' },
    el('div', { class: 'row' }, badge(task.status), el('span', { class: 'badge' }, task.type),
      el('span', { class: 'badge' }, `优先级 ${task.priority}`),
      task.origin === 'agent' ? toneBadge(task.adopted ? 'muted' : 'warn', task.adopted ? '智能体提案（已接管）' : '智能体提案（待接管）') : null,
      task.archivedAt ? toneBadge('muted', '已归档') : null),
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
  );
  if (task.input && Object.keys(task.input).length) {
    meta.append(
      el('dt', {}, '输入'),
      el('dd', {}, el('pre', { class: 'code' }, JSON.stringify(task.input))),
    );
  }

  const actions = renderTaskActions(detail, owner);

  if (state.taskTab === 'room') {
    return frag(back, head, tabs, renderTaskRoom());
  }

  return frag(
    back,
    head,
    tabs,
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
    renderMaterials(detail),
    task.result ? el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, '汇总')),
      el('div', { class: 'result-box' }, task.result.text ?? JSON.stringify(task.result, null, 2))) : null,
    renderSubtasks(detail, owner),
    renderParticipation(detail, owner),
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

function taskTabButton(id, label) {
  return el('button', {
    type: 'button',
    'aria-current': state.taskTab === id ? 'true' : 'false',
    onclick: () => {
      state.taskTab = id;
      state.roomThread = '';
      refresh();
    },
  }, label);
}

// ---------------------------------------------------------------- 任务房间

const ROOM_STREAM_LABEL = { event: '进展', message: '消息', file: '文件', knowledge: '经验' };
const ROOM_ROLE_LABEL = {
  owner: '负责人',
  coordinator: '协调者',
  agent: '受派智能体',
  participant: '参与者',
};

function renderTaskRoom() {
  const room = state.room;
  if (!room) return el('div', { class: 'empty' }, '加载中…');
  const counts = room.counts;
  return frag(
    el('div', { class: 'grid' },
      statCard('消息', counts.messages, '人与智能体共用一条线'),
      statCard('开放线程', counts.threadsOpen, `共 ${room.threads.length} 个线程`),
      statCard('文件', counts.files, '输入、中间产物与成果'),
      statCard('经验', counts.knowledge, '与这件事相关的经验')),
    renderRoomParticipants(room),
    renderRoomRequests(),
    renderRoomThreads(room),
    renderRoomMessages(room),
    renderRoomFiles(room),
    renderRoomActivity(room),
    renderRoomKnowledge(room),
  );
}

function renderRoomParticipants(room) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '参与者'),
      el('span', { class: 'muted' }, `${room.participants.length} 位`)),
    room.participants.length
      ? el('div', { class: 'row' }, room.participants.map((person) =>
        el('span', { class: 'comment-person', title: person.id },
          avatarNode(person.displayName || person.id, person.avatar, 'sm'),
          el('span', {}, `${person.displayName}（${ROOM_ROLE_LABEL[person.role] ?? person.role}）`))))
      : el('div', { class: 'empty' }, '还没有参与者。'));
}

function renderRoomRequests() {
  if (!state.taskRequests.length) return null;
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '协作请求'),
      el('span', { class: 'muted' }, `${state.taskRequests.length} 个，接受后才落库`)),
    el('div', { class: 'list' }, state.taskRequests.map((request) => requestCard(request))));
}

function renderRoomThreads(room) {
  const rows = room.threads.map((thread) => {
    const active = state.roomThread === thread.id;
    return el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('span', { class: 'title' }, thread.topic),
        toneBadge(thread.status === 'open' ? 'warn' : 'muted', thread.status === 'open' ? '进行中' : '已结束')),
      el('div', { class: 'meta' },
        el('span', {}, `发起 ${thread.openedByName}`),
        thread.assigneeId ? el('span', {}, `指派给 ${thread.assigneeId}`) : null,
        el('span', {}, `${thread.messageCount} 条消息`),
        el('span', {}, formatTime(thread.createdAt))),
      el('div', { class: 'row actions-row' },
        el('button', {
          class: 'link',
          type: 'button',
          onclick: () => {
            state.roomThread = active ? '' : thread.id;
            refresh();
          },
        }, active ? '看全部消息' : '只看这个线程'),
        thread.status === 'open'
          ? el('button', {
            class: 'link',
            type: 'button',
            onclick: () => act(
              () => api(`tasks/${room.task.id}/threads/${thread.id}/resolve`, { body: {} }),
              '线程已结束',
            ),
          }, '结束线程')
          : null));
  });

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '对话线程'),
      el('button', { type: 'button', onclick: () => openThread(room.task) }, '开启线程')),
    rows.length ? el('div', { class: 'list' }, rows) : el('div', { class: 'empty' }, '还没有线程。开一个线程，把讨论收在一处。'));
}

function openThread(task) {
  openDialog({
    title: '开启对话线程',
    description: '线程用来收拢一个话题：谁在等谁、结论是什么，结束时点“结束线程”。',
    submitLabel: '开启',
    fields: [
      { name: 'topic', label: '话题', required: true, placeholder: '例如：补货方案' },
      { name: 'assigneeId', label: '指派给（主体 ID，可空）', placeholder: 'inv-room' },
    ],
    onSubmit: (values) => act(
      () => api(`tasks/${task.id}/threads`, {
        body: { topic: values.topic, assigneeId: values.assigneeId || undefined },
      }),
      '线程已开启',
    ),
  });
}

function renderRoomMessages(room) {
  const threads = new Map(room.threads.map((thread) => [thread.id, thread]));
  const files = new Map(room.files.map((file) => [file.id, file]));
  const messages = state.roomThread
    ? room.messages.filter((message) => message.threadId === state.roomThread)
    : room.messages;

  const rows = messages.map((message) => {
    const thread = message.threadId ? threads.get(message.threadId) : null;
    const parent = message.replyTo ? room.messages.find((item) => item.id === message.replyTo) : null;
    const blocking = message.payload?.blocking === true;
    return el('div', { class: 'comment' },
      el('div', { class: 'comment-head' },
        el('span', { class: 'comment-person' },
          avatarNode(message.authorName || message.authorId, message.authorAvatar, 'sm'),
          el('span', { class: 'comment-author' }, message.authorName || message.authorId)),
        toneBadge(message.authorKind === 'human' ? 'muted' : 'active', KIND_LABEL[message.authorKind] ?? message.authorKind),
        toneBadge(MESSAGE_KIND_TONE[message.kind] ?? 'muted', MESSAGE_KIND_LABEL[message.kind] ?? message.kind),
        blocking ? toneBadge('danger', '阻塞') : null,
        thread ? el('span', { class: 'muted small' }, `#${thread.topic}`) : null,
        el('span', { class: 'when' }, formatTime(message.createdAt))),
      parent
        ? el('div', { class: 'muted small' }, `回复 ${parent.authorName || parent.authorId}：${parent.body.slice(0, 80)}`)
        : null,
      el('div', { class: 'comment-body' }, message.body),
      message.fileIds?.length
        ? el('div', { class: 'row', style: 'margin-top:4px' }, message.fileIds.map((fileId) => {
          const file = files.get(fileId);
          return el('button', {
            class: 'link',
            type: 'button',
            onclick: () => (file ? downloadSpaceFile(room.task.id, file) : toast('文件已删除', 'error')),
          }, file ? `${file.name}（${formatBytes(file.size)}）` : '附件');
        }))
        : null,
      el('div', { class: 'row actions-row' },
        el('button', {
          class: 'link',
          type: 'button',
          onclick: () => {
            state.replyTo = message.id;
            refresh();
          },
        }, '回复')));
  });

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, state.roomThread ? `消息 · ${threads.get(state.roomThread)?.topic ?? ''}` : '消息'),
      state.roomThread
        ? el('button', {
          class: 'link',
          type: 'button',
          onclick: () => {
            state.roomThread = '';
            refresh();
          },
        }, '看全部消息')
        : el('span', { class: 'muted' }, `${messages.length} 条`)),
    rows.length ? el('div', { class: 'comments' }, rows) : el('div', { class: 'empty' }, '还没有消息。问一句、给个结论，都会留在房间里。'),
    renderMessageComposer(room));
}

function renderMessageComposer(room) {
  const draft = el('textarea', { placeholder: '写点进展、问题或结论；用 @主体ID 提到某人' });
  const kind = el('select', {}, MESSAGE_KIND_OPTIONS.map((option) => {
    const node = el('option', { value: option.value }, option.label);
    if (option.value === 'status') node.selected = true;
    return node;
  }));
  const thread = el('select', {},
    el('option', { value: '' }, '不归线程'),
    room.threads.filter((item) => item.status === 'open').map((item) => el('option', { value: item.id }, item.topic)));
  if (state.roomThread) thread.value = state.roomThread;
  const parent = state.replyTo ? room.messages.find((message) => message.id === state.replyTo) : null;

  const send = el('button', { class: 'primary', type: 'button' }, '发送');
  send.addEventListener('click', () => act(async () => {
    const text = draft.value.trim();
    if (!text) throw new Error('消息不能为空');
    await api(`tasks/${room.task.id}/messages`, {
      body: {
        body: text,
        kind: kind.value,
        threadId: thread.value || undefined,
        replyTo: state.replyTo || undefined,
      },
    });
    draft.value = '';
    state.replyTo = '';
  }, '已发送'));

  return el('div', { class: 'comment-form' },
    parent
      ? el('div', { class: 'row spread' },
        el('span', { class: 'muted small' }, `回复 ${parent.authorName || parent.authorId}：${parent.body.slice(0, 60)}`),
        el('button', {
          class: 'link',
          type: 'button',
          onclick: () => {
            state.replyTo = '';
            refresh();
          },
        }, '取消'))
      : null,
    draft,
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', {}, '类型'), kind),
      el('label', { class: 'field' }, el('span', {}, '线程'), thread),
      send));
}

const TEXT_PREVIEW_LIMIT = 200 * 1024;

function fileContentPath(taskId, file) {
  const fileId = encodeURIComponent(file.fileId ?? file.id);
  return taskId
    ? `tasks/${encodeURIComponent(taskId)}/files/${fileId}/content`
    : `space/files/${fileId}/content`;
}

async function fetchFileBytes(taskId, file) {
  const response = await fetch(`${API_ROOT}/${fileContentPath(taskId, file)}`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    if (response.status === 401) signOut('登录状态已失效，请重新连接');
    const payload = await readPayload(response);
    throw new Error(payload?.error?.message ?? `读取文件失败（HTTP ${response.status}）`);
  }
  return response;
}

function isTextFile(file) {
  const mime = String(file.mime ?? '');
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/x-yaml'].includes(mime)) return true;
  return /\.(md|txt|json|csv|tsv|log|ya?ml|xml|html?)$/i.test(String(file.name ?? ''));
}

/**
 * 预览只读不下载：图片和 PDF 用对象 URL 交给浏览器，
 * 文本读前 200 KiB 直接铺开，其余类型退回下载。
 */
function previewSpaceFile(taskId, file) {
  act(async () => {
    const mime = String(file.mime ?? '');
    let body;
    let objectUrl = null;
    if (mime.startsWith('image/')) {
      const response = await fetchFileBytes(taskId, file);
      objectUrl = URL.createObjectURL(await response.blob());
      body = el('img', { class: 'preview-media', src: objectUrl, alt: file.name });
    } else if (mime === 'application/pdf') {
      const response = await fetchFileBytes(taskId, file);
      objectUrl = URL.createObjectURL(await response.blob());
      body = el('iframe', {
        class: 'preview-doc',
        src: `${objectUrl}#page=1&view=FitH`,
        title: file.name,
      });
    } else if (isTextFile(file)) {
      const response = await fetchFileBytes(taskId, file);
      const text = await response.text();
      body = frag(
        el('pre', { class: 'preview-text' }, text.slice(0, TEXT_PREVIEW_LIMIT)),
        text.length > TEXT_PREVIEW_LIMIT
          ? el('p', { class: 'muted small' }, `只显示前 ${formatBytes(TEXT_PREVIEW_LIMIT)}，完整内容请下载。`)
          : null,
      );
    } else {
      body = el('p', { class: 'muted' }, `暂不支持预览 ${mime || '该类型'}，请下载后查看。`);
    }

    if (objectUrl) {
      document.getElementById('dialog').addEventListener(
        'close',
        () => URL.revokeObjectURL(objectUrl),
        { once: true },
      );
    }
    showPanel(
      `预览 · ${file.name}`,
      `${formatBytes(file.size)} · ${mime || '未知类型'} · v${file.version}`,
      el('div', { class: 'preview-body' },
        body,
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { type: 'button', onclick: () => downloadSpaceFile(taskId, file) }, '下载'))),
    );
  }, '');
}

function downloadSpaceFile(taskId, file) {
  act(async () => {
    // 任务文件与独立附件走同一条流式读取路径，不再把整个文件塞进 base64 JSON。
    const response = await fetchFileBytes(taskId, file);
    const url = URL.createObjectURL(await response.blob());
    const link = el('a', { href: url, download: file.name ?? '下载' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, '');
}

function renderRoomFiles(room) {
  const rows = room.files.map((file) => el('div', { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('span', { class: 'title' }, file.name),
      toneBadge('muted', SPACE_FILE_KIND_LABEL[file.kind] ?? file.kind)),
    el('div', { class: 'meta' },
      el('span', {}, formatBytes(file.size)),
      el('span', {}, `v${file.version}`),
      el('span', {}, `上传 ${file.producedByName || file.producedBy}`),
      el('span', { class: 'mono muted', title: `sha256 ${file.sha256}` }, file.sha256.slice(0, 12)),
      el('span', {}, formatTime(file.createdAt))),
    el('div', { class: 'row actions-row' },
      el('button', { class: 'link', type: 'button', onclick: () => previewSpaceFile(room.task.id, file) }, '预览'),
      el('button', { class: 'link', type: 'button', onclick: () => downloadSpaceFile(room.task.id, file) }, '下载'),
      file.kind === 'output'
        ? el('button', {
          class: 'link',
          type: 'button',
          onclick: () => openPromoteFile(room.task, file),
        }, '挂到经验')
        : null,
      el('button', {
        class: 'link danger',
        type: 'button',
        onclick: () => act(
          () => api(`tasks/${room.task.id}/files/${file.id}/delete`, { body: {} }),
          '文件已删除',
        ),
      }, '删除'))));

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '文件'),
      el('button', { type: 'button', onclick: () => openUploadFile(room.task) }, '上传文件')),
    rows.length ? el('div', { class: 'list' }, rows) : el('div', { class: 'empty' }, '还没有文件。中间产物和成果都可以留在这里。'));
}

const MAX_SPACE_FILE_BYTES = 256 * 1024;

function openUploadFile(task) {
  openDialog({
    title: '上传文件',
    description: '单文件上限 256 KiB；成果文件可以挂到经验下当证据。',
    submitLabel: '上传',
    fields: [
      { name: 'file', label: '文件', type: 'files', required: true },
      { name: 'kind', label: '类别', type: 'select', value: 'intermediate', options: SPACE_FILE_KIND_OPTIONS },
    ],
    onSubmit: (values) => act(async () => {
      const file = values.file?.[0];
      if (!file) throw new Error('请选择文件');
      if (file.size > MAX_SPACE_FILE_BYTES) throw new Error('单文件上限 256 KiB');
      await api(`tasks/${task.id}/files`, {
        body: {
          name: file.name || '未命名文件',
          mime: file.type || 'application/octet-stream',
          kind: values.kind,
          data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        },
      });
    }, '已上传'),
  });
}

function openPromoteFile(task, file) {
  act(async () => {
    const items = await api('aicds');
    const options = items
      .filter((item) => item.state !== 'archived' && item.state !== 'revoked')
      .map((item) => ({
        value: item.id,
        label: `${item.title}（${AICD_STATE_LABEL[item.state] ?? item.state}）`,
      }));
    if (!options.length) {
      toast('先建一条经验，再把成果挂成证据', 'error');
      return;
    }
    openDialog({
      title: '挂到经验',
      description: '只有成果文件能挂成证据；同团队内复制时附件会一起带走。',
      submitLabel: '挂接',
      fields: [
        { name: 'knowledgeId', label: '经验', type: 'select', options },
        {
          name: 'role',
          label: '角色',
          type: 'select',
          value: 'evidence',
          options: [
            { value: 'evidence', label: '证据' },
            { value: 'attachment', label: '附件' },
          ],
        },
      ],
      onSubmit: (values) => act(
        () => api(`tasks/${task.id}/files/${file.id}/promote`, { body: values }),
        '已挂接',
      ),
    });
  }, '');
}

function renderRoomActivity(room) {
  const streams = [['', '全部'], ['event', '进展'], ['message', '消息'], ['file', '文件'], ['knowledge', '经验']];
  const entries = state.roomStream
    ? room.activity.filter((entry) => entry.stream === state.roomStream)
    : room.activity;
  const items = entries.slice(-60).reverse().map((entry) => el('li', {},
    el('div', { class: 'what' },
      `${ROOM_STREAM_LABEL[entry.stream] ?? entry.stream} · ${entry.summary}`),
    el('div', { class: 'when' }, `${entry.actorName || entry.actorId} · ${formatTime(entry.at)}`)));
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '合并时间线'),
      el('span', { class: 'muted' }, '进展、对话、文件与经验按时间排在一起')),
    el('div', { class: 'row actions-row' }, streams.map(([value, label]) =>
      el('button', {
        class: 'link',
        type: 'button',
        'aria-current': state.roomStream === value ? 'true' : 'false',
        onclick: () => { state.roomStream = value; refresh(); },
      }, label))),
    items.length ? el('ul', { class: 'timeline' }, items) : el('div', { class: 'empty' }, '暂无动态'));
}

function renderRoomKnowledge(room) {
  if (!room.knowledge.length) return null;
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '这件事沉淀的经验'),
      el('span', { class: 'muted' }, '发布后团队智能体能读到')),
    el('div', { class: 'list' }, room.knowledge.map((item) =>
      el('div', { class: 'list-item static' },
        el('div', { class: 'row spread top' },
          el('span', { class: 'title' }, item.title || item.content.slice(0, 40)),
          toneBadge(AICD_STATE_TONE[item.state] ?? 'muted', AICD_STATE_LABEL[item.state] ?? item.state)),
        el('div', { class: 'meta' },
          el('span', {}, AICD_KIND_LABEL[item.kind] ?? item.kind),
          el('span', {}, `v${item.version}`),
          el('span', {}, `适用：${item.conditions || '—'}`)),
        el('div', { class: 'row actions-row' },
          el('button', {
            class: 'link',
            type: 'button',
            onclick: () => openAicdDetail(item.id),
          }, '详情'))))));
}

function renderMaterials(detail) {
  const materials = detail.materials ?? [];
  if (!materials.length) return null;
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '材料'),
      el('span', { class: 'muted' }, `${materials.length} 个`)),
    el('div', { class: 'list' }, materials.map((item) =>
      el('div', { class: 'list-item static' },
        el('div', { class: 'row spread top' },
          el('span', {}, item.name),
          el('button', {
            class: 'link',
            type: 'button',
            onclick: () => downloadMaterial(detail.task.id, item),
          }, '下载')),
        el('div', { class: 'meta' },
          el('span', {}, formatBytes(item.size)),
          el('span', { class: 'mono muted', title: `材料编号 ${item.id}` }, item.id.slice(0, 8)))))),
  );
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadMaterial(taskId, item) {
  try {
    const content = await api(
      `tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(item.id)}`,
    );
    const binary = atob(content.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: content.mime }));
    const link = el('a', { href: url, download: content.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    toast(error.message, 'error');
  }
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
  const agentSubmitted = detail.subtasks.some(
    (item) => item.agentId === state.me.id && ['submitted', 'verified'].includes(item.status),
  );
  if (!owner && agentSubmitted && task.status !== 'cancelled') {
    buttons.push(el('button', { type: 'button', class: 'accent', onclick: () => openCandidate(task) }, '总结成经验'));
  }
  if (owner && !['completed', 'cancelled'].includes(task.status)) {
    buttons.push(el('button', { type: 'button', class: 'ghost', onclick: () => openCancel(task) }, '取消任务'));
  }
  if (owner && ['completed', 'cancelled'].includes(task.status)) {
    buttons.push(task.archivedAt
      ? el('button', {
        type: 'button',
        onclick: () => act(async () => {
          await api(`tasks/${task.id}/unarchive`, { body: {} });
          refresh();
        }, '已取消归档'),
      }, '取消归档')
      : el('button', {
        type: 'button',
        class: 'ghost',
        onclick: () => act(async () => {
          await api(`tasks/${task.id}/archive`, { body: {} });
          refresh();
        }, '已归档，可从列表「显示已归档」找回'),
      }, '归档任务'));
  }
  return buttons.length ? frag(...buttons) : null;
}

const requestTermText = (terms = {}) => {
  const parts = [];
  if (terms.kind) parts.push(`类别 ${terms.kind}`);
  if (terms.dueAt) parts.push(`截止 ${formatTime(terms.dueAt)}`);
  if (terms.note) parts.push(terms.note);
  return parts.join(' · ') || '—';
};

/** 协商记录在任务页、房间和待办里复用同一张卡片。 */
function requestCard(request, options = {}) {
  // 人可以在页面上替自己的智能体回应；落库的仍是那个智能体。
  const mine = request.toPrincipal === state.me.id
    || state.myAgents.some((agent) => agent.agentPrincipalId === request.toPrincipal);
  const fromMe = request.fromPrincipal === state.me.id;
  const actions = [];
  if (mine && request.status === 'proposed') {
    actions.push(el('button', {
      class: 'primary',
      type: 'button',
      onclick: () => act(
        () => api(`requests/${encodeURIComponent(request.id)}/accept`, { body: {} }),
        '已接受，分工已建立',
      ),
    }, '接受'));
    actions.push(el('button', { type: 'button', onclick: () => openDeclineRequest(request) }, '拒绝'));
    actions.push(el('button', { type: 'button', onclick: () => openCounterRequest(request) }, '还价'));
  }
  if (fromMe && request.status === 'countered') {
    actions.push(el('button', {
      class: 'primary',
      type: 'button',
      onclick: () => act(
        () => api(`requests/${encodeURIComponent(request.id)}/confirm`, { body: {} }),
        '已确认还价，分工已建立',
      ),
    }, '确认还价'));
  }
  if (fromMe && ['proposed', 'countered'].includes(request.status)) {
    actions.push(el('button', {
      class: 'ghost',
      type: 'button',
      onclick: () => act(
        () => api(`requests/${encodeURIComponent(request.id)}/withdraw`, { body: {} }),
        '已撤回请求',
      ),
    }, '撤回'));
  }

  return el('div', { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', {},
        el('span', { class: 'title' },
          `${REQUEST_ROLE_LABEL[request.role] ?? request.role} · ${request.fromName} → ${request.toName}`),
        options.showTask ? el('div', { class: 'meta' }, el('span', {}, request.taskTitle)) : null),
      badge(request.status)),
    el('div', { class: 'meta' },
      el('span', {}, requestTermText(request.payload)),
      request.counter ? el('span', {}, `还价：${requestTermText(request.counter)}`) : null,
      el('span', {}, formatTime(request.createdAt))),
    actions.length ? el('div', { class: 'row actions-row' }, actions) : null);
}

function invitationCard(invitation) {
  return el('div', { class: 'list-item static' },
    el('div', { class: 'row spread top' },
      el('div', {},
        el('span', { class: 'title' }, invitation.taskTitle),
        el('div', { class: 'meta' },
          el('span', {}, `邀请人 ${invitation.invitedByName || invitation.invitedBy}`),
          badge(invitation.taskStatus))),
      badge(invitation.status)),
    invitation.note ? el('div', { class: 'muted small', style: 'margin-top:6px' }, invitation.note) : null,
    el('div', { class: 'row actions-row' },
      el('button', {
        class: 'primary',
        type: 'button',
        onclick: () => openAcceptInvitation(invitation),
      }, '接受并选智能体'),
      el('button', { type: 'button', onclick: () => openDeclineInvitation(invitation) }, '拒绝')));
}

/** 工作台上的「等你回应」：邀请按人，协作请求按智能体。 */
function renderPendingWork() {
  const invites = state.invitations.length
    ? frag(
      el('div', { class: 'section-title' }, '任务邀请'),
      el('div', { class: 'list' }, state.invitations.map(invitationCard)),
    )
    : null;
  const requests = state.requestInbox.length
    ? frag(
      el('div', { class: 'section-title' }, '待回应的协作请求'),
      el('div', { class: 'list' }, state.requestInbox.map((item) => requestCard(item, { showTask: true }))),
    )
    : null;
  return invites || requests ? frag(invites, requests) : null;
}

function renderParticipation(detail, owner) {
  const task = detail.task;
  const coordinator = detail.coordinators.includes(state.me.id);
  const canManage = owner || coordinator || isAdmin();
  const active = ['pending', 'running'].includes(task.status);
  const personal = Boolean(state.tenant?.personal);
  const canInvite = canManage && active && !personal;

  const people = state.participants.map((person) => {
    const actions = [];
    if (canManage && person.status !== 'revoked') {
      actions.push(el('button', {
        class: 'link',
        type: 'button',
        onclick: () => act(
          () => api(
            `tasks/${encodeURIComponent(task.id)}/participants/${encodeURIComponent(person.id)}/revoke`,
            { body: {} },
          ),
          '已撤销参与',
        ),
      }, '撤销'));
    }
    return el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', {},
          el('span', { class: 'title' }, person.displayName || person.humanPrincipalId),
          el('div', { class: 'meta' },
            person.email ? el('span', {}, person.email) : null,
            el('span', {}, person.agentName ? `智能体 ${person.agentName}` : '尚未选定智能体'))),
        badge(person.status === 'revoked' ? 'revoked' : person.status)),
      actions.length ? el('div', { class: 'row actions-row' }, actions) : null);
  });

  const requests = state.taskRequests.map((request) => requestCard(request));

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '参与人与分工'),
      el('span', { class: 'muted' },
        `${state.participants.length} 人 · ${state.taskRequests.length} 个请求`)),
    personal
      ? el('div', { class: 'muted small' }, '个人任务只有你一个人，不邀请他人。')
      : people.length
        ? el('div', { class: 'list' }, people)
        : el('div', { class: 'empty' }, '还没有邀请其他人。邀请的是人，对方接受时选自己的智能体进来。'),
    canInvite
      ? el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', onclick: () => openInviteParticipant(task) }, '邀请人参与'))
      : null,
    el('div', { class: 'section-title', style: 'margin-top:18px' }, '协作请求'),
    requests.length
      ? el('div', { class: 'list' }, requests)
      : el('div', { class: 'empty' }, '分工由智能体之间协商：先提议，对方接受或确认还价后才落库。'),
    canManage && active && !personal
      ? el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', onclick: () => openProposeRequest(task) }, '发起协作请求'))
      : null);
}

function openInviteParticipant(task) {
  openDialog({
    title: '邀请人参与任务',
    description: '邀请的是人，不是智能体。对方接受时，会从自己的智能体里选一个进入任务；对方必须已经是本团队成员。',
    submitLabel: '发出邀请',
    fields: [
      { name: 'email', label: '对方邮箱', required: true, placeholder: 'name@example.com' },
      { name: 'note', label: '说明（可选）', type: 'textarea', placeholder: '例如：请一起核对供应商数据' },
    ],
    onSubmit: (values) => act(
      () => api(`tasks/${encodeURIComponent(task.id)}/participants`, {
        body: { email: values.email, note: values.note || '' },
      }),
      '已发出邀请',
    ),
  });
}

async function openProposeRequest(task) {
  const owner = task.ownerId === state.me.id || isAdmin();
  const options = [
    ...(owner ? [{ value: 'coordinate', label: '委托协调 · 统筹整个任务' }] : []),
    { value: 'subtask', label: '分配子任务 · 一段具体工作' },
  ];
  const agents = await api('principals')
    .then((items) => items.filter((item) => item.kind === 'agent' && item.active))
    .catch(() => []);
  openDialog({
    title: '发起协作请求',
    description: '这只是一个提议。对方接受，或还价后由你确认，才会建立协调者或子任务。',
    submitLabel: '发出请求',
    fields: [
      { name: 'role', label: '交接方式', type: 'select', value: options[0].value, options },
      agents.length
        ? {
          name: 'to',
          label: '交给哪个智能体',
          type: 'select',
          value: agents[0].id,
          options: agents.map((agent) => ({
            value: agent.id,
            label: agent.displayName || agent.id,
          })),
        }
        : { name: 'to', label: '智能体 ID', required: true, placeholder: 'agent-id' },
      { name: 'kind', label: '子任务类别（分配子任务时必填）', placeholder: 'supplier-check' },
      { name: 'dueAt', label: '截止时间（可空）', type: 'datetime-local' },
      { name: 'note', label: '说明（可空）', type: 'textarea' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const body = { to: values.to, role: values.role };
        if (values.kind) body.kind = values.kind;
        if (values.dueAt) body.dueAt = new Date(values.dueAt).toISOString();
        if (values.note) body.note = values.note;
        await api(`tasks/${encodeURIComponent(task.id)}/requests`, { body });
      }, '已发出请求，等待对方回应'),
  });
}

function openCounterRequest(request) {
  openDialog({
    title: '还价',
    description: '只能改期限、粒度或说明。发起方确认后才落库；还价只有这一轮。',
    submitLabel: '提交还价',
    fields: [
      ...(request.role === 'subtask'
        ? [{ name: 'kind', label: '子任务类别', value: request.payload.kind ?? '', placeholder: 'supplier-check' }]
        : []),
      { name: 'dueAt', label: '截止时间（可空）', type: 'datetime-local' },
      { name: 'note', label: '说明（可空）', type: 'textarea' },
    ],
    onSubmit: (values) =>
      act(async () => {
        const body = {};
        if (values.kind) body.kind = values.kind;
        if (values.dueAt) body.dueAt = new Date(values.dueAt).toISOString();
        if (values.note) body.note = values.note;
        await api(`requests/${encodeURIComponent(request.id)}/counter`, { body });
      }, '已还价，等待发起方确认'),
  });
}

function openDeclineRequest(request) {
  openDialog({
    title: '拒绝协作请求',
    description: '拒绝会保留记录，发起方能看到原因。',
    submitLabel: '拒绝',
    fields: [{ name: 'reason', label: '原因（可选）', type: 'textarea' }],
    onSubmit: (values) => act(
      () => api(`requests/${encodeURIComponent(request.id)}/decline`, {
        body: { reason: values.reason || '' },
      }),
      '已拒绝请求',
    ),
  });
}

async function openAcceptInvitation(invitation) {
  let agents = state.myAgents;
  if (!agents.length) {
    agents = await api('agents')
      .then((items) => items.filter((item) => item.status === 'active'))
      .catch(() => []);
  }
  if (!agents.length) {
    toast('你还没有可用的智能体，请先在「我的智能体」里授权一个', 'error');
    return;
  }
  openDialog({
    title: '接受任务邀请',
    description: '选一个自己的智能体进入任务；之后它会在任务房间里工作。',
    submitLabel: '接受',
    fields: [{
      name: 'agent',
      label: '智能体',
      type: 'select',
      value: agents[0].agentPrincipalId,
      options: agents.map((agent) => ({
        value: agent.agentPrincipalId,
        label: agent.agentName || agent.agentPrincipalId,
      })),
    }],
    onSubmit: (values) => act(
      () => api(`task-invitations/${encodeURIComponent(invitation.id)}/accept`, {
        body: { agent: values.agent },
      }),
      '已接受邀请，选定的智能体已进入任务',
    ),
  });
}

function openDeclineInvitation(invitation) {
  openDialog({
    title: '拒绝任务邀请',
    description: '拒绝不会影响你在团队里的其他工作。',
    submitLabel: '拒绝',
    fields: [{ name: 'note', label: '说明（可选）', type: 'textarea' }],
    onSubmit: (values) => act(
      () => api(`task-invitations/${encodeURIComponent(invitation.id)}/decline`, {
        body: { note: values.note || '' },
      }),
      '已拒绝邀请',
    ),
  });
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
        el('span', { class: 'comment-person' },
          avatarNode(comment.authorName || comment.authorId, comment.authorAvatar, 'sm'),
          el('span', { class: 'comment-author' }, comment.authorName || comment.authorId)),
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
  knowledge_shared: '分享经验',
  comment_added: '发表评论',
  offer_published: '挂出开放子任务',
  offer_claimed: '认领开放子任务',
  offer_withdrawn: '撤回开放子任务',
  participant_invited: '邀请参与任务',
  participant_accepted: '接受任务邀请',
  participant_declined: '拒绝任务邀请',
  participant_agent_selected: '选定参与智能体',
  participant_revoked: '撤销任务参与',
  request_proposed: '发起协作请求',
  request_accepted: '接受协作请求',
  request_declined: '拒绝协作请求',
  request_countered: '协作请求还价',
  request_confirmed: '确认还价',
  request_withdrawn: '撤回协作请求',
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
    case 'knowledge_shared':
      return Array.isArray(payload.teamIds) ? `${payload.teamIds.length} 个团队` : null;
    case 'offer_published':
      return text(payload.kind);
    case 'offer_claimed':
      return text(payload.claimedBy) ?? text(payload.agent) ?? null;
    case 'participant_invited':
    case 'participant_revoked':
      return text(payload.humanPrincipalId);
    case 'participant_accepted':
    case 'participant_agent_selected':
      return text(payload.agentId);
    case 'request_proposed':
    case 'request_accepted':
    case 'request_confirmed':
      return [REQUEST_ROLE_LABEL[text(payload.role)] ?? text(payload.role), text(payload.to)]
        .filter(Boolean)
        .join(' · ');
    case 'request_countered':
      return text(payload.terms?.note) ?? REQUEST_ROLE_LABEL[text(payload.role)] ?? null;
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
    description: '遇到并解决的问题可以总结成经验。候选经验需要审核人批准、写明适用范围与有效期后才能被引用。',
    submitLabel: '生成候选',
    fields: [
      { name: 'content', label: '经验内容', type: 'textarea', required: true },
      { name: 'conditions', label: '适用条件', type: 'textarea', required: true },
    ],
    onSubmit: (values) =>
      act(async () => {
        await api(`tasks/${task.id}/knowledge`, { body: values, expectedVersion: task.version });
        state.view = 'knowledge';
        state.tab = hasRole('reviewer', 'admin') ? 'candidates' : 'published';
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
  const pendingInvites = state.aicdInvites.filter((invite) => invite.status === 'pending').length;
  const tabs = el('div', { class: 'tabs' },
    tabButton('aicds', '经验'),
    tabButton('published', '已发布'),
    hasRole('reviewer', 'admin') ? tabButton('candidates', `待审核 ${state.candidates.length ? `(${state.candidates.length})` : ''}`) : null,
    tabButton('invites', pendingInvites ? `复制邀请 (${pendingInvites})` : '复制邀请'));

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

  if (state.tab === 'aicds') return frag(tabs, renderAicds());
  if (state.tab === 'invites') return frag(tabs, renderAicdInvites());
  const body = state.tab === 'candidates' && hasRole('reviewer', 'admin')
    ? renderCandidates()
    : renderPublished();
  return frag(tabs, state.tab === 'published' ? search : null, body);
}

function renderAicds() {
  const filter = el('select', {
    onchange: (event) => {
      state.aicdState = event.target.value;
      refresh();
    },
  }, [
    ['', '全部状态'],
    ['draft', '草稿'],
    ['candidate', '待审核'],
    ['published', '已发布'],
    ['archived', '已归档'],
    ['revoked', '已撤销'],
  ].map(([value, label]) => {
    const node = el('option', { value }, label);
    if (value === state.aicdState) node.selected = true;
    return node;
  }));

  const toolbar = el('div', { class: 'toolbar' },
    filter,
    !isAgentSide() && !isGuest()
      ? el('button', { class: 'primary', type: 'button', onclick: openCreateAicd }, '新建经验')
      : null);

  if (!state.aicds.length) {
    return frag(toolbar, el('div', { class: 'empty' },
      '还没有经验。新建一条草稿，写清适用条件与有效期，再提交审核。'));
  }

  return frag(toolbar, el('div', { class: 'list' }, state.aicds.map((item) => {
    const mine = item.authorId === state.me.id;
    const manage = mine || hasRole('admin', 'reviewer');
    const personal = Boolean(state.tenant?.personal);
    return el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', { style: 'min-width:0' },
          el('p', { class: 'title' }, item.title || item.content.slice(0, 60)),
          item.summary ? el('p', { class: 'muted small' }, item.summary) : null),
        el('div', { class: 'row' },
          toneBadge(AICD_STATE_TONE[item.state] ?? 'muted', AICD_STATE_LABEL[item.state] ?? item.state),
          toneBadge('muted', AICD_KIND_LABEL[item.kind] ?? item.kind))),
      el('div', { class: 'meta' },
        el('span', {}, `v${item.version}`),
        el('span', {}, `作者 ${item.authorName || item.authorId}`),
        el('span', {}, EVIDENCE_LABEL[item.evidenceLevel] ?? item.evidenceLevel),
        item.expiresAt ? el('span', {}, `有效期至 ${formatDate(item.expiresAt)}`) : null,
        item.copiedFrom
          ? el('span', {},
            `复制自 ${item.copiedFrom.authorName || '成员'} · `
            + `${item.copiedFrom.personal ? '个人空间' : item.copiedFrom.workspaceName} v${item.copiedFrom.version}`)
          : null,
        el('span', {}, `更新 ${formatTime(item.updatedAt)}`)),
      item.sourceRevoked
        ? el('div', { class: 'note warn' }, '来源已被撤销：这份副本仍可用，但引用前请先复核。')
        : null,
      el('div', { class: 'row actions-row' }, aicdActionButtons(item, manage, personal)));
  })));
}

function aicdActionButtons(item, manage, personal) {
  const buttons = [
    el('button', { class: 'link', type: 'button', onclick: () => openAicdDetail(item.id) }, '详情'),
  ];
  if (manage && (item.state === 'draft' || item.state === 'candidate')) {
    buttons.push(el('button', { class: 'link', type: 'button', onclick: () => openEditAicd(item) }, '编辑'));
    buttons.push(el('button', {
      class: 'link danger',
      type: 'button',
      onclick: () => openDeleteAicd(item),
    }, '删除'));
    if (item.state === 'draft') {
      buttons.push(el('button', {
        class: 'link',
        type: 'button',
        onclick: () => openSubmitAicd(item),
      }, '提交审核'));
    } else if (personal || hasRole('reviewer', 'admin')) {
      buttons.push(el('button', {
        class: 'link',
        type: 'button',
        onclick: () => openPublishAicd(item),
      }, '发布'));
    }
  }
  if (manage && (item.state === 'published' || item.state === 'revoked')) {
    buttons.push(el('button', {
      class: 'link',
      type: 'button',
      onclick: () => openRevise(item),
    }, '修订'));
  }
  if (item.state === 'published') {
    buttons.push(el('button', {
      class: 'link',
      type: 'button',
      onclick: () => openCopyAicd(item),
    }, '复制'));
    if (manage) {
      buttons.push(el('button', {
        class: 'link',
        type: 'button',
        onclick: () => openInviteAicd(item),
      }, '邀请他人复制'));
    }
  }
  if (manage && item.state !== 'archived') {
    buttons.push(el('button', {
      class: 'link danger',
      type: 'button',
      onclick: () => openArchiveAicd(item),
    }, '归档'));
  }
  return buttons;
}

const AICD_KIND_OPTIONS = Object.entries(AICD_KIND_LABEL).map(([value, label]) => ({ value, label }));

function aicdFields(item = {}) {
  return [
    { name: 'kind', label: '类型', type: 'select', value: item.kind ?? 'experience', options: AICD_KIND_OPTIONS },
    { name: 'title', label: '标题', value: item.title ?? '', required: true, placeholder: '一句话说明它解决什么问题' },
    { name: 'summary', label: '摘要', value: item.summary ?? '', placeholder: '列表里展示的一句话' },
    { name: 'content', label: '正文', type: 'textarea', value: item.content ?? '', required: true },
    {
      name: 'conditions',
      label: '适用条件',
      type: 'textarea',
      value: item.conditions ?? '',
      required: true,
      placeholder: '什么时候适用、什么时候不要用',
    },
    { name: 'tags', label: '标签（逗号分隔）', value: (item.tags ?? []).join('，') },
  ];
}

function aicdBody(values) {
  return {
    kind: values.kind,
    title: values.title,
    summary: values.summary || undefined,
    content: values.content,
    conditions: values.conditions,
    tags: values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
  };
}

function openCreateAicd() {
  openDialog({
    title: '新建经验',
    description: state.tenant?.personal
      ? '先存成草稿；发布后在个人空间生效，再复制给团队。'
      : '先存成草稿；提交审核后由你、审核人或管理员发布。',
    submitLabel: '保存草稿',
    fields: aicdFields(),
    onSubmit: (values) => act(
      () => api('aicds', { body: aicdBody(values) }),
      '草稿已保存',
    ),
  });
}

function openEditAicd(item) {
  openDialog({
    title: '编辑经验',
    description: '草稿与待审核稿可以直接改。',
    submitLabel: '保存',
    fields: aicdFields(item),
    onSubmit: (values) => act(
      () => api(`aicds/${item.id}/edit`, { body: aicdBody(values), expectedVersion: item.version }),
      '已保存',
    ),
  });
}

function openSubmitAicd(item) {
  openDialog({
    title: '提交审核',
    description: '提交后状态变成待审核；发布前还能继续编辑。',
    submitLabel: '提交审核',
    fields: [],
    onSubmit: () => act(
      () => api(`aicds/${item.id}/submit`, { body: {}, expectedVersion: item.version }),
      '已提交审核',
    ),
  });
}

function openPublishAicd(item) {
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  openDialog({
    title: '发布经验',
    description: state.tenant?.personal
      ? '发布后先在个人空间生效，可以再复制给团队。'
      : '发布后，本团队的智能体能读到这条经验。',
    submitLabel: '发布',
    fields: [
      { name: 'expiresAt', label: '有效期至', type: 'date', value: expires, required: true },
    ],
    onSubmit: (values) => act(
      () => api(`aicds/${item.id}/publish`, {
        body: { expiresAt: new Date(`${values.expiresAt}T00:00:00Z`).toISOString() },
      }),
      '已发布',
    ),
  });
}

function openArchiveAicd(item) {
  openDialog({
    title: '归档经验',
    description: '归档后不再出现在常规列表，但版本、来源链与副本都保留。',
    submitLabel: '归档',
    fields: [{ name: 'reason', label: '原因', type: 'textarea', placeholder: '可选' }],
    onSubmit: (values) => act(
      () => api(`aicds/${item.id}/archive`, {
        body: { reason: values.reason || undefined },
        expectedVersion: item.version,
      }),
      '已归档',
    ),
  });
}

function openDeleteAicd(item) {
  openDialog({
    title: '删除经验',
    description: '删除后不可恢复；已有副本或被任务引用的条目不能删除。',
    submitLabel: '删除',
    fields: [],
    onSubmit: () => act(
      () => api(`aicds/${item.id}/delete`, { body: {}, expectedVersion: item.version }),
      '已删除',
    ),
  });
}

function openCopyAicd(item) {
  const options = state.tenants
    .filter((tenant) => !tenant.personal && ['owner', 'admin', 'member'].includes(tenant.role))
    .map((tenant) => ({
      value: tenant.id,
      label: `${tenant.name}（${tenant.id === state.tenant?.id ? '当前团队' : TENANT_ROLE_LABEL[tenant.role] ?? tenant.role}）`,
    }));
  if (!options.length) {
    toast('先加入一个团队，再把经验复制过去', 'error');
    return;
  }
  openDialog({
    title: '复制经验',
    description: '选择要复制到的团队；确认后会在目标团队生成一份独立草稿，取消则不会复制。',
    submitLabel: '复制',
    fields: [
      { name: 'targetWorkspace', label: '目标团队', type: 'select', options },
    ],
    onSubmit: (values) => act(
      () => api(`aicds/${item.id}/copy`, {
        body: { targetWorkspace: values.targetWorkspace },
        expectedVersion: item.version,
      }),
      '已复制为草稿',
    ),
  });
}

function openInviteAicd(item) {
  openDialog({
    title: '邀请他人复制',
    description: '对方接受后，会在其个人空间生成独立草稿；邀请 7 天内有效。',
    submitLabel: '发出邀请',
    fields: [
      { name: 'targetPrincipal', label: '对方主体 ID', required: true, placeholder: '对方的个人空间成员 ID' },
      { name: 'note', label: '附言', type: 'textarea', placeholder: '可选' },
    ],
    onSubmit: (values) => act(
      () => api(`aicds/${item.id}/invite`, {
        body: { targetPrincipal: values.targetPrincipal, note: values.note || undefined },
        expectedVersion: item.version,
      }),
      '邀请已发出',
    ),
  });
}

function openAicdDetail(id) {
  act(async () => {
    const [item, assets, copies, lineage] = await Promise.all([
      api(`aicds/${encodeURIComponent(id)}`),
      api(`aicds/${encodeURIComponent(id)}/assets`).catch(() => []),
      api(`aicds/${encodeURIComponent(id)}/copies`).catch(() => []),
      api(`aicds/${encodeURIComponent(id)}/lineage`).catch(() => []),
    ]);
    showPanel(
      item.title || '经验',
      `${AICD_KIND_LABEL[item.kind] ?? item.kind} · v${item.version} · ${EVIDENCE_LABEL[item.evidenceLevel] ?? item.evidenceLevel}`,
      el('div', { class: 'stack' },
        el('div', { class: 'row' },
          toneBadge(AICD_STATE_TONE[item.state] ?? 'muted', AICD_STATE_LABEL[item.state] ?? item.state),
          item.sourceRevoked ? toneBadge('danger', '来源已撤销') : null),
        item.summary ? el('p', {}, item.summary) : null,
        el('div', { class: 'result-box' }, item.content),
        item.conditions ? el('p', { class: 'muted' }, `适用：${item.conditions}`) : null,
        item.tags?.length ? el('p', { class: 'muted' }, `标签：${item.tags.join('、')}`) : null,
        el('dl', { class: 'kv' },
          el('dt', {}, '作者'),
          el('dd', {}, item.authorName || item.authorId),
          el('dt', {}, '空间'),
          el('dd', {}, item.sourceName || item.workspace),
          el('dt', {}, '更新时间'),
          el('dd', {}, formatTime(item.updatedAt)),
          item.expiresAt ? el('dt', {}, '有效期至') : null,
          item.expiresAt ? el('dd', {}, formatDate(item.expiresAt)) : null,
          item.archivedAt ? el('dt', {}, '归档时间') : null,
          item.archivedAt ? el('dd', {}, formatTime(item.archivedAt)) : null),
        item.copiedFrom
          ? el('div', { class: 'note' },
            `复制自 ${item.copiedFrom.authorName || '成员'} 的`
            + `${item.copiedFrom.personal ? '个人空间' : `团队 ${item.copiedFrom.workspaceName}`}`
            + ` v${item.copiedFrom.version}`)
          : null,
        item.sourceRevoked
          ? el('div', { class: 'note warn' },
            '来源已被撤销。这份副本仍然可用，但引用前请先复核内容是否仍然成立。')
          : null,
        lineage.length
          ? el('div', {},
            el('div', { class: 'section-title muted' }, '来源链'),
            el('div', { class: 'list' }, lineage.map((entry) =>
              el('div', { class: 'list-item static' },
                el('p', { class: 'title' }, entry.title || entry.id),
                el('div', { class: 'meta' },
                  el('span', {}, entry.workspaceName),
                  el('span', {}, `v${entry.version}`),
                  el('span', {}, AICD_STATE_LABEL[entry.state] ?? entry.state),
                  el('span', {}, formatTime(entry.copiedAt)))))))
          : null,
        copies.length
          ? el('div', {},
            el('div', { class: 'section-title muted' }, '副本去向'),
            el('div', { class: 'list' }, copies.map((copy) =>
              el('div', { class: 'list-item static' },
                el('p', { class: 'title' }, copy.workspaceName),
                el('div', { class: 'meta' },
                  el('span', {}, copy.personal ? '个人空间' : '团队空间'),
                  el('span', {}, AICD_STATE_LABEL[copy.state] ?? copy.state),
                  el('span', {}, formatTime(copy.copiedAt)))))))
          : null,
        assets.length
          ? el('div', {},
            el('div', { class: 'section-title muted' }, '证据附件'),
            el('div', { class: 'list' }, assets.map((asset) =>
              el('div', { class: 'list-item static' },
                el('div', { class: 'row spread' },
                  el('span', {}, asset.name),
                  el('button', {
                    class: 'link',
                    type: 'button',
                    onclick: () => downloadSpaceFile(asset.taskId, asset),
                  }, '下载')),
                el('div', { class: 'meta' },
                  el('span', {}, asset.role === 'evidence' ? '证据' : '附件'),
                  el('span', {}, formatBytes(asset.size)),
                  el('span', { class: 'mono muted' }, asset.sha256.slice(0, 12)))))))
          : null),
    );
  }, '');
}

function renderAicdInvites() {
  if (!state.aicdInvites.length) {
    return el('div', { class: 'empty' }, '没有复制邀请。别人把经验复制给你时，会先在这里等你接受。');
  }
  const personal = Boolean(state.tenant?.personal);
  return el('div', { class: 'list' }, state.aicdInvites.map((invite) => {
    const pending = invite.status === 'pending';
    return el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('div', { style: 'min-width:0' },
          el('p', { class: 'title' }, invite.title || invite.knowledgeId),
          invite.summary ? el('p', { class: 'muted small' }, invite.summary) : null),
        toneBadge(pending ? 'warn' : 'muted',
          pending ? '待接受' : invite.status === 'accepted' ? '已接受' : invite.status === 'declined' ? '已拒绝' : '已过期')),
      el('div', { class: 'meta' },
        el('span', {}, `来自 ${invite.fromName || invite.fromPrincipal}`),
        invite.sourceName ? el('span', {}, `来源 ${invite.sourceName}`) : null,
        el('span', {}, `v${invite.version}`),
        el('span', {}, `有效至 ${formatDate(invite.expiresAt)}`)),
      invite.note ? el('p', { class: 'muted' }, invite.note) : null,
      pending
        ? el('div', { class: 'row actions-row' },
          !personal ? el('span', { class: 'muted small' }, '接受前请切换到个人空间') : null,
          el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => act(
              () => api(`me/copy-invites/${invite.id}/accept`, { body: {} }),
              '已复制到个人空间',
            ),
          }, '接受'),
          el('button', {
            class: 'link',
            type: 'button',
            onclick: () => act(
              () => api(`me/copy-invites/${invite.id}/decline`, { body: {} }),
              '已拒绝',
            ),
          }, '拒绝'))
        : null);
  }));
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
  if (!state.knowledge.length) {
    return el(
      'div',
      { class: 'empty' },
      state.tenant?.personal
        ? '个人空间还没有发布经验。完成任务后可以沉淀，再分享给团队。'
        : '团队还没有发布经验。',
    );
  }
  return el('div', { class: 'list' }, state.knowledge.map((item) => {
    const sharedIn = item.workspace !== state.me.workspace;
    const source = item.sourcePersonal
      ? `${item.authorName ?? '成员'} 的个人经验`
      : `${item.sourceName ?? '其他团队'} 的经验`;
    const manageable = !sharedIn && hasRole('reviewer', 'admin');
    const personal = Boolean(state.tenant?.personal) && !sharedIn;
    return el('div', { class: 'list-item static' },
      el('div', { class: 'row spread top' },
        el('p', { class: 'statement' }, item.content),
        badge('published')),
      el('div', { class: 'meta' },
        el('span', {}, `v${item.version}`),
        sharedIn ? el('span', {}, `来自 ${source}`) : null,
        el('span', {}, `适用：${item.conditions}`),
        el('span', {}, `有效期至 ${formatDate(item.expiresAt)}`),
        personal && item.sharedTeams?.length
          ? el('span', {}, `已分享给 ${item.sharedTeams.length} 个团队`)
          : null,
        el('span', { class: 'mono muted', title: `经验编号 ${item.id}` }, item.id.slice(0, 8))),
      manageable
        ? el('div', { class: 'row actions-row' },
          el('button', { class: 'link', type: 'button', onclick: () => openRevise(item) }, '修订'),
          personal
            ? el('button', { class: 'link', type: 'button', onclick: () => openShareKnowledge(item) }, '分享给团队')
            : el('button', { class: 'link', type: 'button', onclick: () => openAccess(item) }, '调整范围'),
          el('button', { class: 'link', type: 'button', onclick: () => openVersions(item) }, '版本历史'),
          el('button', { class: 'link danger', type: 'button', onclick: () => openArchiveAicd(item) }, '归档'),
          el('button', { class: 'link danger', type: 'button', onclick: () => openRevoke(item) }, '撤销'))
        : null,
    );
  }));
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
        el('span', {}, `来自 ${item.authorName || item.authorId}`),
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
    description: state.tenant?.personal
      ? '发布后先在个人空间生效，可再分享给团队。'
      : '发布后，本团队的智能体能读到这条经验。',
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

function openShareKnowledge(item) {
  act(async () => {
    let shares = [];
    try {
      const result = await api(`knowledge/${item.id}/shares`);
      shares = result.teams ?? [];
    } catch {
      shares = item.sharedTeams ?? [];
    }
    const options = state.tenants
      .filter((tenant) => !tenant.personal && ['owner', 'admin', 'member'].includes(tenant.role))
      .map((tenant) => ({
        value: tenant.id,
        label: `${tenant.name}（${TENANT_ROLE_LABEL[tenant.role] ?? tenant.role}）`,
      }));
    for (const team of shares) {
      if (!options.some((option) => option.value === team.id)) {
        options.push({ value: team.id, label: `${team.name}（已停用或已退出）` });
      }
    }
    if (!options.length) {
      toast('先创建或加入一个团队，再分享经验', 'error');
      return;
    }
    openDialog({
      title: '分享经验给团队',
      description: '目标团队的成员能看到这条经验；团队经验不能反向带出。取消勾选即可撤回。',
      fields: [{
        name: 'teamIds',
        label: '目标团队',
        type: 'checkbox-group',
        value: shares.map((team) => team.id),
        options,
      }],
      submitLabel: '保存',
      onSubmit: (values) =>
        act(() => api(`knowledge/${item.id}/shares`, { body: { teamIds: values.teamIds } }), '分享已更新'),
    });
  }, '');
}

/** 行级差异：版本正文都不大，用 LCS 回溯；超长时退回逐行比较。 */
function lineDiff(before, after) {
  const left = String(before ?? '').split('\n');
  const right = String(after ?? '').split('\n');
  if (left.length + right.length > 4000) {
    const rows = [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if (left[index] === right[index]) {
        rows.push({ type: 'same', text: left[index] ?? '' });
      } else {
        if (left[index] !== undefined) rows.push({ type: 'del', text: left[index] });
        if (right[index] !== undefined) rows.push({ type: 'add', text: right[index] });
      }
    }
    return rows;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const diff = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      diff.push({ type: 'same', text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      diff.push({ type: 'del', text: left[i] });
      i += 1;
    } else {
      diff.push({ type: 'add', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) diff.push({ type: 'del', text: left[i++] });
  while (j < right.length) diff.push({ type: 'add', text: right[j++] });
  return diff;
}

function openVersionDiff(from, to) {
  const diff = lineDiff(from.content, to.content);
  const added = diff.filter(row => row.type === 'add').length;
  const removed = diff.filter(row => row.type === 'del').length;
  showPanel(
    `版本对比 · v${from.version} → v${to.version}`,
    `新增 ${added} 行，删除 ${removed} 行`,
    el('div', { class: 'diff' }, diff.map(row => el('div', { class: `diff-line ${row.type}` },
      el('span', { class: 'diff-sign' }, row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '),
      el('span', {}, row.text || ' ')))),
  );
}

function openVersions(item) {
  act(async () => {
    const versions = await api(`knowledge/${item.id}/versions`);
    showPanel(
      `版本历史 · ${item.id.slice(0, 8)}`,
      '',
      el('div', { class: 'stack' }, versions.map((version, index) =>
        el('div', { class: 'result-box' },
          el('div', { class: 'row spread top' },
            el('div', { class: 'mono' }, `v${version.version} · ${formatTime(version.publishedAt)}`),
            index > 0
              ? el('button', {
                class: 'link',
                type: 'button',
                onclick: () => openVersionDiff(versions[index - 1], version),
              }, `与 v${versions[index - 1].version} 对比`)
              : null),
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
        el('div', { class: 'person' },
          avatarNode(member.displayName || member.principalId, member.avatar, 'sm'),
          el('div', {},
            el('div', { class: 'row', style: 'gap:8px;align-items:baseline' },
              el('strong', {}, member.displayName || member.principalId),
              self ? el('span', { class: 'badge', dataset: { tone: 'muted' } }, '你') : null,
              member.active ? null : el('span', { class: 'badge', dataset: { tone: 'danger' } }, '已停用')),
            member.title ? el('div', { class: 'muted small' }, member.title) : null,
            el('div', { class: 'muted small mono' },
              member.email ?? (member.did ? `did:wba:…${member.did.slice(-12)}` : member.principalId))))),
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

  const spaces = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, '我加入的团队与空间'),
      toneBadge('muted', `${state.tenants.length} 个`)),
    state.tenants.length
      ? el('div', { class: 'list' }, state.tenants.map((space) =>
          el('div', { class: 'list-row' },
            el('div', {},
              el('strong', {}, tenantLabel(space)),
              el('div', { class: 'muted small' },
                `${TENANT_ROLE_LABEL[space.role] ?? space.role}` +
                (space.status === 'suspended' ? ' · 已停用' : '') +
                (space.id === state.me.workspace ? ' · 当前' : ''))),
            space.id === state.me.workspace
              ? null
              : el('button', {
                  type: 'button',
                  class: 'ghost small',
                  onclick: () => act(() => switchTenant(space.id), `已切换到「${tenantLabel(space)}」`),
                }, '进入'))))
      : el('div', { class: 'empty' }, '还没有加入任何团队。'));

  return frag(
    spaces,
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, tenantLabel(tenant ?? state.tenant)),
        toneBadge(
          tenant?.role === 'owner' ? 'active' : tenant?.role === 'admin' ? 'ok' : 'muted',
          TENANT_ROLE_LABEL[tenant?.role ?? state.me.tenantRole] ?? '成员')),
      el('p', { class: 'hint tight' },
        tenant?.personal
          ? '这是你的个人空间，只属于你。个人任务的经验可以分享给团队。'
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
        applySession(result);
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
        el('h3', {}, '个人资料'),
        el('div', { class: 'row' },
          toneBadge('muted', KIND_LABEL[me.kind] ?? me.kind ?? '主体'),
          el('button', { class: 'ghost small', type: 'button', onclick: openProfileEditor }, '编辑资料'))),
      el('div', { class: 'profile-head' },
        avatarNode(me.displayName || me.id, me.avatar, 'lg'),
        el('div', { class: 'profile-text' },
          el('strong', { class: 'profile-name' }, me.displayName || me.id),
          me.title
            ? el('div', { class: 'profile-title' }, me.title)
            : el('div', { class: 'muted small' }, '还没有头衔'),
          me.bio
            ? el('p', { class: 'profile-bio' }, me.bio)
            : el('p', { class: 'muted small' }, '写一句介绍，让别人知道你在做什么。'))),
      el('dl', { class: 'kv', style: 'margin-top:18px' },
        el('dt', {}, '角色'), el('dd', {}, roleText(me.roles)),
        el('dt', {}, 'DID'), el('dd', {}, el('span', { class: 'mono' }, me.did || '未绑定')),
        el('dt', {}, '主体'), el('dd', {}, el('span', { class: 'mono' }, me.id))),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', onclick: openProfileEditor }, '编辑资料')),
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

/** 把选中的图片裁成正方形并压到请求体允许的大小内；返回 data URL。 */
function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) return reject(new Error('请选择图片文件'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('图片太大，请选择 8MB 以内的图片'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('这张图片无法解析'));
      image.onload = () => {
        if (!image.width || !image.height) return reject(new Error('图片尺寸无效'));
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('浏览器无法处理这张图片'));
        const side = Math.min(image.width, image.height);
        ctx.drawImage(
          image,
          (image.width - side) / 2,
          (image.height - side) / 2,
          side,
          side,
          0,
          0,
          256,
          256,
        );
        let data = canvas.toDataURL('image/webp', 0.82);
        if (data.length > 48000) data = canvas.toDataURL('image/webp', 0.6);
        if (data.length > 48000) return reject(new Error('图片太复杂，请换一张更简单的小图'));
        resolve(data);
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function openProfileEditor() {
  const dialog = document.getElementById('dialog');
  const me = state.me;
  const nameInput = el('input', {
    id: 'profile-name',
    type: 'text',
    maxlength: '40',
    value: me.displayName || '',
    placeholder: '你的姓名或昵称',
  });
  const titleInput = el('input', {
    id: 'profile-title',
    type: 'text',
    maxlength: '60',
    value: me.title || '',
    placeholder: '例如：履约负责人',
  });
  const bioInput = el('textarea', {
    id: 'profile-bio',
    maxlength: '280',
    placeholder: '一两句话介绍你的职责或擅长的事',
  });
  bioInput.value = me.bio || '';
  const urlInput = el('input', {
    id: 'profile-avatar-url',
    type: 'url',
    value: me.avatar && /^https?:/i.test(me.avatar) ? me.avatar : '',
    placeholder: 'https://…（可选）',
  });
  const fileInput = el('input', {
    id: 'profile-avatar-file',
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
  });
  let uploaded = '';

  const preview = el('div', { class: 'avatar-preview' });
  const paint = () => {
    preview.replaceChildren(
      avatarNode(nameInput.value.trim() || me.displayName || me.id, uploaded || urlInput.value.trim(), 'lg'),
    );
  };
  paint();

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      uploaded = await resizeAvatar(file);
      urlInput.value = '';
      paint();
    } catch (error) {
      fileInput.value = '';
      toast(error.message, 'error');
    }
  });
  urlInput.addEventListener('input', () => {
    if (urlInput.value.trim()) uploaded = '';
    paint();
  });
  nameInput.addEventListener('input', paint);

  const form = el(
    'form',
    { method: 'dialog' },
    el('h3', {}, '编辑个人资料'),
    el('p', { class: 'muted' },
      '姓名、头像、头衔和简介会显示在侧栏、成员列表与评论里；同一账号加入的团队会一起更新。'),
    el('div', { class: 'profile-avatar-edit' },
      preview,
      el('div', { class: 'stack' },
        el('label', { class: 'field' }, el('span', {}, '上传图片'), fileInput),
        el('label', { class: 'field' }, el('span', {}, '或用图片地址'), urlInput),
        el('button', {
          class: 'link danger',
          type: 'button',
          onclick: () => {
            uploaded = '';
            urlInput.value = '';
            fileInput.value = '';
            paint();
          },
        }, '移除头像'))),
    el('label', { class: 'field', for: 'profile-name' }, el('span', {}, '姓名'), nameInput),
    el('label', { class: 'field', for: 'profile-title' }, el('span', {}, '头衔'), titleInput),
    el('label', { class: 'field', for: 'profile-bio' }, el('span', {}, '简介'), bioInput),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'ghost', onclick: () => dialog.close() }, '取消'),
      el('button', { type: 'submit', class: 'primary' }, '保存')),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!nameInput.value.trim()) {
      toast('姓名不能为空', 'error');
      return;
    }
    const body = {
      displayName: nameInput.value.trim(),
      avatar: uploaded || urlInput.value.trim(),
      title: titleInput.value.trim(),
      bio: bioInput.value.trim(),
    };
    dialog.close();
    await act(async () => {
      await api('me/profile', { body });
      state.me = await api('me');
      renderIdentity();
    }, '资料已更新');
  });

  dialog.replaceChildren(form);
  dialog.showModal();
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
        value: ['tasks:read', 'tasks:submit', 'offers:claim', 'comments:write', 'presence:write'],
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

/** 这句话是念给智能体听的：人复制它，贴进对话即可。 */
function agentHandoffText() {
  return `读取这个链接里的 SKILL.md，按里面的步骤接入 Anpio Collab：${agentSkillUrl()}`;
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

/** 智能体的接入物是一个文件：话装在一个框里，复制在框外。 */
function skillHandoff() {
  const url = agentSkillUrl();
  return el('div', { class: 'agent-handoff' },
    el('p', { class: 'handoff-line' },
      '读取这个链接里的 SKILL.md，按里面的步骤接入 Anpio Collab：',
      el('a', { href: url, target: '_blank', rel: 'noopener' }, url)),
    el('button', {
      class: 'ghost small',
      type: 'button',
      onclick: () => copyText(agentHandoffText(), '已复制，发给智能体即可'),
    }, '复制'));
}

// ---------------------------------------------------------------- 内置智能体

const PROTOCOL_LABEL = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'gemini-generate': 'Gemini Generate',
  'gemini-interactions': 'Gemini Interactions',
  'workers-ai': 'Workers AI',
  'decision-jev': 'Jev 决策',
  'subscription-cli': '订阅 CLI',
  script: '脚本（演示）',
};

const EMBEDDED_TOOL_LABEL = {
  task_get: '读取任务',
  task_accept: '接受子任务',
  task_progress: '记录进度',
  task_submit: '提交结果',
  task_comment: '发表评论',
  knowledge_search: '检索经验',
  shell: '执行 shell',
  read_file: '读文件',
  write_file: '写文件',
  list_files: '列目录',
  finish: '结束本轮',
};

const EMBEDDED_DEFAULT_TOOLS = [
  'task_get', 'task_accept', 'task_progress', 'task_submit', 'task_comment',
  'knowledge_search', 'read_file', 'list_files', 'finish',
];

const RUN_LABEL = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  timeout: '超时',
  outcome_unknown: '结果未知',
};
const RUN_TONE = {
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  timeout: 'warn',
  outcome_unknown: 'warn',
};

/** 自定义供应商没有默认端点，协议要让用户自己选，否则会落到 OpenAI Chat。 */
function customProtocol(providerId) {
  return {
    'custom-openai-chat': 'openai-chat',
    'custom-openai-responses': 'openai-responses',
    'custom-anthropic': 'anthropic-messages',
    'custom-gemini': 'gemini-generate',
    'custom-gemini-interactions': 'gemini-interactions',
    'custom-jev': 'decision-jev',
  }[providerId] ?? 'openai-chat';
}

function embeddedProviderGroups() {
  const categories = ['厂商', '订阅', '分发站', '自定义'];
  const groups = categories.map((category) => ({
    label: category,
    options: state.embeddedProviders
      .filter((provider) => provider.category === category)
      .map((provider) => ({
        value: provider.id,
        label: provider.vendor === provider.label ? provider.label : `${provider.label} · ${provider.vendor}`,
      })),
  }));
  return groups.filter((group) => group.options.length);
}

function agentState(agent) {
  if (agent.running > 0) return ['info', '运行中'];
  if (!agent.enabled) return ['muted', '已停用'];
  if (agent.lastError) return ['danger', '上次失败'];
  return ['ok', '睡着'];
}

function durationText(run) {
  if (!run?.startedAt) return '—';
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

const embeddedLogText = (logs) =>
  logs.length
    ? logs.map((entry) => `${entry.at} ${entry.level.toUpperCase()} ${entry.text}`).join('\n')
    : '（还没有日志）';

let embeddedTimer = null;

function stopEmbeddedPolling() {
  if (embeddedTimer !== null) {
    clearInterval(embeddedTimer);
    embeddedTimer = null;
  }
}

/** 运行中每 2.5 秒补一次日志；跑完就停，不在后台空转。 */
function startEmbeddedPolling() {
  if (embeddedTimer !== null) return;
  embeddedTimer = setInterval(() => void pollEmbeddedRun(), 2500);
  embeddedTimer?.unref?.();
}

async function pollEmbeddedRun() {
  const runId = state.embeddedRunId;
  if (!runId) return;
  try {
    const [run, logs] = await Promise.all([
      api(`embedded/runs/${encodeURIComponent(runId)}`),
      api(`embedded/runs/${encodeURIComponent(runId)}/log?limit=100`),
    ]);
    if (state.embeddedRunId !== runId) return;
    state.embeddedRun = run;
    state.embeddedLogs = logs;
    const pre = document.getElementById('embedded-run-log');
    if (pre) pre.textContent = embeddedLogText(logs);
    const status = document.getElementById('embedded-run-status');
    if (status) {
      status.replaceChildren(toneBadge(RUN_TONE[run.status] ?? 'muted', RUN_LABEL[run.status] ?? run.status));
    }
    if (run.status !== 'running') {
      stopEmbeddedPolling();
      await refresh();
    }
  } catch {
    stopEmbeddedPolling();
  }
}

function selectEmbeddedAgent(agentId) {
  state.embeddedAgentId = agentId;
  state.embeddedRunId = '';
  state.embeddedRun = null;
  state.embeddedLogs = [];
  void refresh();
}

function selectEmbeddedRun(runId) {
  state.embeddedRunId = runId;
  state.embeddedRun = null;
  state.embeddedLogs = [];
  void refresh();
}

async function toggleEmbeddedAgent(agent) {
  await act(async () => {
    await api(`embedded/agents/${encodeURIComponent(agent.id)}/${agent.enabled ? 'disable' : 'enable'}`, {
      body: {},
    });
  }, agent.enabled ? '已停用' : '已启用');
}

async function runEmbeddedAgent(agent) {
  await act(async () => {
    const run = await api(`embedded/agents/${encodeURIComponent(agent.id)}/run`, {
      body: {},
      operationId: `ui-run:${agent.id}:${Date.now()}`,
    });
    state.embeddedAgentId = agent.id;
    state.embeddedRunId = run.id;
  }, '已创建一轮运行，supervisor 会来接管');
}

function openEmbeddedEditor(agent) {
  const providers = state.embeddedProviders;
  const fallback = providers.find((provider) => provider.id === 'script') ?? providers[0];
  const providerId = agent?.provider.id ?? fallback?.id ?? 'script';
  const provider = providers.find((item) => item.id === providerId);
  const protocol = agent?.provider.protocol ?? provider?.endpoints[0]?.protocol ?? customProtocol(providerId);
  const apiKeyEnv = agent ? (agent.provider.apiKeyEnv ?? '') : (provider?.keyEnv ?? '');

  openDialog({
    title: agent ? `编辑「${agent.name}」` : '新建内置智能体',
    description: '定义只保存模型与密钥的环境变量名，密钥本身留在运行时的环境里。',
    submitLabel: agent ? '保存' : '创建',
    fields: [
      { name: 'name', label: '名称', value: agent?.name ?? '', required: true },
      { name: 'description', label: '描述', type: 'textarea', value: agent?.description ?? '' },
      {
        name: 'capabilities',
        label: '能力（逗号分隔）',
        value: (agent?.capabilities ?? []).join(', '),
        placeholder: 'inventory:read, supplier:contact',
      },
      { name: 'provider', label: '供应商', type: 'select', groups: embeddedProviderGroups(), value: providerId },
      {
        name: 'protocol',
        label: '协议',
        type: 'select',
        options: Object.entries(PROTOCOL_LABEL).map(([value, label]) => ({ value, label })),
        value: protocol,
      },
      { name: 'model', label: '模型', value: agent?.provider.model ?? provider?.defaultModel ?? '' },
      {
        name: 'baseUrl',
        label: 'Base URL（自定义必填；留空使用默认地址）',
        value: agent?.provider.baseUrl ?? provider?.endpoints[0]?.baseUrl ?? '',
      },
      { name: 'apiKeyEnv', label: '密钥环境变量名（只存名字）', value: apiKeyEnv },
      { name: 'systemPrompt', label: '系统提示', type: 'textarea', value: agent?.systemPrompt ?? '' },
      {
        name: 'tools',
        label: '可用工具',
        type: 'checkbox-group',
        options: Object.entries(EMBEDDED_TOOL_LABEL).map(([value, label]) => ({ value, label })),
        value: agent?.tools ?? EMBEDDED_DEFAULT_TOOLS,
      },
      { name: 'maxTurns', label: '最多轮次', type: 'number', value: agent?.limits.maxTurns ?? 8 },
      { name: 'timeoutMs', label: '超时（毫秒）', type: 'number', value: agent?.limits.timeoutMs ?? 120000 },
      { name: 'concurrency', label: '并发', type: 'number', value: agent?.concurrency ?? 1 },
    ],
    onSubmit: async (values) => {
      const tools = values.tools ?? [];
      const body = {
        name: values.name.trim(),
        description: values.description ?? '',
        capabilities: String(values.capabilities ?? '')
          .split(/[,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        provider: {
          id: values.provider,
          protocol: values.protocol,
          model: values.model.trim(),
          ...(values.baseUrl.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
          apiKeyEnv: values.apiKeyEnv.trim() || null,
        },
        systemPrompt: values.systemPrompt ?? '',
        tools,
        limits: {
          maxTurns: Number(values.maxTurns),
          timeoutMs: Number(values.timeoutMs),
        },
        sandbox: { shell: tools.includes('shell') },
        concurrency: Number(values.concurrency),
      };
      await act(async () => {
        if (agent) {
          await api(`embedded/agents/${encodeURIComponent(agent.id)}/update`, { body });
        } else {
          const created = await api('embedded/agents', { body });
          state.embeddedAgentId = created.id;
          state.embeddedRunId = '';
        }
      }, agent ? '已保存' : '已创建');
    },
  });

  // 换供应商时把默认协议、地址、模型、密钥变量名带出来，少让人查文档。
  const dialog = document.getElementById('dialog');
  const select = dialog.querySelector('#field-provider');
  if (!select) return;
  select.addEventListener('change', () => {
    const chosen = providers.find((item) => item.id === select.value);
    if (!chosen) return;
    const endpoint = chosen.endpoints[0];
    dialog.querySelector('#field-protocol').value = endpoint?.protocol ?? customProtocol(chosen.id);
    dialog.querySelector('#field-model').value = chosen.defaultModel ?? '';
    dialog.querySelector('#field-baseUrl').value = endpoint?.baseUrl ?? '';
    dialog.querySelector('#field-apiKeyEnv').value = chosen.keyEnv ?? '';
  });
}

function renderEmbedded() {
  if (!hasRole('admin', 'owner')) return el('div', { class: 'empty' }, '只有管理员或负责人可以管理内置智能体。');

  const status = state.embeddedStatus ?? { agents: [], supervisors: [], activeRuns: 0 };
  const agents = status.agents ?? [];
  const taken = new Set(agents.map((agent) => agent.id));
  if (state.embeddedAgentId && !taken.has(state.embeddedAgentId)) state.embeddedAgentId = agents[0]?.id ?? '';
  const selected = agents.find((agent) => agent.id === state.embeddedAgentId) ?? null;
  const supervisor = status.supervisors?.[0];
  const running = state.embeddedRun;
  if (running?.status === 'running') startEmbeddedPolling();
  else stopEmbeddedPolling();

  const agentRow = (agent) => {
    const [tone, label] = agentState(agent);
    const active = agent.id === state.embeddedAgentId;
    return el('tr', {},
      el('td', {},
        el('button', {
          type: 'button',
          class: 'link',
          style: 'text-align:left',
          onclick: () => selectEmbeddedAgent(agent.id),
          'aria-current': active ? 'true' : 'false',
        }, el('strong', {}, agent.name)),
        agent.description
          ? el('div', { class: 'muted small', title: agent.description }, agent.description.slice(0, 80))
          : null),
      el('td', {},
        el('div', {}, agent.provider.model || '—'),
        el('div', { class: 'muted small' }, `${agent.provider.id} · ${PROTOCOL_LABEL[agent.provider.protocol] ?? agent.provider.protocol}`)),
      el('td', { class: 'muted small' }, (agent.capabilities ?? []).join('、') || '—'),
      el('td', {}, toneBadge(tone, label)),
      el('td', {}, agent.unread > 0 ? toneBadge('warn', `${agent.unread} 封`) : el('span', { class: 'muted' }, '0')),
      el('td', { class: 'muted small nowrap' }, agent.lastRunAt ? formatTime(agent.lastRunAt) : '还没跑过'),
      el('td', {},
        el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          el('button', {
            type: 'button',
            class: 'ghost small',
            disabled: !agent.enabled || agent.running > 0,
            onclick: () => runEmbeddedAgent(agent),
          }, '立即运行'),
          el('button', {
            type: 'button',
            class: 'ghost small',
            onclick: () => openEmbeddedEditor(agent),
          }, '编辑'),
          el('button', {
            type: 'button',
            class: 'ghost small',
            onclick: () => toggleEmbeddedAgent(agent),
          }, agent.enabled ? '停用' : '启用'))),
    );
  };

  const runs = state.embeddedRuns ?? [];
  const runRow = (run) => el('tr', {},
    el('td', {},
      el('button', {
        type: 'button',
        class: 'link mono',
        onclick: () => selectEmbeddedRun(run.id),
      }, run.id.slice(0, 12))),
    el('td', {}, toneBadge(RUN_TONE[run.status] ?? 'muted', RUN_LABEL[run.status] ?? run.status)),
    el('td', { class: 'muted small nowrap' }, formatTime(run.startedAt)),
    el('td', { class: 'muted small nowrap' }, durationText(run)),
    el('td', { class: 'muted small' }, `${run.turns} 步`),
    el('td', { class: 'muted small' }, `${run.promptTokens + run.completionTokens} tok`));

  const runsCard = selected
    ? el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, `${selected.name} 的运行记录`),
        el('span', { class: 'muted' }, runs.length ? `最近 ${runs.length} 次` : '还没有运行')),
      runs.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, '运行'), el('th', {}, '状态'), el('th', {}, '开始'),
              el('th', {}, '耗时'), el('th', {}, '步数'), el('th', {}, 'token'))),
            el('tbody', {}, runs.map(runRow))))
        : el('div', { class: 'empty' }, '还没有运行记录。收到任务或信箱消息后会自己醒来。'),
      running
        ? el('div', { style: 'margin-top:16px' },
            el('div', { class: 'card-head' },
              el('h3', {}, '本轮日志'),
              el('span', { id: 'embedded-run-status' },
                toneBadge(RUN_TONE[running.status] ?? 'muted', RUN_LABEL[running.status] ?? running.status))),
            el('div', { class: 'muted small', style: 'margin:6px 0' },
              `${running.id} · ${durationText(running)} · ${running.turns} 步 · ` +
              `${running.promptTokens + running.completionTokens} token` +
              (running.exitCode === null ? '' : ` · 退出码 ${running.exitCode}`)),
            running.error ? el('p', { class: 'error' }, running.error) : null,
            el('pre', { id: 'embedded-run-log', class: 'log' }, embeddedLogText(state.embeddedLogs ?? [])))
        : null)
    : null;

  return frag(
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '内置智能体'),
        el('div', { class: 'row', style: 'gap:8px' },
          el('button', { id: 'embedded-new', type: 'button', class: 'primary small', onclick: () => openEmbeddedEditor(null) }, '新建'),
          el('button', {
            id: 'embedded-refresh',
            type: 'button',
            class: 'ghost small',
            onclick: () => act(async () => undefined, '已刷新'),
          }, '刷新'))),
      el('p', { class: 'muted small', style: 'margin-bottom:12px' },
        `${agents.filter((agent) => agent.enabled).length} 个启用 · ${status.activeRuns ?? 0} 轮在跑 · ` +
        (supervisor
          ? `supervisor 最近心跳 ${formatTime(supervisor.lastSeenAt)}（${supervisor.host}）`
          : '还没有 supervisor 连接；运行 npm run runtime 后，有未读消息的智能体会被叫醒。')),
      agents.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, '定义'), el('th', {}, '模型'), el('th', {}, '能力'),
              el('th', {}, '状态'), el('th', {}, '未读'), el('th', {}, '最近运行'), el('th', {}, ''))),
            el('tbody', {}, agents.map(agentRow))))
        : el('div', { class: 'empty' }, '还没有内置智能体定义。新建一个，或用 agents.json 导入。')),

    runsCard,
  );
}

// ---------------------------------------------------------------- 审计

const OUTCOME_LABEL = { success: '成功', replay: '幂等重放', read: '读取' };
const OUTCOME_TONE = { success: 'ok', replay: 'muted', read: 'muted' };

/** 路径里的 UUID 只留前 8 位，否则审计表会被长串编号撑开。 */
const shortPath = (path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => id.slice(0, 8));

function renderAudit() {
  if (!hasRole('admin')) return el('div', { class: 'empty' }, '只有管理员可以查看审计。');
  const report = state.auditReport;
  const summary = report
    ? el('div', { class: 'grid' },
      statCard('近 7 天操作', report.totals.entries, '写操作、重放、拒绝与敏感读取'),
      statCard('被拒绝', report.totals.denied,
        report.totals.entries ? `${Math.round((report.totals.denied / report.totals.entries) * 100)}%` : '0%'),
      statCard('覆盖天数', report.byDay.length, `${report.days} 天窗口`),
      statCard('活跃主体', report.topPrincipals.length, '按记录数取前 20'))
    : null;
  const byAction = report?.byAction.length
    ? el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, '按接口'),
        el('span', { class: 'muted' }, `自 ${formatTime(report.since)} 起`)),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '接口'), el('th', {}, '次数'), el('th', {}, '被拒绝'))),
        el('tbody', {}, report.byAction.slice(0, 12).map(item =>
          el('tr', {},
            el('td', { class: 'mono', title: item.action }, shortPath(item.action)),
            el('td', {}, String(item.total)),
            el('td', {}, item.denied ? el('span', { class: 'badge', dataset: { tone: 'danger' } }, String(item.denied)) : '—')))))))
    : null;
  if (!state.audit.length) {
    return frag(summary, byAction, el('div', { class: 'empty' }, '暂无记录。'));
  }
  return frag(
    summary,
    byAction,
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
