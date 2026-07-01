import config from '../../config.js';

function providerError(message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = 'pollinations';
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function isPollinationsEnabled() {
  // Pollinations API is free and doesn't require a key typically, 
  // or it's handled by their own proxy
  return true;
}

export async function pollinationsCompletion(messages, opts = {}) {
  if (!isPollinationsEnabled()) {
    throw providerError('Pollinations tidak diaktifkan', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      // Model is omitted by request since it is handled by the user/Pollinations proxy
      messages,
      max_tokens: opts.maxTokens || config.maxTokens,
      temperature: opts.temperature ?? 0.7,
    };

    const res = await fetch(config.pollinationsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
      throw providerError('Pollinations mengembalikan respons kosong', { code: 'EMPTY_RESPONSE' });
    }

    return {
      text: content.trim(),
      model: data.model || 'pollinations-default',
      usage: data.usage || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`Pollinations timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'pollinations') throw error;
    throw providerError(`Pollinations gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export default { isPollinationsEnabled, pollinationsCompletion };
