import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

const provider = createOpenAIProvider('puter', {
  baseURL: config.puterUrl,
  apiKey: config.puterApiKey,
  defaultModel: config.puterModel,
});

export const isPuterEnabled = provider.isEnabled;
export const puterCompletion = provider.complete;
export default { isPuterEnabled, puterCompletion };
