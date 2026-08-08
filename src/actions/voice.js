import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isOwner } from '../utils/permissions.js';
import { extractUserId } from '../utils/discord-helpers.js';
import { setupVoiceMaster, removeVoiceMaster, isVoiceMasterActive } from '../utils/voicemaster.js';

// ─── Voice Check ───────────────────────────────────────────────────
export async function execVoiceCheck(message) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const voiceChannels = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice);
  const data = [];
  for (const [, ch] of voiceChannels) {
    if (ch.members.size === 0) continue;
    const members = [];
    for (const [, m] of ch.members) {
      if (!m.voice) continue;
      const s = [];
      if (m.voice.selfMute || m.voice.serverMute) s.push('muted');
      if (m.voice.selfDeaf || m.voice.serverDeaf) s.push('deaf');
      if (m.voice.streaming) s.push('streaming');
      if (m.voice.selfVideo) s.push('camera');
      members.push({ name: m.displayName, status: s.length > 0 ? s : ['normal'] });
    }
    data.push({ channel: ch.name, members });
  }
  return { success: true, type: 'voice_check', data };
}

// ─── Voice Moderation ──────────────────────────────────────────────
export async function execVoiceMod(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const permMap = {
    mute: PermissionFlagsBits.MuteMembers,
    unmute: PermissionFlagsBits.MuteMembers,
    deafen: PermissionFlagsBits.DeafenMembers,
    undeafen: PermissionFlagsBits.DeafenMembers,
    disconnect: PermissionFlagsBits.MoveMembers
  };

  if (!isOwner(message.author.id) && !message.member.permissions.has(permMap[action])) {
    return { success: false, error: 'Tidak punya permission untuk voice moderation' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target user tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada di server' };
  if (!member.voice || !member.voice.channel) return { success: false, error: `${member.displayName} tidak di voice channel` };

  try {
    const name = member.displayName;
    if (action === 'mute') { await member.voice.setMute(true); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'unmute') { await member.voice.setMute(false); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'deafen') { await member.voice.setDeaf(true); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'undeafen') { await member.voice.setDeaf(false); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'disconnect') { await member.voice.disconnect(); return { success: true, type: 'voice_mod', action, targetName: name }; }
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Setup VoiceMaster ─────────────────────────────────────────────
export async function execSetupVoiceMaster(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Kamu tidak punya permission ManageChannels.' };
  }

  const action = (params.action || 'enable').toLowerCase();

  // ─── Disable VoiceMaster ──────────────────────────────────────
  if (action === 'disable' || action === 'off' || action === 'hapus' || action === 'matikan') {
    if (!isVoiceMasterActive(guild.id)) {
      return { success: false, error: 'VoiceMaster belum aktif di server ini.' };
    }
    removeVoiceMaster(guild.id);
    return { success: true, type: 'voicemaster_disabled' };
  }

  // ─── Enable VoiceMaster ───────────────────────────────────────
  let hubChannelId = params.hub_channel_id;

  // If a specific channel ID was given, validate it
  if (hubChannelId) {
    hubChannelId = hubChannelId.replace(/[<#>]/g, '');
    const ch = guild.channels.cache.get(hubChannelId);
    if (!ch || ch.type !== ChannelType.GuildVoice) {
      return { success: false, error: 'Channel hub harus berupa voice channel yang sudah ada.' };
    }
    setupVoiceMaster(guild.id, hubChannelId);
    return {
      success: true,
      type: 'voicemaster_enabled',
      hubChannelName: ch.name,
      hubChannelId: ch.id,
      created: false,
    };
  }

  // No hub channel specified — create one automatically
  try {
    const hubChannel = await guild.channels.create({
      name: '➕ Create VC',
      type: ChannelType.GuildVoice,
      reason: 'VoiceMaster hub channel',
    });

    setupVoiceMaster(guild.id, hubChannel.id);
    return {
      success: true,
      type: 'voicemaster_enabled',
      hubChannelName: hubChannel.name,
      hubChannelId: hubChannel.id,
      created: true,
    };
  } catch (err) {
    return { success: false, error: `Gagal membuat hub channel: ${err.message}` };
  }
}
