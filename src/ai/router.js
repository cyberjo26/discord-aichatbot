import config from '../config.js';
import logger from '../utils/logger.js';
import { isOpenRouterEnabled, openRouterCompletion } from './providers/openrouter.js';
import { isGeminiEnabled, geminiCompletion } from './providers/gemini.js';
import { isGroqEnabled, groqCompletion } from './providers/groq.js';
import { isCerebrasEnabled, cerebrasCompletion } from './providers/cerebras.js';

const providers = {
  openrouter: { enabled: isOpenRouterEnabled, complete: openRouterCompletion },
  gemini: { enabled: isGeminiEnabled, complete: geminiCompletion },
  groq: { enabled: isGroqEnabled, complete: groqCompletion },
  cerebras: { enabled: isCerebrasEnabled, complete: cerebrasCompletion },
};

const health = new Map(Object.keys(providers).map((name) => [name, {
  failures: 0,
  openUntil: 0,
  requests: 0,
  successes: 0,
  totalLatencyMs: 0,
}]));

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

  if (error.code === 'QUOTA_EXHAUSTED') {
    state.openUntil = Date.now() + config.aiQuotaCooldownMs;
  } else if (error.code === 'RATE_LIMITED') {
    state.openUntil = Date.now() + config.aiRateLimitCooldownMs;
  } else if (state.failures >= config.aiCircuitFailureThreshold) {
    state.openUntil = Date.now() + config.aiCircuitCooldownMs;
  }
}

export async function chatCompletion(messages, opts = {}) {
  const order = providerOrder(opts);
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
      const result = await provider.complete(messages, opts);
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
    requests: state.requests,
    successes: state.successes,
    failures: state.requests - state.successes,
    averageLatencyMs: state.requests ? Math.round(state.totalLatencyMs / state.requests) : 0,
    circuitOpen: state.openUntil > Date.now(),
    circuitOpenUntil: state.openUntil || null,
  }]));
}

export default { chatCompletion, getAiStats };
