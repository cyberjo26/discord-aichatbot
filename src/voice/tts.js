import { createRequire } from 'module';
import { readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { chatCompletion } from '../ai/openrouter.js';
import { VOICE_CONDENSE_PROMPT, VOICE_TRANSLATE_PROMPT } from '../ai/prompts.js';

// node-edge-tts is CJS, need createRequire for ESM
const require = createRequire(import.meta.url);
const { EdgeTTS } = require('node-edge-tts');

// Temp directory for audio files
const TEMP_DIR = join(process.cwd(), 'temp');

// Ensure temp dir exists
await mkdir(TEMP_DIR, { recursive: true });

// Edge TTS voice per output language. Extend as needed.
// Full list: https://learn.microsoft.com/azure/ai-services/speech-service/language-support
const EDGE_VOICE_BY_LANGUAGE = {
  'id-ID': 'id-ID-ArdiNeural',   // Indonesian (male)
  'en-US': 'en-US-AriaNeural',   // English US (female)
  'en-GB': 'en-GB-SoniaNeural',  // English UK (female)
  'ja-JP': 'ja-JP-NanamiNeural', // Japanese (female)
  'ko-KR': 'ko-KR-SunHiNeural',  // Korean (female)
  'zh-CN': 'zh-CN-XiaoxiaoNeural', // Chinese Mandarin (female)
  'ms-MY': 'ms-MY-OsmanNeural',  // Malay (male)
  'es-ES': 'es-ES-ElviraNeural', // Spanish (female)
  'fr-FR': 'fr-FR-DeniseNeural', // French (female)
  'de-DE': 'de-DE-KatjaNeural',  // German (female)
};

/**
 * Resolve the Edge TTS voice for the configured language.
 * Explicit TTS_VOICE config wins; otherwise use the language map,
 * falling back to Indonesian.
 */
function resolveEdgeVoice() {
  return (
    config.ttsVoice ||
    EDGE_VOICE_BY_LANGUAGE[config.ttsLanguage] ||
    EDGE_VOICE_BY_LANGUAGE['id-ID']
  );
}

/**
 * Edge voice to use when text has been translated to English
 * (TTS_TRANSLATE_ENGLISH mode). Only the translated callers use this —
 * reminders/welcome keep their configured language voice.
 *
 * An explicit TTS_VOICE is honored only when it is an English voice;
 * a non-English explicit voice (e.g. id-ID-*) would defeat the point of
 * translation mode, so it falls back to the default English voice.
 */
export function resolveEnglishVoice() {
  if (config.ttsVoice && config.ttsVoice.toLowerCase().startsWith('en-')) {
    return config.ttsVoice;
  }
  return EDGE_VOICE_BY_LANGUAGE['en-US'];
}

// Common Indonesian words — cheap check to skip AI translation when the
// text is already English (voice replies stay instant).
const ID_MARKER_RE = /\b(aku|gue|gw|kamu|lu|kalian|yang|untuk|dengan|tidak|nggak|gak|sudah|udah|bisa|sih|deh|kok|dong|aja|bang|bro|kak|dari|ini|itu|dan|atau|juga|mau|ingin|tolong|caranya|kenapa)\b/i;

function looksIndonesian(text) {
  const matches = String(text).match(ID_MARKER_RE);
  return (matches || []).length >= 2;
}

/**
 * Clean a raw translation response for TTS.
 * Free/rotating models sometimes "reason aloud" before answering — the
 * actual translation is the last few sentences. If the output is verbose,
 * keep only the final sentences.
 */
function cleanTranslation(raw) {
  const text = stripMarkdown(raw).trim();
  if (!text) return null;

  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 4) {
    return sentences.slice(-2).join(' ').trim();
  }
  return text;
}

// Reliable model for translation: the default 'openrouter/free' endpoint can
// randomly route to non-chat models (e.g. content-safety) and return garbage,
// so the translation call pins a known-good free chat model first.
const TRANSLATE_MODEL = process.env.TTS_TRANSLATE_MODEL || 'openai/gpt-oss-20b:free';

/**
 * Translate text to natural spoken English for TTS output.
 * Used when TTS_TRANSLATE_ENGLISH is on: chat/action answers are spoken
 * in English regardless of the language the AI replied in.
 *
 * @param {string} text - Text to translate (also condenses long text)
 * @returns {Promise<string|null>} Translated text, or null on failure
 *          (condenseForVoice then runs its normal fallback)
 */
export async function translateForVoice(text) {
  if (process.env.TEST_ENV) return text;
  // Already-English SHORT replies (e.g. "OK", "Done") skip the AI call.
  // Long English text returns null so condenseForVoice still condenses it.
  if (!looksIndonesian(text) && String(text).length <= 200) return stripMarkdown(text);

  const messages = [
    { role: 'system', content: VOICE_TRANSLATE_PROMPT },
    { role: 'user', content: String(text).slice(0, 2000) },
  ];

  // Attempt 1: pinned chat model via OpenRouter ONLY (deterministic quality).
  // Restricting the provider is essential: the pinned model ID (e.g.
  // `openai/gpt-oss-20b:free`) only exists on OpenRouter — passing it through
  // the router would 404 on groq/cerebras and produce a log line per provider.
  let translated = null;
  try {
    translated = cleanTranslation(
      await chatCompletion(messages, {
        provider: 'openrouter',
        model: TRANSLATE_MODEL,
        maxTokens: 300,
        temperature: 0,
        timeoutMs: 15000,
      })
    );
  } catch (err) {
    logger.debug(`TTS translate (pinned model) failed: ${err.message}`);
  }

  // Attempt 2: default router order (any available provider).
  if (!translated) {
    try {
      translated = cleanTranslation(
        await chatCompletion(messages, { maxTokens: 300, temperature: 0 })
      );
    } catch (err) {
      logger.warn(`TTS translate failed, using original: ${err.message}`);
    }
  }

  // Return null on total failure — condenseForVoice then runs its normal
  // condense/truncate fallback so voice output always speaks something.
  return translated;
}

