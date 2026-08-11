import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';

/**
 * AFK System — per-user away status.
 * User sets AFK via `!afk <reason>`. The bot tells people who mention/reply
 * to an AFK user, and auto-clears the status when the user is seen again
 * (sends a message or starts typing).
 *
 * Persists to data/afk.json.
 */

let afkStore = new Map(); // userId -> { reason, setAt, guildId }
let saveTimeout = null;

/**
 * Initialize — load AFK entries from disk
 */
export function initAfk() {
  try {
    const dir = path.dirname(config.afkFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(config.afkFile)) {
      const raw = fs.readFileSync(config.afkFile, 'utf-8');
      const data = JSON.parse(raw);
      afkStore = new Map(Object.entries(data));
      logger.info(`😴 Loaded ${afkStore.size} AFK entr${afkStore.size === 1 ? 'y' : 'ies'}`);
    }
  } catch (err) {
    logger.warn(`Failed to load AFK store: ${err.message}`);
  }
}

/**
 * Save AFK entries to disk (debounced)
 */
function scheduleSave() {
  // Hermetic test mode: never touch disk or keep the event loop alive
  if (process.env.TEST_ENV) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const dir = path.dirname(config.afkFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Object.fromEntries(afkStore);
      safeWriteJson(config.afkFile, data);
      logger.debug('AFK store saved to disk');
    } catch (err) {
      logger.error(`Failed to save AFK store: ${err.message}`);
    }
  }, 3000);
}

/**
 * Check if a user is currently AFK
 * @param {string} userId
 * @returns {boolean}
 */
export function isAfk(userId) {
  return afkStore.has(userId);
}

/**
 * Get AFK entry for a user (or null)
 * @param {string} userId
 * @returns {{reason: string, setAt: number, guildId: string|null}|null}
 */
export function getAfk(userId) {
  return afkStore.get(userId) || null;
}

/**
 * Set a user as AFK
 * @param {string} userId
 * @param {string} reason
 * @param {string|null} [guildId]
 * @returns {object} The stored entry
 */
export function setAfk(userId, reason, guildId = null) {
  const entry = {
    reason: (reason || '').trim() || 'AFK',
    setAt: Date.now(),
    guildId,
  };
  afkStore.set(userId, entry);
  scheduleSave();
  return entry;
}

/**
 * Clear a user's AFK status
 * @param {string} userId
 * @returns {object|null} The removed entry, or null if user wasn't AFK
 */
export function clearAfk(userId) {
  if (!afkStore.has(userId)) return null;
  const entry = afkStore.get(userId);
  afkStore.delete(userId);
  scheduleSave();
  return entry;
}

/**
 * Human-readable "since X" text from a timestamp
 * @param {number} setAt - epoch ms
 * @returns {string} e.g. "5 menit lalu", "2 jam lalu"
 */
