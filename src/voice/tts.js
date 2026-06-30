import { createRequire } from 'module';
import { readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { chatCompletion } from '../ai/openrouter.js';
import { VOICE_CONDENSE_PROMPT } from '../ai/prompts.js';

// node-edge-tts is CJS, need createRequire for ESM
const require = createRequire(import.meta.url);
const { EdgeTTS } = require('node-edge-tts');

// Temp directory for audio files
const TEMP_DIR = join(process.cwd(), 'temp');

// Ensure temp dir exists
await mkdir(TEMP_DIR, { recursive: true });

/**
 * Condense a long AI answer into 2-3 sentences suitable for speech.
 *
 * @param {string} fullAnswer - The full text answer from AI
 * @returns {Promise<string>} Condensed text for TTS
 */
export async function condenseForVoice(fullAnswer) {
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
 * Convert text to speech using Microsoft Edge TTS.
 * Saves to temp file, reads back as Buffer, then cleans up.
 *
 * @param {string} text - Text to synthesize
 * @param {string} [voice] - Voice ID (e.g., 'id-ID-ArdiNeural')
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function synthesize(text, voice = config.ttsVoice) {
  if (process.env.TEST_ENV) {
    return Buffer.from('mock_audio_data');
  }
  
  logger.debug(`TTS synthesizing (${voice}): "${text.slice(0, 80)}..."`);

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
    logger.debug(`TTS done: ${(buffer.length / 1024).toFixed(1)} KB`);

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

export default { condenseForVoice, synthesize };
