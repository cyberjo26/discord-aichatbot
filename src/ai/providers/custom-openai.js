import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

function buildCustomProviders() {
  const baseURL = config.customAiBaseUrl;
  const keys = config.customAiApiKeys.length > 0 ? config.customAiApiKeys : [];
  const models = config.customAiModels.length > 0 ? config.customAiModels : [];

  return keys.map((apiKey, idx) => createOpenAIProvider(`custom${idx + 1}`, {
    baseURL,
    apiKey,
    defaultModel: models[0] || '',
    extraHeaders: config.customAiExtraHeaders,
    authPrefix: config.customAiAuthPrefix || 'Bearer',
  }));
}

const providers = buildCustomProviders();

export const isCustomEnabled = () => Boolean(config.customAiBaseUrl && config.customAiApiKeys.length > 0 && config.customAiModels.length > 0);
export const customCompletion = async (messages, opts = {}) => {
  if (!isCustomEnabled()) {
    throw new Error('CUSTOM_AI_BASE_URL, CUSTOM_AI_API_KEYS, atau CUSTOM_AI_MODELS belum dikonfigurasi');
  }

  const models = config.customAiModels;
  const errors = [];

  for (const model of models) {
    for (const provider of providers) {
      try {
        const result = await provider.complete(messages, { ...opts, model });
        return result;
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
      }
    }
  }

  throw new Error(`Custom AI gagal: ${errors.join(' | ') || 'tidak ada provider aktif'}`);
};

export default { isCustomEnabled, customCompletion };
