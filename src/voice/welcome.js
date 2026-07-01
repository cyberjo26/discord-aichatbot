import { PermissionFlagsBits, ChannelType } from 'discord.js';
import logger from '../utils/logger.js';
import { synthesize } from './tts.js';
import { playInVoiceChannel } from './player.js';
import { getSetting } from '../utils/server-settings.js';

// Cooldown tracker: Map of "guildId-userId" -> lastWelcomeTimestamp
const welcomeCooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of welcomeCooldowns.entries()) {
    if (now - timestamp > COOLDOWN_MS) {
      welcomeCooldowns.delete(key);
    }
  }
}, COOLDOWN_MS).unref();

/**
 * Sanitize display name: Unicode normalize NFKC, remove emojis, control characters,
 * clean spaces, and limit to max 32 characters.
 */
export function sanitizeDisplayName(name) {
  if (!name) return 'User';
  
  // 1. Unicode normalize NFKC
  let clean = name.normalize('NFKC');
  
  // 2. Remove emojis and control characters
  clean = clean.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Control}\u200b-\u200d\ufeff]/gu, '');
  
  // 3. Clean spaces
  clean = clean.trim().replace(/\s+/g, ' ');
  
  // 4. Max 32 characters
  if (clean.length > 32) {
    clean = clean.slice(0, 32).trim();
  }
  
  return clean || 'User';
}

// Set to track users who entered the VoiceMaster hub from outside voice channels
const pendingHubWelcomes = new Set();

/**
 * Handle voice state update for personalized voice welcome.
 */
export async function handleVoiceWelcome(oldState, newState, options = {}) {
  const synthesizeFn = options.synthesizeFn || synthesize;
  const playFn = options.playFn || playInVoiceChannel;
  const scheduleFn = options.scheduleFn || ((callback, delay) => setTimeout(callback, delay));
  const member = newState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild;
  const guildId = guild.id;
  const userId = member.id;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // Track transfers from null -> hub
  const hubId = getSetting(guildId, 'voicemasterHubId');
  if (oldChannelId === null && newChannelId === hubId) {
    pendingHubWelcomes.add(userId);
    return; // Wait for the VoiceMaster move to a temp channel
  }

  // Determine if this is a valid welcome event
  let shouldWelcome = false;

  if (oldChannelId === null && newChannelId !== hubId && newChannelId !== null) {
    // Normal join to a normal channel from null
    shouldWelcome = true;
  } else if (oldChannelId === hubId && newChannelId !== null) {
    // Moved from hub to temp channel
    if (pendingHubWelcomes.has(userId)) {
      shouldWelcome = true;
      pendingHubWelcomes.delete(userId);
    }
  } else {
    // Clear pending state on any other transition
    pendingHubWelcomes.delete(userId);
  }

  if (!shouldWelcome) return;

  const channel = newState.channel;
  if (!channel) return;

  // Ignore AFK channel
  if (guild.afkChannelId === newChannelId) return;

  // Ignore Stage channel
  if (channel.type === ChannelType.GuildStageVoice) return;

  // Check cooldown: 5 minutes per guild + user
  const cooldownKey = `${guildId}-${userId}`;
  const now = Date.now();
  const lastWelcome = welcomeCooldowns.get(cooldownKey) || 0;
  if (now - lastWelcome < COOLDOWN_MS) {
    logger.debug(`Welcome skipped for ${member.displayName} (cooldown active)`);
    return;
  }

  // Update cooldown immediately to prevent concurrent duplicate welcome trigger
  welcomeCooldowns.set(cooldownKey, now);

  // Check permissions: ViewChannel, Connect, Speak
  const botMember = guild.members.me;
  if (!botMember) return;
  const permissions = channel.permissionsFor(botMember);
  if (!permissions || 
      !permissions.has(PermissionFlagsBits.ViewChannel) || 
      !permissions.has(PermissionFlagsBits.Connect) || 
      !permissions.has(PermissionFlagsBits.Speak)) {
    logger.warn(`Missing connect/speak permissions in voice channel ${channel.name} (${channel.id}) to welcome ${member.displayName}`);
    return;
  }

  // Set timeout of 1 second to ensure Discord API state and VoiceMaster are fully settled
  return scheduleFn(async () => {
    try {
      // Re-fetch member voice state to ensure they are still in the same channel
      const latestMember = await guild.members.fetch(userId).catch(() => null);
      if (!latestMember || latestMember.voice.channelId !== newChannelId) {
        logger.debug(`Welcome skipped: ${member.displayName} left the channel before greeting.`);
        return;
      }

      const name = sanitizeDisplayName(member.displayName);
      const text = `Selamat datang kak ${name}! Selamat mabar ya!`;
      
      logger.info(`🗣️ Welcoming ${name} in voice channel "${channel.name}"`);
      const audioBuffer = await synthesizeFn(text);
      await playFn(channel, audioBuffer);
    } catch (err) {
      logger.error(`Voice welcome failed: ${err.message}`);
    }
  }, 1000);
}

// Export for testing
export const _cooldowns = welcomeCooldowns;
