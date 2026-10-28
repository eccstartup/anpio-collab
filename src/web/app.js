/**
 * Anpio Collab 管理台。
 *
 * 无构建、无框架：一个文件完成路由、渲染和动作。
 * 约定：
 *  - 所有网络请求经过 api()，写请求自动带 Idempotency-Key；
 *  - 渲染只用 DOM 节点拼接，不用 innerHTML 插入服务端内容；
 *  - 每个动作失败时把服务端的中文错误原样显示，不做二次包装。
 */

const API_ROOT = '/v1';
const VIEWS = [
  { id: 'home', label: '工作台' },
  { id: 'tasks', label: '任务' },
  { id: 'knowledge', label: '经验库' },
  { id: 'directory', label: '参与者' },
  { id: 'audit', label: '审计' },
];

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
};

const ROLE_LABEL = { admin: '管理员', owner: '负责人', agent: '智能体', reviewer: '审核人' };

const state = {
  token: '',
  me: null,
  view: 'home',
  tab: 'published',
  tasks: [],
  taskId: null,
  detail: null,
  knowledge: [],
  candidates: [],
  principals: [],
  audit: [],
  query: '',
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

const badge = (value) =>
  el('span', { class: 'badge', dataset: { tone: STATUS_TONE[value] ?? 'muted' } }, STATUS_LABEL[value] ?? value);

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

const hasRole = (...roles) => Boolean(state.me && roles.some((role) => state.me.roles.includes(role)));
const isAdmin = () => hasRole('admin');

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
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`服务返回了无法解析的响应（HTTP ${response.status}）`);
    }
  }
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

// ---------------------------------------------------------------- 登录

async function signIn(token) {
  state.token = token;
  state.me = await api('me');
  sessionStorage.setItem('collab.token', token);
  document.getElementById('login').hidden = true;
  document.getElementById('shell').hidden = false;
  renderIdentity();
  renderNav();
  await refresh();
}

function signOut(message) {
  state.token = '';
  state.me = null;
  sessionStorage.removeItem('collab.token');
  document.getElementById('shell').hidden = true;
  document.getElementById('login').hidden = false;
  document.getElementById('login-error').textContent = message ?? '';
}

