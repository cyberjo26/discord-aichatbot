import config from '../config.js';
import logger from './logger.js';

/**
 * Permission levels
 */
export const PermLevel = {
  USER: 0,    // Regular user — can use /ask, /chat, /help
  OWNER: 10,  // Bot owner — full control
};

/**
 * Check if a user is the bot owner
 * @param {string} userId
 * @returns {boolean}
 */
export function isOwner(userId) {
  return config.ownerId && userId === config.ownerId;
}

/**
 * Get the permission level of a user
 * @param {string} userId
 * @returns {number}
 */
export function getPermLevel(userId) {
  if (isOwner(userId)) return PermLevel.OWNER;
  return PermLevel.USER;
}

/**
 * Check if a user has the required permission level
 * @param {string} userId
 * @param {number} requiredLevel
 * @returns {boolean}
 */
export function hasPermission(userId, requiredLevel) {
  return getPermLevel(userId) >= requiredLevel;
}

/**
 * Middleware: require owner permission for an interaction.
 * Returns true if allowed, false if blocked (and sends error reply).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
export async function requireOwner(interaction) {
  if (isOwner(interaction.user.id)) return true;

  logger.warn(`Unauthorized access attempt by ${interaction.user.tag} (${interaction.user.id})`);

  await interaction.reply({
    content: '🔒 Perintah ini hanya bisa digunakan oleh owner bot.',
    ephemeral: true,
  });
  return false;
}

export default { PermLevel, isOwner, getPermLevel, hasPermission, requireOwner };
