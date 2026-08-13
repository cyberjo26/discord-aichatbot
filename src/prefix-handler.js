import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { chatCompletion, getAiStats } from './ai/openrouter.js';
import { buildJarvisPrompt, SUMMARIZE_PROMPT } from './ai/prompts.js';
import { ragPipeline } from './rag/pipeline.js';
import { scrapeUrl } from './rag/scraper.js';
import { condenseForVoice, synthesize, resolveEnglishVoice } from './voice/tts.js';
import { playInVoiceChannel, getMemberVoiceChannel } from './voice/player.js';
import {
  buildAnswerEmbed,
  buildChatEmbed,
  buildSummaryEmbed,
  buildHelpEmbed,
  buildErrorEmbed,
} from './utils/formatter.js';
import { getHistory, addMessage, clearHistory } from './utils/memory.js';
import { isOwner } from './utils/permissions.js';
import { parseDuration, formatDuration } from './utils/reminders.js';
import { addWarning, applyWarningEscalation } from './utils/warnings.js';
import { getSetting, setSetting, removeSetting } from './utils/server-settings.js';
import { buildWelcomeEmbed, isHttpUrl, WELCOME_TITLE_MAX, WELCOME_MESSAGE_MAX } from './utils/welcome-embed.js';
import { isAfk, setAfk, clearAfk, getAfk, formatAfkSince, sendTempMessage } from './utils/afk.js';
import config from './config.js';
import logger from './utils/logger.js';
import { execPing, execWeather, execInvite } from './actions/index.js';
import {
  getReactionRoles,
  addReactionRole,
  removeReactionRole,
  removeAllReactionRoles,
  updateReactionRoleEmoji,
  findMessageInGuild,
} from './utils/reaction-roles.js';

const PREFIX = '!';

/**
 * Parse and handle prefix commands.
 * Supported: !ask, !chat, !summarize, !help, !voice, !admin
 */
export async function handlePrefixCommand(message) {
  const content = message.content.slice(PREFIX.length).trim();
  if (!content) return;

  // Parse command and args
  const spaceIdx = content.indexOf(' ');
  const command = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1).trim();

  switch (command) {
    case 'ask':
    case 'ask-voice':
      return handleAsk(message, args, command === 'ask-voice' ? 'voice' : 'text');

    case 'chat':
    case 'chat-voice':
      return handleChat(message, args, command === 'chat-voice' ? 'voice' : 'text');

    case 'summarize':
      return handleSummarize(message, args);

    case 'help':
      return handleHelp(message);

    case 'welcome':
    case 'admin-welcome':
      return handleWelcomeConfig(message, args);

    case 'voice':
      return handleVoiceToggle(message, args);

    // Admin commands
    case 'admin-voice':
      return handleAdminVoice(message);

    case 'admin-say':
      return handleAdminSay(message, args);

    case 'admin-status':
      return handleAdminStatus(message);

    case 'admin-execute':
      return handleAdminExecute(message, args);

    case 'admin-model':
      return handleAdminSetModel(message, args);

    case 'admin-clear':
      return handleAdminClear(message, args);

    case 'admin-voicewelcome':
    case 'admin-voice-welcome':
      return handleAdminVoiceWelcomeToggle(message, args);

    // New moderation/utility commands requested by the user
    case 'cvoice':
      return handleCVoice(message, args);
    case 'warn':
      return handleWarn(message, args);
    case 'bungkam':
      return handleBungkam(message, args);
    case 'kick':
      return handleKick(message, args);
    case 'dc':
      return handleDc(message, args);
    case 'to':
      return handleTo(message, args);
    case 'prune':
      return handlePrune(message, args);
    case 'cn':
      return handleCn(message, args);

    case 'act':
      return handleAct(message, args);

    case 'ping':
      return handlePing(message);
    case 'weather':
    case 'cuaca':
      return handleWeather(message, args);
    case 'invite':
    case 'undang':
      return handleInvite(message);

    case 'afk':
      return handleAfk(message, args);

    case 'rrole':
      return handleRrole(message, args);

    default:
      // Unknown command — silently ignore
      return;
  }
}

// ─── !ask ──────────────────────────────────────────────────────────

async function handleAsk(message, query, mode) {
  if (!query) {
    return message.reply('❗ Tulis pertanyaannya. Contoh: `!ask Siapa pendiri Google?`');
  }

  logger.command(message.author.tag, `!ask`, `"${query}" mode:${mode}`);

  // Show typing indicator
  await message.channel.sendTyping();

  try {
    // Answer naturally first
    const answer = await chatCompletion([
      { role: 'system', content: buildJarvisPrompt({}) },
      { role: 'user', content: query },
    ]);

    const embed = buildAnswerEmbed({ query, answer, sources: [], mode });

    // Add "search sources" button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`prag_${message.id}`)
        .setLabel('📚 Tambahkan Sumber Artikel')
        .setStyle(ButtonStyle.Secondary)
    );

    const replyOptions = { embeds: [embed], components: [row] };

    // Voice mode
    if (mode === 'voice') {
      await handleVoiceReply(message, answer, replyOptions);
    }

    const reply = await message.reply(replyOptions);

    // Wait for button click
    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.customId === `prag_${message.id}`,
        time: 60_000,
      });

      await btn.deferUpdate();
      await reply.edit({
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`prag_${message.id}`)
              .setLabel('⏳ Sedang mencari sumber...')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          ),
        ],
      });

      const { answer: ragAnswer, sources } = await ragPipeline(query);
      const ragEmbed = buildAnswerEmbed({ query, answer: ragAnswer, sources, mode });
      await reply.edit({ embeds: [ragEmbed], components: [] });
    } catch {
      try { await reply.edit({ components: [] }); } catch { /* reply already gone */ }
    }
  } catch (err) {
    logger.error(`!ask error: ${err.message}`);
    await message.reply({ embeds: [buildErrorEmbed('Maaf, terjadi kesalahan. Coba lagi nanti.')] });
  }
}

// ─── !chat ─────────────────────────────────────────────────────────

async function handleChat(message, text, mode) {
  if (!text) {
    return message.reply('❗ Tulis pesannya. Contoh: `!chat Halo, apa kabar?`');
  }

  logger.command(message.author.tag, `!chat`, `"${text}" mode:${mode}`);
  await message.channel.sendTyping();

  try {
    const history = getHistory(message.author.id);
    const systemPrompt = buildJarvisPrompt({});
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6),
      { role: 'user', content: text },
    ];

    const answer = await chatCompletion(messages);

    addMessage(message.author.id, 'user', text);
    addMessage(message.author.id, 'assistant', answer);

    const embed = buildChatEmbed({ answer, mode });
    const replyOptions = { embeds: [embed] };

    if (mode === 'voice') {
      await handleVoiceReply(message, answer, replyOptions);
    }

    await message.reply(replyOptions);
  } catch (err) {
    logger.error(`!chat error: ${err.message}`);
    await message.reply({ embeds: [buildErrorEmbed('Maaf, terjadi kesalahan. Coba lagi nanti.')] });
  }
}