function renderIdentity() {
  const box = document.getElementById('identity');
  box.replaceChildren(
    el('strong', {}, state.me.displayName || state.me.id),
    el('span', {}, `${state.me.id} · ${state.me.roles.map((role) => ROLE_LABEL[role] ?? role).join(' / ')}`),
  );
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...VIEWS.map((view) =>
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
    if (state.view === 'home' || state.view === 'tasks') state.tasks = await api('tasks');
    if (state.view === 'tasks' && state.taskId) state.detail = await api(`tasks/${encodeURIComponent(state.taskId)}`);
    if (state.view === 'knowledge') {
      state.knowledge = await api(`knowledge${state.query ? `?q=${encodeURIComponent(state.query)}` : ''}`);
      if (hasRole('reviewer', 'admin')) state.candidates = await api('knowledge/candidates');
    }
    if (state.view === 'directory') state.principals = await api('principals');
    if (state.view === 'audit') state.audit = await api('audit');
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- 渲染入口

function render() {
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const titles = {
    home: ['工作台', '今天需要你判断的事'],
    tasks: ['任务', '目标、分工、验收与证据'],
    knowledge: ['经验库', '经过审核、带范围与有效期的经验'],
    directory: ['参与者', '人与智能体的身份、能力与状态'],
    audit: ['审计', '谁在何时做了什么，结果如何'],
  };
  const [title, subtitle] = titles[state.view];
  topbar.replaceChildren(el('h2', {}, title), el('span', { class: 'sub' }, subtitle));

  let content;
  if (state.view === 'home') content = renderHome();
  else if (state.view === 'tasks') content = state.taskId ? renderTaskDetail() : renderTaskList();
  else if (state.view === 'knowledge') content = renderKnowledge();
  else if (state.view === 'directory') content = renderDirectory();
  else content = renderAudit();

  view.replaceChildren(el('div', { class: 'content' }, content));
}

// ---------------------------------------------------------------- 工作台

function renderHome() {
  const mine = state.tasks.filter((task) => task.ownerId === state.me.id);
  const toReview = mine.filter((task) => task.status === 'review');
  const running = state.tasks.filter((task) => task.status === 'running');
  const attention = [...toReview, ...running.filter((task) => !toReview.includes(task))].slice(0, 6);

  const stats = el(
    'div',
    { class: 'grid' },
    statCard('执行中任务', running.length),
    statCard('待我验收', toReview.length),
    statCard('可见任务', state.tasks.length),
    statCard('已完成', state.tasks.filter((task) => task.status === 'completed').length),
  );

  const attentionList = attention.length
    ? el('div', { class: 'list' }, attention.map(taskRow))
    : el('div', { class: 'empty' }, '暂时没有需要处理的任务。');

  return frag(
    el('div', { class: 'card' }, el('h3', {}, '从这里开始'), el('p', { class: 'muted', style: 'margin-top:8px' },
      '创建任务并写明验收条件，委派协调智能体提出分工；业务智能体在各自授权范围内执行，结果由人验收。验收后的结论才能沉淀为经验。')),
    el('div', { class: 'section-title' }, '概览'),
    stats,
    el('div', { class: 'section-title' }, '需要你判断'),
    attentionList,
  );
}

function statCard(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
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
    el('div', { class: 'row spread' }, el('span', { class: 'title' }, task.title), badge(task.status)),
    el(
      'div',
      { class: 'meta' },
      el('span', {}, `负责人 ${task.ownerName}`),
      el('span', {}, `截止 ${formatDate(task.dueAt)}`),
      el('span', {}, `子任务 ${task.subtaskDone}/${task.subtaskCount}`),
      el('span', { class: 'mono' }, task.id.slice(0, 8)),
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
    hasRole('owner', 'admin')
      ? el('button', { class: 'accent', type: 'button', onclick: openCreateTask }, '新建任务')
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
    title: '新建任务',
    description: '验收条件必须可核对；它决定任务能否被接受。',
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
    { class: 'ghost', type: 'button', onclick: () => { state.taskId = null; refresh(); } },
    '← 返回任务列表',
  );

  const head = el(
    'div',
    { class: 'detail-head' },
    el('div', { class: 'row' }, badge(task.status), el('span', { class: 'badge' }, task.type),
      el('span', { class: 'badge' }, `优先级 ${task.priority}`)),
    el('h3', { class: 'detail-title' }, task.title),
    el('p', { class: 'muted' }, task.goal),
  );

  const meta = el(
    'dl',
    { class: 'kv' },
    el('dt', {}, '负责人'),
    el('dd', {}, task.ownerId),
    el('dt', {}, '截止'),
    el('dd', {}, formatTime(task.dueAt)),
    el('dt', {}, '验收条件'),
    el('dd', {}, task.acceptance),
    el('dt', {}, '版本'),
    el('dd', { class: 'mono' }, String(task.version)),
    el('dt', {}, '输入'),
    el('dd', { class: 'mono' }, JSON.stringify(task.input)),
  );

  const actions = renderTaskActions(detail, owner);

  return frag(
    back,
    el('div', { style: 'height:16px' }, ''),
    head,
    actions ? el('div', { class: 'card' }, el('div', { class: 'actions' }, actions)) : null,
    el('div', { class: 'card' }, meta),
    task.result ? el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, '汇总')),
      el('div', { class: 'result-box' }, task.result.text ?? JSON.stringify(task.result, null, 2))) : null,
    renderSubtasks(detail, owner),
    detail.knowledgeRefs.length
      ? el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, '引用的经验')),
        el('div', { class: 'list' }, detail.knowledgeRefs.map((ref) =>
          el('div', { class: 'list-item', style: 'cursor:default' },
            el('div', { class: 'mono' }, `${ref.knowledgeId}`),
            el('div', { class: 'meta' }, `版本 v${ref.version}`)))))
      : null,
    renderTimeline(detail.events),
  );
}

function renderTaskActions(detail, owner) {
  const task = detail.task;
  const buttons = [];

  if (owner && ['pending', 'running'].includes(task.status)) {
    buttons.push(el('button', { type: 'button', onclick: () => openDelegate(task) }, '委派协调智能体'));
    buttons.push(el('button', { type: 'button', onclick: () => openAssign(task) }, '分派子任务'));
  }
  if ((owner || detail.coordinators.includes(state.me.id) || isAdmin()) && task.status === 'running') {
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
        ? `数量 ${subtask.result.quantity} · 来源 ${subtask.result.source ?? '—'}`
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
      el('td', {}, subtask.kind),
      el('td', {}, subtask.agentId),
      el('td', {}, badge(subtask.status)),
      el('td', {}, el('div', { style: 'max-width:320px' }, result)),
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
          el('th', {}, '类别'), el('th', {}, '智能体'), el('th', {}, '状态'), el('th', {}, '结果'), el('th', {}, '操作'))),
        el('tbody', {}, rows)))
      : el('div', { class: 'empty' }, '尚未分派'),
  );
}

const EVENT_TEXT = {
  task_created: '创建任务',
  task_cancelled: '取消任务',
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
};

