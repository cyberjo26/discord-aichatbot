import config from '../config.js';
import logger from '../utils/logger.js';
import { isOpenRouterEnabled, openRouterCompletion } from './providers/openrouter.js';
import { isGeminiEnabled, geminiCompletion } from './providers/gemini.js';
import { isGroqEnabled, groqCompletion } from './providers/groq.js';
import { isCerebrasEnabled, cerebrasCompletion } from './providers/cerebras.js';
import { isPollinationsEnabled, pollinationsCompletion } from './providers/pollinations.js';
import { isPuterEnabled, puterCompletion } from './providers/puter.js';
import { isNamedCustomEnabled, createNamedCustomProvider, isCustomEnabled, customCompletion } from './providers/custom-openai.js';

const builtInProviders = {
  openrouter: { enabled: isOpenRouterEnabled, complete: openRouterCompletion },
  gemini: { enabled: isGeminiEnabled, complete: geminiCompletion },
  groq: { enabled: isGroqEnabled, complete: groqCompletion },
  cerebras: { enabled: isCerebrasEnabled, complete: cerebrasCompletion },
  pollinations: { enabled: isPollinationsEnabled, complete: pollinationsCompletion },
  puter: { enabled: isPuterEnabled, complete: puterCompletion },
  custom: { enabled: isCustomEnabled, complete: customCompletion },
};

export function getProvider(name) {
  if (builtInProviders[name]) {
    return builtInProviders[name];
  }
  return {
    enabled: () => isNamedCustomEnabled(name),
    complete: (messages, opts) => {
      const p = createNamedCustomProvider(name);
      return p.complete(messages, opts);
    },
  };
}

const health = new Map(Object.keys(builtInProviders).map((name) => [name, {
  failures: 0,
  openUntil: 0,
  requests: 0,
  successes: 0,
  totalLatencyMs: 0,
}]));

function getHealth(name) {
  if (!health.has(name)) {
    health.set(name, {
      failures: 0,
      openUntil: 0,
      requests: 0,
      successes: 0,
      totalLatencyMs: 0,
    });
  }
  return health.get(name);
}

