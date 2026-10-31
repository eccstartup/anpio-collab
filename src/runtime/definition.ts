/**
 * 内嵌智能体定义：校验、默认值与规范化。
 *
 * 平台（保存定义）与运行时（执行一轮）共用这一份结构，
 * 避免"控制台能存进去、运行时读不懂"的两套格式。
 */

import { invalid } from '../protocol/errors.ts';
import { asEnum, asBoolean, asInteger, asObject, asOptionalString, asString, asStringArray } from '../protocol/parse.ts';
import { AGENT_SCOPES, type AgentScope } from '../protocol/types.ts';
import { PROTOCOLS, defaultBaseUrl, providerOf, type Protocol } from './providers.ts';

export const EMBEDDED_TOOLS = [
  'task_get',
  'task_accept',
  'task_progress',
  'task_submit',
  'task_comment',
  'knowledge_search',
  'shell',
  'read_file',
  'write_file',
  'list_files',
  'finish',
] as const;

export type EmbeddedTool = (typeof EMBEDDED_TOOLS)[number];

const DEFAULT_TOOLS: EmbeddedTool[] = [
  'task_get',
  'task_accept',
  'task_progress',
  'task_submit',
  'task_comment',
  'knowledge_search',
  'read_file',
  'list_files',
  'finish',
];

export const EMBEDDED_SCOPES: AgentScope[] = [
  'tasks:read',
  'tasks:submit',
  'offers:claim',
  'knowledge:read',
  'comments:write',
  'presence:write',
  'mailbox:read',
  'mailbox:write',
];

export type ScriptStep = {
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
};

export type EmbeddedProviderConfig = {
  id: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKeyEnv: string | null;
  /** 只给 script 协议用：每一步要么说一句话，要么调一个工具。 */
  script?: ScriptStep[];
};

export type EmbeddedLimits = {
  maxTurns: number;
  timeoutMs: number;
  maxTokens: number;
};

export type EmbeddedSandbox = {
  shell: boolean;
  shellTimeoutMs: number;
  maxOutputBytes: number;
};

export type EmbeddedAgentDefinition = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  provider: EmbeddedProviderConfig;
  systemPrompt: string;
  tools: EmbeddedTool[];
  scopes: AgentScope[];
  limits: EmbeddedLimits;
  sandbox: EmbeddedSandbox;
  enabled: boolean;
  concurrency: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastError: string | null;
};

export type NormalizedDefinition = Omit<
  EmbeddedAgentDefinition,
  'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastError'
>;

