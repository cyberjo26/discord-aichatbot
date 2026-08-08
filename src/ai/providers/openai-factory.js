import config from '../../config.js';

function providerError(providerName, message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = providerName;
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function createOpenAIProvider(name, { baseURL, apiKey, defaultModel, extraHeaders = {}, omitModel = false, authPrefix = 'Bearer' }) {
  const isEnabled = () => Boolean(apiKey || (name === 'pollinations'));

  const complete = async (messages, opts = {}) => {
    if (!isEnabled()) {
      throw providerError(name, `${name.toUpperCase()}_API_KEY belum dikonfigurasi`, {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = {
        messages,
        max_tokens: opts.maxTokens || config.maxTokens,
        temperature: opts.temperature ?? 0.7,
      };

      if (!omitModel) {
        body.model = opts.model || defaultModel;
      }

      const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders,
      };

      if (apiKey) {
        headers['Authorization'] = `${authPrefix} ${apiKey}`;
      }

      const res = await fetch(baseURL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const responseText = await res.text();
        throw providerError(name, `API ${res.status}: ${responseText.slice(0, 200)}`, {
          status: res.status,
          code: res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          retryable: res.status === 408 || res.status === 429 || res.status >= 500,
        });
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw providerError(name, `${name.charAt(0).toUpperCase() + name.slice(1)} mengembalikan respons kosong`, { code: 'EMPTY_RESPONSE' });
      }

      return {
        text: content.trim(),
        model: data.model || body.model || `${name}-default`,
        usage: data.usage || null,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw providerError(name, `${name.charAt(0).toUpperCase() + name.slice(1)} timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
      }
      if (error.provider === name) throw error;
      throw providerError(name, `${name.charAt(0).toUpperCase() + name.slice(1)} gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timeout);
    }
  };

  return { isEnabled, complete };
}

export default { createOpenAIProvider };
