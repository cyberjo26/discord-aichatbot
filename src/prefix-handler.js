import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { chatCompletion, getAiStats } from './ai/openrouter.js';
import { SYSTEM_PROMPT } from './ai/prompts.js';
import { ragPipeline } from './rag/pipeline.js';
import { scrapeUrl } from './rag/scraper.js';
import { SUMMARIZE_PROMPT } from './ai/prompts.js';
import { condenseForVoice, synthesize } from './voice/tts.js';
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
import { addWarning } from './utils/warnings.js';
import config from './config.js';
import logger from './utils/logger.js';
import { fetchWeather, getWeatherCodeInfo } from './utils/weather.js';

const PREFIX = '!';

/**
 * Parse and handle prefix commands.
 * Supported: !ask, !chat, !summarize, !help, !admin
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

    case 'ping':
      return handlePing(message);
    case 'weather':
    case 'cuaca':
      return handleWeather(message, args);
    case 'invite':
    case 'undang':
      return handleInvite(message);

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
      { role: 'system', content: SYSTEM_PROMPT },
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
      try { await reply.edit({ components: [] }); } catch {}
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
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
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
      { name: '!help', value: 'Panduan ini' },
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
      { name: '🔒 Admin Commands (Owner Only)', value: '`!admin-voice` `!admin-say` `!admin-status`\n`!admin-execute` `!admin-model` `!admin-clear`' },
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

async function handleAdminClear(message, mention) {
  if (!isOwner(message.author.id)) return message.reply('🔒 Owner only.');

  const user = message.mentions.users.first();
  if (!user) return message.reply('❗ `!admin-clear @user`');

  clearHistory(user.id);
  await message.reply(`✅ Memory untuk ${user.tag} dihapus.`);
}

// ─── Voice helper ──────────────────────────────────────────────────

async function handleVoiceReply(message, answer, replyOptions) {
  try {
    const voiceText = await condenseForVoice(answer);
    const audioBuffer = await synthesize(voiceText);
    const voiceChannel = getMemberVoiceChannel(message.member);

    if (voiceChannel) {
      // Will play after message is sent
      setTimeout(async () => {
        try {
          await playInVoiceChannel(voiceChannel, audioBuffer);
        } catch (err) {
          logger.error(`Voice play error: ${err.message}`);
        }
      }, 500);
    } else {
      const attachment = new AttachmentBuilder(audioBuffer, {
        name: 'bot-response.mp3',
      });
      replyOptions.files = [attachment];
      replyOptions.content = '🔊 *Kamu tidak di voice channel, aku kirim audionya di sini.*';
    }
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
        await guild.members.fetch();
        targetMember = guild.members.cache.find(m =>
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

  if (result.total === 3) {
    try {
      await member.timeout(10 * 60 * 1000, `Auto-timeout: 3 warnings reached`);
      replyText += '\n⏱️ **Auto-timeout 10 menit** diterapkan (3 peringatan tercapai).';
    } catch (err) {
      replyText += '\n⚠️ Gagal menerapkan auto-timeout (bot tidak memiliki permission).';
    }
  } else if (result.total >= 5) {
    try {
      await member.timeout(60 * 60 * 1000, `Auto-timeout: 5+ warnings reached`);
      replyText += '\n⏱️ **Auto-timeout 1 jam** diterapkan (5+ peringatan tercapai).';
    } catch (err) {
      replyText += '\n⚠️ Gagal menerapkan auto-timeout (bot tidak memiliki permission).';
    }
  }

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
  const msg = await message.reply('🏓 Pinging...');
  const discordPing = message.client.ws.ping;

  let googlePing = -1;
  try {
    const gStart = Date.now();
    await fetch('https://www.google.com', { method: 'HEAD' });
    googlePing = Date.now() - gStart;
  } catch (err) {
    // ignore
  }

  const embed = new EmbedBuilder()
    .setColor('#00ffcc')
    .setTitle('🏓 Pong!')
    .addFields(
      { name: '🌐 Discord Gateway Latency', value: `${discordPing}ms`, inline: true },
      { name: '🔍 Google HTTP Latency', value: googlePing !== -1 ? `${googlePing}ms` : 'Error', inline: true }
    )
    .setFooter({ text: `Total round-trip time: ${Date.now() - message.createdTimestamp}ms` })
    .setTimestamp();

  await msg.edit({ content: null, embeds: [embed] });
}

async function handleWeather(message, args) {
  const location = args.trim();
  if (!location) {
    return message.reply('⚠️ Harap masukkan lokasi yang ingin dicari. Contoh: `!weather Jakarta` atau `!cuaca Tokyo`');
  }

  const msg = await message.reply('🔍 Memeriksa cuaca...');

  const weatherData = await fetchWeather(location);
  if (!weatherData) {
    const errorEmbed = new EmbedBuilder()
      .setColor('#ff4757')
      .setTitle('❌ Lokasi Tidak Ditemukan')
      .setDescription(`Maaf, tidak bisa menemukan informasi cuaca untuk lokasi **"${location}"**.`);
    return await msg.edit({ content: null, embeds: [errorEmbed] });
  }

  const info = getWeatherCodeInfo(weatherData.current.weather_code);
  const embed = new EmbedBuilder()
    .setColor('#37b24d')
    .setTitle(`${info.emoji} Cuaca Realtime di ${weatherData.name}, ${weatherData.country}`)
    .addFields(
      { name: '🌡️ Suhu Saat Ini', value: `${weatherData.current.temperature_2m}°C (Terasa seperti ${weatherData.current.apparent_temperature}°C)`, inline: true },
      { name: '💧 Kelembapan', value: `${weatherData.current.relative_humidity_2m}%`, inline: true },
      { name: '💨 Kecepatan Angin', value: `${weatherData.current.wind_speed_10m} km/h`, inline: true },
      { name: '📊 Kondisi', value: info.label, inline: true },
      { name: '📍 Koordinat', value: `${weatherData.latitude.toFixed(4)}, ${weatherData.longitude.toFixed(4)}`, inline: true },
      { name: '🌍 Wilayah', value: weatherData.admin1 || '-', inline: true }
    )
    .setTimestamp();

  await msg.edit({ content: null, embeds: [embed] });
}

async function handleInvite(message) {
  const clientId = message.client.user.id;
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`;

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🤖 Undang Bot Ini Ke Server Kamu!')
    .setDescription('Klik tombol di bawah ini untuk mengundang bot ini ke server lain dengan hak akses Administrator dan Slash Commands.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Undang Bot (Invite Link)')
      .setStyle(ButtonStyle.Link)
      .setURL(inviteUrl)
  );

  await message.reply({ embeds: [embed], components: [row] });
}