// ─── !summarize ────────────────────────────────────────────────────

async function handleSummarize(message, url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return message.reply('❗ Kirim URL yang valid. Contoh: `!summarize https://example.com/article`');
  }

  logger.command(message.author.tag, '!summarize', url);
  await message.channel.sendTyping();

  try {
    const content = await scrapeUrl(url);
    if (!content) {
      return message.reply({ embeds: [buildErrorEmbed('Gagal mengambil konten dari URL tersebut.')] });
    }

    const summary = await chatCompletion([
      { role: 'system', content: SUMMARIZE_PROMPT },
      { role: 'user', content: `Ringkas konten berikut:\n\n${content}` },
    ]);

    await message.reply({ embeds: [buildSummaryEmbed({ url, summary })] });
  } catch (err) {
    logger.error(`!summarize error: ${err.message}`);
    await message.reply({ embeds: [buildErrorEmbed('Gagal meringkas artikel.')] });
  }
}

// ─── !help ─────────────────────────────────────────────────────────

async function handleHelp(message) {
  const helpEmbed = buildHelpEmbed();

  // Add prefix commands section
  const prefixEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⌨️ Prefix Commands')
    .setDescription('Selain slash commands, kamu juga bisa pakai prefix `!`')
    .addFields(
      { name: '!ask <pertanyaan>', value: 'Tanya (text mode)' },
      { name: '!ask-voice <pertanyaan>', value: 'Tanya (voice mode)' },
      { name: '!chat <pesan>', value: 'Ngobrol (text mode)' },
      { name: '!chat-voice <pesan>', value: 'Ngobrol (voice mode)' },
      { name: '!summarize <url>', value: 'Ringkas artikel' },
      { name: '!afk [alasan]', value: 'Set status AFK (cth: `!afk tidur`). `!afk off` untuk hapus' },
      { name: '🧠 AFK natural', value: 'Bot auto-detect kalimat AFK, cth: `gw afk dulu mau makan` / `im going afk for dinner`' },
      { name: '!help', value: 'Panduan ini' },
      { name: '!welcome status|preview|on|off|reset', value: 'Atur atau preview welcome embed (Owner). Preview memakai konfigurasi tersimpan dan member yang menjalankan command. Channel: `!welcome channel #welcome` atau `!welcome channel 123456789012345678`. Message mention: `@{user}`. Subcommand: `title`, `message`, `image`' },
      { name: '!voice on|off|status', value: 'Aktifkan/nonaktifkan auto voice reply saat ngobrol dengan `@bot` (Admin/Owner)' },
      { name: '!cvoice [nama/ID channel]', value: 'Cek member di voice channel & statusnya (Mute, Deafen, Live)' },
      { name: '🔒 Moderasi (Admin/Mod Only)', value: 
        '`!warn <@user/nama> [alasan]` — Beri warning ke user\n' +
        '`!bungkam <@user/nama>` — Mute user di voice channel\n' +
        '`!kick <@user/nama> [alasan]` — Kick user dari server\n' +
        '`!dc <@user/nama>` — Keluarkan user dari voice channel\n' +
        '`!to <@user/nama> <durasi>` — Timeout user (cth: `!to @user 10` atau `!to @user 1 jam`)\n' +
        '`!prune <jumlah>` — Hapus pesan di channel (1-100)\n' +
        '`!cn <@user/nama> <nickname baru>` — Ganti nickname user'
      },
      { name: '🔒 Admin Commands (Owner Only)', value: '`!admin-voice` `!admin-say` `!admin-status`\n`!admin-execute` `!admin-model` `!admin-clear`\n`!admin-voicewelcome on|off|toggle` — Toggle sapaan suara di voice channel\n`!welcome status|preview|on|off|reset` — Atur/preview welcome embed; alias: `!admin-welcome`\n`!act <channel id> <pesan>` — Kirim pesan sebagai bot ke channel mana pun (tag: `@username` / `@userID` / `<@userID>` jadi mention asli)' },
    )
    .setFooter({ text: `${config.botName} • Prefix Commands` });

  // Jarvis Mode embed
  const jarvisEmbed = new EmbedBuilder()
    .setColor(0xff6b35)
    .setTitle('🤖 Jarvis Mode — Mention @bot')
    .setDescription(
      'Cukup tag aku dan bicara secara natural! Aku akan memahami maksudmu dan langsung eksekusi.'
    )
    .addFields(
      {
        name: '💬 Tanya / Ngobrol',
        value: '`@bot siapa pendiri Google?`\n`@bot halo apa kabar`\n`@bot rekomendasi belajar backend`',
      },
      {
        name: '🔊 Cek Voice Channel',
        value: '`@bot siapa yang di voice?`\n`@bot ada orang di vc gak?`',
      },
      {
        name: '🛡️ Moderasi',
        value:
          '`@bot mute @user`\n`@bot kasih role VIP ke @user`\n`@bot timeout @user 10 menit`\n`@bot ganti nick @user jadi Budi`',
      },
      {
        name: '⏰ Reminder',
        value: '`@bot ingatkan aku 10 menit lagi`\n`@bot remind me 1 jam`',
      },
      {
        name: '🧠 Smart Features',
        value:
          '• **Smart Memory** — Aku ingat konteks percakapan\n' +
          '• **Multi-Step Thinking** — Jawab kompleks dengan langkah-langkah\n' +
          '• **Self-Improving** — Aku adapt gaya jawab sesuai preferensimu\n' +
          '• **Code Helper** — Convert dan jelaskan kode',
      },
      {
        name: '💤 Wake/Sleep (Owner)',
        value: '`@bot tidur` — bot istirahat\n`@bot bangun` — bot aktif kembali',
      }
    )
    .setFooter({ text: `${config.botName} • Jarvis Mode` });

  await message.reply({ embeds: [helpEmbed, prefixEmbed, jarvisEmbed] });
}

// ─── !welcome / !admin-welcome ─────────────────────────────────────
// Owner-only welcome embed configuration.
// Usage: !welcome status|preview|on|off|reset
//        !welcome channel #channel
//        !welcome title <text>
//        !welcome message <text>
//        !welcome image <http(s)://url>

