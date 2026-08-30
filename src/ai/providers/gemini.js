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
  return Boolean(config.geminiApiKey || (config.geminiApiKeys && config.geminiApiKeys.length > 0));
}

let geminiKeyIndex = 0;

export async function geminiCompletion(messages, opts = {}) {
  if (!isGeminiEnabled()) {
    throw providerError('GEMINI_API_KEY belum dikonfigurasi', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const model = opts.geminiModel || config.geminiModel;
  const timeoutMs = opts.timeoutMs || config.aiRequestTimeoutMs;
  const keys = config.geminiApiKeys.length > 0 ? config.geminiApiKeys : [config.geminiApiKey];
  const startIndex = geminiKeyIndex % keys.length;
  const errors = [];
  // Track the dominant failure mode across keys so the router's circuit
  // breaker picks the right cooldown (a 403 quota exhaustion must not be
  // reported as a 60 s rate-limit blip, and vice versa).
  let lastStatus = null;
  let sawRateLimit = false;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIndex + i) % keys.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${config.geminiUrl}/models/${encodeURIComponent(model)}:generateContent`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(toGeminiPayload(messages, opts)),
        signal: controller.signal,
      });

      if (!res.ok) {
        const responseText = await res.text();
        const err = providerError(`API ${res.status}: ${responseText.slice(0, 200)}`, {
          status: res.status,
          code: res.status === 429 ? 'RATE_LIMITED' : res.status === 403 ? 'QUOTA_EXHAUSTED' : 'HTTP_ERROR',
          retryable: res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500,
        });
        lastStatus = res.status;
        if (res.status === 429) sawRateLimit = true;
        errors.push(`key_${i + 1}: ${err.message}`);
        continue;
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

      geminiKeyIndex = (geminiKeyIndex + 1) % keys.length;
      return {
        text,
        model,
        usage: data.usageMetadata || null,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        errors.push(`key_${i + 1}: timeout setelah ${timeoutMs}ms`);
      } else {
        errors.push(`key_${i + 1}: ${error.message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // Classify the aggregate failure from what the keys actually returned —
  // defaulting everything to RATE_LIMITED misreports bad model names (400)
  // and auth failures (401) as rate limits and picks the wrong cooldown.
  if (sawRateLimit) {
    throw providerError(`Semua Gemini key gagal (rate limit): ${errors.join(' | ')}`, {
      code: 'RATE_LIMITED',
      retryable: true,
    });
  }
  if (lastStatus === 403) {
    throw providerError(`Semua Gemini key gagal (quota/auth): ${errors.join(' | ')}`, {
      status: 403,
      code: 'QUOTA_EXHAUSTED',
      retryable: true,
    });
  }
  throw providerError(`Semua Gemini key gagal: ${errors.join(' | ')}`, {
    status: lastStatus ?? undefined,
    code: 'HTTP_ERROR',
    retryable: true,
  });
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

  // Rotate across the full key list (config.geminiApiKeys already folds the
  // singular GEMINI_API_KEY in) so multi-key deployments don't hammer one key
  // and single-key setups are unaffected.
  const keys = config.geminiApiKeys.length > 0 ? config.geminiApiKeys : [config.geminiApiKey];
  const key = keys[geminiKeyIndex % keys.length] || config.geminiApiKey;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
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
