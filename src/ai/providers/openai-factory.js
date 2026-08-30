import config from '../../config.js';

function providerError(providerName, message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = providerName;
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function extractContent(data) {
  if (!data) return '';
  if (typeof data.choices?.[0]?.message?.content === 'string' && data.choices[0].message.content.trim()) {
    return data.choices[0].message.content;
  }
  if (typeof data.choices?.[0]?.message?.reasoning_content === 'string' && data.choices[0].message.reasoning_content.trim()) {
    return data.choices[0].message.reasoning_content;
  }
  if (typeof data.choices?.[0]?.text === 'string' && data.choices[0].text.trim()) {
    return data.choices[0].text;
  }
  if (typeof data.response === 'string' && data.response.trim()) return data.response;
  if (typeof data.text === 'string' && data.text.trim()) return data.text;
  if (typeof data.output === 'string' && data.output.trim()) return data.output;
  return '';
}

function extractFallbackText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';

  // Match content in standard, truncated, or unclosed JSON
  const match = rawText.match(/"(?:content|reasoning_content|text|response|output)"\s*:\s*"((?:[^"\\]|\\.)*)/i);
  if (match && match[1] && match[1].trim()) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
    }
  }

  return '';
}

export function createOpenAIProvider(name, { baseURL, apiKey, defaultModel, extraHeaders = {}, omitModel = false, authPrefix = 'Bearer', defaultTimeoutMs }) {
  const isEnabled = () => Boolean(apiKey || (name === 'pollinations') || name.startsWith('custom'));

  const complete = async (messages, opts = {}) => {
    if (!isEnabled()) {
      throw providerError(name, `${name.toUpperCase()}_API_KEY belum dikonfigurasi`, {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || defaultTimeoutMs || config.aiRequestTimeoutMs;
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

      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        // 1. Handle SSE (Server-Sent Events) formatted stream from proxies like 9router
        if (rawText.includes('data:')) {
          const lines = rawText.split('\n');
          let accumulatedContent = '';
          let _accumulatedReasoning = '';
          let responseModel = body.model || `${name}-default`;

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;
            if (trimmed.startsWith('data:')) {
              const jsonPart = trimmed.slice(5).trim();
              try {
                const chunk = JSON.parse(jsonPart);
                if (chunk.model) responseModel = chunk.model;
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) accumulatedContent += delta.content;
                if (delta?.reasoning_content) _accumulatedReasoning += delta.reasoning_content;
                if (chunk.choices?.[0]?.text) accumulatedContent += chunk.choices[0].text;
              } catch {
                // ignore unparseable chunk
              }
            }
          }

          // Only return real content. A stream that emitted nothing but
          // reasoning_content (e.g. truncated CoT from a reasoning proxy)
          // must NOT be surfaced as the answer — fail over instead.
          if (accumulatedContent.trim()) {
            return {
              text: accumulatedContent.trim(),
              model: responseModel,
              usage: null,
            };
          }
        }

        // 2. Handle truncated or malformed JSON with regex fallback
        const fallbackText = extractFallbackText(rawText);
        if (fallbackText) {
          return {
            text: fallbackText,
            model: body.model || `${name}-default`,
            usage: null,
          };
        }

        throw providerError(name, `${name.charAt(0).toUpperCase() + name.slice(1)} gagal parse JSON: ${rawText.slice(0, 200)}`, { code: 'INVALID_JSON' });
      }

      const content = extractContent(data);
      if (!content) {
        // Fallback to regex text extraction if content field was non-standard
        const fallbackText = extractFallbackText(rawText);
        if (fallbackText) {
          return {
            text: fallbackText,
            model: data.model || body.model || `${name}-default`,
            usage: data.usage || null,
          };
        }
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
