import config from '../../config.js';

function providerError(message, { status, code, retryable = true } = {}) {
  const error = new Error(message);
  error.provider = 'gemini';
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function toGeminiPayload(messages, opts) {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content) }],
    }));

  const generationConfig = {
    maxOutputTokens: opts.maxTokens || config.maxTokens,
    temperature: opts.temperature ?? 0.7,
  };

  if (opts.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = opts.jsonSchema;
  }

  return {
    ...(systemText && { systemInstruction: { parts: [{ text: systemText }] } }),
    contents,
    generationConfig,
  };
}

export function isGeminiEnabled() {
  return Boolean(config.geminiApiKey);
}

export async function geminiCompletion(messages, opts = {}) {
  if (!isGeminiEnabled()) {
    throw providerError('GEMINI_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const model = opts.geminiModel || config.geminiModel;
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${config.geminiUrl}/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify(toGeminiPayload(messages, opts)),
      signal: controller.signal,
    });

    if (!res.ok) {
      const responseText = await res.text();
      throw providerError(`API ${res.status}: ${responseText.slice(0, 200)}`, {
        status: res.status,
        code: res.status === 429 ? 'RATE_LIMITED' : res.status === 403 ? 'QUOTA_EXHAUSTED' : 'HTTP_ERROR',
        retryable: res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500,
      });
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();

    if (!text) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'EMPTY_RESPONSE';
      throw providerError(`Gemini mengembalikan respons kosong: ${reason}`, { code: reason });
    }

    return {
      text,
      model,
      usage: data.usageMetadata || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`Gemini timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'gemini') throw error;
    throw providerError(`Gemini gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export async function geminiEmbedding(text) {
  if (!isGeminiEnabled()) {
    throw providerError('GEMINI_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const model = 'gemini-embedding-001';
  const timeoutMs = config.aiRequestTimeoutMs || 10000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${config.geminiUrl}/models/${model}:embedContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        content: {
          parts: [{ text }]
        }
      }),
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
    const values = data.embedding?.values;
    if (!values || !Array.isArray(values)) {
      throw providerError('Gemini mengembalikan embedding yang tidak valid', { code: 'INVALID_RESPONSE' });
    }

    return values;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(`Gemini embedding timeout setelah ${timeoutMs}ms`, { code: 'TIMEOUT' });
    }
    if (error.provider === 'gemini') throw error;
    throw providerError(`Gemini embedding gagal: ${error.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

export default { isGeminiEnabled, geminiCompletion, geminiEmbedding };