export function normalizeDefinition(value: unknown): NormalizedDefinition {
  const input = asObject(value, 'definition');
  const name = asString(input.name, 'name', { min: 1, max: 80 });
  const description = asOptionalString(input.description, 'description', { max: 4000 }) ?? '';
  const capabilities = input.capabilities === undefined
    ? []
    : asStringArray(input.capabilities, 'capabilities', { max: 20, maxLength: 60 });

  const providerInput = asObject(input.provider, 'provider');
  const providerId = asString(providerInput.id, 'provider.id', { min: 1, max: 80 });
  const known = providerOf(providerId);
  const protocol = asEnum(
    providerInput.protocol ?? known?.endpoints[0]?.protocol ?? 'openai-chat',
    'provider.protocol',
    PROTOCOLS,
  ) as Protocol;
  const explicitBase = asOptionalString(providerInput.baseUrl, 'provider.baseUrl', { max: 500 });
  const baseUrl = explicitBase ?? defaultBaseUrl(providerId, protocol) ?? '';
  if (protocol !== 'script' && protocol !== 'subscription-cli' && !baseUrl) {
    throw invalid('这个供应商没有默认地址，必须填写 provider.baseUrl');
  }
  const model =
    asOptionalString(providerInput.model, 'provider.model', { max: 120 }) ??
    known?.defaultModel ??
    (protocol === 'script' ? 'script' : '');
  if (protocol !== 'script' && !model) throw invalid('必须填写 provider.model');
  const apiKeyEnv = asOptionalString(providerInput.apiKeyEnv, 'provider.apiKeyEnv', { max: 120 }) ?? null;
  if (apiKeyEnv !== null && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
    throw invalid('provider.apiKeyEnv 必须是环境变量名（大写字母、数字、下划线）');
  }
  const script = normalizeScript(providerInput.script);

  const systemPrompt = asOptionalString(input.systemPrompt, 'systemPrompt', { max: 20_000 }) ?? '';

  const requestedTools = input.tools === undefined
    ? DEFAULT_TOOLS
    : asStringArray(input.tools, 'tools', { max: EMBEDDED_TOOLS.length, maxLength: 40 });
  const tools: EmbeddedTool[] = [];
  for (const tool of requestedTools) {
    if (!(EMBEDDED_TOOLS as readonly string[]).includes(tool)) throw invalid(`未知工具 ${tool}`);
    tools.push(tool as EmbeddedTool);
  }
  if (!tools.includes('finish')) tools.push('finish');

  const scopesInput = input.scopes === undefined ? EMBEDDED_SCOPES : asStringArray(input.scopes, 'scopes', { max: 20 });
  const scopes: AgentScope[] = [];
  for (const scope of scopesInput) {
    if (!(AGENT_SCOPES as readonly string[]).includes(scope)) throw invalid(`未知授权范围 ${scope}`);
    scopes.push(scope as AgentScope);
  }
  if (scopes.length === 0) throw invalid('scopes 不能为空');
  for (const required of ['tasks:read', 'mailbox:read', 'mailbox:write'] as AgentScope[]) {
    if (!scopes.includes(required)) scopes.push(required);
  }

  const limitsInput = input.limits === undefined ? {} : asObject(input.limits, 'limits');
  const limits: EmbeddedLimits = {
    maxTurns: asInteger(Number(limitsInput.maxTurns ?? 8), 'limits.maxTurns', { min: 1, max: 50 }),
    timeoutMs: asInteger(Number(limitsInput.timeoutMs ?? 120_000), 'limits.timeoutMs', {
      min: 1_000,
      max: 3_600_000,
    }),
    maxTokens: asInteger(Number(limitsInput.maxTokens ?? 8192), 'limits.maxTokens', {
      min: 256,
      max: 200_000,
    }),
  };

  const sandboxInput = input.sandbox === undefined ? {} : asObject(input.sandbox, 'sandbox');
  const sandbox: EmbeddedSandbox = {
    shell: sandboxInput.shell === undefined ? tools.includes('shell') : asBoolean(sandboxInput.shell, 'sandbox.shell'),
    shellTimeoutMs: asInteger(Number(sandboxInput.shellTimeoutMs ?? 60_000), 'sandbox.shellTimeoutMs', {
      min: 1_000,
      max: 600_000,
    }),
    maxOutputBytes: asInteger(Number(sandboxInput.maxOutputBytes ?? 65_536), 'sandbox.maxOutputBytes', {
      min: 1_024,
      max: 1_048_576,
    }),
  };
  if (tools.includes('shell') && !sandbox.shell) throw invalid('工具含 shell 时必须开启 sandbox.shell');

  return {
    name,
    description,
    capabilities,
    provider: { id: providerId, protocol, baseUrl, model, apiKeyEnv, ...(script ? { script } : {}) },
    systemPrompt,
    tools,
    scopes,
    limits,
    sandbox,
    enabled: input.enabled === undefined ? true : asBoolean(input.enabled, 'enabled'),
    concurrency: asInteger(Number(input.concurrency ?? 1), 'concurrency', { min: 1, max: 8 }),
  };
}

function normalizeScript(value: unknown): ScriptStep[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('provider.script 必须是数组');
  if (value.length > 50) throw invalid('provider.script 最多 50 步');
  return value.map((item, index) => {
    const step = asObject(item, `provider.script[${index}]`);
    const text = asOptionalString(step.text, `provider.script[${index}].text`, { max: 4000 });
    const tool = asOptionalString(step.tool, `provider.script[${index}].tool`, { max: 40 });
    if (!text && !tool) throw invalid(`provider.script[${index}] 需要 text 或 tool`);
    const input = step.input === undefined ? undefined : asObject(step.input, `provider.script[${index}].input`);
    return { ...(text ? { text } : {}), ...(tool ? { tool } : {}), ...(input ? { input } : {}) };
  });
}
