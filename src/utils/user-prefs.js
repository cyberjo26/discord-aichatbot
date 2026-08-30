import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';

/**
 * User Preferences — Self-Improving Response System
 * Tracks and adapts to each user's preferred interaction style.
 * Persists to data/user-prefs.json.
 */

const DEFAULT_PREFS = {
  responseStyle: 'balanced', // 'concise' | 'detailed' | 'balanced'
  language: 'auto',          // 'id' | 'en' | 'auto'
  interactionCount: 0,
  avgMessageLength: 0,       // track how long user messages are
  preferMarkdown: true,
  lastUpdated: null,
};

let prefsStore = new Map();
let saveTimeout = null;

/**
 * Initialize — load prefs from disk
 */
export function initPrefs() {
  try {
    const dir = path.dirname(config.userPrefsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(config.userPrefsFile)) {
      const raw = fs.readFileSync(config.userPrefsFile, 'utf-8');
      const data = JSON.parse(raw);
      prefsStore = new Map(Object.entries(data));
      logger.info(`📋 Loaded ${prefsStore.size} user preferences`);
    }
  } catch (err) {
    logger.warn(`Failed to load user prefs: ${err.message}`);
  }
}

/**
 * Save prefs to disk (debounced)
 */
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const dir = path.dirname(config.userPrefsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = Object.fromEntries(prefsStore);
      safeWriteJson(config.userPrefsFile, data);
      logger.debug('User prefs saved to disk');
    } catch (err) {
      logger.error(`Failed to save user prefs: ${err.message}`);
    }
  }, 5000); // save after 5s of inactivity
}

/**
 * Get user preferences
 */
export function getUserPrefs(userId) {
  if (!prefsStore.has(userId)) {
    prefsStore.set(userId, { ...DEFAULT_PREFS });
  }
  return prefsStore.get(userId);
}

/**
 * Update preferences based on user interaction
 * Called after each message to learn from user patterns
 */
export function trackInteraction(userId, messageContent) {
  const prefs = getUserPrefs(userId);
  prefs.interactionCount++;
  prefs.lastUpdated = Date.now();

  // Track average message length to determine style preference
  const msgLen = messageContent.length;
  prefs.avgMessageLength = Math.round(
    (prefs.avgMessageLength * (prefs.interactionCount - 1) + msgLen) / prefs.interactionCount
  );

  // Auto-detect language preference
  const idPattern = /\b(aku|gue|gw|dong|ya|nih|bro|kak|bang|min|tolong|gimana|kenapa|apa|siapa|bagaimana|caranya)\b/i;
  const enPattern = /\b(please|could|would|should|what|where|when|why|how|the|is|are|was|were)\b/i;

  const idScore = (messageContent.match(idPattern) || []).length;
  const enScore = (messageContent.match(enPattern) || []).length;

  if (idScore > enScore + 1) prefs.language = 'id';
  else if (enScore > idScore + 1) prefs.language = 'en';

  // Auto-detect response style preference every 5 interactions
  if (prefs.interactionCount % 5 === 0) {
    if (prefs.avgMessageLength < 30) {
      // Short messages → user prefers concise responses
      prefs.responseStyle = 'concise';
    } else if (prefs.avgMessageLength > 100) {
      // Long messages → user appreciates detail
      prefs.responseStyle = 'detailed';
    } else {
      prefs.responseStyle = 'balanced';
    }
    logger.debug(`User ${userId} style adapted: ${prefs.responseStyle} (avg msg: ${prefs.avgMessageLength} chars)`);
  }

  scheduleSave();
}

/**
 * Build a style instruction string for the AI based on user prefs
 */
export function buildStyleInstruction(userId) {
  const prefs = getUserPrefs(userId);
  const parts = [];

  switch (prefs.responseStyle) {
    case 'concise':
      parts.push('User ini suka jawaban SINGKAT dan to-the-point. Jangan bertele-tele. Maksimal 2-3 kalimat kalau bisa.');
      break;
    case 'detailed':
      parts.push('User ini suka jawaban DETAIL dan mendalam. Berikan penjelasan lengkap, contoh, dan breakdown step-by-step.');
      break;
    default:
      parts.push('Jawab dengan panjang yang proporsional — tidak terlalu singkat, tidak terlalu panjang.');
  }

  if (prefs.language === 'id') {
    parts.push('User lebih nyaman berbahasa Indonesia. Gunakan Bahasa Indonesia casual/santai.');
  } else if (prefs.language === 'en') {
    parts.push('User prefers English. Respond in English.');
  }

  return parts.join(' ');
}

/**
 * Manually set a preference
 */
export function setUserPref(userId, key, value) {
  const prefs = getUserPrefs(userId);
  if (key in DEFAULT_PREFS) {
    prefs[key] = value;
    prefs.lastUpdated = Date.now();
    scheduleSave();
    return true;
  }
  return false;
}

export function forceSavePrefs() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (prefsStore.size === 0) return;
  const data = Object.fromEntries(prefsStore);
  safeWriteJson(config.userPrefsFile, data);
}

export default { initPrefs, getUserPrefs, trackInteraction, buildStyleInstruction, setUserPref, forceSavePrefs };
