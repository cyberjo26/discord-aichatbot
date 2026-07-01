import config from '../config.js';
import logger from '../utils/logger.js';
import { isOpenRouterEnabled, openRouterCompletion } from './providers/openrouter.js';
import { isGeminiEnabled, geminiCompletion } from './providers/gemini.js';
import { isGroqEnabled, groqCompletion } from './providers/groq.js';
import { isCerebrasEnabled, cerebrasCompletion } from './providers/cerebras.js';
import { isPollinationsEnabled, pollinationsCompletion } from './providers/pollinations.js';
import { isPuterEnabled, puterCompletion } from './providers/puter.js';

const providers = {
  openrouter: { enabled: isOpenRouterEnabled, complete: openRouterCompletion },
  gemini: { enabled: isGeminiEnabled, complete: geminiCompletion },
  groq: { enabled: isGroqEnabled, complete: groqCompletion },
  cerebras: { enabled: isCerebrasEnabled, complete: cerebrasCompletion },
  pollinations: { enabled: isPollinationsEnabled, complete: pollinationsCompletion },
  puter: { enabled: isPuterEnabled, complete: puterCompletion },
};

const health = new Map(Object.keys(providers).map((name) => [name, {
  failures: 0,
  openUntil: 0,
  requests: 0,
  successes: 0,
  totalLatencyMs: 0,
}]));

const TASK_TOKEN_LIMITS = {
  routing: 150,
  chat: 400,
  knowledge: 600,
  code_help: 800,
  summarize: 300,
  clarification: 100,
};

let requestCount = 0;

function providerOrder(opts) {
  if (opts.provider) return [opts.provider];
  const configured = [...config.aiProviderOrder];
  if (configured.length <= 1) return configured;

  // Rotate provider order for load balancing (round-robin)
  const shift = requestCount % configured.length;
  requestCount++;

  return [...configured.slice(shift), ...configured.slice(0, shift)];
}

function circuitOpen(name) {
  return health.get(name).openUntil > Date.now();
}

function recordSuccess(name, latencyMs) {
  const state = health.get(name);
  state.failures = 0;
  state.openUntil = 0;
  state.requests++;
  state.successes++;
  state.totalLatencyMs += latencyMs;
}

function recordFailure(name, error, latencyMs) {
  const state = health.get(name);
  state.failures++;
  state.requests++;
  state.totalLatencyMs += latencyMs;
  
  // Track error types
  state.errorTypes = state.errorTypes || {};
  const errCode = error.code || 'UNKNOWN';
  state.errorTypes[errCode] = (state.errorTypes[errCode] || 0) + 1;

  if (errCode === 'QUOTA_EXHAUSTED') {
    state.openUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
  } else if (errCode === 'RATE_LIMITED') {
    state.openUntil = Date.now() + 2 * 60 * 1000; // 2 minutes
  } else if (errCode === 'TIMEOUT') {
    const timeoutCount = state.errorTypes['TIMEOUT'] || 1;
    state.openUntil = Date.now() + Math.min(timeoutCount * 10000, 60000); // up to 60s
  } else if (state.failures >= config.aiCircuitFailureThreshold) {
    state.openUntil = Date.now() + config.aiCircuitCooldownMs;
  }
}

export async function chatCompletion(messages, opts = {}) {
  const maxTokens = opts.maxTokens || TASK_TOKEN_LIMITS[opts.task] || config.maxTokens;
  const mergedOpts = { ...opts, maxTokens };
  const order = providerOrder(mergedOpts);
  const failures = [];

  for (const name of order) {
    const provider = providers[name];
    if (!provider || !provider.enabled()) continue;
    if (circuitOpen(name)) {
      logger.debug(`AI ${name} dilewati: circuit breaker aktif`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await provider.complete(messages, mergedOpts);
      const latencyMs = Date.now() - startedAt;
      recordSuccess(name, latencyMs);
      logger.info(`AI OK: provider=${name} model=${result.model} task=${opts.task || 'completion'} latency=${latencyMs}ms`);
      const cleanedText = result.text
        .replace(/^(User|Response)\s+Safety:\s*\w+\r?\n?/gim, '')
        .trim();
      return cleanedText;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      recordFailure(name, error, latencyMs);
      failures.push(`${name}: ${error.message}`);
      logger.warn(`AI gagal: provider=${name} code=${error.code || 'UNKNOWN'} latency=${latencyMs}ms; mencoba provider berikutnya`);
    }
  }

  logger.error(`Semua provider AI gagal: ${failures.join(' | ') || 'tidak ada provider aktif'}`);
  throw new Error('Semua provider AI sedang tidak tersedia. Coba lagi sebentar.');
}

export function getAiStats() {
  return Object.fromEntries([...health.entries()].map(([name, state]) => [name, {
    isConfigured: providers[name].enabled(),
    requests: state.requests,
    successes: state.successes,
    failures: state.requests - state.successes,
    averageLatencyMs: state.requests ? Math.round(state.totalLatencyMs / state.requests) : 0,
    circuitOpen: state.openUntil > Date.now(),
    circuitOpenUntil: state.openUntil || null,
  }]));
}

export default { chatCompletion, getAiStats };