function renderTimeline(events) {
  const items = events.slice(-25).reverse().map((event) =>
    el('li', {},
      el('div', { class: 'what' }, EVENT_TEXT[event.type] ?? event.type,
        event.payload && event.payload.note ? el('span', { class: 'muted' }, ` · ${event.payload.note}`) : null),
      el('div', { class: 'when' }, `${event.actorId} · ${formatTime(event.recordedAt)}`)));
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, '事件时间线'), el('span', { class: 'muted' }, `${events.length} 条`)),
    events.length ? el('ul', { class: 'timeline' }, items) : el('div', { class: 'empty' }, '暂无事件'));
}

// ---------------------------------------------------------------- 任务动作

function openDelegate(task) {
  openDialog({
    title: '委派协调智能体',
    description: '协调者可以分派子任务、写阶段摘要、提交汇总，但不能验收。',
    submitLabel: '委派',
    fields: [{ name: 'principal', label: '主体 ID', required: true, placeholder: 'coordinator' }],
    onSubmit: (values) => act(() => api(`tasks/${task.id}/coordinators`, { body: { principal: values.principal }, expectedVersion: task.version }), '已委派'),
  });
}

function openAssign(task) {
  openDialog({
    title: '分派子任务',
    description: '同一智能体对同一类别的子任务只能有一个。',
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
  if (!state.knowledge.length) return el('div', { class: 'empty' }, '还没有对当前身份可见的经验。');
  return el('div', { class: 'list' }, state.knowledge.map((item) =>
    el('div', { class: 'list-item', style: 'cursor:default' },
      el('div', { class: 'row spread' }, el('span', { class: 'title' }, item.content.slice(0, 80)), badge('published')),
      el('div', { class: 'meta' },
        el('span', {}, `适用：${item.conditions}`),
        el('span', {}, `v${item.version}`),
        el('span', {}, `有效期至 ${formatDate(item.expiresAt)}`),
        el('span', { class: 'mono' }, item.id.slice(0, 8))),
      hasRole('reviewer', 'admin')
        ? el('div', { class: 'row', style: 'margin-top:6px' },
          el('button', { class: 'link', type: 'button', onclick: () => openRevoke(item) }, '撤销'),
          el('button', { class: 'link', type: 'button', onclick: () => openRevise(item) }, '修订'),
          el('button', { class: 'link', type: 'button', onclick: () => openAccess(item) }, '调整范围'),
          el('button', { class: 'link', type: 'button', onclick: () => openVersions(item) }, '版本'))
        : null,
    )));
}

function renderCandidates() {
  if (!state.candidates.length) return el('div', { class: 'empty' }, '没有待审核的候选经验。');
  return el('div', { class: 'list' }, state.candidates.map((item) =>
    el('div', { class: 'list-item', style: 'cursor:default' },
      el('div', { class: 'row spread' }, el('span', { class: 'title' }, item.content.slice(0, 80)), badge('candidate')),
      el('div', { class: 'meta' },
        el('span', {}, `适用：${item.conditions}`),
        el('span', {}, `v${item.version}`),
        el('span', { class: 'mono' }, item.id.slice(0, 8))),
      el('div', { class: 'row', style: 'margin-top:6px' },
        el('button', { class: 'primary', type: 'button', onclick: () => openPublish(item) }, '审核发布')),
    )));
}

function openPublish(item) {
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  openDialog({
    title: '发布经验',
    description: '发布即对外可见；请明确有效期与共享范围。',
    submitLabel: '发布',
    fields: [
      { name: 'expiresAt', label: '有效期至', type: 'date', value: expires, required: true },
      {
        name: 'audience',
        label: '共享范围',
        type: 'select',
        value: 'reviewers',
        options: [
          { value: 'reviewers', label: '仅审核人与管理员（最小范围）' },
          { value: 'workspace', label: '整个工作空间' },
        ],
      },
    ],
    onSubmit: (values) =>
      act(() => api(`knowledge/${item.id}/publish`, {
        body: {
          expiresAt: new Date(`${values.expiresAt}T00:00:00Z`).toISOString(),
          ...(values.audience === 'workspace' ? { audience: 'workspace' } : {}),
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
    title: '调整共享范围',
    description: '范围变更立即生效；已被复制的正文无法收回。',
    submitLabel: '保存',
    fields: [
      {
        name: 'mode',
        label: '范围',
        type: 'select',
        value: 'workspace',
        options: [
          { value: 'workspace', label: '整个工作空间' },
          { value: 'restricted', label: '仅指定主体' },
        ],
      },
      { name: 'principals', label: '指定主体 ID（逗号分隔，仅在上面选择“仅指定主体”时生效）' },
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
    const dialog = document.getElementById('dialog');
    const form = el('form', { method: 'dialog' });
    form.append(el('h3', {}, `版本历史 · ${item.id.slice(0, 8)}`));
    form.append(
      el('div', { class: 'stack' }, versions.map((version) =>
        el('div', { class: 'result-box' },
          el('div', { class: 'mono' }, `v${version.version} · ${formatTime(version.publishedAt)}`),
          el('div', { style: 'margin-top:6px' }, version.content),
          el('div', { class: 'muted' }, `适用：${version.conditions} · 有效期至 ${formatDate(version.expiresAt)}`)))),
    );
    const actions = el('div', { class: 'dialog-actions' });
    actions.append(el('button', { type: 'button', class: 'ghost', onclick: () => dialog.close() }, '关闭'));
    form.append(actions);
    dialog.replaceChildren(form);
    dialog.showModal();
  }, '');
}

// ---------------------------------------------------------------- 参与者

function renderDirectory() {
  const rows = state.principals.map((principal) =>
    el('tr', {},
      el('td', {},
        el('div', {}, principal.displayName || principal.id),
        el('div', { class: 'mono muted' }, principal.id)),
      el('td', {}, principal.roles.map((role) => ROLE_LABEL[role] ?? role).join(' / ')),
      el('td', {}, principal.capabilities.length ? principal.capabilities.join(', ') : '—'),
      el('td', {}, el('span', { class: 'badge', dataset: { tone: principal.active ? 'ok' : 'muted' } },
        principal.active ? '正常' : '已停用')),
      el('td', {}, isAdmin() && principal.id !== state.me.id && principal.active
        ? el('button', { class: 'link', type: 'button', onclick: () => confirmDeactivate(principal) }, '停用')
        : '—')));

  return frag(
    isAdmin()
      ? el('div', { class: 'row', style: 'margin-bottom:16px' },
        el('button', { class: 'accent', type: 'button', onclick: openRegisterPrincipal }, '登记参与者'))
      : null,
    el('div', { class: 'card' },
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '主体'), el('th', {}, '角色'), el('th', {}, '能力声明'), el('th', {}, '状态'), el('th', {}, '操作'))),
        el('tbody', {}, rows))))
  );
}

function openRegisterPrincipal() {
  openDialog({
    title: '登记参与者',
    description: '令牌只在本对话框出现一次，请立即交给对方并妥善保管。',
    submitLabel: '登记',
    fields: [
      { name: 'id', label: '主体 ID', required: true, placeholder: 'inventory' },
      { name: 'displayName', label: '显示名称', placeholder: '库存智能体' },
      {
        name: 'roles',
        label: '角色',
        type: 'checkbox-group',
        value: ['agent'],
        options: [
          { value: 'agent', label: '智能体（agent）' },
          { value: 'owner', label: '负责人（owner）' },
          { value: 'reviewer', label: '审核人（reviewer）' },
          { value: 'admin', label: '管理员（admin）' },
        ],
      },
      { name: 'token', label: '访问令牌', required: true, placeholder: '至少 24 个字符' },
      { name: 'capabilities', label: '能力声明（逗号分隔）', placeholder: 'inventory:read, supplier:read' },
    ],
    onSubmit: (values) =>
      act(() => api('principals', {
        body: {
          id: values.id,
          roles: values.roles,
          token: values.token,
          displayName: values.displayName || values.id,
          capabilities: values.capabilities.split(',').map((value) => value.trim()).filter(Boolean),
        },
      }), '已登记'),
  });
}

function confirmDeactivate(principal) {
  openDialog({
    title: `停用 ${principal.id}`,
    description: '停用后该主体的令牌立即失效；历史结果与审计保留。',
    submitLabel: '停用',
    fields: [],
    onSubmit: () => act(() => api(`principals/${principal.id}/deactivate`, { body: {} }), '已停用'),
  });
}

// ---------------------------------------------------------------- 审计

function renderAudit() {
  if (!hasRole('admin')) return el('div', { class: 'empty' }, '只有管理员可以查看审计。');
  if (!state.audit.length) return el('div', { class: 'empty' }, '暂无记录。');
  return el('div', { class: 'card' },
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '时间'), el('th', {}, '主体'), el('th', {}, '动作'), el('th', {}, '结果'))),
      el('tbody', {}, state.audit.slice(0, 200).map((entry) =>
        el('tr', {},
          el('td', { class: 'mono' }, formatTime(entry.recordedAt)),
          el('td', {}, entry.principalId),
          el('td', { class: 'mono' }, entry.action),
          el('td', {}, entry.outcome)))))));
}

// ---------------------------------------------------------------- 启动

function boot() {
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = document.getElementById('token').value.trim();
    const error = document.getElementById('login-error');
    error.textContent = '';
    try {
      await signIn(token);
    } catch (problem) {
      state.token = '';
      error.textContent = problem.message;
    }
  });

  document.getElementById('logout').addEventListener('click', () => signOut());

  const remembered = sessionStorage.getItem('collab.token');
  if (remembered) {
    signIn(remembered).catch((error) => {
      signOut(error.message);
    });
  }
}

boot();
