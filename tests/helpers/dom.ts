/**
 * 极简 DOM：只实现管理台真正用到的那部分。
 *
 * 目的不是模拟浏览器，而是让 `src/web/app.js` 能在 Node 里被完整执行一遍，
 * 从而用真实 HTTP 服务验证「钱包登录 → 渲染 → 各角色视图」这条路。
 *
 * 支持：createElement / createTextNode / createDocumentFragment /
 * getElementById / querySelector（`#id tag[data-x="v"]` 形式）/ 事件触发。
 * 不支持：innerHTML、样式计算、真实布局。
 */

export class DomNode {
  parent: DomNode | null = null;
  children: DomNode[] = [];
  ownerDocument: DomDocument;

  constructor(document: DomDocument) {
    this.ownerDocument = document;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (!(node instanceof DomNode)) continue;
      if (node instanceof DomFragment) {
        for (const child of [...node.children]) this.append(child);
        node.children = [];
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  get textContent(): string {
    return this.children.map(child => child.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(this.ownerDocument.createTextNode(String(value)));
  }
}

export class DomText extends DomNode {
  value: string;

  constructor(document: DomDocument, value: string) {
    super(document);
    this.value = value;
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string) {
    this.value = String(value);
  }
}

export class DomFragment extends DomNode {}

type Listener = (event: unknown) => unknown;

export class DomElement extends DomNode {
  tagName: string;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: { cssText: string } = { cssText: '' };
  className = '';
  listeners = new Map<string, Listener[]>();

  // 用到的布尔/值属性直接作为字段存在。
  hidden = false;
  disabled = false;
  required = false;
  checked = false;
  selected = false;
  open = false;
  value = '';
  title = '';

  constructor(document: DomDocument, tagName: string) {
    super(document);
    this.tagName = tagName.toLowerCase();
    if (this.tagName === 'dialog') {
      (this as unknown as { showModal: () => void }).showModal = () => {
        this.open = true;
      };
      (this as unknown as { close: () => void }).close = () => {
        this.open = false;
      };
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name === 'id') this.ownerDocument.register(value, this);
    if (name === 'value') this.value = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }

  /** 触发事件并把监听器的返回值（通常是 Promise）收集起来。 */
  fire(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    };
    const results = (this.listeners.get(type) ?? []).map(listener => listener(event));
    return Promise.all(results);
  }

  querySelector(selector: string): DomElement | null {
    return querySelectorAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): DomElement[] {
    return querySelectorAll(this, selector);
  }

  get childElementCount(): number {
    return this.children.filter(child => child instanceof DomElement).length;
  }
}

export class DomDocument {
  root: DomElement;
  byId = new Map<string, DomElement>();

  constructor() {
    this.root = new DomElement(this, 'body');
  }

  register(id: string, node: DomElement): void {
    this.byId.set(id, node);
  }

  createElement(tagName: string): DomElement {
    return new DomElement(this, tagName);
  }

  createTextNode(value: string): DomText {
    return new DomText(this, value);
  }

  createDocumentFragment(): DomFragment {
    return new DomFragment(this);
  }

  getElementById(id: string): DomElement | null {
    return this.byId.get(id) ?? null;
  }

  querySelector(selector: string): DomElement | null {
    return querySelectorAll(this.root, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): DomElement[] {
    return querySelectorAll(this.root, selector);
  }
}

type Compound = { id?: string; tag?: string; classes: string[]; attrs: Array<{ name: string; value?: string }> };

function parseCompound(text: string): Compound {
  const compound: Compound = { classes: [], attrs: [] };
  let rest = text;
  const tag = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(rest);
  if (tag) {
    compound.tag = tag[1]!.toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    if (rest.startsWith('#')) {
      const id = /^#([\w-]+)/.exec(rest);
      if (!id) break;
      compound.id = id[1]!;
      rest = rest.slice(id[0].length);
      continue;
    }
    if (rest.startsWith('.')) {
      const cls = /^\.([\w-]+)/.exec(rest);
      if (!cls) break;
      compound.classes.push(cls[1]!);
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (rest.startsWith('[')) {
      const attr = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
      if (!attr) break;
      compound.attrs.push({ name: attr[1]!, value: attr[2] });
      rest = rest.slice(attr[0].length);
      continue;
    }
    break;
  }
  return compound;
}

function matches(node: DomElement, compound: Compound): boolean {
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.id && node.attributes.id !== compound.id) return false;
  if (compound.classes.length) {
    const own = new Set(node.className.split(/\s+/).filter(Boolean));
    for (const cls of compound.classes) if (!own.has(cls)) return false;
  }
  for (const attr of compound.attrs) {
    const asData = attr.name.startsWith('data-');
    const actual = asData ? node.dataset[attr.name.slice(5)] : node.attributes[attr.name];
    if (attr.value === undefined) {
      if (actual === undefined) return false;
    } else if (actual !== attr.value) return false;
  }
  return true;
}

function descendants(node: DomNode, out: DomElement[] = []): DomElement[] {
  for (const child of node.children) {
    if (child instanceof DomElement) out.push(child);
    descendants(child, out);
  }
  return out;
}

function querySelectorAll(root: DomNode, selector: string): DomElement[] {
  const steps = selector.trim().split(/\s+/).map(parseCompound);
  let scope: DomNode[] = [root];
  let matched: DomElement[] = [];
  for (const step of steps) {
    matched = [];
    for (const node of scope) {
      for (const candidate of descendants(node)) {
        if (matches(candidate, step)) matched.push(candidate);
      }
    }
    scope = matched;
  }
  return matched;
}
