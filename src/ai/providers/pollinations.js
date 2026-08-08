import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

const provider = createOpenAIProvider('pollinations', {
  baseURL: config.pollinationsUrl,
  apiKey: config.pollinationsApiKey,
  omitModel: true,
});

export const isPollinationsEnabled = provider.isEnabled;
export const pollinationsCompletion = provider.complete;
export default { isPollinationsEnabled, pollinationsCompletion };