/**
 * Condense a long AI answer into 2-3 sentences suitable for speech.
 *
 * @param {string} fullAnswer - The full text answer from AI
 * @returns {Promise<string>} Condensed text for TTS
 */
export async function condenseForVoice(fullAnswer) {
  // English translation mode: one AI call that translates + condenses.
  // Falls back to the normal path (below) if translation fails.
  if (config.ttsTranslateEnglish) {
    const translated = await translateForVoice(fullAnswer);
    if (translated) return translated;
  }

  // If already short enough, use as-is
  if (fullAnswer.length <= 200) {
    return stripMarkdown(fullAnswer);
  }

  try {
    const condensed = await chatCompletion([
      { role: 'system', content: VOICE_CONDENSE_PROMPT },
      {
        role: 'user',
        content: `Ringkas jawaban berikut untuk diucapkan:\n\n${fullAnswer}`,
      },
    ], { maxTokens: 200 });

    return stripMarkdown(condensed);
  } catch (err) {
    logger.warn(`Condense failed, using truncated original: ${err.message}`);
    // Fallback: take first 2 sentences
    const sentences = fullAnswer.match(/[^.!?]+[.!?]+/g) || [fullAnswer];
    return stripMarkdown(sentences.slice(0, 2).join(' '));
  }
}

/**
 * Convert text to speech.
 * Uses the custom OpenAI-compatible TTS API when configured (primary),
 * falling back to Microsoft Edge TTS on failure or when not configured.
 *
 * @param {string} text - Text to synthesize
 * @param {string} [voice] - Voice ID (e.g., 'id-ID-ArdiNeural')
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function synthesize(text, voice = resolveEdgeVoice()) {
  if (process.env.TEST_ENV) {
    return Buffer.from('mock_audio_data');
  }

  logger.debug(`TTS synthesizing (${voice}): "${text.slice(0, 80)}..."`);

  // Primary: custom OpenAI-compatible TTS (only if configured)
  if (isCustomTtsConfigured()) {
    try {
      const buffer = await synthesizeCustom(text);
      logger.debug(`Custom TTS done: ${(buffer.length / 1024).toFixed(1)} KB`);
      return buffer;
    } catch (err) {
      logger.warn(`Custom TTS failed, falling back to Edge TTS: ${err.message}`);
      // fall through to Edge TTS
    }
  }

  // Fallback: Microsoft Edge TTS
  return synthesizeEdge(text, voice);
}

/**
 * Check whether the custom OpenAI-compatible TTS is configured.
 */
function isCustomTtsConfigured() {
  return Boolean(config.customTtsBaseUrl && config.customTtsModel);
}

/**
 * Synthesize speech via a custom OpenAI-compatible TTS endpoint.
 * Calls POST {base}/v1/audio/speech with the standard OpenAI audio.speech body.
 *
 * @param {string} text - Text to synthesize
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesizeCustom(text) {
  const base = config.customTtsBaseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/audio/speech`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.customTtsTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.customTtsApiKey ? { Authorization: `Bearer ${config.customTtsApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.customTtsModel,
        input: text,
        voice: config.customTtsVoice,
        language: config.customTtsLanguage,
        response_format: config.customTtsResponseFormat,
        speed: config.customTtsSpeed,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert text to speech using Microsoft Edge TTS.
 * Saves to temp file, reads back as Buffer, then cleans up.
 *
 * @param {string} text - Text to synthesize
 * @param {string} voice - Voice ID (e.g., 'id-ID-ArdiNeural')
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesizeEdge(text, voice) {
  const tts = new EdgeTTS({
    voice,
    lang: voice.split('-').slice(0, 2).join('-'),
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
    rate: config.ttsRate,
    pitch: config.ttsPitch,
    timeout: 30000,
  });

  // Generate unique temp file path
  const tempFile = join(TEMP_DIR, `tts_${randomBytes(8).toString('hex')}.mp3`);

  try {
    // Synthesize to temp file
    await tts.ttsPromise(text, tempFile);

    // Read back as buffer
    const buffer = await readFile(tempFile);
    logger.debug(`Edge TTS done: ${(buffer.length / 1024).toFixed(1)} KB`);

    return buffer;
  } catch (err) {
    throw new Error(`TTS synthesis failed: ${err.message || err}`);
  } finally {
    // Clean up temp file
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Strip markdown formatting from text (for voice output)
 */
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')       // bold
    .replace(/\*(.*?)\*/g, '$1')             // italic
    .replace(/`(.*?)`/g, '$1')               // inline code
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/#{1,6}\s/g, '')                // headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^\s*[-*+]\s/gm, '')            // list markers
    .replace(/^\s*\d+\.\s/gm, '')            // numbered list
    .replace(/\n{2,}/g, '. ')                // double newlines to period
    .replace(/\n/g, ' ')                     // single newlines to space
    .replace(/\s{2,}/g, ' ')                 // multiple spaces
    .trim();
}

export default { condenseForVoice, translateForVoice, resolveEnglishVoice, synthesize };
