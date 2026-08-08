import config from '../config.js';
import logger from './logger.js';

export function extractUserId(str) {
  if (!str) return null;
  const match = str.match(/<@!?(\d+)>/);
  if (match) return match[1];
  if (/^\d+$/.test(str)) return str;
  return null;
}

export function extractChannelId(str) {
  if (!str) return null;
  const match = str.match(/<#(\d+)>/);
  if (match) return match[1];
  if (/^\d+$/.test(str)) return str;
  return null;
}

/**
 * Shared: Resolve target member (by ID or nickname)
 */
export async function resolveTargetMember(message, params) {
  const guild = message.guild;
  const targetId = extractUserId(params.target_id);

  // If we have a direct user ID/mention, use it
  if (targetId) {
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (member) return { member };
    return { error: 'User tidak ada di server.' };
  }

  // If we have a nickname/name, search for matching members
  const targetName = params.target_name;
  if (!targetName) return { error: 'Target user tidak ditemukan. Tolong tag (@) user yang dimaksud.' };

  // Search members by displayName or username (query-based to avoid fetching all members)
  const fetched = await guild.members.fetch({ query: targetName, limit: 10 });
  const matches = fetched.filter(m =>
    m.displayName.toLowerCase().includes(targetName.toLowerCase()) ||
    m.user.username.toLowerCase().includes(targetName.toLowerCase())
  );

  if (matches.size === 0) {
    return { error: `Tidak ada member dengan nama "${targetName}".` };
  }

  if (matches.size === 1) {
    return { member: matches.first() };
  }

  // Multiple matches — ask user to tag the right one
  const memberList = matches.first(10).map(m => `• **${m.displayName}** (<@${m.id}>)`).join('\n');
  const askReply = await message.reply(
    `⚠️ Ada **${matches.size}** member dengan nama mirip "${targetName}":\n\n${memberList}\n\n` +
    `Tolong **tag (@)** user yang kamu maksud dalam 1 menit.`
  );

  try {
    const collected = await message.channel.awaitMessages({
      filter: (m) => m.author.id === message.author.id && m.mentions.users.size > 0,
      max: 1,
      time: 60_000,
      errors: ['time'],
    });

    const response = collected.first();
    const mentionedUser = response.mentions.users.filter(u => u.id !== message.client.user.id).first();
    if (!mentionedUser) {
      await askReply.edit('⏰ Tidak ada user yang di-tag. Perintah dibatalkan.').catch(() => {});
      return { error: null, cancelled: true };
    }

    await askReply.delete().catch(() => {});
    const member = await guild.members.fetch(mentionedUser.id).catch(() => null);
    if (!member) return { error: 'User yang di-tag tidak ada di server.' };
    return { member };
  } catch {
    await askReply.edit('⏰ Waktu habis (1 menit). Perintah dibatalkan.').catch(() => {});
    return { error: null, cancelled: true };
  }
}

/**
 * Send an alert for manual moderation action (e.g. auto-kick failed at 5/5 warnings
 * because the target's role is too high for the bot).
 * Delivers to the guild owner's DM and, if configured, the MOD_LOG_CHANNEL_ID channel.
 */
export async function sendModAlert(guild, summary, detail) {
  const alertText = `🚨 **⚠️ Butuh Tindakan Manual**\n${summary}\n${detail}`;

  // 1. DM the guild owner
  try {
    const owner = await guild.fetchOwner();
    await owner.send(alertText).catch(() => {});
  } catch {
    logger.debug('sendModAlert: gagal DM owner (DM mungkin tertutup)');
  }

  // 2. Post to mod log channel if configured
  const channelId = config.modLogChannelId;
  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(alertText).catch(() => {});
    }
  }
}

export default { extractUserId, extractChannelId, resolveTargetMember, sendModAlert };
