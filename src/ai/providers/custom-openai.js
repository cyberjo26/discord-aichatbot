import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

const KNOWN_PRESETS = {
  sambanova: {
    baseURL: 'https://api.sambanova.ai/v1/chat/completions',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-small-latest',
  },
  together: {
    baseURL: 'https://api.together.xyz/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  deepinfra: {
    baseURL: 'https://api.deepinfra.com/v1/openai/chat/completions',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  },
  github: {
    baseURL: 'https://models.inference.ai.azure.com/chat/completions',
    defaultModel: 'gpt-4o-mini',
  },
  cohere: {
    baseURL: 'https://api.cohere.com/compatibility/v1/chat/completions',
    defaultModel: 'command-r-08-2024',
  },
};

export function getNamedCustomConfig(name = 'custom') {
  const clean = String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const upper = clean.toUpperCase();
  const preset = KNOWN_PRESETS[clean] || {};

  // 1. Try provider-specific env variables (e.g. 9ROUTER_BASE_URL, HCNSEC_BASE_URL, SAMBANOVA_BASE_URL)
  // 2. Fall back to preset baseURL or generic CUSTOM_AI_BASE_URL
  const baseURL = process.env[`${upper}_BASE_URL`] ||
    process.env[`${upper}_URL`] ||
    process.env[`CUSTOM_${upper}_BASE_URL`] ||
    preset.baseURL ||
    config.customAiBaseUrl ||
    '';

  const rawKeys = process.env[`${upper}_API_KEYS`] ||
    process.env[`${upper}_API_KEY`] ||
    process.env[`${upper}_KEY`] ||
    process.env[`${upper}_TOKEN`] ||
    (upper === 'GITHUB' ? (process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_KEY) : '') ||
    process.env[`CUSTOM_${upper}_API_KEY`] ||
    '';
  const apiKeys = rawKeys
    ? rawKeys.split(',').map((s) => s.trim()).filter(Boolean)
    : (config.customAiApiKeys.length > 0 ? config.customAiApiKeys : ['']);

  const rawModels = process.env[`${upper}_MODELS`] ||
    process.env[`${upper}_MODEL`] ||
    process.env[`CUSTOM_${upper}_MODEL`] ||
    '';
  const models = rawModels
    ? rawModels.split(',').map((s) => s.trim()).filter(Boolean)
    : (preset.defaultModel ? [preset.defaultModel] : (config.customAiModels.length > 0 ? config.customAiModels : []));

  const authPrefix = process.env[`${upper}_AUTH_PREFIX`] ||
    config.customAiAuthPrefix ||
    'Bearer';

  const timeoutMs = process.env[`${upper}_TIMEOUT_MS`]
    ? Number.parseInt(process.env[`${upper}_TIMEOUT_MS`], 10)
    : config.aiRequestTimeoutMs;

  return {
    baseURL: baseURL.trim(),
    apiKeys,
    models,
    defaultModel: models[0] || preset.defaultModel || config.primaryModel || 'default',
    apiKey: apiKeys[0] || '',
    authPrefix: authPrefix.trim(),
    extraHeaders: config.customAiExtraHeaders,
    timeoutMs,
  };
}

export const isNamedCustomEnabled = (name = 'custom') => {
  const cfg = getNamedCustomConfig(name);
  const hasLocal = cfg.baseURL.includes('localhost') || cfg.baseURL.includes('127.0.0.1');
  const hasKey = cfg.apiKeys.length > 0 && cfg.apiKeys[0] !== '';
  return Boolean(cfg.baseURL && (hasKey || hasLocal || name === 'custom'));
};

export const isCustomEnabled = () => isNamedCustomEnabled('custom');

export function createNamedCustomProvider(name = 'custom') {
  const cfg = getNamedCustomConfig(name);
  const models = cfg.models.length > 0 ? cfg.models : [cfg.defaultModel];
  const keys = cfg.apiKeys.length > 0 ? cfg.apiKeys : [''];

  const subProviders = keys.map((apiKey, idx) => createOpenAIProvider(`${name}_${idx + 1}`, {
    baseURL: cfg.baseURL,
    apiKey,
    defaultModel: cfg.defaultModel,
    extraHeaders: cfg.extraHeaders,
    authPrefix: cfg.authPrefix,
    defaultTimeoutMs: cfg.timeoutMs,
  }));

  return {
    isEnabled: () => Boolean(cfg.baseURL),
    complete: async (messages, opts = {}) => {
      const modelList = opts.model ? [opts.model, ...models.filter((m) => m !== opts.model)] : models;
      const errors = [];

      for (const model of modelList) {
        for (const sub of subProviders) {
          try {
            const res = await sub.complete(messages, { ...opts, ...(model ? { model } : {}) });
            return res;
          } catch (err) {
            errors.push(`${model || name}: ${err.message}`);
          }
        }
      }

      throw new Error(`${name} gagal: ${errors.join(' | ') || 'tidak ada response'}`);
    },
  };
}

export const customCompletion = async (messages, opts = {}) => {
  const providerName = opts.provider || 'custom';
  if (!isNamedCustomEnabled(providerName)) {
    throw new Error(`CUSTOM_AI_BASE_URL atau ${providerName.toUpperCase()}_BASE_URL belum dikonfigurasi di .env`);
  }

  const customProv = createNamedCustomProvider(providerName);
  return customProv.complete(messages, opts);
};

export default {
  isCustomEnabled,
  isNamedCustomEnabled,
  createNamedCustomProvider,
  getNamedCustomConfig,
  customCompletion,
};
