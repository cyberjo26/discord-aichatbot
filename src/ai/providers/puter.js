import config from '../../config.js';

function providerError(message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = 'puter';
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function isPuterEnabled() {
  return Boolean(config.puterApiKey);
}

export async function puterCompletion(messages, opts = {}) {
  if (!isPuterEnabled()) {
    throw providerError('PUTER_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: opts.model || config.puterModel,
      messages,
      max_tokens: opts.maxTokens || config.maxTokens,
      temperature: opts.temperature ?? 0.7,
    };

    const res = await fetch(config.puterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.puterApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const responseText = await res.text();
      throw providerError(`API ${res.status}: ${responseText.slice(0, 200)}`, {
        status: res.status,
        code: res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw providerError('Puter mengembalikan respons kosong', { code: 'EMPTY_RESPONSE' });
    }

    return {
      text: content.trim(),
      model: data.model || body.model,
      usage: data.usage || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`Puter timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'puter') throw error;
    throw providerError(`Puter gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export default { isPuterEnabled, puterCompletion };