export function formatAfkSince(setAt) {
  const diffMs = Date.now() - setAt;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

/**
 * Force flush to disk (shutdown / crash safety)
 */
export function forceSaveAfk() {
  if (process.env.TEST_ENV) return;
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (afkStore.size === 0) {
    // Still persist an empty store so stale entries get cleared on disk
    safeWriteJson(config.afkFile, {});
    return;
  }
  const data = Object.fromEntries(afkStore);
  safeWriteJson(config.afkFile, data);
}

/**
 * Detect a natural-language AFK statement (no !afk prefix needed).
 *
 * Matches first-person AFK intents in English and Indonesian:
 *   - "Im going to afk because want to dinner"
 *   - "Gw afk dulu mau makan"
 *   - "aku afk sebentar"
 *   - "going afk for study" / "afk brb" / "brb"
 *
 * @param {string} content - Raw message text
 * @returns {{matched: boolean, reason: string|null}}
 */
export function detectAfkIntent(content) {
  const text = String(content || '').trim();
  if (!text) return { matched: false, reason: null };

  const INTENT_RE =
    /(?:\b(?:i'?m|im|am|aku|saya|gw|gue|guee)\s+(?:going\s+)?(?:to\s+)?(?:be\s+)?afk\b)|(?:\b(?:going|gonna|go|will)\s+(?:to\s+)?(?:be\s+)?afk\b)|(?:\bafk\s+(?:dulu|bentar|sebentar|for|because|mau|mo|untuk|karena|now|brb)\b)|(?:\b(?:set|be)\s+afk\b)|(?:^\s*brb\b)|(?:\bbrb\s+(?:for|dulu|mau|mo)\b)/i;

  if (!INTENT_RE.test(text)) return { matched: false, reason: null };

  // Extract reason: text after the afk/brb keyword, then strip connectors
  // repeatedly so chains like "because want to dinner" → "dinner".
  const keywordIdx = text.search(/\b(?:afk|brb)\b/i);
  let reason = keywordIdx !== -1 ? text.slice(keywordIdx) : '';
  reason = reason.replace(/^\s*(?:afk|brb)\b/i, '');
  for (let i = 0; i < 4; i++) {
    const cleaned = reason
      .replace(/^[\s,:;.\-–]+/, '')
      .replace(/^(?:because|untuk|karena|for|want to|wanna|going to|gonna|mau|mo|dulu|bentar|sebentar|nih|ya|to|akan|bakal)\b[\s,:;.\-–]*/i, '')
      .replace(/[.!?]+\s*$/, '')
      .trim();
    if (cleaned === reason) break;
    reason = cleaned;
  }

  // Fallback reason when nothing extractable remains
  if (!reason) reason = text.search(/\bbrb\b/i) !== -1 ? 'brb' : 'AFK';

  // Keep it short for the notification
  reason = reason.slice(0, 80);
  return { matched: true, reason };
}

/**
 * Build the AFK notification text for a user.
 * @param {string} userId
 * @returns {string|null} Message to send, or null if user is not AFK
 */
export function buildAfkNotice(userId) {
  const entry = getAfk(userId);
  if (!entry) return null;
  return (
    `😴 <@${userId}> sedang **AFK**: ${entry.reason} (${formatAfkSince(entry.setAt)}).\n` +
    'Kemungkinan tidak akan segera membalas.'
  );
}

/**
 * Process an incoming guild message for the AFK system:
 * 1. Auto-clear the author's AFK status (they are back) unless it's an !afk command.
 * 2. If the message mentions or replies to an AFK user, notify the sender.
 *
 * @param {object} message - Discord message (client-side)
 */
export async function handleAfkMessageEvent(message) {
  if (!message.guild) return;

  const authorId = message.author.id;
  const content = message.content || '';
  const isAfkCommand = content.trim().toLowerCase().startsWith('!afk');

  // 0. Natural-language AFK intent (no prefix needed)
  // e.g. "Gw afk dulu mau makan" / "Im going to afk because dinner"
  if (!isAfkCommand) {
    const intent = detectAfkIntent(content);
    if (intent.matched) {
      const reason = intent.reason || 'AFK';
      const previous = getAfk(authorId);
      setAfk(authorId, reason, message.guild.id);
      logger.info(`${message.author.tag} AFK via natural language ("${reason}")`);
      const wasAlready = previous ? ` (alasan diganti dari "${previous.reason}")` : '';
      await message.channel
        .send(`😴 <@${authorId}> sekarang **AFK**: ${reason}${wasAlready}\n` +
              'Kalau ada yang mention/reply kamu, mereka akan diberitahu. Ketik pesan apa saja untuk kembali.')
        .catch(() => {});
      return; // message consumed — don't auto-clear or notify
    }
  }

  // 1. AFK user returns by sending a normal message
  if (!isAfkCommand && isAfk(authorId)) {
    const cleared = clearAfk(authorId);
    if (cleared) {
      logger.info(`👋 ${message.author.tag} kembali dari AFK ("${cleared.reason}")`);
      await message.channel
        .send(`👋 <@${authorId}> sudah kembali! Status AFK ("${cleared.reason}") dihapus.`)
        .catch(() => {});
    }
  }

  // 2. Message mentions an AFK user → tell the sender
  const mentioned = [...(message.mentions?.users?.values() || [])]
    .filter((u) => u.id !== authorId && !u.bot);
  for (const user of mentioned) {
    const notice = buildAfkNotice(user.id);
    if (notice) {
      await message.reply(notice).catch(() => {});
      return; // one notice per message is enough
    }
  }

  // 3. Message replies to an AFK user → tell the sender
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      if (ref && !ref.author.bot && ref.author.id !== authorId) {
        const notice = buildAfkNotice(ref.author.id);
        if (notice) {
          await message.reply(notice).catch(() => {});
        }
      }
    } catch (err) {
      logger.debug(`AFK reply lookup failed: ${err.message}`);
    }
  }
}

export default {
  initAfk,
  isAfk,
  getAfk,
  setAfk,
  clearAfk,
  formatAfkSince,
  buildAfkNotice,
  detectAfkIntent,
  handleAfkMessageEvent,
  forceSaveAfk,
};
