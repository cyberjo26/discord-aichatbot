import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';

/**
 * Jarvis Wake/Sleep Mode
 * - Wake (default): Bot responds to mentions
 * - Sleep: Bot ignores everything except owner "wake up" command
 * State persists to disk.
 */

let isAwake = true;

/**
 * Initialize — load state from disk
 */
export function initWakeSleep() {
  try {
    const dir = path.dirname(config.wakeSleepFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(config.wakeSleepFile)) {
      const raw = fs.readFileSync(config.wakeSleepFile, 'utf-8');
      const data = JSON.parse(raw);
      isAwake = data.isAwake !== false; // default to awake
      logger.info(`🔋 Wake/Sleep state loaded: ${isAwake ? '🟢 AWAKE' : '💤 SLEEPING'}`);
    }
  } catch (err) {
    logger.warn(`Failed to load wake/sleep state: ${err.message}`);
    isAwake = true;
  }
}

/**
 * Save state to disk
 */
function saveState() {
  safeWriteJson(config.wakeSleepFile, { isAwake, updatedAt: new Date().toISOString() });
}

/**
 * Check if bot is awake
 */
export function isBotAwake() {
  return isAwake;
}

/**
 * Put bot to sleep
 */
export function sleep() {
  isAwake = false;
  saveState();
  logger.info('💤 Jarvis entering SLEEP mode');
}

/**
 * Wake bot up
 */
export function wake() {
  isAwake = true;
  saveState();
  logger.info('🟢 Jarvis entering WAKE mode');
}

/**
 * Check if a message is a wake/sleep command.
 * Returns: 'sleep' | 'wake' | null
 */
export function checkWakeSleepCommand(text) {
  const normalized = text.toLowerCase().trim();

  // Sleep patterns
  const sleepPatterns = [
    /\b(tidur|sleep|istirahat|off|shutdown|matikan|diam)\b/i,
  ];

  // Wake patterns
  const wakePatterns = [
    /\b(bangun|wake\s*up|hidup|on|start|aktif|nyala)\b/i,
  ];

  for (const pattern of wakePatterns) {
    if (pattern.test(normalized)) return 'wake';
  }

  for (const pattern of sleepPatterns) {
    if (pattern.test(normalized)) return 'sleep';
  }

  return null;
}

export default { initWakeSleep, isBotAwake, sleep, wake, checkWakeSleepCommand };
