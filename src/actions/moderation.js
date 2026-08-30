import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } from 'discord.js';
import { isOwner } from '../utils/permissions.js';
import { extractUserId, resolveTargetMember } from '../utils/discord-helpers.js';
import { addWarning, applyWarningEscalation, getWarnings, clearWarnings } from '../utils/warnings.js';

// Mirrors formatDuration in utils/reminders.js (kept local to avoid pulling the
// voice/TTS dependency chain into moderation).
function formatTimeoutDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} detik`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    return remainHours === 0 ? `${days} hari` : `${days} hari ${remainHours} jam`;
  }
  const remainMins = minutes % 60;
  return remainMins === 0 ? `${hours} jam` : `${hours} jam ${remainMins} menit`;
}

// ─── Timeout ───────────────────────────────────────────────────────
export async function execTimeout(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers' };
  }

  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  // Can't timeout server owner
  if (member.id === guild.ownerId) {
    return { success: false, error: 'Tidak bisa me-timeout pemilik server.' };
  }

  // Check bot role hierarchy
  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: `Role ${member.displayName} terlalu tinggi. Bot tidak bisa timeout.` };
  }

  let durationMs = 60 * 1000; // default 1 min
  let durationText = '1 menit';
  let rawDuration = params.duration;

  if (!rawDuration) {
    const askReply = await message.reply('⏱️ Tolong ketik durasi timeout (contoh: **10 menit**, **1 jam**, **2 hari**) dalam 60 detik:').catch(() => null);
    if (askReply) {
      try {
        const collected = await message.channel.awaitMessages({
          filter: (m) => m.author.id === message.author.id,
          max: 1,
          time: 60_000,
          errors: ['time'],
        });
        const response = collected.first();
        rawDuration = response.content.trim();
        await askReply.delete().catch(() => {});
        await response.delete().catch(() => {});
      } catch {
        await askReply.edit('⏰ Waktu habis. Aksi timeout dibatalkan.').catch(() => {});
        return { success: true, type: 'cancelled', replied: true };
      }
    }
  }

  if (rawDuration) {
    // Match number + unit as a pair so unit words can't collide via substrings
    // ("1 jam" contains 'm', "2 hari" contains 'h', "30 detik" contains 'd').
    // Bare compact letters use a letter-guard so compounds like "1h30m" sum correctly.
    const strDuration = String(rawDuration).toLowerCase().trim();
    const UNIT_PATTERNS = [
      { re: /(\d+(?:[.,]\d+)?)\s*(?:(?:hari|days?)\b|d(?![a-z]))/gi, ms: 24 * 60 * 60 * 1000 },
      { re: /(\d+(?:[.,]\d+)?)\s*(?:(?:jam|hours?|hrs?)\b|h(?![a-z]))/gi, ms: 60 * 60 * 1000 },
      { re: /(\d+(?:[.,]\d+)?)\s*(?:(?:menit|mnt|minutes?|mins?|min)\b|m(?![a-z]))/gi, ms: 60 * 1000 },
      { re: /(\d+(?:[.,]\d+)?)\s*(?:(?:detik|dtk|det|seconds?|secs?|sec)\b|s(?![a-z]))/gi, ms: 1000 },
    ];
    let parsedMs = 0;
    for (const { re, ms } of UNIT_PATTERNS) {
      for (const m of strDuration.matchAll(re)) {
        parsedMs += parseFloat(m[1].replace(',', '.')) * ms;
      }
    }
    if (parsedMs > 0) {
      durationMs = parsedMs;
      durationText = formatTimeoutDuration(parsedMs);
      const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord hard cap
      if (durationMs > MAX_TIMEOUT_MS) {
        durationMs = MAX_TIMEOUT_MS;
        durationText = '28 hari (maksimum Discord)';
      }
    } else {
      // Bare number = seconds (intentional: differs from parseDuration's minutes)
      const num = parseInt(strDuration);
      if (!isNaN(num) && num > 0) {
        durationMs = num * 1000;
        durationText = `${num} detik`;
      }
    }
  }

  const reason = params.reason || 'Tidak disebutkan';

  try {
    await member.timeout(durationMs, reason);
    return { success: true, type: 'timeout', targetName: member.displayName, duration: durationText, reason };
  } catch (err) {
    if (err.code === 50013) {
      return { success: false, error: `Bot tidak punya permission untuk timeout ${member.displayName}.` };
    }
    return { success: false, error: err.message };
  }
}

// ─── Ban / Kick ────────────────────────────────────────────────────
export async function execBanKick(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const permNeeded = action === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
  if (!isOwner(message.author.id) && !message.member.permissions.has(permNeeded)) {
    return { success: false, error: `Tidak punya permission ${action === 'ban' ? 'BanMembers' : 'KickMembers'}` };
  }

  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  // Can't ban/kick server owner
  if (member.id === guild.ownerId) {
    return { success: false, error: `${member.displayName} adalah pemilik server, tidak bisa di-${action}.` };
  }

  // Check bot role hierarchy
  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: `Role ${member.displayName} terlalu tinggi. Bot tidak bisa ${action}.` };
  }

  const reason = params.reason || 'Tidak disebutkan';

  try {
    const confirmId = `confirm_${action}_${member.id}_${Date.now()}`;
    const cancelId = `cancel_${action}_${member.id}_${Date.now()}`;

    const embed = new EmbedBuilder()
      .setColor('#ff0000')
      .setTitle(`⚠️ Konfirmasi ${action.toUpperCase()}`)
      .setDescription(`Apakah kamu yakin ingin me-${action} **${member.displayName}**?\n**Alasan:** ${reason}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('✅ Yakin').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('❌ Batal').setStyle(ButtonStyle.Secondary)
    );

    const reply = await message.reply({ embeds: [embed], components: [row] });

    // Collect the confirmation separately from the action itself — a single
    // catch used to misreport API failures (e.g. missing bot permission) as
    // "confirmation timeout" with success: true.
    let i;
    try {
      i = await reply.awaitMessageComponent({
        filter: (interaction) => interaction.user.id === message.author.id,
        time: 30000
      });
    } catch {
      await reply.edit({ content: `⏰ Waktu konfirmasi habis. Aksi ${action} dibatalkan.`, embeds: [], components: [] });
      return { success: true, type: 'cancelled', replied: true };
    }
    await i.deferUpdate();

    if (i.customId === confirmId) {
      try {
        if (action === 'ban') {
          await member.ban({ reason });
        } else {
          await member.kick(reason);
        }
      } catch (actErr) {
        await reply.edit({ content: `❌ Gagal me-${action} ${member.displayName}: ${actErr.code === 50013 ? 'bot tidak punya permission' : actErr.message}`, embeds: [], components: [] }).catch(() => { });
        return { success: false, error: actErr.message, replied: true };
      }
      await reply.edit({ content: `✅ Berhasil me-${action} ${member.displayName}.`, embeds: [], components: [] });
      return { success: true, type: action, targetName: member.displayName, reason, replied: true };
    } else {
      await reply.edit({ content: `❌ Aksi ${action} dibatalkan.`, embeds: [], components: [] });
      return { success: true, type: 'cancelled', replied: true };
    }
  } catch (err) {
    if (err.code === 50013) {
      return { success: false, error: `Bot tidak punya permission untuk ${action} ${member.displayName}.` };
    }
    return { success: false, error: err.message };
  }
}

