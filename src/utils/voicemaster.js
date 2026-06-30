import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getSetting, setSetting, removeSetting } from './server-settings.js';
import logger from './logger.js';

/**
 * ─── VoiceMaster System ─────────────────────────────────────────────
 * Auto voice channel: user joins hub → creates temp VC → deletes when empty.
 *
 * Flow:
 * 1. Admin sets a "hub" voice channel via bot command
 * 2. When a user joins the hub channel, bot creates a new temp VC named "VC • {username}"
 * 3. User is moved to the new temp VC
 * 4. When all users leave the temp VC, it's automatically deleted
 */

// Track active temporary channels: Set of channel IDs
const activeTempChannels = new Set();

/**
 * Initialize VoiceMaster — load active temp channels from guilds
 * Called after client is ready
 */
export async function initVoiceMaster(client) {
  for (const [, guild] of client.guilds.cache) {
    const hubId = getSetting(guild.id, 'voicemasterHubId');
    if (!hubId) continue;

    // Clean up any leftover empty temp channels from previous session
    const tempChannels = getSetting(guild.id, 'voicemasterTempChannels') || [];
    for (const channelId of tempChannels) {
      const ch = guild.channels.cache.get(channelId);
      if (ch && ch.members.size === 0) {
        try {
          await ch.delete('VoiceMaster cleanup: empty temp channel');
          logger.debug(`🧹 VoiceMaster cleaned up empty channel: ${channelId}`);
        } catch { /* channel may already be deleted */ }
      } else if (ch) {
        activeTempChannels.add(channelId);
      }
    }

    // Update persisted list
    saveTempChannels(guild.id);
    logger.info(`🔊 VoiceMaster active for guild "${guild.name}" (hub: ${hubId})`);
  }
}

/**
 * Handle voiceStateUpdate event
 */
export async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const hubId = getSetting(guild.id, 'voicemasterHubId');
  if (!hubId) return;

  // ─── User joined the hub channel → create temp VC ───────────
  if (newState.channelId === hubId && newState.channelId !== oldState.channelId) {
    await createTempChannel(newState);
  }

  // ─── User left a channel → check if it was a temp VC that's now empty ───
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await cleanupIfEmpty(oldState);
  }
}

/**
 * Create a temporary voice channel and move the user there
 */
async function createTempChannel(state) {
  const member = state.member;
  const guild = state.guild;
  const hubChannel = state.channel;

  if (!hubChannel) return;

  try {
    // Create the temp channel in the same category as the hub
    const channelName = `🔊 VC • ${member.displayName}`;
    const tempChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: hubChannel.parent, // same category
      bitrate: hubChannel.bitrate,
      userLimit: hubChannel.userLimit || 0,
      permissionOverwrites: [
        // Channel creator can manage their VC
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.Connect,
          ],
        },
      ],
    });

    // Track it
    activeTempChannels.add(tempChannel.id);
    saveTempChannels(guild.id);

    // Move the user to the new channel
    await member.voice.setChannel(tempChannel);
    logger.info(`🔊 VoiceMaster: Created "${channelName}" for ${member.displayName}`);
  } catch (err) {
    logger.error(`VoiceMaster create failed: ${err.message}`);
  }
}

/**
 * Check if a channel is a temp VC and delete it if empty
 */
async function cleanupIfEmpty(state) {
  const channelId = state.channelId;
  if (!activeTempChannels.has(channelId)) return;

  const guild = state.guild;
  const channel = guild.channels.cache.get(channelId);

  if (!channel) {
    // Channel already deleted
    activeTempChannels.delete(channelId);
    saveTempChannels(guild.id);
    return;
  }

  if (channel.members.size === 0) {
    try {
      const name = channel.name;
      await channel.delete('VoiceMaster: temp channel empty');
      activeTempChannels.delete(channelId);
      saveTempChannels(guild.id);
      logger.info(`🗑️ VoiceMaster: Deleted empty channel "${name}"`);
    } catch (err) {
      logger.error(`VoiceMaster cleanup failed: ${err.message}`);
    }
  }
}

/**
 * Persist active temp channel IDs to server settings
 */
function saveTempChannels(guildId) {
  const tempIds = [...activeTempChannels].filter(id => {
    // Only keep channels that belong to this guild (best effort)
    return true;
  });
  setSetting(guildId, 'voicemasterTempChannels', tempIds);
}

/**
 * Setup VoiceMaster for a guild — set the hub channel
 * @param {string} guildId
 * @param {string} hubChannelId
 */
export function setupVoiceMaster(guildId, hubChannelId) {
  setSetting(guildId, 'voicemasterHubId', hubChannelId);
}

/**
 * Remove VoiceMaster from a guild
 * @param {string} guildId
 */
export function removeVoiceMaster(guildId) {
  removeSetting(guildId, 'voicemasterHubId');
  removeSetting(guildId, 'voicemasterTempChannels');
}

/**
 * Check if VoiceMaster is active for a guild
 */
export function isVoiceMasterActive(guildId) {
  return !!getSetting(guildId, 'voicemasterHubId');
}

export default {
  initVoiceMaster,
  handleVoiceStateUpdate,
  setupVoiceMaster,
  removeVoiceMaster,
  isVoiceMasterActive,
};
