import fs from 'fs';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';

const WARNINGS_FILE = config.dataDir + '/warnings.json';
let warnings = {}; // { guildId: { userId: [{ reason, warnedBy, timestamp }] } }

/**
 * Initialize warnings from file
 */
export function initWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
      const totalWarns = Object.values(warnings).reduce((sum, guild) =>
        sum + Object.values(guild).reduce((s, arr) => s + arr.length, 0), 0
      );
      logger.info(`⚠️ Loaded ${totalWarns} warnings`);
    }
  } catch (err) {
    logger.warn(`Failed to load warnings: ${err.message}`);
    warnings = {};
  }
}

function save() {
  safeWriteJson(WARNINGS_FILE, warnings);
}

/**
 * Add a warning to a user
 */
export function addWarning(guildId, userId, reason, warnedBy) {
  if (!warnings[guildId]) warnings[guildId] = {};
  if (!warnings[guildId][userId]) warnings[guildId][userId] = [];

  const entry = {
    reason,
    warnedBy,
    timestamp: new Date().toISOString(),
  };

  warnings[guildId][userId].push(entry);
  save();

  return {
    total: warnings[guildId][userId].length,
    entry,
  };
}

/**
 * Get warnings for a user
 */
export function getWarnings(guildId, userId) {
  return (warnings[guildId] && warnings[guildId][userId]) || [];
}

/**
 * Clear all warnings for a user
 */
export function clearWarnings(guildId, userId) {
  if (warnings[guildId] && warnings[guildId][userId]) {
    const count = warnings[guildId][userId].length;
    delete warnings[guildId][userId];
    save();
    return count;
  }
  return 0;
}

export default { initWarnings, addWarning, getWarnings, clearWarnings };
