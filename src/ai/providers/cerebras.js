import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

const provider = createOpenAIProvider('cerebras', {
  baseURL: config.cerebrasUrl,
  apiKey: config.cerebrasApiKey,
  defaultModel: config.cerebrasModel,
});

export const isCerebrasEnabled = provider.isEnabled;
export const cerebrasCompletion = provider.complete;
export default { isCerebrasEnabled, cerebrasCompletion };
