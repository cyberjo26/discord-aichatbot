import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../config.js';
import logger from './logger.js';

/**
 * ─── Server Settings ────────────────────────────────────────────────
 * Per-guild settings stored in JSON file.
 * Replaces hardcoded .env values for welcome/announce channels.
 *
 * Settings per guild:
 * - welcomeChannelId: channel ID for welcoming new members
 * - announceChannelId: default channel ID for announcements
 * - voicemasterHubId: channel ID for VoiceMaster hub
 */

const SETTINGS_FILE = config.serverSettingsFile || './data/server-settings.json';

// In-memory store: { guildId: { welcomeChannelId, announceChannelId, voicemasterHubId, ... } }
let settings = {};

/**
 * Initialize server settings from file
 */
export function initServerSettings() {
  try {
    const dir = dirname(SETTINGS_FILE);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, 'utf-8');
      settings = JSON.parse(raw);
      const guildCount = Object.keys(settings).length;
      logger.info(`⚙️ Server settings loaded (${guildCount} guild${guildCount !== 1 ? 's' : ''})`);
    } else {
      settings = {};
      save();
      logger.info('⚙️ Server settings file created');
    }
  } catch (err) {
    logger.error(`Failed to load server settings: ${err.message}`);
    settings = {};
  }
}

/**
 * Save settings to file
 */
function save() {
  try {
    const dir = dirname(SETTINGS_FILE);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`Failed to save server settings: ${err.message}`);
  }
}

/**
 * Get all settings for a guild
 * @param {string} guildId
 * @returns {object} settings object
 */
export function getSettings(guildId) {
  return settings[guildId] || {};
}

/**
 * Get a specific setting for a guild, with fallback to config/.env
 * @param {string} guildId
 * @param {string} key - setting key (e.g. 'welcomeChannelId')
 * @returns {string|null}
 */
export function getSetting(guildId, key) {
  const guildSettings = settings[guildId];
  if (guildSettings && guildSettings[key]) {
    return guildSettings[key];
  }
  // Fallback to config (.env values)
  if (config[key]) return config[key];
  return null;
}

/**
 * Set a setting for a guild
 * @param {string} guildId
 * @param {string} key
 * @param {*} value
 */
export function setSetting(guildId, key, value) {
  if (!settings[guildId]) settings[guildId] = {};
  settings[guildId][key] = value;
  save();
}

/**
 * Remove a setting for a guild
 * @param {string} guildId
 * @param {string} key
 */
export function removeSetting(guildId, key) {
  if (settings[guildId]) {
    delete settings[guildId][key];
    save();
  }
}

/**
 * Get all settings as a readable list for a guild
 * @param {string} guildId
 * @returns {object}
 */
export function getAllSettings(guildId) {
  const guildSettings = settings[guildId] || {};
  return {
    welcomeChannelId: guildSettings.welcomeChannelId || config.welcomeChannelId || null,
    announceChannelId: guildSettings.announceChannelId || config.announceChannelId || null,
    voicemasterHubId: guildSettings.voicemasterHubId || null,
  };
}

export default {
  initServerSettings,
  getSettings,
  getSetting,
  setSetting,
  removeSetting,
  getAllSettings,
};
