import config from '../../config.js';

function providerError(message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = 'groq';
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function isGroqEnabled() {
  return Boolean(config.groqApiKey);
}

export async function groqCompletion(messages, opts = {}) {
  if (!isGroqEnabled()) {
    throw providerError('GROQ_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: opts.model || config.groqModel,
      messages,
      max_tokens: opts.maxTokens || config.maxTokens,
      temperature: opts.temperature ?? 0.7,
    };

    const res = await fetch(config.groqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.groqApiKey}`,
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
      throw providerError('Groq mengembalikan respons kosong', { code: 'EMPTY_RESPONSE' });
    }

    return {
      text: content.trim(),
      model: data.model || body.model,
      usage: data.usage || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`Groq timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'groq') throw error;
    throw providerError(`Groq gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export default { isGroqEnabled, groqCompletion };