// Cap error messages in logs so a long API response body can't spam the log file,
// and strip control chars so embedded newlines can't break the line-based bot.log.
function shortError(error) {
  const msg = (error.message || String(error)).replace(/[\r\n\t]+/g, ' ').trim();
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/**
 * Strips internal thinking/reasoning traces (<think> tags, CoT preambles, and meta artifacts)
 * emitted by reasoning models (e.g. DeepSeek-R1, Qwen Thinking, Gemini Thinking).
 */
export function stripThinkingAndMeta(text) {
  if (typeof text !== 'string') return '';
  let out = text;

  // 1. Remove explicit XML/HTML thinking tags (<think>...</think>, <thought>...</thought>)
  out = out.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '');
  out = out.replace(/<(?:think|thought)>[\s\S]*$/gi, ''); // unclosed tag if truncated

  // 2. Remove safety / metadata headers
  out = out.replace(/^(?:User|Response)\s+Safety:\s*\w+\r?\n?/gim, '');

  // 3. Remove raw reasoning blocks (e.g. "Here's a thinking process:\n...")
  if (/^(?:Here(?:'s| is) a thinking process:?|Thinking Process:?|Reasoning:?)/i.test(out.trim())) {
    // If output contains an explicit Final Polish / Final Response / Final Answer marker:
    const finalMarkerMatch = out.match(/(?:Final (?:Polish|Response|Answer)):\s*["']?([\s\S]+?)(?:["']\s*-\s*[^\n]+|\n\s*Check rules|\n\s*Rules:|$)/i);
    if (finalMarkerMatch && finalMarkerMatch[1].trim()) {
      out = finalMarkerMatch[1].trim();
      out = out.replace(/^["']|["']$/g, '');
    } else {
      // General Response marker if present after thinking headers
      const responseMarkerMatch = out.match(/\n+(?:Response|Draft Response):\s*["']?([\s\S]+?)(?:["']\s*-\s*[^\n]+|\n\s*Check rules|\n\s*Rules:|$)/i);
      if (responseMarkerMatch && responseMarkerMatch[1].trim()) {
        out = responseMarkerMatch[1].trim();
        out = out.replace(/^["']|["']$/g, '');
      } else {
        // Fallback: strip header up to double newline
        out = out.replace(/^(?:Here(?:'s| is) a thinking process:?|Thinking Process:?|Reasoning:?)[\s\S]*?\n\n/i, '');
      }
    }
  }

  // 4. Strip trailing internal rule checks / prompt leaks (e.g. "Check rules:\nSpeak AS Ch...")
  out = out.replace(/\n+\s*Check rules:[\s\S]*$/i, '');
  out = out.replace(/\n+\s*Speak AS Ch[\s\S]*$/i, '');

  // 5. Strip English anime roleplay asterisks (*smirks*, *giggles*, *sighs*)
  out = out.replace(/\s*\*(?:smirks?|giggles?|sighs?|crosses arms|winks?|chuckles?|pouts?|rolls eyes|blushes?)\*\s*/gi, ' ');

  return out.trim();
}

const TASK_TOKEN_LIMITS = {
  routing: config.maxTokensTask.routing,
  chat: config.maxTokensTask.simpleChat,
  knowledge: config.maxTokensTask.complexChat,
  code_help: config.maxTokensTask.complexChat,
  summarize: config.maxTokensTask.simpleChat,
  clarification: config.maxTokensTask.routing,
};

let requestCount = 0;

export function providerOrder(opts) {
  if (opts.provider) return [opts.provider];
  const configured = [...config.aiProviderOrder];
  if (configured.length <= 1) return configured;

  // Rotate provider order for load balancing (round-robin)
  // Keep the counter bounded by the provider count (modulo) so it never
  // grows unbounded over the bot's lifetime.
  const shift = requestCount;
  requestCount = (requestCount + 1) % configured.length;

  return [...configured.slice(shift), ...configured.slice(0, shift)];
}

function circuitOpen(name) {
  return getHealth(name).openUntil > Date.now();
}

function recordSuccess(name, latencyMs) {
  const state = getHealth(name);
  state.failures = 0;
  state.openUntil = 0;
  state.requests++;
  state.successes++;
  state.totalLatencyMs += latencyMs;
}

function recordFailure(name, error, latencyMs) {
  const state = getHealth(name);
  state.failures++;
  state.requests++;
  state.totalLatencyMs += latencyMs;
  
  // Track error types
  state.errorTypes = state.errorTypes || {};
  const errCode = error.code || 'UNKNOWN';
  state.errorTypes[errCode] = (state.errorTypes[errCode] || 0) + 1;

  if (errCode === 'QUOTA_EXHAUSTED') {
    state.openUntil = Date.now() + config.aiQuotaCooldownMs;
  } else if (errCode === 'RATE_LIMITED') {
    state.openUntil = Date.now() + config.aiRateLimitCooldownMs;
  } else if (errCode === 'TIMEOUT') {
    const timeoutCount = state.errorTypes['TIMEOUT'] || 1;
    state.openUntil = Date.now() + Math.min(timeoutCount * config.aiRateLimitCooldownMs / 6, config.aiCircuitCooldownMs * 2);
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
    const provider = getProvider(name);
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
      const cleanedText = stripThinkingAndMeta(result.text);
      return cleanedText;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      recordFailure(name, error, latencyMs);
      failures.push(`${name}: ${shortError(error)}`);
      logger.warn(
        `AI gagal: provider=${name} code=${error.code || 'UNKNOWN'} status=${error.status || '-'} latency=${latencyMs}ms retryable=${error.retryable === false ? 'no' : 'yes'} msg="${shortError(error)}"; mencoba provider berikutnya`
      );
    }
  }

  logger.error(`Semua provider AI gagal: ${failures.join(' | ') || 'tidak ada provider aktif'}`);
  logger.error(`Detail: order=[${order.join(', ')}] circuitOpen=${order.filter((n) => circuitOpen(n)).join(',') || '-'}`);
  throw new Error(
    'Semua provider AI sedang tidak tersedia. Coba lagi sebentar. ' +
    '(Operator: set minimal satu key — OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ' +
    'CEREBRAS_API_KEY, PUTER_API_KEY, CUSTOM_AI_BASE_URL, atau POLLINATIONS_API_KEY — lalu cek log untuk detail provider.)'
  );
}

export function getAiStats() {
  const allNames = new Set([...Object.keys(builtInProviders), ...config.aiProviderOrder, ...health.keys()]);
  return Object.fromEntries([...allNames].map((name) => {
    const state = getHealth(name);
    const provider = getProvider(name);
    return [name, {
      isConfigured: provider.enabled(),
      requests: state.requests,
      successes: state.successes,
      failures: state.requests - state.successes,
      averageLatencyMs: state.requests ? Math.round(state.totalLatencyMs / state.requests) : 0,
      circuitOpen: state.openUntil > Date.now(),
      circuitOpenUntil: state.openUntil || null,
    }];
  }));
}

export default { chatCompletion, getAiStats, providerOrder, getProvider };
