import config from '../config.js';
import { isOwner } from '../utils/permissions.js';
import { setReminder, parseDuration, formatDuration, parseAbsoluteTime } from '../utils/reminders.js';
import { setSetting, removeSetting, getAllSettings } from '../utils/server-settings.js';

// ─── Reminder ──────────────────────────────────────────────────────
export async function execReminder(message, params) {
  const delivery = params.delivery || 'text';
  const targetId = message.author.id; // Enforce user can only make reminder for themselves
  const guildId = message.guild?.id;
  if (!guildId) return { success: false, error: 'Fitur ini hanya bisa digunakan di server.' };

  let triggerAt = 0;
  let durationText = '';

  if (params.schedule && params.schedule.trim() !== '') {
    const time = parseAbsoluteTime(params.schedule, config.timezone || 'Asia/Bangkok');
    if (!time) return { success: false, error: 'Format waktu absolut tidak dipahami (contoh: "jam 3 sore", "besok jam 7 pagi", "pukul 20.30")' };
    triggerAt = time;
    const remainingMs = triggerAt - Date.now();
    if (remainingMs <= 0) {
      return { success: false, error: 'Waktu tersebut sudah terlewat.' };
    }
    const targetTz = config.timezone || 'Asia/Bangkok';
    const tzLabel = targetTz.includes('Jakarta') || targetTz.includes('Bangkok') ? 'WIB' : 
                    targetTz.includes('Makassar') || targetTz.includes('Kuala_Lumpur') || targetTz.includes('Singapore') ? 'WITA' : 
                    targetTz.includes('Jayapura') ? 'WIT' : targetTz.split('/')[1]?.replace(/_/g, ' ') || 'Local Time';

    durationText = `pada pukul ${new Date(triggerAt).toLocaleString('id-ID', { timeZone: targetTz, hour: '2-digit', minute: '2-digit' }).replace(/\./g, ':')} ${tzLabel}`;
  } else {
    const dur = parseDuration(params.duration || '');
    if (dur <= 0) return { success: false, error: 'Durasi tidak jelas (contoh: "10 menit", "1 jam")' };
    if (dur > 24 * 60 * 60 * 1000) return { success: false, error: 'Maksimal 24 jam' };
    triggerAt = Date.now() + dur;
    durationText = `dalam ${formatDuration(dur)}`;
  }

  const text = params.text || 'Reminder!';
  setReminder({
    guildId,
    userId: targetId,
    fallbackChannelId: message.channel.id,
    text,
    delivery,
    triggerAt
  });

  return { success: true, type: 'reminder', text, duration: durationText, delivery };
}

// ─── Set Config ────────────────────────────────────────────────────
export async function execSetConfig(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  // Owner only
  if (!isOwner(message.author.id)) {
    return { success: false, error: 'Hanya owner bot yang bisa mengubah pengaturan.' };
  }

  const setting = (params.setting || '').toLowerCase().replace(/\s+/g, '_');
  let channelId = params.channel_id;

  // Map setting names to internal keys
  const settingMap = {
    'welcome_channel': 'welcomeChannelId',
    'welcome': 'welcomeChannelId',
    'announce_channel': 'announceChannelId',
    'announcement_channel': 'announceChannelId',
    'announcement': 'announceChannelId',
    'announce': 'announceChannelId',
  };

  const internalKey = settingMap[setting];
  if (!internalKey) {
    return { success: false, error: `Setting "${setting}" tidak dikenali. Pilihan: welcome_channel, announce_channel` };
  }

  // Handle remove/clear
  if (!channelId || channelId === 'none' || channelId === 'hapus' || channelId === 'remove') {
    removeSetting(guild.id, internalKey);
    return {
      success: true,
      type: 'set_config',
      setting: setting,
      action: 'removed',
      channelName: null,
    };
  }

  // Extract channel ID from mention format <#id>
  channelId = channelId.replace(/[<#>]/g, '');

  // If it's "here" or "sini", use current channel
  if (channelId === 'here' || channelId === 'sini' || channelId === 'di_sini') {
    channelId = message.channel.id;
  }

  // Validate channel exists
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    return { success: false, error: 'Channel tidak ditemukan. Mention channel pakai #nama atau kirim perintah di channel yang mau diset.' };
  }

  setSetting(guild.id, internalKey, channelId);
  return {
    success: true,
    type: 'set_config',
    setting: setting,
    action: 'set',
    channelName: channel.name,
    channelId: channel.id,
  };
}

// ─── Get Config ────────────────────────────────────────────────────
export async function execGetConfig(message) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const settings = getAllSettings(guild.id);

  const lines = ['📋 **Pengaturan Server:**\n'];

  // Welcome channel
  if (settings.welcomeChannelId) {
    const ch = guild.channels.cache.get(settings.welcomeChannelId);
    lines.push(`👋 **Welcome Channel:** ${ch ? `<#${ch.id}>` : `ID: ${settings.welcomeChannelId} (tidak ditemukan)`}`);
  } else {
    lines.push('👋 **Welcome Channel:** _belum diatur_ (menggunakan system channel)');
  }

  // Announce channel
  if (settings.announceChannelId) {
    const ch = guild.channels.cache.get(settings.announceChannelId);
    lines.push(`📢 **Announcement Channel:** ${ch ? `<#${ch.id}>` : `ID: ${settings.announceChannelId} (tidak ditemukan)`}`);
  } else {
    lines.push('📢 **Announcement Channel:** _belum diatur_ (menggunakan channel saat ini)');
  }

  // VoiceMaster
  if (settings.voicemasterHubId) {
    const ch = guild.channels.cache.get(settings.voicemasterHubId);
    lines.push(`🔊 **VoiceMaster Hub:** ${ch ? `<#${ch.id}>` : `ID: ${settings.voicemasterHubId} (tidak ditemukan)`}`);
  } else {
    lines.push('🔊 **VoiceMaster:** _tidak aktif_');
  }

  lines.push('\n💡 *Ubah pengaturan: "@bot set welcome channel ke #channel"*');

  await message.reply(lines.join('\n'));
  return { success: true, type: 'get_config', replied: true };
}
