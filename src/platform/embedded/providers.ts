/**
 * 模型供应商注册表。
 *
 * 只是数据：界面按分类展示，运行时按 `protocol` 选适配器。
 * Base URL 全部可被定义覆盖——厂商会改地址，这里给的是默认值。
 * 密钥只认环境变量名，注册表与数据库都不存密钥本身。
 */

export const PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini-generate',
  'gemini-interactions',
  'workers-ai',
  'decision-jev',
  'subscription-cli',
  'script',
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export type ProviderCategory = '厂商' | '订阅' | '分发站' | '自定义';

export type ProviderEndpoint = { protocol: Protocol; baseUrl: string };

export type Provider = {
  id: string;
  label: string;
  vendor: string;
  category: ProviderCategory;
  endpoints: ProviderEndpoint[];
  defaultModel?: string;
  keyEnv?: string;
  /** 地址可能随厂商调整，界面上允许改。 */
  notes?: string;
};

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'dashscope',
    label: '阿里云百炼',
    vendor: '阿里云',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }],
    defaultModel: 'qwen-plus',
    keyEnv: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    vendor: 'Anthropic',
    category: '厂商',
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }],
    defaultModel: 'claude-sonnet-4-5',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'qianfan',
    label: '百度千帆',
    vendor: '百度',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://qianfan.baidubce.com/v2' }],
    keyEnv: 'QIANFAN_API_KEY',
  },
  {
    id: 'hunyuan',
    label: '腾讯云混元',
    vendor: '腾讯',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
    ],
    keyEnv: 'HUNYUAN_API_KEY',
    notes: '腾讯云正在迁移到 tokenhub，国际站：https://tokenhub-intl.tencentcloudmaas.com/v1',
  },
  {
    id: 'ark',
    label: '火山方舟',
    vendor: '字节跳动',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { protocol: 'anthropic-messages', baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible' },
    ],
    keyEnv: 'ARK_API_KEY',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    vendor: 'MiniMax',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.minimax.cn/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://api.minimaxi.com/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://api.minimax.io/v1' },
    ],
    keyEnv: 'MINIMAX_API_KEY',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    vendor: '月之暗面',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1' }],
    defaultModel: 'kimi-k2',
    keyEnv: 'MOONSHOT_API_KEY',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    vendor: '阶跃星辰',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.stepfun.com/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://api.stepfun.com/step_plan/v1' },
    ],
    keyEnv: 'STEPFUN_API_KEY',
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    vendor: '小米',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://api.xiaomimimo.com/anthropic' },
    ],
    keyEnv: 'MIMO_API_KEY',
  },
  {
    id: 'bigmodel',
    label: '智谱 GLM',
    vendor: '智谱',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }],
    defaultModel: 'glm-4.6',
    keyEnv: 'ZHIPU_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: '深度求索',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' },
    ],
    defaultModel: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: 'OpenAI',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1' },
      { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    ],
    defaultModel: 'gpt-5',
    keyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    vendor: 'Google',
    category: '厂商',
    endpoints: [
      { protocol: 'gemini-generate', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      { protocol: 'openai-chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      { protocol: 'gemini-interactions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    ],
    defaultModel: 'gemini-2.5-pro',
    keyEnv: 'GEMINI_API_KEY',
    notes: 'Interactions 协议以官方文档为准',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    vendor: 'xAI',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.x.ai/v1' }],
    keyEnv: 'XAI_API_KEY',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    vendor: 'Mistral AI',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1' }],
    keyEnv: 'MISTRAL_API_KEY',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    vendor: 'Cohere',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.cohere.com/compatibility/v1' }],
    keyEnv: 'COHERE_API_KEY',
  },
  {
    id: 'groq',
    label: 'Groq',
    vendor: 'Groq',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1' }],
    keyEnv: 'GROQ_API_KEY',
  },
  {
    id: 'together',
    label: 'Together AI',
    vendor: 'Together',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.together.xyz/v1' }],
    keyEnv: 'TOGETHER_API_KEY',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    vendor: 'Fireworks',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.fireworks.ai/inference/v1' }],
    keyEnv: 'FIREWORKS_API_KEY',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    vendor: 'NVIDIA',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://integrate.api.nvidia.com/v1' }],
    keyEnv: 'NVIDIA_API_KEY',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    vendor: 'Microsoft',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://{resource}.openai.azure.com/openai/v1' }],
    keyEnv: 'AZURE_OPENAI_API_KEY',
    notes: '旧部署路径为 /openai/deployments/{deployment}，按资源实际地址填写',
  },
  {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    vendor: 'Cloudflare',
    category: '厂商',
    endpoints: [
      {
        protocol: 'workers-ai',
        baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
      },
    ],
    keyEnv: 'CLOUDFLARE_API_TOKEN',
  },
  {
    id: 'clef',
    label: 'Cloudflare Clef',
    vendor: 'Cloudflare',
    category: '厂商',
    endpoints: [
      { protocol: 'decision-jev', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai' },
    ],
    keyEnv: 'CLOUDFLARE_API_TOKEN',
    notes: '决策模型，模型名以 Workers AI 页面为准',
  },
  {
    id: 'jev',
    label: 'TypeSafe (Jev)',
    vendor: 'TypeSafe',
    category: '厂商',
    endpoints: [],
    keyEnv: 'JEV_API_KEY',
    notes: 'Jev 是决策协议，没有公开默认地址，请在定义里填写',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    vendor: 'Ollama',
    category: '厂商',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'http://localhost:11434/v1' },
      { protocol: 'openai-chat', baseUrl: 'http://localhost:11434/api' },
    ],
    defaultModel: 'qwen3',
    keyEnv: 'OLLAMA_API_KEY',
    notes: '本地部署通常不需要密钥；原生 API 为 /api',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    vendor: '硅基流动',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1' }],
    keyEnv: 'SILICONFLOW_API_KEY',
  },
  {
    id: 'spark',
    label: '讯飞星火',
    vendor: '科大讯飞',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://spark-api-open.xf-yun.com/v1' }],
    keyEnv: 'SPARK_API_KEY',
  },
  {
    id: 'sensenova',
    label: '商汤日日新',
    vendor: '商汤',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.sensenova.cn/compatible-mode/v1' }],
    keyEnv: 'SENSENOVA_API_KEY',
  },
  {
    id: 'lingyiwanwu',
    label: '零一万物',
    vendor: '零一万物',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.lingyiwanwu.com/v1' }],
    keyEnv: 'YI_API_KEY',
  },
  {
    id: 'baichuan',
    label: '百川智能',
    vendor: '百川智能',
    category: '厂商',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.baichuan-ai.com/v1' }],
    keyEnv: 'BAICHUAN_API_KEY',
  },

  {
    id: 'kiro',
    label: 'Kiro (AWS)',
    vendor: 'AWS',
    category: '订阅',
    endpoints: [],
    keyEnv: 'KIRO_CLI',
    notes: '没有公开 API，由本机 kiro CLI 适配；未安装时明确报错',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    vendor: 'OpenAI',
    category: '订阅',
    endpoints: [],
    keyEnv: 'CODEX_CLI',
    notes: '没有公开 API，由本机 codex CLI 适配；未安装时明确报错',
  },

  {
    id: 'openrouter',
    label: 'OpenRouter',
    vendor: 'OpenRouter',
    category: '分发站',
    endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' }],
    keyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'requesty',
    label: 'Requesty',
    vendor: 'Requesty',
    category: '分发站',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://router.requesty.ai/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://router.requesty.ai' },
    ],
    keyEnv: 'REQUESTY_API_KEY',
  },
  {
    id: 'aiberm',
    label: 'Aiberm',
    vendor: 'Aiberm',
    category: '分发站',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://aiberm.com/v1' },
      { protocol: 'openai-responses', baseUrl: 'https://aiberm.com/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://aiberm.com' },
      { protocol: 'gemini-generate', baseUrl: 'https://aiberm.com/v1beta' },
    ],
    keyEnv: 'AIBERM_API_KEY',
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    vendor: '阿里云',
    category: '分发站',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api-inference.modelscope.cn/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://api-inference.modelscope.cn' },
    ],
    keyEnv: 'MODELSCOPE_API_KEY',
  },
  {
    id: 'ucloud',
    label: '优云智算 UCloud',
    vendor: 'UCloud',
    category: '分发站',
    endpoints: [
      { protocol: 'openai-chat', baseUrl: 'https://api.modelverse.cn/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://api.umodelverse.ai/v1' },
      { protocol: 'anthropic-messages', baseUrl: 'https://api.modelverse.cn' },
      { protocol: 'gemini-generate', baseUrl: 'https://api.modelverse.cn/v1beta' },
    ],
    keyEnv: 'UCLOUD_API_KEY',
  },

  {
    id: 'custom-openai-chat',
    label: '自定义 OpenAI Chat',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填',
  },
  {
    id: 'custom-openai-responses',
    label: '自定义 OpenAI Responses',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填',
  },
  {
    id: 'custom-anthropic',
    label: '自定义 Anthropic',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填',
  },
  {
    id: 'custom-gemini',
    label: '自定义 Gemini',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填',
  },
  {
    id: 'custom-gemini-interactions',
    label: '自定义 Gemini Interactions',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填，协议以官方文档为准',
  },
  {
    id: 'custom-jev',
    label: '自定义 Jev 决策模型',
    vendor: '自定义',
    category: '自定义',
    endpoints: [],
    notes: 'Base URL 必填',
  },
  {
    id: 'script',
    label: '脚本（测试/演示）',
    vendor: '内置',
    category: '自定义',
    endpoints: [],
    defaultModel: 'script',
    notes: '不调用网络，按定义里的 steps 逐步执行，用于演示与测试',
  },
];

export function providerOf(id: string): Provider | undefined {
  return PROVIDERS.find(item => item.id === id);
}

/** 定义没写 Base URL 时，取注册表里同协议的第一条。 */
export function defaultBaseUrl(providerId: string, protocol: Protocol): string | null {
  const provider = providerOf(providerId);
  const endpoint = provider?.endpoints.find(item => item.protocol === protocol);
  return endpoint?.baseUrl ?? null;
}