async function handleWelcomeConfig(message, args) {
  if (!message.guild) return message.reply('❌ Hanya bisa dipakai di server.');
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');

  const input = (args || '').trim();
  const spaceIdx = input.indexOf(' ');
  const sub = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).toLowerCase();
  const value = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
  const guildId = message.guild.id;

  if (sub === 'preview') {
    if (!message.member?.guild || typeof message.member.user?.displayAvatarURL !== 'function') {
      return message.reply('❌ Member preview tidak tersedia. Coba lagi di server.');
    }

    const embed = buildWelcomeEmbed(message.member, {
      title: getSetting(guildId, 'welcomeTitle'),
      message: getSetting(guildId, 'welcomeMessage'),
      image: getSetting(guildId, 'welcomeImage') || config.welcomeFallbackImage,
    });

    return message.reply({ embeds: [embed] });
  }

  if (!sub || sub === 'status') {
    const channelId = getSetting(guildId, 'welcomeChannelId');
    const enabled = getSetting(guildId, 'welcomeEnabled') !== false;
    const image = getSetting(guildId, 'welcomeImage') || config.welcomeFallbackImage || 'Tidak ada';
    return message.reply([
      `**Welcome:** ${enabled ? 'AKTIF' : 'NONAKTIF'}`,
      `**Channel:** ${channelId ? `<#${channelId}>` : 'System channel / .env'}`,
      `**Title:** ${getSetting(guildId, 'welcomeTitle') || '(default)'}`,
      `**Message:** ${getSetting(guildId, 'welcomeMessage') || '(default)'}`,
      `**Image:** ${image}`,
      'Usage: `!welcome status|preview|on|off|reset`, `!welcome channel #channel|CHANNEL_ID`, `!welcome title <text>`, `!welcome message <text>`, `!welcome image <url>`',
    ].join('\\n').slice(0, 1900));
  }

  if (sub === 'reset') {
    for (const key of ['welcomeChannelId', 'welcomeTitle', 'welcomeMessage', 'welcomeImage', 'welcomeEnabled']) {
      removeSetting(guildId, key);
    }
    return message.reply('✅ Konfigurasi welcome direset ke default.');
  }

  if (['on', 'off'].includes(sub)) {
    setSetting(guildId, 'welcomeEnabled', sub === 'on');
    return message.reply(`✅ Welcome embed sekarang: **${sub === 'on' ? 'AKTIF' : 'NONAKTIF'}**`);
  }

  if (!value) {
    return message.reply('❗ Isi nilai konfigurasi. Gunakan `!welcome status` untuk melihat contoh.');
  }

  if (sub === 'channel') {
    const channelId = value.match(/^<#(\d+)>$/)?.[1] || (/^\d+$/.test(value) ? value : null);
    const channelName = value.replace(/^#/, '').trim().toLowerCase();
    let channel = channelId
      ? message.guild.channels.cache.get(channelId)
      : message.guild.channels.cache.find((candidate) => candidate.name?.toLowerCase() === channelName);

    // Cache may be partial after restart. Numeric IDs use direct Discord fetch;
    // names use a full guild-channel fetch fallback.
    if (!channel && typeof message.guild.channels.fetch === 'function') {
      try {
        if (channelId) {
          channel = await message.guild.channels.fetch(channelId);
        } else {
          const fetchedChannels = await message.guild.channels.fetch();
          channel = fetchedChannels?.find((candidate) => candidate.name?.toLowerCase() === channelName);
        }
      } catch (err) {
        logger.debug(`!welcome: channel lookup failed: ${err.message}`);
      }
    }

    if (!channel) {
      return message.reply(
        `❌ Channel ${channelId ? `ID \`${channelId}\`` : `\`${value}\``} tidak ditemukan di server ini.`
      );
    }

    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      return message.reply('❌ Channel ditemukan, tapi bukan channel teks atau announcement.');
    }
    setSetting(guildId, 'welcomeChannelId', channel.id);
    return message.reply(`✅ Welcome channel: <#${channel.id}>`);
  }

  if (sub === 'image') {
    if (!isHttpUrl(value)) return message.reply('❌ Image harus berupa URL http:// atau https://.');
    setSetting(guildId, 'welcomeImage', value.slice(0, 2000));
    return message.reply('✅ Welcome image diperbarui.');
  }

  if (sub === 'title' || sub === 'message') {
    const key = sub === 'title' ? 'welcomeTitle' : 'welcomeMessage';
    const max = sub === 'title' ? WELCOME_TITLE_MAX : WELCOME_MESSAGE_MAX;
    setSetting(guildId, key, value.slice(0, max));
    return message.reply(`✅ Welcome ${sub} diperbarui.`);
  }

  return message.reply('❗ Usage: `!welcome status|preview|on|off|reset`, `channel #channel|CHANNEL_ID`, `title <text>`, `message <text>`, `image <url>`');
}

// ─── !voice ────────────────────────────────────────────────────────
// Controls automatic voice replies for natural @bot conversations.
// Explicit !ask-voice / !chat-voice commands remain voice-enabled.

async function handleVoiceToggle(message, args) {
  if (!message.guild) {
    return message.reply('❌ Perintah ini hanya bisa digunakan di server.');
  }

  const canManageVoiceReplies =
    isOwner(message.author.id) ||
    message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
    message.member?.permissions.has(PermissionFlagsBits.Administrator);

  if (!canManageVoiceReplies) {
    return message.reply('🔒 Kamu butuh permission **Manage Server** atau harus owner untuk mengatur auto voice reply.');
  }

  const arg = (args || '').trim().toLowerCase();
  const guildId = message.guild.id;
  const current = getSetting(guildId, 'autoVoiceRepliesEnabled') !== false;

  if (!arg || arg === 'status') {
    return message.reply(
      `🔊 Auto voice reply: **${current ? 'AKTIF' : 'NONAKTIF'}**\n` +
      'Usage: `!voice on|off|status`\n' +
      'Pengaturan ini hanya memengaruhi chat natural `@bot`, bukan `!ask-voice` atau `!chat-voice`.'
    );
  }

  let next;
  if (['on', 'true', '1', 'enable', 'aktif'].includes(arg)) {
    next = true;
  } else if (['off', 'false', '0', 'disable', 'matikan', 'nonaktif'].includes(arg)) {
    next = false;
  } else {
    return message.reply('❗ Usage: `!voice on|off|status`');
  }

  setSetting(guildId, 'autoVoiceRepliesEnabled', next);
  return message.reply(
    `✅ Auto voice reply sekarang: **${next ? 'AKTIF' : 'NONAKTIF'}**\n` +
    'Berlaku untuk chat natural `@bot`; command voice eksplisit tetap tersedia.'
  );
}

// ─── Admin commands (owner only) ───────────────────────────────────

async function handleAdminVoice(message) {
  if (!isOwner(message.author.id)) {
    return message.reply('🔒 Perintah ini hanya untuk owner bot.');
  }

  const guild = message.guild;
  if (!guild) return;

  const voiceChannels = guild.channels.cache.filter(
    (ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔊 Voice Channel — Siapa di mana?')
    .setTimestamp()
    .setFooter({ text: `${guild.name} • ${config.botName} Admin` });

  let totalMembers = 0;
  let hasAny = false;

  for (const [, channel] of voiceChannels) {
    const members = channel.members;
    if (members.size === 0) continue;
    hasAny = true;
    totalMembers += members.size;

    const list = members.map((m) => {
      const s = [];
      if (m.voice.selfMute) s.push('🔇');
      if (m.voice.selfDeaf) s.push('🔕');
      if (m.voice.streaming) s.push('📺');
      if (m.voice.selfVideo) s.push('📷');
      if (m.user.bot) s.push('🤖');
      return `• ${m.displayName}${s.length ? ' ' + s.join('') : ''}`;
    }).join('\n');

    embed.addFields({ name: `🔊 ${channel.name} (${members.size})`, value: list });
  }

  embed.setDescription(hasAny ? `Total **${totalMembers}** orang.` : '*Tidak ada yang di voice.*');
  await message.reply({ embeds: [embed] });
}

async function handleAdminSay(message, text) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');
  if (!text) return message.reply('❗ `!admin-say <pesan>`');

  await message.delete().catch(() => {});
  await message.channel.send(text);
}

async function handleAdminStatus(message) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');

  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const aiStats = getAiStats();
  const aiHealth = config.aiProviderOrder.map((name) => {
    const stats = aiStats[name];
    const state = stats?.circuitOpen ? 'circuit open' : 'ready';
    return `**${name}**: ${state}, ${stats?.successes || 0}/${stats?.requests || 0} sukses, avg ${stats?.averageLatencyMs || 0}ms`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('📊 Bot Status')
    .addFields(
      { name: '⏱️ Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
      { name: '💾 Memory', value: `${mem} MB`, inline: true },
      { name: '🌐 Servers', value: `${message.client.guilds.cache.size}`, inline: true },
      { name: '🤖 Provider order', value: config.aiProviderOrder.join(' → '), inline: false },
      { name: '📈 AI health', value: aiHealth, inline: false },
      { name: '🤖 OpenRouter model', value: config.primaryModel, inline: true },
      { name: 'Gemini model', value: config.geminiModel, inline: true },
    )
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

async function handleAdminExecute(message, prompt) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');
  if (!prompt) return message.reply('❗ `!admin-execute <prompt>`');

  await message.channel.sendTyping();

  try {
    const answer = await chatCompletion([
      { role: 'system', content: 'Kamu adalah AI assistant. Jawab apapun yang diminta. Ini perintah dari owner.' },
      { role: 'user', content: prompt },
    ]);

    const embed = new EmbedBuilder()
      .setColor(0xff6b35)
      .setTitle('🔧 Admin Execute')
      .setDescription(answer.slice(0, 4000))
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (err) {
    await message.reply(`❌ Error: ${err.message}`);
  }
}

async function handleAdminSetModel(message, model) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');
  if (!model) return message.reply('❗ `!admin-model <model_id>`');

  const old = config.primaryModel;
  config.primaryModel = model;
  logger.info(`Owner changed model: ${old} → ${model}`);
  await message.reply(`✅ Model: \`${old}\` → \`${model}\``);
}

async function handleAdminClear(message, _mention) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');

  const user = message.mentions.users.first();
  if (!user) return message.reply('❗ `!admin-clear @user`');

  clearHistory(user.id);
  await message.reply(`✅ Memory untuk ${user.tag} dihapus.`);
}

async function handleAdminVoiceWelcomeToggle(message, args) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');
  if (!message.guild) return message.reply('❌ Hanya bisa dipakai di server.');

  const arg = (args || '').trim().toLowerCase();
  const guildId = message.guild.id;
  const current = getSetting(guildId, 'voiceWelcomeEnabled') !== false;

  let next;
  if (!arg || arg === 'status') {
    const status = current ? '🟢 AKTIF' : '🔴 NONAKTIF';
    return message.reply(`🔊 Voice welcome: **${status}**\nUsage: \`!admin-voicewelcome on|off|toggle\``);
  } else if (['on', 'true', '1', 'enable', 'aktif'].includes(arg)) {
    next = true;
  } else if (['off', 'false', '0', 'disable', 'matikan', 'nonaktif'].includes(arg)) {
    next = false;
  } else if (['toggle', 'flip', 'switch'].includes(arg)) {
    next = !current;
  } else {
    return message.reply('❗ Usage: `!admin-voicewelcome on|off|toggle`');
  }

  setSetting(guildId, 'voiceWelcomeEnabled', next);
  const status = next ? '🟢 AKTIF' : '🔴 NONAKTIF';
  logger.command(message.author.tag, `!admin-voicewelcome → ${next}`);
  return message.reply(`✅ Voice welcome sekarang: **${status}**`);
}

// ─── !act (Owner Only) ────────────────────────────────────────────
// Send a message AS the bot to any channel the bot can see.
// Usage: !act <channelId> <message>  (channel id can be raw or <#id>)
// Works from server channels and DMs.

// Discord only turns "@name" into a real mention (<@id>) when it resolves at
// typing time (autocomplete). Tags typed literally — pasted, from a DM, or for
// a user in another server — stay as "@name" text and send as plain text.
// This converts literal tags in the !act message into real mentions using the
// TARGET channel's guild (usernames are single-word, so a single-token match
// covers the common case; multi-word nicknames need <@id>).
async function resolveMentions(text, channel) {
  if (!text) return text;

  // Bare user-ID form: @123456789012345678 -> <@123456789012345678>.
  // (?<!<) guard: never touch @ids already inside <@...> mention brackets,
  // otherwise <@id> would become <<@id>> and render as plain text.
  let out = text.replace(/(?<!<)@(\d{15,20})/g, '<@$1>');

  // Already-resolved forms (<@id>, <@!id>, <@&roleid>, <#id>) pass through.

  if (!channel.guild) return out; // DM target — nothing to resolve against

  // Collect unique literal @name tokens (skip @everyone/@here — API handles
  // them; check is case-exact like Discord's own ping behavior)
  const tokenRe = /(^|\s)@([a-zA-Z0-9][a-zA-Z0-9_.-]*)/g;
  const names = new Set();
  for (const m of out.matchAll(tokenRe)) {
    const name = m[2];
    if (name !== 'everyone' && name !== 'here') names.add(name);
  }
  if (names.size === 0) return out;

  const replacements = new Map();
  const unresolved = [];

  for (const name of names) {
    // Role from cache (cheap) — exact name match
    const role = channel.guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (role) {
      replacements.set(name, `<@&${role.id}>`);
      continue;
    }
    // Member from cache first (exact username / nickname)
    const lower = name.toLowerCase();
    const cachedMember =
      channel.guild.members.cache.find(m => m.user.username.toLowerCase() === lower) ||
      channel.guild.members.cache.find(m => (m.nickname || '').toLowerCase() === lower);
    if (cachedMember) {
      replacements.set(name, `<@${cachedMember.id}>`);
      continue;
    }
    unresolved.push(name);
  }

  // API search fallback (needs Server Members Intent) — run in parallel
  await Promise.all(unresolved.map(async (name) => {
    const lower = name.toLowerCase();
    try {
      const members = await channel.guild.members.fetch({ query: name, limit: 5 });
      const member =
        members.find(m => m.user.username.toLowerCase() === lower) ||
        members.find(m => (m.nickname || '').toLowerCase() === lower) ||
        members.first();
      if (member) replacements.set(name, `<@${member.id}>`);
    } catch (err) {
      logger.debug(`!act: member lookup gagal untuk "${name}": ${err.message}`);
    }
  }));

  return out.replace(tokenRe, (m, pre, name) => {
    if (name === 'everyone' || name === 'here') return m;
    const rep = replacements.get(name);
    return rep ? `${pre}${rep}` : m;
  });
}

async function handleAct(message, args) {
  if (!isOwner(message.author.id)) {
    return message.reply('🔒 Perintah ini hanya untuk owner bot.');
  }

  if (!args) {
    return message.reply('❗ Usage: `!act <channel id> <pesan>`\nContoh: `!act 123456789012345678 Halo semua!`');
  }

  // Parse channel id (raw `123...` or mention `<#123...>`) + the message after it
  const match = args.match(/^(?:<#)?(\d+)(?:>)?\s+([\s\S]+)/);
  if (!match) {
    return message.reply('❗ Format salah. Contoh: `!act 123456789012345678 Halo semua!`');
  }

  const [, rawChannelId, rawText] = match;
  const text = rawText.trim().slice(0, 2000); // Discord 2000-char limit
  if (!text) {
    return message.reply('❗ Pesannya kosong. Contoh: `!act 123456789012345678 Halo semua!`');
  }

  // Resolve channel — check cache first, then fetch from API
  let channel = message.client.channels.cache.get(rawChannelId);
  if (!channel) {
    try {
      channel = await message.client.channels.fetch(rawChannelId);
    } catch {
      return message.reply(`❌ Channel \`${rawChannelId}\` tidak ditemukan atau bot tidak punya akses ke sana.`);
    }
  }

  // Must be a text-capable channel — exclude voice, forum, and media channels
  // (forum/media need thread creation, not plain channel.send)
  if (
    !channel.isTextBased ||
    !channel.isTextBased() ||
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildMedia
  ) {
    return message.reply('❌ Channel tersebut bukan channel teks biasa.');
  }

  // Permission check (DM channels have no permissions — skip there).
  // Threads need SendMessagesInThreads, regular channels need SendMessages.
  const botPerms = channel.permissionsFor?.(message.client.user.id);
  const neededPerm = channel.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (botPerms && !botPerms.has(neededPerm)) {
    return message.reply(`❌ Bot tidak punya permission untuk mengirim pesan di <#${channel.id}>.`);
  }

  // NOTE: owner-only tool — can reach any channel the bot can see in any guild,
  // including DM channels. Owner-only gating is the intended safeguard.
  try {
    const finalText = await resolveMentions(text, channel);
    await channel.send(finalText);
    logger.command(message.author.tag, '!act', `→ <#${channel.id}>: "${finalText.slice(0, 80)}"`);

    // Confirm via DM to keep it discreet; fall back to a normal reply
    const confirm = `✅ Pesan terkirim ke <#${channel.id}> di **${channel.guild?.name || 'DM'}**.`;
    try {
      await message.author.send(confirm);
    } catch {
      await message.reply(confirm);
    }

    // Stealth: remove the trigger command (best-effort — needs ManageMessages)
    await message.delete().catch(() => {});
  } catch (err) {
    logger.error(`!act error: ${err.message}`);
    await message.reply(`❌ Gagal mengirim pesan: ${err.message}`);
  }
}

// ─── Voice helper ──────────────────────────────────────────────────

async function handleVoiceReply(message, answer, replyOptions) {
  try {
    const voiceChannel = getMemberVoiceChannel(message.member);

    // Not in voice → skip TTS entirely to preserve rate limit.
    // Text reply proceeds normally via the caller.
    if (!voiceChannel) {
      return;
    }

    const voiceText = await condenseForVoice(answer);
    // Translated text (TTS_TRANSLATE_ENGLISH) must use an English voice.
    const voice = config.ttsTranslateEnglish ? resolveEnglishVoice() : undefined;
    const audioBuffer = await synthesize(voiceText, voice);

    // Will play after message is sent
    setTimeout(async () => {
      try {
        await playInVoiceChannel(voiceChannel, audioBuffer);
      } catch (err) {
        logger.error(`Voice play error: ${err.message}`);
      }
    }, 500);
  } catch (err) {
    logger.error(`Voice error: ${err.message}`);
    replyOptions.content = '⚠️ *Voice gagal.*';
  }
}

// ─── Shared: Resolve target member for prefix commands ─────────────

async function resolveMemberFromArgs(message, args) {
  if (!args) return null;
  const guild = message.guild;
  if (!guild) return null;

  const mentionRegex = /<@!?(\d+)>/;
  const hasMention = mentionRegex.test(args);
  let targetMember = null;
  let remainingArgs = '';

  if (hasMention) {
    const match = args.match(mentionRegex);
    const targetId = match[1];
    targetMember = await guild.members.fetch(targetId).catch(() => null);
    remainingArgs = args.replace(mentionRegex, '').trim();
  } else {
    // No mention, split by first space
    const spaceIdx = args.indexOf(' ');
    const targetStr = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    remainingArgs = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();
    
    if (targetStr) {
      if (/^\d+$/.test(targetStr)) {
        targetMember = await guild.members.fetch(targetStr).catch(() => null);
      } else {
        const fetched = await guild.members.fetch({ query: targetStr, limit: 10 });
        targetMember = fetched.find(m =>
          m.displayName.toLowerCase().includes(targetStr.toLowerCase()) ||
          m.user.username.toLowerCase().includes(targetStr.toLowerCase())
        );
      }
    }
  }

  return { member: targetMember, remaining: remainingArgs };
}

// ─── New Moderation & Utility Handlers ─────────────────────────────

async function handleCVoice(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  let voiceChannels = [];
  
  if (args) {
    const query = args.toLowerCase();
    const match = guild.channels.cache.filter(
      (ch) =>
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
        (ch.id === query || ch.name.toLowerCase().includes(query))
    );
    if (match.size === 0) {
      return message.reply(`❌ Voice channel dengan nama/ID "${args}" tidak ditemukan.`);
    }
    voiceChannels = [...match.values()];
  } else if (message.member?.voice?.channel) {
    voiceChannels = [message.member.voice.channel];
  } else {
    const allVoice = guild.channels.cache.filter(
      (ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
    );
    voiceChannels = [...allVoice.values()];
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔊 Voice Channel Info')
    .setTimestamp()
    .setFooter({ text: `${guild.name} • ${config.botName}` });

  let hasAny = false;

  for (const channel of voiceChannels) {
    const members = channel.members;
    if (members.size === 0 && args) {
      embed.addFields({ name: `📌 ${channel.name}`, value: '*Channel ini kosong.*' });
      hasAny = true;
      continue;
    }
    if (members.size === 0) continue;

    hasAny = true;
    const list = members.map((m) => {
      const status = [];
      if (m.voice.selfMute || m.voice.serverMute) status.push('🔇 Muted');
      if (m.voice.selfDeaf || m.voice.serverDeaf) status.push('🔕 Deafened');
      if (m.voice.streaming) status.push('🖥️ Live Screen');
      if (m.voice.selfVideo) status.push('📷 Camera On');
      if (m.user.bot) status.push('🤖 Bot');

      const statusText = status.length > 0 ? `(${status.join(', ')})` : '(Normal)';
      return `• **${m.displayName}** ${statusText}`;
    }).join('\n');

    embed.addFields({ name: `📌 ${channel.name} (${members.size} member)`, value: list });
  }

  if (!hasAny) {
    return message.reply('🔊 *Semua voice channel saat ini sedang kosong.*');
  }

  await message.reply({ embeds: [embed] });
}

async function handleWarn(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `ModerateMembers` untuk memberikan warning.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!warn @user spamming` atau `!warn nama_user spamming`');
  }

  const member = resolved.member;
  const reason = resolved.remaining || 'Tidak disebutkan';

  if (member.id === guild.ownerId) {
    return message.reply('❌ Tidak dapat memberi warning kepada pemilik server.');
  }

  const result = addWarning(guild.id, member.id, reason, message.author.id);

  let replyText = `⚠️ **${member.displayName}** telah diperingatkan oleh **${message.author.username}**.\n📝 **Alasan:** ${reason}\n📊 **Total Peringatan:** ${result.total}/5`;

  // Shared escalation policy (warnings.js): 3 → timeout 10m, 5 → kick
  const escalation = await applyWarningEscalation({
    guild,
    member,
    total: result.total,
    channelId: message.channel?.id ?? null,
  });
  replyText += escalation.text;

  await message.reply(replyText);
}

async function handleBungkam(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.MuteMembers)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `MuteMembers` untuk membungkam user.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!bungkam @user` atau `!bungkam nama_user`');
  }

  const member = resolved.member;
  if (!member.voice.channel) {
    return message.reply(`⚠️ **${member.displayName}** tidak berada di voice channel saat ini.`);
  }

  try {
    await member.voice.setMute(true);
    await message.reply(`🔇 **${member.displayName}** telah dibungkam di voice channel.`);
  } catch (err) {
    await message.reply(`❌ Gagal membungkam **${member.displayName}**: ${err.message}`);
  }
}

async function handleKick(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `KickMembers` untuk menendang user.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!kick @user melanggar aturan` atau `!kick nama_user`');
  }

  const member = resolved.member;
  const reason = resolved.remaining || 'Tidak disebutkan';

  if (member.id === guild.ownerId) {
    return message.reply('❌ Tidak dapat menendang pemilik server.');
  }

  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return message.reply(`❌ Role **${member.displayName}** sama atau lebih tinggi dari bot, tidak bisa di-kick.`);
  }

  try {
    await member.kick(reason);
    await message.reply(`👢 **${member.displayName}** telah di-kick dari server.\n📝 **Alasan:** ${reason}`);
  } catch (err) {
    await message.reply(`❌ Gagal menendang **${member.displayName}**: ${err.message}`);
  }
}

async function handleDc(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `MoveMembers` untuk memutuskan voice channel.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!dc @user` atau `!dc nama_user`');
  }

  const member = resolved.member;
  if (!member.voice.channel) {
    return message.reply(`⚠️ **${member.displayName}** tidak sedang berada di voice channel.`);
  }

  try {
    await member.voice.disconnect();
    await message.reply(`🚪 **${member.displayName}** telah dikeluarkan dari voice channel.`);
  } catch (err) {
    await message.reply(`❌ Gagal mengeluarkan **${member.displayName}**: ${err.message}`);
  }
}

async function handleTo(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `ModerateMembers` untuk memberikan timeout.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!to @user 10` atau `!to nama_user 5 menit`');
  }

  const member = resolved.member;
  const durationStr = resolved.remaining;

  if (!durationStr) {
    return message.reply('⚠️ Harap sebutkan durasi timeout. Contoh: `!to @user 10` (10 menit) atau `!to @user 1 jam`');
  }

  const ms = parseDuration(durationStr);
  if (ms <= 0 || ms > 28 * 24 * 60 * 60 * 1000) {
    return message.reply('❌ Durasi timeout tidak valid. Gunakan rentang waktu antara 1 detik s.d 28 hari.');
  }

  if (member.id === guild.ownerId) {
    return message.reply('❌ Tidak dapat memberikan timeout kepada pemilik server.');
  }

  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return message.reply(`❌ Role **${member.displayName}** sama atau lebih tinggi dari bot, tidak bisa di-timeout.`);
  }

  try {
    await member.timeout(ms);
    await message.reply(`⏱️ **${member.displayName}** telah di-timeout selama **${formatDuration(ms)}**.`);
  } catch (err) {
    await message.reply(`❌ Gagal memberikan timeout kepada **${member.displayName}**: ${err.message}`);
  }
}

async function handlePrune(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `ManageMessages` untuk menghapus pesan.');
  }

  const amount = parseInt(args);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    return message.reply('⚠️ Harap tentukan jumlah pesan yang valid antara 1 s.d 100. Contoh: `!prune 10`');
  }

  try {
    const deleteCount = amount + 1;
    const deleted = await message.channel.bulkDelete(deleteCount, true);
    
    const successMsg = await message.channel.send(`🧹 Berhasil menghapus **${deleted.size - 1}** pesan.`);
    setTimeout(() => {
      successMsg.delete().catch(() => {});
    }, 3000);
  } catch (err) {
    await message.reply(`❌ Gagal menghapus pesan: ${err.message}`);
  }
}

async function handleCn(message, args) {
  const guild = message.guild;
  if (!guild) return message.reply('❌ Perintah ini hanya bisa digunakan di server.');

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator) && !message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return message.reply('🔒 Kamu tidak memiliki role Admin atau permission `ManageNicknames` untuk mengubah nickname.');
  }

  const resolved = await resolveMemberFromArgs(message, args);
  if (!resolved || !resolved.member) {
    return message.reply('⚠️ Target user tidak ditemukan. Contoh: `!cn @user NicknameBaru` atau `!cn nama_user NicknameBaru`');
  }

  const member = resolved.member;
  const newNickname = resolved.remaining;

  if (!newNickname) {
    return message.reply('⚠️ Harap sebutkan nickname baru yang ingin diberikan.');
  }

  if (member.id === guild.ownerId) {
    return message.reply('❌ Tidak dapat mengubah nickname pemilik server.');
  }

  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return message.reply(`❌ Role **${member.displayName}** sama atau lebih tinggi dari bot, tidak bisa mengubah nickname.`);
  }

  try {
    const oldNick = member.displayName;
    await member.setNickname(newNickname);
    await message.reply(`✏️ Nickname **${oldNick}** berhasil diubah menjadi **${newNickname}**.`);
  } catch (err) {
    await message.reply(`❌ Gagal mengubah nickname **${member.displayName}**: ${err.message}`);
  }
}

async function handlePing(message) {
  return execPing(message);
}

async function handleWeather(message, args) {
  const location = args.trim();
  if (!location) {
    return message.reply('⚠️ Harap masukkan lokasi yang ingin dicari. Contoh: `!weather Jakarta` atau `!cuaca Tokyo`');
  }
  return execWeather(message, { location });
}

async function handleInvite(message) {
  return execInvite(message);
}

// ─── !afk ──────────────────────────────────────────────────────────
// Set/clear AFK status. Usage:
//   !afk               → set AFK (default reason)
//   !afk tidur         → set AFK with reason
//   !afk off           → clear AFK manually

async function handleAfk(message, args) {
  const arg = (args || '').trim().toLowerCase();
  const userId = message.author.id;

  // Manual clear: !afk off / !afk end / !afk kembali
  if (['off', 'end', 'stop', 'kembali', 'balik'].includes(arg)) {
    const cleared = clearAfk(userId);
    if (cleared) {
      logger.command(message.author.tag, '!afk off');
      return sendTempMessage(message, { reply: true, text: `👋 Selamat kembali, <@${userId}>! Status AFK kamu ("${cleared.reason}") sudah dihapus.` });
    }
    return sendTempMessage(message, { reply: true, text: '❌ Kamu tidak sedang AFK.' });
  }

  // Already AFK → tell them (they can use !afk off, or the status clears
  // automatically when they send a normal message / type).
  if (isAfk(userId)) {
    const current = getAfk(userId);
    return sendTempMessage(message, {
      reply: true,
      text: `😴 Kamu sudah AFK: **${current.reason}** (${formatAfkSince(current.setAt)}).\n` +
        'Ketik `!afk off` untuk hapus, atau kirim pesan biasa — otomatis kembali.',
    });
  }

  const reason = (args || '').trim() || 'Sedang AFK';
  setAfk(userId, reason, message.guild?.id || null);
  logger.command(message.author.tag, '!afk', reason);
  return sendTempMessage(message, {
    reply: true,
    text: `😴 <@${userId}> sekarang **AFK**: ${reason}\n` +
      'Kalau ada yang mention/reply kamu, mereka akan diberitahu.\n' +
      'Status otomatis hilang saat kamu kirim pesan atau mengetik.',
  });
}

// ─── !rrole ────────────────────────────────────────────────────────
// Reaction role management. Usage:
//   !rrole setup <title> [description]   → buat panel reaction role
//   !rrole add <msgId> <emoji> <@role>   → tambah binding
//   !rrole remove <msgId> <emoji> [@role]→ hapus binding
//   !rrole remove-all <msgId>            → hapus semua binding di pesan
//   !rrole list                          → lihat semua binding

function checkRrolePermission(message) {
  if (isOwner(message.author.id)) return true;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageRoles)) return true;
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

function resolveEmojiPrefix(input) {
  const trimmed = (input || '').trim();

  // Discord custom emoji: <:name:123456> or <a:name:123456>
  const match = trimmed.match(/^<a?:(\w+):(\d+)>$/);
  if (match) return match[2];

  // Plain numeric ID
  if (/^\d{15,}$/.test(trimmed)) return trimmed;

  // Unicode emoji
  return trimmed;
}

async function handleRrole(message, args) {
  if (!checkRrolePermission(message)) {
    return message.reply('🔒 Kamu butuh izin **Manage Roles** atau harus owner untuk pakai `!rrole`.');
  }

  const parts = args ? args.split(/\s+/) : [];
  const sub = (parts[0] || '').toLowerCase();
  // Raw text after subcommand (preserves newlines)
  const rawArgs = args ? args.slice(sub.length).trim() : '';

  switch (sub) {
    case 'setup':
      return handleRroleSetup(message, rawArgs);
    case 'add':
      return handleRroleAdd(message, parts.slice(1));
    case 'remove':
      return handleRroleRemove(message, parts.slice(1));
    case 'remove-all':
      return handleRroleRemoveAll(message, parts.slice(1));
    case 'list':
      return handleRroleList(message);
    case 'set-emoji':
      return handleRroleSetEmoji(message, parts.slice(1));
    default:
      return message.reply(
        '📋 **!rrole** — Reaction Role Manager\n' +
        '```\n' +
        '!rrole setup <judul> (deskripsi)\n' +
        '!rrole setup <msgId>\n' +
        '!rrole add <messageId> <emoji> <@role>\n' +
        '!rrole remove <messageId> <emoji> [@role]\n' +
        '!rrole remove-all <messageId>\n' +
        '!rrole set-emoji <messageId> <oldEmoji> <newEmoji> <@role>\n' +
        '!rrole list\n```\n' +
        'Contoh: `!rrole setup Role Kalian (Pilih sesuai kebutuhan)`'
      );
  }
}

async function handleRroleSetup(message, raw) {
  if (!raw) {
    return message.reply(
      '❗ **!rrole setup** — dua mode:\n' +
      '• `!rrole setup <judul> (deskripsi)` — buat panel embed baru\n' +
      '• `!rrole setup <msgId>` — pakai pesan yang sudah ada sebagai panel'
    );
  }

  // Mode 1: raw is a message ID → reuse existing message as panel
  const msgIdMatch = raw.match(/^(\d{17,20})$/);
  if (msgIdMatch) {
    const msgId = msgIdMatch[1];
    const guild = message.guild;
    const found = await findMessageInGuild(guild, msgId, message.channelId);
    if (!found) {
      return message.reply(`❌ Pesan \`${msgId}\` tidak ditemukan di server ini.`);
    }
    await message.reply(
      `✅ Pesan \`${msgId}\` dari <#${found.channelId}> dijadikan panel reaction role!\n` +
      'Gunakan `!rrole add <msgId> <emoji> <@role>` untuk tambah binding.'
    );
    return;
  }

  // Mode 2: raw is text → create new embed panel
  // Parse: title (description) — description in parens stripped, placed on new line
  // Newlines in description are preserved.
  const parenIdx = raw.indexOf('(');
  let title, description;
  if (parenIdx !== -1 && raw.endsWith(')')) {
    title = raw.slice(0, parenIdx).trim();
    description = raw.slice(parenIdx + 1, -1).trim();
  } else {
    title = raw;
    description = null;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setFooter({ text: 'Reaction Roles — klik emoji di bawah untuk dapat role!' })
    .setTimestamp();

  if (description) {
    embed.setDescription(description);
  }

  await message.channel.send({ embeds: [embed] });
  message.reply('✅ Panel dibuat. Gunakan `!rrole add <messageId> <emoji> <@role>` untuk tambah binding.');
}

async function handleRroleAdd(message, rest) {
  if (rest.length < 3) {
    return message.reply('❗ Gunakan: `!rrole add <messageId> <emoji> <@role>`\nContoh: `!rrole add 123456789012345678 🎨 @Artist`');
  }

  const messageId = rest[0];
  const emojiRaw = rest[1];
  const roleMention = rest[2];
  const roleId = roleMention.replace(/^<@&/, '').replace(/>$/, '');
  const role = message.guild.roles.cache.get(roleId);
  if (!role) {
    return message.reply(`❌ Role tidak ditemukan: ${roleMention}`);
  }

  const emoji = resolveEmojiPrefix(emojiRaw);

  // Validate message exists (scan all guild channels)
  const guild = message.guild;
  const msg = await findMessageInGuild(guild, messageId, message.channelId);
  if (!msg) {
    return message.reply(`❌ Pesan \`${messageId}\` tidak ditemukan di server ini. Pastikan ID benar dan bot punya akses ke channel-nya.`);
  }

  // React to the message
  const reactEmoji = /^\d{15,}$/.test(emoji)
    ? guild.emojis.cache.get(emoji) ?? emoji
    : emoji;
  try {
    await msg.react(reactEmoji);
  } catch (err) {
    return message.reply(`❌ Gagal menambahkan reaksi: ${err.message}`);
  }

  const added = addReactionRole(guild.id, {
    messageId,
    channelId: msg.channelId,
    emoji,
    roleId: role.id,
  });

  if (!added) {
    return message.reply(`⚠️ Binding untuk emoji **${emojiRaw}** → ${role} **sudah ada**.`);
  }

  message.reply(`✅ **Reaction role ditambahkan!**\n📌 Pesan: \`${messageId}\`\n🎨 Emoji: ${emojiRaw}\n👤 Role: ${role}`);
}

async function handleRroleRemove(message, rest) {
  if (rest.length < 2) {
    return message.reply('❗ Gunakan: `!rrole remove <messageId> <emoji> [@role]`');
  }

  const messageId = rest[0];
  const emojiRaw = rest[1];
  const roleMention = rest[2];
  let roleId = null;
  if (roleMention) {
    roleId = roleMention.replace(/^<@&/, '').replace(/>$/, '');
  }

  const emoji = resolveEmojiPrefix(emojiRaw);
  const removed = removeReactionRole(message.guild.id, messageId, emoji, roleId);

  if (removed === 0) {
    return message.reply('⚠️ Tidak ada binding yang cocok.');
  }
  message.reply(`✅ **${removed}** binding dihapus dari pesan \`${messageId}\` untuk emoji ${emojiRaw}.`);
}

async function handleRroleRemoveAll(message, rest) {
  if (rest.length === 0) {
    return message.reply('❗ Gunakan: `!rrole remove-all <messageId>`');
  }

  const messageId = rest[0];
  const removed = removeAllReactionRoles(message.guild.id, messageId);

  if (removed === 0) {
    return message.reply(`⚠️ Tidak ada reaction role di pesan \`${messageId}\`.`);
  }
  message.reply(`✅ **${removed}** binding dihapus dari pesan \`${messageId}\`.`);
}

async function handleRroleList(message) {
  const list = getReactionRoles(message.guild.id);

  if (list.length === 0) {
    return message.reply('📭 Belum ada reaction role di server ini.');
  }

  // Group by message
  const byMessage = new Map();
  for (const entry of list) {
    if (!byMessage.has(entry.messageId)) byMessage.set(entry.messageId, []);
    byMessage.get(entry.messageId).push(entry);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📌 Reaction Roles — Server Ini')
    .setFooter({ text: `${list.length} total binding` })
    .setTimestamp();

  for (const [msgId, entries] of byMessage) {
    const lines = entries.map((e) => {
      const emojiDisplay = /^\d{15,}$/.test(e.emoji)
        ? `<:custom:${e.emoji}>`
        : e.emoji;
      return `${emojiDisplay} → <@&${e.roleId}>`;
    });
    embed.addFields({
      name: `📋 Pesan \`${msgId}\` (${entries.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  message.reply({ embeds: [embed] });
}

async function handleRroleSetEmoji(message, rest) {
  if (rest.length < 4) {
    return message.reply('❗ Gunakan: `!rrole set-emoji <messageId> <oldEmoji> <newEmoji> <@role>`\nContoh: `!rrole set-emoji 123456789012345678 🎨 🖌️ @Artist`');
  }

  const messageId = rest[0];
  const oldEmojiRaw = rest[1];
  const newEmojiRaw = rest[2];
  const roleMention = rest[3];
  const roleId = roleMention.replace(/^<@&/, '').replace(/>$/, '');
  const role = message.guild.roles.cache.get(roleId);
  if (!role) {
    return message.reply(`❌ Role tidak ditemukan: ${roleMention}`);
  }

  const oldEmoji = resolveEmojiPrefix(oldEmojiRaw);
  const newEmoji = resolveEmojiPrefix(newEmojiRaw);

  // Update storage
  const updated = updateReactionRoleEmoji(message.guild.id, messageId, oldEmoji, newEmoji, roleId);
  if (!updated) {
    return message.reply(`❌ Binding tidak ditemukan: \`${messageId}\` ${oldEmojiRaw} → ${role}`);
  }

  // Remove old reaction + add new reaction on the message
  const guild = message.guild;
  const msg = await findMessageInGuild(guild, messageId, message.channelId);
  if (msg) {
    try {
      const oldReact = /^\d{15,}$/.test(oldEmoji)
        ? guild.emojis.cache.get(oldEmoji) ?? oldEmoji
        : oldEmoji;
      const reactKey = typeof oldReact === 'string' ? oldReact : oldReact.id;
      const reaction = msg.reactions.cache.get(reactKey);
      if (reaction) {
        await reaction.users.remove(message.client.user.id);
      }
    } catch { /* ignore */ }

    try {
      const newReact = /^\d{15,}$/.test(newEmoji)
        ? guild.emojis.cache.get(newEmoji) ?? newEmoji
        : newEmoji;
      await msg.react(newReact);
    } catch (err) {
      return message.reply(`⚠️ Binding diupdate, tapi gagal react emoji baru: ${err.message}`);
    }
  }

  message.reply(`✅ Emoji diubah: ${oldEmojiRaw} → ${newEmojiRaw} untuk ${role} di pesan \`${messageId}\`.`);
}
