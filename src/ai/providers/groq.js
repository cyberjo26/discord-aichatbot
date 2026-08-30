import config from '../../config.js';
import { createOpenAIProvider } from './openai-factory.js';

const provider = createOpenAIProvider('groq', {
  baseURL: config.groqUrl,
  apiKey: config.groqApiKey,
  defaultModel: config.groqModel,
});

export const isGroqEnabled = provider.isEnabled;
export const groqCompletion = provider.complete;
export default { isGroqEnabled, groqCompletion };
