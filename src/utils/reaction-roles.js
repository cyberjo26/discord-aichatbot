import { setSetting, getSetting } from './server-settings.js';
import logger from './logger.js';

/**
 * ─── Reaction Roles ──────────────────────────────────────────────────
 * Per-guild reaction-role mappings stored in server-settings JSON.
 *
 * Each guild stores an array:
 *   { messageId, channelId, emoji, roleId }
 *
 * On messageReactionAdd → assign role.
 * On messageReactionRemove → remove role.
 * Bot's own reactions are ignored.
 * Partial reactions are fetched before processing.
 */

const DEFAULT_EMPTY = [];

/**
 * Get all reaction-role entries for a guild.
 * @param {string} guildId
 * @returns {Array<{messageId, channelId, emoji, roleId}>}
 */
export function getReactionRoles(guildId) {
  const raw = getSetting(guildId, 'reactionRoles');
  if (Array.isArray(raw)) return raw;
  return DEFAULT_EMPTY;
}

/**
 * Save the full reaction-role list for a guild.
 * @param {string} guildId
 * @param {Array} list
 */
function saveReactionRoles(guildId, list) {
  setSetting(guildId, 'reactionRoles', list);
}

/**
 * Add a reaction-role binding.
 * @param {string} guildId
 * @param {{messageId, channelId, emoji, roleId}} entry
 * @returns {boolean} true if added, false if duplicate
 */
export function addReactionRole(guildId, { messageId, channelId, emoji, roleId }) {
  const list = getReactionRoles(guildId);
  const exists = list.some(
    (e) => e.messageId === messageId && e.emoji === emoji && e.roleId === roleId
  );
  if (exists) return false;

  list.push({ messageId, channelId, emoji, roleId });
  saveReactionRoles(guildId, list);
  logger.info(`📌 Reaction-role added: guild=${guildId} msg=${messageId} emoji=${emoji} role=${roleId}`);
  return true;
}

/**
 * Remove a reaction-role binding by emoji+role on a message.
 * @param {string} guildId
 * @param {string} messageId
 * @param {string} emoji
 * @param {string} [roleId] — if omitted, removes all entries for this emoji on this message
 * @returns {number} count of entries removed
 */
export function removeReactionRole(guildId, messageId, emoji, roleId) {
  const list = getReactionRoles(guildId);
  const before = list.length;
  const filtered = list.filter((e) => {
    if (e.messageId !== messageId) return true;
    if (e.emoji !== emoji) return true;
    if (roleId && e.roleId !== roleId) return true;
    return false;
  });
  const removed = before - filtered.length;
  if (removed > 0) {
    saveReactionRoles(guildId, filtered);
    logger.info(`🗑️ Reaction-role removed: guild=${guildId} msg=${messageId} emoji=${emoji} count=${removed}`);
  }
  return removed;
}

/**
 * Remove all reaction-role bindings for a message.
 * @param {string} guildId
 * @param {string} messageId
 * @returns {number} count removed
 */
export function removeAllReactionRoles(guildId, messageId) {
  const list = getReactionRoles(guildId);
  const before = list.length;
  const filtered = list.filter((e) => e.messageId !== messageId);
  const removed = before - filtered.length;
  if (removed > 0) {
    saveReactionRoles(guildId, filtered);
    logger.info(`🗑️ All reaction-roles removed: guild=${guildId} msg=${messageId} count=${removed}`);
  }
  return removed;
}

/**
 * Find the role entry matching a reaction on a message.
 * @param {string} guildId
 * @param {string} messageId
 * @param {string} emoji — raw emoji name or ID string (e.g. '🎉' or 'customEmoji:123')
 * @returns {{roleId, channelId}|null}
 */
export function findReactionRole(guildId, messageId, emoji) {
  const list = getReactionRoles(guildId);
  const entry = list.find((e) => e.messageId === messageId && e.emoji === emoji);
  return entry ? { roleId: entry.roleId, channelId: entry.channelId } : null;
}