// ─── Role Management ───────────────────────────────────────────────
export async function execRole(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { success: false, error: 'Tidak punya permission ManageRoles' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada' };

  const roleName = params.role_name;
  if (!roleName) return { success: false, error: 'Nama role tidak dicantumkan' };

  const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleName.replace(/[<@&>]/g, ''));
  if (!role) return { success: false, error: `Role "${roleName}" tidak ditemukan` };

  const botMember = await guild.members.fetchMe();
  if (role.position >= botMember.roles.highest.position) {
    return { success: false, error: `Role ${role.name} lebih tinggi/sejajar dengan role bot.` };
  }

  try {
    if (action === 'add') { await member.roles.add(role); } else { await member.roles.remove(role); }
    return { success: true, type: 'role', action, targetName: member.displayName, roleName: role.name };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Nickname ──────────────────────────────────────────────────────
export async function execNickname(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return { success: false, error: 'Tidak punya permission ManageNicknames' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada' };

  if (member.id === guild.ownerId) {
    return { success: false, error: 'Tidak bisa mengganti nickname pemilik server.' };
  }

  const newNickname = params.nickname || params.new_nick || '';

  try {
    const oldName = member.displayName;
    await member.setNickname(newNickname);
    return { success: true, type: 'nickname', oldName, newName: newNickname || member.user.username, targetName: member.displayName };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Pin Message ───────────────────────────────────────────────────
export async function execPinMessage(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const botPerms = message.channel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Bot tidak punya permission ManageMessages di channel ini.' };
  }

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Kamu tidak punya permission ManageMessages untuk pin pesan.' };
  }

  let targetMessage = null;
  const msgId = params.message_id;

  if (message.reference && message.reference.messageId) {
    try {
      targetMessage = await message.channel.messages.fetch(message.reference.messageId);
    } catch {
      return { success: false, error: 'Gagal mengambil pesan yang di-reply.' };
    }
  } else if (msgId && msgId !== 'latest' && msgId !== 'reply' && /^\d+$/.test(msgId)) {
    try {
      targetMessage = await message.channel.messages.fetch(msgId);
    } catch {
      return { success: false, error: `Pesan dengan ID ${msgId} tidak ditemukan.` };
    }
  } else {
    try {
      const messages = await message.channel.messages.fetch({ limit: 5 });
      targetMessage = messages.filter(m => m.id !== message.id).first();
    } catch {
      return { success: false, error: 'Gagal mencari pesan terbaru.' };
    }
  }

  if (!targetMessage) return { success: false, error: 'Pesan tidak ditemukan' };

  try {
    await targetMessage.pin();
    return { success: true, type: 'pin_message', author: targetMessage.author.username, messagePreview: targetMessage.content.slice(0, 50) };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Unpin Message ─────────────────────────────────────────────────
export async function execUnpinMessage(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const botPerms = message.channel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Bot tidak punya permission ManageMessages di channel ini.' };
  }

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Kamu tidak punya permission ManageMessages untuk unpin pesan.' };
  }

  let targetMessage = null;
  const msgId = params.message_id;

  try {
    const pinned = await message.channel.messages.fetchPinned();
    if (pinned.size === 0) return { success: false, error: 'Tidak ada pesan yang dipin di channel ini.' };

    if (message.reference && message.reference.messageId) {
      targetMessage = pinned.get(message.reference.messageId);
    } else if (msgId && /^\d+$/.test(msgId)) {
      targetMessage = pinned.get(msgId);
    } else {
      targetMessage = pinned.first(); // Unpin the most recent pin
    }
  } catch {
    return { success: false, error: 'Gagal mengambil daftar pin.' };
  }

  if (!targetMessage) return { success: false, error: 'Pesan pin tidak ditemukan' };

  try {
    await targetMessage.unpin();
    return { success: true, type: 'unpin_message', author: targetMessage.author.username };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Warn ──────────────────────────────────────────────────────────
export async function execWarn(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers untuk memberi warning.' };
  }

  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  if (member.id === guild.ownerId) {
    return { success: false, error: 'Tidak bisa memberi warning pada owner server.' };
  }

  const reason = params.reason || 'Tidak disebutkan';
  const warnerId = message.author.id;

  const result = addWarning(guild.id, member.id, reason, warnerId);
  const totalWarnings = result.total;

  // Shared escalation policy (warnings.js): 3 → timeout 10m, 5 → kick
  const escalation = await applyWarningEscalation({
    guild,
    member,
    total: totalWarnings,
    channelId: message.channel?.id ?? null,
  });

  return { success: true, type: 'warn', targetName: member.displayName, reason, totalWarnings, extraAction: escalation.text };
}

// ─── Warn List ─────────────────────────────────────────────────────
export async function execWarnList(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  const list = getWarnings(guild.id, member.id);
  return { success: true, type: 'warn_list', targetName: member.displayName, warnings: list };
}

// ─── Warn Clear ────────────────────────────────────────────────────
export async function execWarnClear(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers untuk menghapus warning.' };
  }

  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  const clearedCount = clearWarnings(guild.id, member.id);
  return { success: true, type: 'warn_clear', targetName: member.displayName, clearedCount };
}

// ─── Create Channel ────────────────────────────────────────────────
export async function execCreateChannel(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Tidak punya permission ManageChannels' };
  }

  const name = params.name || params.channel_name || 'new-channel';
  const type = String(params.type || params.channel_type || 'text').toLowerCase();

  try {
    const channelType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
    const channel = await guild.channels.create({ name, type: channelType });
    return { success: true, type: 'create_channel', channelName: channel.name, channelId: channel.id, channelType: type };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Delete Channel ────────────────────────────────────────────────
export async function execDeleteChannel(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Tidak punya permission ManageChannels' };
  }

  const channelId = params.channel_id || params.channel_name || params.name;
  if (!channelId) return { success: false, error: 'Nama channel tidak dicantumkan' };

  const cleanName = channelId.replace(/[<#>]/g, '');
  const channel = guild.channels.cache.find(c => c.id === cleanName || c.name.toLowerCase() === cleanName.toLowerCase());
  if (!channel) return { success: false, error: `Channel "${channelId}" tidak ditemukan` };

  try {
    await channel.delete();
    return { success: true, type: 'delete_channel', channelName: channel.name };
  } catch (err) { return { success: false, error: err.message }; }
}
