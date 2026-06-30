import config from '../../config.js';

function providerError(message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = 'openrouter';
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function isOpenRouterEnabled() {
  return Boolean(config.openRouterKey);
}

export async function openRouterCompletion(messages, opts = {}) {
  if (!isOpenRouterEnabled()) {
    throw providerError('OPENROUTER_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: opts.model || config.primaryModel,
      messages,
      max_tokens: opts.maxTokens || config.maxTokens,
      temperature: opts.temperature ?? 0.7,
    };

    // OpenRouter handles these fallbacks inside one HTTP request.
    if (!opts.model && config.openRouterFallbackModels.length > 0) {
      body.models = config.openRouterFallbackModels;
    }

    const res = await fetch(config.openRouterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openRouterKey}`,
        'HTTP-Referer': 'https://github.com/discord-ai-bot',
        'X-OpenRouter-Title': config.botName,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const responseText = await res.text();
      throw providerError(`API ${res.status}: ${responseText.slice(0, 200)}`, {
        status: res.status,
        code: res.status === 402 ? 'QUOTA_EXHAUSTED' : res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
        retryable: res.status === 402 || res.status === 408 || res.status === 429 || res.status >= 500,
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw providerError('OpenRouter mengembalikan respons kosong', { code: 'EMPTY_RESPONSE' });
    }

    return {
      text: content.trim(),
      model: data.model || body.model,
      usage: data.usage || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`OpenRouter timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'openrouter') throw error;
    throw providerError(`OpenRouter gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export default { isOpenRouterEnabled, openRouterCompletion };