/**
 * Change emoji for an existing reaction-role binding.
 * @param {string} guildId
 * @param {string} messageId
 * @param {string} oldEmoji
 * @param {string} newEmoji
 * @param {string} roleId
 * @returns {boolean} true if updated
 */
export function updateReactionRoleEmoji(guildId, messageId, oldEmoji, newEmoji, roleId) {
  const list = getReactionRoles(guildId);
  const entry = list.find(
    (e) => e.messageId === messageId && e.emoji === oldEmoji && e.roleId === roleId
  );
  if (!entry) return false;
  entry.emoji = newEmoji;
  saveReactionRoles(guildId, list);
  logger.info(`🔄 Reaction-role emoji changed: guild=${guildId} msg=${messageId} ${oldEmoji}→${newEmoji} role=${roleId}`);
  return true;
}

/**
 * Find a message by ID across all text channels in a guild.
 * Tries the preferred channel first, then scans the rest.
 * @param {import('discord.js').Guild} guild
 * @param {string} messageId
 * @param {string} [preferChannelId] - try this channel first
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function findMessageInGuild(guild, messageId, preferChannelId) {
  // Try preferred channel first
  if (preferChannelId) {
    const channel = guild.channels.cache.get(preferChannelId);
    if (channel?.isTextBased?.()) {
      try {
        return await channel.messages.fetch(messageId);
      } catch { /* not found in this channel */ }
    }
  }

  // Scan all text channels
  const textChannels = guild.channels.cache.filter(
    (ch) => ch.isTextBased?.() && ch.id !== preferChannelId
  );
  for (const [, channel] of textChannels) {
    try {
      const msg = await channel.messages.fetch(messageId);
      if (msg) return msg;
    } catch { /* not found, try next */ }
  }
  return null;
}

/**
 * Handle a reaction add event: assign the role if a binding exists.
 * @param {import('discord.js').MessageReaction} reaction
 * @param {import('discord.js').User} user
 */
export async function handleReactionAdd(reaction, user) {
  if (user.bot) return;

  // Fetch partials
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  const { message } = reaction;
  if (!message.guild) return;

  const emojiKey = reaction.emoji.id ?? reaction.emoji.name;
  const entry = findReactionRole(message.guild.id, message.id, emojiKey);
  if (!entry) return;

  try {
    const member = await message.guild.members.fetch(user.id);
    if (member.roles.cache.has(entry.roleId)) return; // already has it

    await member.roles.add(entry.roleId, 'Reaction role');
    logger.info(`✅ Reaction-role assigned: user=${user.tag} role=${entry.roleId} guild=${message.guild.id}`);
  } catch (err) {
    logger.warn(`Reaction-role assign failed: user=${user.id} role=${entry.roleId} — ${err.message}`);
  }
}

/**
 * Handle a reaction remove event: remove the role if a binding exists.
 * @param {import('discord.js').MessageReaction} reaction
 * @param {import('discord.js').User} user
 */
export async function handleReactionRemove(reaction, user) {
  if (user.bot) return;

  // Fetch partials
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  const { message } = reaction;
  if (!message.guild) return;

  const emojiKey = reaction.emoji.id ?? reaction.emoji.name;
  const entry = findReactionRole(message.guild.id, message.id, emojiKey);
  if (!entry) return;

  try {
    const member = await message.guild.members.fetch(user.id);
    if (!member.roles.cache.has(entry.roleId)) return; // doesn't have it

    await member.roles.remove(entry.roleId, 'Reaction role removed');
    logger.info(`🔓 Reaction-role removed: user=${user.tag} role=${entry.roleId} guild=${message.guild.id}`);
  } catch (err) {
    logger.warn(`Reaction-role remove failed: user=${user.id} role=${entry.roleId} — ${err.message}`);
  }
}