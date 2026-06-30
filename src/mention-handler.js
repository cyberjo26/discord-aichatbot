import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType, ChannelType, PermissionFlagsBits } from 'discord.js';
import { fetchWeather, getWeatherCodeInfo } from './utils/weather.js';
import { condenseForVoice, synthesize } from './voice/tts.js';
import { playInVoiceChannel, getMemberVoiceChannel } from './voice/player.js';
import { chatCompletion } from './ai/openrouter.js';
import { buildAgentRoutingPrompt, buildJarvisPrompt, ACTION_RESPONSE_PROMPT } from './ai/prompts.js';
import { ragPipeline } from './rag/pipeline.js';
import { scrapeUrl } from './rag/scraper.js';
import { getHistory, getContext, addMessage, buildContextInjection } from './utils/memory.js';
import { trackInteraction, buildStyleInstruction } from './utils/user-prefs.js';
import { setReminder, parseDuration, formatDuration, parseAbsoluteTime } from './utils/reminders.js';
import { isOwner } from './utils/permissions.js';
import { isBotAwake, sleep, wake } from './utils/wake-sleep.js';
import { hasPendingLearn, addExplanation, completeLearning, startPendingLearn, buildLearnedKnowledge } from './utils/learned-patterns.js';
import config from './config.js';
import logger from './utils/logger.js';
import { addWarning, getWarnings, clearWarnings } from './utils/warnings.js';
import { getSetting, setSetting, removeSetting, getAllSettings } from './utils/server-settings.js';
import { setupVoiceMaster, removeVoiceMaster, isVoiceMasterActive } from './utils/voicemaster.js';

// ─── Message Deduplication ─────────────────────────────────────────
const processedMessages = new Set();
const DEDUP_TTL_MS = 30_000; // 30 seconds

function isDuplicate(messageId) {
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), DEDUP_TTL_MS);
  return false;
}

export async function handleMention(message) {
  // Deduplicate — prevent processing same message multiple times
  if (isDuplicate(message.id)) {
    logger.warn(`⚠️ Duplikat pesan ${message.id}, skip.`);
    return;
  }

  const client = message.client;
  const botId = client.user.id;
  const rawContent = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

  if (!rawContent) {
    if (isBotAwake()) await message.reply('Hai! Ada yang bisa aku bantu? 🤖');
    return;
  }

  // Handle manual learn trigger: belajar: or ajarkan:
  const normalizedRaw = rawContent.toLowerCase();
  if (normalizedRaw.startsWith('belajar:') || normalizedRaw.startsWith('ajarkan:')) {
    const keyword = normalizedRaw.startsWith('belajar:') ? 'belajar:' : 'ajarkan:';
    const originalQuery = rawContent.slice(normalizedRaw.indexOf(keyword) + keyword.length).trim();
    if (originalQuery) {
      startPendingLearn(message.channel.id, message.author.id, originalQuery);
      await message.reply(`✍️ Sesi belajar dimulai untuk pesan: **"${originalQuery}"**\nJelasin artinya di bawah (ga perlu tag aku), lalu kirim **UPDATE**.`);
      return;
    }
  }

  // Check UPDATE trigger for self-learning
  if (rawContent.toUpperCase() === 'UPDATE') {
    return await handleUpdateLearn(message);
  }

  // If there's a pending learn session, capture explanation
  const userId = message.author.id;
  if (hasPendingLearn(message.channel.id, userId) && rawContent.toUpperCase() !== 'UPDATE') {
    addExplanation(message.channel.id, userId, rawContent);
    return; // Don't process as normal message, wait for UPDATE
  }

  // If sleeping, only owner can wake
  if (!isBotAwake()) {
    // Try to detect wake intent even while sleeping (owner only)
    if (isOwner(userId) && /\b(bangun|wake\s*up|hidup|on|start|aktif|nyala)\b/i.test(rawContent)) {
      wake();
      await message.reply('🟢 Siap bertugas kembali, Boss!');
      client.user.setActivity('🧠 Mention aku!', { type: 3 });
      client.user.setStatus('online');
      return;
    }
    return;
  }

  trackInteraction(userId, rawContent);
  await message.channel.sendTyping();

  const totalStart = Date.now();
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`📩 Pesan dari ${message.author.username}: "${rawContent}"`);

  try {
    const serverCtx = gatherServerContext(message);

    // Step 1: local fast path for safe, obvious intents; AI only for ambiguity/actions.
    logger.info(`[Step 1] 🧠 Reasoning — menganalisis pesan...`);
    const reasonStart = Date.now();
    const { prompt: learnedKnowledge, hasMatch } = await buildLearnedKnowledge(rawContent);
    const plan = (!hasMatch && fastRoute(rawContent)) || await analyzeAndPlan(rawContent, message, serverCtx, learnedKnowledge);
    const reasonMs = Date.now() - reasonStart;
    logger.info(`[Step 1] ✅ Selesai dalam ${(reasonMs / 1000).toFixed(1)}s → Action: ${plan.action} | Thought: ${plan.thought}`);

    // For simple chat/knowledge/code_help — skip executeAction entirely,
    // go straight to generating a natural response (avoids double AI call)
    if (plan.action === 'chat' || plan.action === 'knowledge' || plan.action === 'code_help') {
      logger.info(`[Step 2] 💬 Generating response (${plan.action})...`);
      const respStart = Date.now();
      const response = await generateNaturalResponse(plan, { success: true, type: plan.action }, message);
      const respMs = Date.now() - respStart;
      logger.info(`[Step 2] ✅ Response generated dalam ${(respMs / 1000).toFixed(1)}s`);

      if (response) {
        const text = response.length > 1900 ? response.slice(0, 1900) + '...' : response;
        await message.reply(text);
        // Play voice response if user is in a voice channel
        playVoiceIfInChannel(message, response).catch((err) =>
          logger.error(`Mention voice trigger error: ${err.message}`)
        );
      }
      const totalMs = Date.now() - totalStart;
      logger.success(`✅ DONE — Total waktu: ${(totalMs / 1000).toFixed(1)}s (reason: ${(reasonMs / 1000).toFixed(1)}s + response: ${(respMs / 1000).toFixed(1)}s)`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      return;
    }

    // Step 2: Send "checking..." reply, execute action, then edit with result
    const pendingReply = await message.reply('⏳ Oke, saya periksa dulu...').catch(() => null);

    logger.info(`[Step 2] ⚡ Executing action: ${plan.action}...`);
    const actionStart = Date.now();
    const result = await executeAction(plan, message, serverCtx);
    const actionMs = Date.now() - actionStart;
    logger.info(`[Step 2] ✅ Action selesai dalam ${(actionMs / 1000).toFixed(1)}s → success: ${result.success}`);

    if (result.replied) {
      // Action already sent its own reply, remove the pending message
      if (pendingReply) await pendingReply.delete().catch(() => { });
      const totalMs = Date.now() - totalStart;
      logger.success(`✅ DONE (replied by action) — Total waktu: ${(totalMs / 1000).toFixed(1)}s`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      return;
    }

    // Format the result directly — no AI call needed for action results
    const formattedReply = formatActionResult(plan, result);
    if (pendingReply) {
      await pendingReply.edit(formattedReply).catch(() => { });
    } else {
      await message.reply(formattedReply).catch(() => { });
    }

    const totalMs = Date.now() - totalStart;
    logger.success(`✅ DONE — Total waktu: ${(totalMs / 1000).toFixed(1)}s (reason: ${(reasonMs / 1000).toFixed(1)}s + action: ${(actionMs / 1000).toFixed(1)}s)`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  } catch (err) {
    const totalMs = Date.now() - totalStart;
    logger.error(`❌ Mention handler error setelah ${(totalMs / 1000).toFixed(1)}s: ${err.message}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    await message.reply('Aduh, ada yang error nih. Coba lagi ya.').catch(() => { });
  }
}

// ─── Server Context ────────────────────────────────────────────────

function gatherServerContext(message) {
  const guild = message.guild;
  if (!guild) return 'Konteks: Pesan di DM (bukan server)';

  const lines = [`Server: ${guild.name}`, `Channel: #${message.channel.name}`, `User: ${message.author.username} (${message.author.id})`];

  if (isOwner(message.author.id)) lines.push('⭐ User ini adalah OWNER bot');

  // Mentioned users
  const mentioned = message.mentions.users.filter(u => u.id !== message.client.user.id);
  if (mentioned.size > 0) {
    lines.push('Mentioned users: ' + mentioned.map(u => `${u.username} (<@${u.id}>)`).join(', '));
  }

  // Voice state
  const voiceChannels = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice);
  const voiceInfo = [];
  for (const [, ch] of voiceChannels) {
    if (ch.members.size === 0) continue;
    const members = ch.members.map((m) => {
      const s = [];
      if (m.voice.selfMute || m.voice.serverMute) s.push('muted');
      if (m.voice.selfDeaf || m.voice.serverDeaf) s.push('deaf');
      if (m.voice.streaming) s.push('streaming');
      return `${m.displayName}(<@${m.id}>) [${s.join(',') || 'normal'}]`;
    }).join(', ');
    voiceInfo.push(`VC "${ch.name}": ${members}`);
  }
  if (voiceInfo.length > 0) lines.push('Voice channels:\n' + voiceInfo.join('\n'));
  else lines.push('Voice channels: semua kosong');

  // Top roles (max 15)
  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .first(15)
    .map(r => r.name);
  if (roles.length > 0) lines.push('Roles tersedia: ' + roles.join(', '));

  // User permissions
  const perms = [];
  const mp = message.member?.permissions;
  if (mp) {
    if (mp.has(PermissionFlagsBits.MuteMembers)) perms.push('MuteMembers');
    if (mp.has(PermissionFlagsBits.DeafenMembers)) perms.push('DeafenMembers');
    if (mp.has(PermissionFlagsBits.MoveMembers)) perms.push('MoveMembers');
    if (mp.has(PermissionFlagsBits.ManageRoles)) perms.push('ManageRoles');
    if (mp.has(PermissionFlagsBits.ManageNicknames)) perms.push('ManageNicknames');
    if (mp.has(PermissionFlagsBits.ModerateMembers)) perms.push('ModerateMembers');
    if (mp.has(PermissionFlagsBits.ManageMessages)) perms.push('ManageMessages');
    if (mp.has(PermissionFlagsBits.ReadMessageHistory)) perms.push('ReadMessageHistory');
  }
  lines.push('User permissions: ' + (perms.length > 0 ? perms.join(', ') : 'basic'));

  return lines.join('\n');
}

// ─── AI Reasoning ──────────────────────────────────────────────────

async function analyzeAndPlan(rawContent, message, serverCtx, learnedKnowledgePrompt) {
  let learnedKnowledge = learnedKnowledgePrompt;
  if (!learnedKnowledge) {
    const res = await buildLearnedKnowledge(rawContent);
    learnedKnowledge = res.prompt;
  }
  const systemPrompt = buildAgentRoutingPrompt(serverCtx, learnedKnowledge);

  try {
    const response = await chatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: rawContent }],
      {
        task: 'routing',
        maxTokens: 220,
        temperature: 0,
        jsonSchema: ROUTE_SCHEMA,
      }
    );
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      thought: parsed.thought || '',
      action: parsed.action || 'chat',
      params: parsed.params || {},
      response_style: parsed.response_style || 'casual',
      rawQuery: rawContent,
    };
  } catch (err) {
    logger.warn(`AI reasoning failed: ${err.message}`);
    return { thought: 'Fallback to chat', action: 'chat', params: {}, response_style: 'casual', rawQuery: rawContent };
  }
}

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'chat', 'knowledge', 'code_help', 'voice_check', 'voice_mute',
        'voice_unmute', 'voice_deafen', 'voice_undeafen', 'voice_disconnect',
        'role_add', 'role_remove', 'timeout', 'nickname', 'ban', 'kick',
        'reminder', 'summarize', 'announce_ask', 'warn', 'warn_list',
        'warn_clear', 'pin_message', 'unpin_message', 'summarize_channel',
        'create_channel', 'delete_channel', 'setup_voicemaster', 'set_config',
        'get_config', 'bot_sleep', 'bot_wake', 'ask_clarification',
        'ping', 'weather', 'invite',
      ],
    },
    params: {
      type: 'object',
      properties: {
        target_id: { type: 'string' },
        target_name: { type: 'string' },
        duration: { type: 'string' },
        schedule: { type: 'string' },
        delivery: { type: 'string', enum: ['text', 'voice', 'both'] },
        role_name: { type: 'string' },
        new_nick: { type: 'string' },
        reason: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        to_lang: { type: 'string' },
        code_text: { type: 'string' },
        channel_id: { type: 'string' },
        message_id: { type: 'string' },
        count: { type: 'integer' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['text', 'voice'] },
        category: { type: 'string' },
        action: { type: 'string', enum: ['enable', 'disable'] },
        hub_channel_id: { type: 'string' },
        setting: { type: 'string' },
        question: { type: 'string' },
        location: { type: 'string' },
      },
    },
    response_style: { type: 'string', enum: ['casual', 'informative', 'mentor', 'playful'] },
  },
  required: ['action', 'params', 'response_style'],
};

const ACTION_HINT = /\b(mute|unmute|deafen|undeafen|disconnect|role|timeout|ban|kick|warn|pin|unpin|remind|ingatkan|ringkas|summary|summarize|announce|pengumuman|channel|voicemaster|config|setting|tidur|bangun|nickname|nick|ping|weather|cuaca|invite|undang)\b/i;
const CODE_HINT = /```|\b(kode|coding|javascript|typescript|node\.?js|python|java|php|golang|rust|html|css|sql|bug|stack trace)\b/i;
const KNOWLEDGE_HINT = /^(apa|apakah|siapa|kenapa|mengapa|bagaimana|jelaskan|terangkan|what|who|why|how|explain)\b/i;
const CHAT_HINT = /^(hai|halo|hello|hi|hey|pagi|siang|sore|malam|makasih|terima kasih|thanks|thank you)[!. ]*$/i;

function fastRoute(rawContent) {
  const text = rawContent.trim();
  if (!text) return null;

  // Local fast paths for utility commands
  if (/^ping[!. ]*$/i.test(text)) {
    return { thought: 'local fast path', action: 'ping', params: {}, response_style: 'casual', rawQuery: rawContent };
  }
  if (/^(invite|link invite|undang bot|link undang|bot invite|invite link)[!. ]*$/i.test(text)) {
    return { thought: 'local fast path', action: 'invite', params: {}, response_style: 'casual', rawQuery: rawContent };
  }
  const weatherMatch = text.match(/^(cuaca|weather)\s+(?:di\s+|in\s+)?(.+)/i);
  if (weatherMatch) {
    return { thought: 'local fast path', action: 'weather', params: { location: weatherMatch[2] }, response_style: 'informative', rawQuery: rawContent };
  }

  if (ACTION_HINT.test(text)) return null;

  if (CHAT_HINT.test(text)) {
    return { thought: 'local fast path', action: 'chat', params: {}, response_style: 'casual', rawQuery: rawContent };
  }
  if (CODE_HINT.test(text)) {
    return { thought: 'local fast path', action: 'code_help', params: {}, response_style: 'mentor', rawQuery: rawContent };
  }
  if (KNOWLEDGE_HINT.test(text) || text.endsWith('?')) {
    return { thought: 'local fast path', action: 'knowledge', params: {}, response_style: 'informative', rawQuery: rawContent };
  }
  return null;
}

// ─── Action Executor ───────────────────────────────────────────────

async function executeAction(plan, message, serverCtx) {
  const { action, params } = plan;
  const guild = message.guild;

  switch (action) {
    case 'chat': return { success: true, type: 'chat' };
    case 'knowledge': return { success: true, type: 'knowledge' };

    // New utility handlers
    case 'ping': return await execPing(message);
    case 'weather': return await execWeather(message, params);
    case 'invite': return await execInvite(message);

    case 'voice_check': return await execVoiceCheck(message);
    case 'voice_mute': return await execVoiceMod(message, params, 'mute');
    case 'voice_unmute': return await execVoiceMod(message, params, 'unmute');
    case 'voice_deafen': return await execVoiceMod(message, params, 'deafen');
    case 'voice_undeafen': return await execVoiceMod(message, params, 'undeafen');
    case 'voice_disconnect': return await execVoiceMod(message, params, 'disconnect');
    case 'role_add': return await execRole(message, params, 'add');
    case 'role_remove': return await execRole(message, params, 'remove');
    case 'timeout': return await execTimeout(message, params);
    case 'nickname': return await execNickname(message, params);
    case 'ban': return await execBanKick(message, params, 'ban');
    case 'kick': return await execBanKick(message, params, 'kick');
    case 'reminder': return await execReminder(message, params);
    case 'summarize': return await execSummarize(message, params, plan);
    case 'code_help': return { success: true, type: 'code_help' };
    case 'announce_ask': return await execAnnounceAsk(message, params, plan);
    case 'warn': return await execWarn(message, params);
    case 'warn_list': return await execWarnList(message, params);
    case 'warn_clear': return await execWarnClear(message, params);
    case 'pin_message': return await execPinMessage(message, params);
    case 'unpin_message': return await execUnpinMessage(message, params);
    case 'summarize_channel': return await execSummarizeChannel(message, params, plan);
    case 'create_channel': return await execCreateChannel(message, params);
    case 'delete_channel': return await execDeleteChannel(message, params);
    case 'setup_voicemaster': return await execSetupVoiceMaster(message, params);
    case 'set_config': return await execSetConfig(message, params);
    case 'get_config': return await execGetConfig(message);

    case 'bot_sleep':
      if (!isOwner(message.author.id)) return { success: false, error: 'Hanya owner yang bisa' };
      sleep();
      message.client.user.setActivity('💤 Sleeping...', { type: 0 });
      message.client.user.setStatus('idle');
      return { success: true, type: 'bot_sleep' };

    case 'bot_wake':
      if (!isOwner(message.author.id)) return { success: false, error: 'Hanya owner yang bisa' };
      wake();
      message.client.user.setActivity('🧠 Mention aku!', { type: 3 });
      message.client.user.setStatus('online');
      return { success: true, type: 'bot_wake' };

    case 'ask_clarification':
      startPendingLearn(message.channel.id, message.author.id, plan.rawQuery);
      const q = params.question || 'Hmm, bisa jelasin lebih detail? Gue belum paham maksudnya.';
      await message.reply(q + '\n\n💡 *Jelasin aja langsung (ga perlu tag aku), lalu kirim* **UPDATE** *biar gue belajar.*');
      return { success: true, type: 'clarification', replied: true };

    default: return { success: true, type: 'chat' };
  }
}

async function execPing(message) {
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
  return { success: true, type: 'ping', replied: true };
}

async function execWeather(message, params) {
  const location = params.location || 'Jakarta';
  const msg = await message.reply('🔍 Memeriksa cuaca...');

  const weatherData = await fetchWeather(location);
  if (!weatherData) {
    const errorEmbed = new EmbedBuilder()
      .setColor('#ff4757')
      .setTitle('❌ Lokasi Tidak Ditemukan')
      .setDescription(`Maaf, tidak bisa menemukan informasi cuaca untuk lokasi **"${location}"**.`);
    await msg.edit({ content: null, embeds: [errorEmbed] });
    return { success: true, type: 'weather', replied: true };
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
  return { success: true, type: 'weather', replied: true };
}

async function execInvite(message) {
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
  return { success: true, type: 'invite', replied: true };
}

// ─── Voice Check ───────────────────────────────────────────────────

async function execVoiceCheck(message) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const voiceChannels = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice);
  const data = [];
  for (const [, ch] of voiceChannels) {
    if (ch.members.size === 0) continue;
    const members = [];
    for (const [, m] of ch.members) {
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

async function execVoiceMod(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const permMap = { mute: PermissionFlagsBits.MuteMembers, unmute: PermissionFlagsBits.MuteMembers, deafen: PermissionFlagsBits.DeafenMembers, undeafen: PermissionFlagsBits.DeafenMembers, disconnect: PermissionFlagsBits.MoveMembers };
  if (!isOwner(message.author.id) && !message.member.permissions.has(permMap[action])) {
    return { success: false, error: 'Tidak punya permission untuk voice moderation' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target user tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada di server' };
  if (!member.voice.channel) return { success: false, error: `${member.displayName} tidak di voice channel` };

  try {
    const name = member.displayName;
    if (action === 'mute') { await member.voice.setMute(true); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'unmute') { await member.voice.setMute(false); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'deafen') { await member.voice.setDeaf(true); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'undeafen') { await member.voice.setDeaf(false); return { success: true, type: 'voice_mod', action, targetName: name }; }
    if (action === 'disconnect') { await member.voice.disconnect(); return { success: true, type: 'voice_mod', action, targetName: name }; }
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Role Management ───────────────────────────────────────────────

async function execRole(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { success: false, error: 'Tidak punya permission ManageRoles' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada di server' };

  const roleName = params.role_name;
  if (!roleName) return { success: false, error: 'Nama role tidak disebutkan' };

  const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) return { success: false, error: `Role "${roleName}" tidak ada` };

  const botMember = await guild.members.fetchMe();
  if (role.position >= botMember.roles.highest.position) return { success: false, error: `Role ${role.name} terlalu tinggi` };

  try {
    if (action === 'add') { await member.roles.add(role); } else { await member.roles.remove(role); }
    return { success: true, type: 'role', action, targetName: member.displayName, roleName: role.name };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── Shared: Resolve target member (by ID or nickname) ─────────────

async function resolveTargetMember(message, params) {
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

  // Search members by displayName or username
  await guild.members.fetch(); // Ensure cache is populated
  const matches = guild.members.cache.filter(m =>
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

// ─── Timeout ───────────────────────────────────────────────────────

async function execTimeout(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers' };
  }

  // Resolve target (supports nickname search)
  const resolved = await resolveTargetMember(message, params);
  if (resolved.cancelled) return { success: true, type: 'cancelled', replied: true };
  if (resolved.error) return { success: false, error: resolved.error };
  const member = resolved.member;

  // If duration is missing or empty, ask the user
  let dur = 0;
  if (!params.duration || params.duration.trim() === '') {
    const askReply = await message.reply(
      `⏱️ Mau timeout **${member.displayName}** berapa lama?\n` +
      `Contoh: "5 menit", "1 jam", "30 detik"\n\n` +
      `_Reply dalam 1 menit, atau perintah dibatalkan._`
    );

    try {
      const collected = await message.channel.awaitMessages({
        filter: (m) => m.author.id === message.author.id,
        max: 1,
        time: 60_000,
        errors: ['time'],
      });

      const response = collected.first();
      dur = parseDuration(response.content.trim());
      await askReply.delete().catch(() => {});
    } catch {
      await askReply.edit('⏰ Waktu habis (1 menit). Timeout dibatalkan.').catch(() => {});
      return { success: true, type: 'cancelled', replied: true };
    }
  } else {
    dur = parseDuration(params.duration);
  }

  if (dur <= 0 || dur > 28 * 24 * 60 * 60 * 1000) return { success: false, error: 'Durasi tidak valid' };

  try {
    await member.timeout(dur);
    return { success: true, type: 'timeout', targetName: member.displayName, duration: formatDuration(dur) };
  } catch (err) {
    if (err.code === 50013) {
      return { success: false, error: `Tidak bisa timeout ${member.displayName}. Role bot harus lebih tinggi.` };
    }
    return { success: false, error: err.message };
  }
}

// ─── Ban / Kick ────────────────────────────────────────────────────

async function execBanKick(message, params, action) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const permNeeded = action === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
  if (!isOwner(message.author.id) && !message.member.permissions.has(permNeeded)) {
    return { success: false, error: `Tidak punya permission ${action === 'ban' ? 'BanMembers' : 'KickMembers'}` };
  }

  // Resolve target (supports nickname search with interactive disambiguation)
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
    if (action === 'ban') {
      await member.ban({ reason });
    } else {
      await member.kick(reason);
    }
    return {
      success: true,
      type: action,
      targetName: member.displayName,
      reason,
    };
  } catch (err) {
    if (err.code === 50013) {
      return { success: false, error: `Bot tidak punya permission untuk ${action} ${member.displayName}.` };
    }
    return { success: false, error: err.message };
  }
}

// ─── Nickname ──────────────────────────────────────────────────────

async function execNickname(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return { success: false, error: 'Tidak punya permission ManageNicknames' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target tidak ditemukan' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada' };

  // Check if target is server owner — nobody can change owner's nick via bot
  if (member.id === guild.ownerId) {
    return { success: false, error: `${member.displayName} adalah pemilik server, nickname-nya tidak bisa diubah oleh bot.` };
  }

  // Check bot role hierarchy — bot's highest role must be above target's highest role
  const botMember = await guild.members.fetchMe();
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: `Role ${member.displayName} sama atau lebih tinggi dari role bot. Bot tidak bisa mengubah nickname-nya.` };
  }

  const nick = params.new_nick;
  if (!nick) return { success: false, error: 'Nickname baru tidak disebutkan' };

  try {
    const old = member.displayName;
    await member.setNickname(nick);
    return { success: true, type: 'nickname', oldName: old, newName: nick };
  } catch (err) {
    // Provide a human-readable error
    if (err.code === 50013) {
      return { success: false, error: `Bot tidak punya permission untuk mengubah nickname ${member.displayName}. Pastikan role bot lebih tinggi.` };
    }
    return { success: false, error: err.message };
  }
}

// ─── Reminder ──────────────────────────────────────────────────────

async function execReminder(message, params) {
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
  const result = setReminder({
    guildId,
    userId: targetId,
    fallbackChannelId: message.channel.id,
    text,
    delivery,
    triggerAt
  });

  return { success: true, type: 'reminder', text, duration: durationText, delivery };
}

// ─── Summarize ─────────────────────────────────────────────────────

async function execSummarize(message, params, plan) {
  const url = params.url;
  const text = params.text || plan.rawQuery;

  await message.channel.sendTyping();

  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    try {
      const content = await scrapeUrl(url);
      if (!content) return { success: false, error: 'Gagal ambil konten dari URL' };
      const summary = await chatCompletion([
        { role: 'system', content: 'Ringkas konten berikut dalam 3-5 poin utama. Plain text, bullet points.' },
        { role: 'user', content: `Ringkas:\n\n${content.slice(0, 6000)}` },
      ]);
      await message.reply(`📋 **Ringkasan:**\n\n${summary.slice(0, 1900)}`);
      return { success: true, type: 'summarize', replied: true };
    } catch (err) { return { success: false, error: err.message }; }
  }

  if (text) {
    try {
      const summary = await chatCompletion([
        { role: 'system', content: 'Ringkas teks berikut secara singkat dan jelas. Plain text.' },
        { role: 'user', content: `Ringkas:\n\n${text.slice(0, 6000)}` },
      ]);
      await message.reply(`📋 **Ringkasan:**\n\n${summary.slice(0, 1900)}`);
      return { success: true, type: 'summarize', replied: true };
    } catch (err) { return { success: false, error: err.message }; }
  }

  return { success: false, error: 'Tidak ada teks/URL untuk diringkas' };
}

// ─── Pin Message ───────────────────────────────────────────────────

async function execPinMessage(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  // Check bot permissions
  const botPerms = message.channel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Bot tidak punya permission ManageMessages di channel ini. Perlu permission tersebut untuk pin pesan.' };
  }

  // Check user permissions
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return { success: false, error: 'Kamu tidak punya permission ManageMessages untuk pin pesan.' };
  }

  let targetMessage = null;
  const msgId = params.message_id;

  // Priority 1: If the user's message is a reply to another message, pin that
  if (message.reference && message.reference.messageId) {
    try {
      targetMessage = await message.channel.messages.fetch(message.reference.messageId);
    } catch {
      return { success: false, error: 'Gagal mengambil pesan yang di-reply.' };
    }
  }
  // Priority 2: If a specific message ID is given
  else if (msgId && msgId !== 'latest' && msgId !== 'reply' && /^\d+$/.test(msgId)) {
    try {
      targetMessage = await message.channel.messages.fetch(msgId);
    } catch {
      return { success: false, error: `Pesan dengan ID ${msgId} tidak ditemukan di channel ini.` };
    }
  }
  // Priority 3: Get the latest non-bot message before the command
  else {
    try {
      const messages = await message.channel.messages.fetch({ limit: 5, before: message.id });
      targetMessage = messages.filter(m => !m.author.bot).first();
      if (!targetMessage) {
        targetMessage = messages.first();
      }
    } catch {
      return { success: false, error: 'Gagal mengambil pesan terakhir.' };
    }
  }

  if (!targetMessage) return { success: false, error: 'Tidak ada pesan yang bisa di-pin.' };

  try {
    if (targetMessage.pinned) {
      return { success: false, error: 'Pesan tersebut sudah di-pin sebelumnya.' };
    }
    await targetMessage.pin();
    return {
      success: true,
      type: 'pin_message',
      replied: true,
      messagePreview: targetMessage.content?.slice(0, 80) || '(embed/attachment)',
      author: targetMessage.author.username,
    };
  } catch (err) {
    if (err.code === 50013) {
      return { success: false, error: 'Bot tidak punya permission untuk pin pesan di channel ini.' };
    }
    return { success: false, error: err.message };
  }
}

// ─── Unpin Message ─────────────────────────────────────────────────

async function execUnpinMessage(message, params) {
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

  // If replying to a message, unpin that
  if (message.reference && message.reference.messageId) {
    try {
      targetMessage = await message.channel.messages.fetch(message.reference.messageId);
    } catch {
      return { success: false, error: 'Gagal mengambil pesan yang di-reply.' };
    }
  }
  // If specific ID given
  else if (msgId && /^\d+$/.test(msgId)) {
    try {
      targetMessage = await message.channel.messages.fetch(msgId);
    } catch {
      return { success: false, error: `Pesan dengan ID ${msgId} tidak ditemukan.` };
    }
  }
  // Otherwise unpin the most recently pinned message
  else {
    try {
      const pinned = await message.channel.messages.fetchPinned();
      targetMessage = pinned.first();
    } catch {
      return { success: false, error: 'Gagal mengambil daftar pinned messages.' };
    }
  }

  if (!targetMessage) return { success: false, error: 'Tidak ada pesan yang bisa di-unpin.' };

  try {
    if (!targetMessage.pinned) {
      return { success: false, error: 'Pesan tersebut tidak sedang di-pin.' };
    }
    await targetMessage.unpin();
    return {
      success: true,
      type: 'unpin_message',
      messagePreview: targetMessage.content?.slice(0, 80) || '(embed/attachment)',
      author: targetMessage.author.username,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Summarize Channel ─────────────────────────────────────────────

async function execSummarizeChannel(message, params, plan) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  // Check if bot can read message history
  const botPerms = message.channel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
    return { success: false, error: 'Bot tidak punya permission ReadMessageHistory di channel ini. Aktifkan permission tersebut agar bot bisa membaca riwayat pesan.' };
  }

  const count = Math.min(Math.max(params.count || 50, 10), 100);

  await message.channel.sendTyping();

  try {
    const messages = await message.channel.messages.fetch({ limit: count, before: message.id });
    if (messages.size === 0) {
      return { success: false, error: 'Tidak ada pesan yang bisa diringkas.' };
    }

    // Build conversation text from messages (oldest first)
    const sorted = [...messages.values()].reverse();
    const conversationLines = sorted
      .filter(m => !m.author.bot && m.content?.trim())
      .map(m => {
        const time = m.createdAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${m.author.username}: ${m.content.slice(0, 300)}`;
      });

    if (conversationLines.length === 0) {
      return { success: false, error: 'Tidak ada pesan teks dari user yang bisa diringkas.' };
    }

    const conversationText = conversationLines.join('\n');

    const summary = await chatCompletion([
      {
        role: 'system',
        content: `Ringkas percakapan Discord berikut menjadi poin-poin utama yang mudah dipahami.
ATURAN:
- Buat ringkasan dalam 3-7 poin utama
- Sebutkan topik yang dibahas dan siapa yang membahasnya
- Gunakan bahasa Indonesia
- Gunakan bullet points
- Fokus pada informasi penting, keputusan, dan diskusi kunci
- Jika ada kesimpulan atau keputusan, highlight itu`
      },
      { role: 'user', content: `Ringkas percakapan berikut (${conversationLines.length} pesan):\n\n${conversationText.slice(0, 6000)}` },
    ]);

    await message.reply(`📋 **Ringkasan ${conversationLines.length} pesan terakhir di #${message.channel.name}:**\n\n${summary.slice(0, 1900)}`);
    return { success: true, type: 'summarize_channel', replied: true };
  } catch (err) {
    logger.error(`Summarize channel error: ${err.message}`);
    return { success: false, error: `Gagal membaca riwayat pesan: ${err.message}` };
  }
}

// ─── Announcement ──────────────────────────────────────────────────

async function execAnnounceAsk(message, params, plan) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return { success: false, error: 'Kamu tidak punya permission untuk membuat announcement.' };
  }

  const announcementText = params.text || plan.rawQuery;
  if (!announcementText) return { success: false, error: 'Isi announcement kosong.' };

  // Build tag selection menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`jarvis_announce_tag_${message.id}`)
    .setPlaceholder('Pilih tag untuk announcement...')
    .addOptions([
      { label: 'Tanpa Tag', description: 'Kirim tanpa mention siapapun', value: 'none', emoji: '📝' },
      { label: '@everyone', description: 'Tag semua orang di server', value: 'everyone', emoji: '📢' },
      { label: '@here', description: 'Tag yang sedang online saja', value: 'here', emoji: '🟢' },
    ]);

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const cancelBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`jarvis_announce_cancel_${message.id}`)
      .setLabel('❌ Batal')
      .setStyle(ButtonStyle.Danger)
  );

  const preview = `📢 **Preview Announcement:**\n\n${announcementText}\n\n*Pilih tag di bawah, atau batal:*`;
  const reply = await message.reply({ content: preview, components: [row, cancelBtn] });

  try {
    const interaction = await reply.awaitMessageComponent({
      filter: (i) => i.user.id === message.author.id,
      time: 60_000,
    });

    if (interaction.customId.startsWith('jarvis_announce_cancel')) {
      await interaction.update({ content: '❌ Announcement dibatalkan.', components: [] });
      return { success: true, type: 'announce_cancelled', replied: true };
    }

    await interaction.deferUpdate();
    const tagChoice = interaction.values[0];

    // Determine target channel: params > server-settings > config (.env) > current channel
    let targetChannel = null;
    if (params.channel_id) {
      targetChannel = guild.channels.cache.get(params.channel_id);
    }
    if (!targetChannel) {
      const settingsAnnounce = getSetting(guild.id, 'announceChannelId');
      if (settingsAnnounce) targetChannel = guild.channels.cache.get(settingsAnnounce);
    }
    if (!targetChannel && config.announceChannelId) {
      targetChannel = guild.channels.cache.get(config.announceChannelId);
    }
    if (!targetChannel) {
      targetChannel = message.channel;
    }

    // Build announcement message
    let prefix = '';
    if (tagChoice === 'everyone') prefix = '@everyone\n\n';
    else if (tagChoice === 'here') prefix = '@here\n\n';

    const finalMsg = `${prefix}📢 **ANNOUNCEMENT**\n\n${announcementText}`;

    await targetChannel.send({
      content: finalMsg,
      allowedMentions: { parse: tagChoice === 'none' ? [] : ['everyone'] }
    });

    const tagLabel = tagChoice === 'none' ? 'tanpa tag' : `@${tagChoice}`;
    await reply.edit({ content: `✅ Announcement terkirim ke <#${targetChannel.id}> (${tagLabel})!`, components: [] });
    return { success: true, type: 'announcement', replied: true };
  } catch {
    try { await reply.edit({ content: '⏰ Waktu habis, announcement dibatalkan.', components: [] }); } catch { }
    return { success: true, type: 'announce_timeout', replied: true };
  }
}

// ─── Warn System ───────────────────────────────────────────────────

async function execWarn(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers untuk warn.' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target user tidak ditemukan.' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { success: false, error: 'User tidak ada di server.' };

  const reason = params.reason || 'Tidak disebutkan';
  const result = addWarning(guild.id, targetId, reason, message.author.id);

  // Auto-action at thresholds
  let extraAction = '';
  if (result.total === 3) {
    try {
      await member.timeout(10 * 60 * 1000, `Auto-timeout: ${result.total} warnings`);
      extraAction = '\n⏱️ **Auto-timeout 10 menit** (3 peringatan tercapai)';
    } catch { extraAction = '\n⚠️ Gagal auto-timeout (permission?)'; }
  } else if (result.total >= 5) {
    try {
      await member.timeout(60 * 60 * 1000, `Auto-timeout: ${result.total} warnings`);
      extraAction = '\n⏱️ **Auto-timeout 1 jam** (5+ peringatan tercapai)';
    } catch { extraAction = '\n⚠️ Gagal auto-timeout (permission?)'; }
  }

  return {
    success: true,
    type: 'warn',
    targetName: member.displayName,
    targetId,
    reason,
    totalWarnings: result.total,
    extraAction,
  };
}

async function execWarnList(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target user tidak ditemukan.' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  const warnings = getWarnings(guild.id, targetId);

  return {
    success: true,
    type: 'warn_list',
    targetName: member?.displayName || `User ${targetId}`,
    warnings,
  };
}

async function execWarnClear(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return { success: false, error: 'Tidak punya permission ModerateMembers.' };
  }

  const targetId = extractUserId(params.target_id);
  if (!targetId) return { success: false, error: 'Target user tidak ditemukan.' };

  const member = await guild.members.fetch(targetId).catch(() => null);
  const count = clearWarnings(guild.id, targetId);

  return {
    success: true,
    type: 'warn_clear',
    targetName: member?.displayName || `User ${targetId}`,
    clearedCount: count,
  };
}

// ─── Create Channel ────────────────────────────────────────────────

async function execCreateChannel(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  // Check permissions
  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Kamu tidak punya permission ManageChannels.' };
  }

  const botPerms = guild.members.me.permissions;
  if (!botPerms.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Bot tidak punya permission ManageChannels.' };
  }

  const channelName = params.name;
  if (!channelName) return { success: false, error: 'Nama channel tidak disebutkan.' };

  // Determine channel type
  const typeStr = (params.type || 'text').toLowerCase();
  let channelType;
  if (typeStr === 'voice' || typeStr === 'vc') {
    channelType = ChannelType.GuildVoice;
  } else {
    channelType = ChannelType.GuildText;
  }

  // Find category if specified
  let parent = null;
  if (params.category) {
    parent = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildCategory &&
        ch.name.toLowerCase().includes(params.category.toLowerCase())
    );
  }

  try {
    const newChannel = await guild.channels.create({
      name: channelName,
      type: channelType,
      parent: parent?.id || null,
    });

    return {
      success: true,
      type: 'create_channel',
      channelName: newChannel.name,
      channelId: newChannel.id,
      channelType: channelType === ChannelType.GuildVoice ? 'voice' : 'text',
      category: parent?.name || null,
    };
  } catch (err) {
    return { success: false, error: `Gagal membuat channel: ${err.message}` };
  }
}

// ─── Delete Channel ────────────────────────────────────────────────

async function execDeleteChannel(message, params) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'Kamu tidak punya permission ManageChannels.' };
  }

  let targetChannel = null;

  // Find by ID
  if (params.channel_id) {
    const chId = params.channel_id.replace(/[<#>]/g, '');
    targetChannel = guild.channels.cache.get(chId);
  }

  // Find by name
  if (!targetChannel && params.channel_name) {
    targetChannel = guild.channels.cache.find(
      ch => ch.name.toLowerCase() === params.channel_name.toLowerCase().replace(/\s+/g, '-')
    );
  }

  if (!targetChannel) return { success: false, error: 'Channel tidak ditemukan.' };

  // Safety: don't delete the channel the command was sent in
  if (targetChannel.id === message.channel.id) {
    return { success: false, error: 'Tidak bisa menghapus channel tempat perintah ini dikirim.' };
  }

  const channelName = targetChannel.name;

  try {
    await targetChannel.delete(`Dihapus oleh ${message.author.username} via bot`);
    return {
      success: true,
      type: 'delete_channel',
      channelName,
    };
  } catch (err) {
    return { success: false, error: `Gagal menghapus channel: ${err.message}` };
  }
}

// ─── Setup VoiceMaster ─────────────────────────────────────────────

async function execSetupVoiceMaster(message, params) {
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

// ─── Set Config ────────────────────────────────────────────────────

async function execSetConfig(message, params) {
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

async function execGetConfig(message) {
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

// ─── Direct Action Result Formatter (no AI call) ───────────────────

function formatActionResult(plan, result) {
  if (!result.success) {
    return `⚠️ Gagal: ${result.error || 'Terjadi kesalahan.'}`;
  }

  switch (result.type) {
    case 'voice_check': {
      if (!result.data || result.data.length === 0) {
        return '🔇 Semua voice channel sedang kosong, ga ada yang online sekarang.';
      }
      let msg = '🔊 **Voice Channel Aktif:**\n';
      for (const ch of result.data) {
        msg += `\n**#${ch.channel}** — ${ch.members.length} orang:\n`;
        for (const m of ch.members) {
          const statusIcons = m.status.map(s => {
            if (s === 'muted') return '🔇';
            if (s === 'deaf') return '🔕';
            if (s === 'streaming') return '🎥';
            if (s === 'camera') return '📷';
            return '';
          }).join('');
          msg += `• ${m.name} ${statusIcons || '🟢'}\n`;
        }
      }
      return msg.trim();
    }

    case 'voice_mod': {
      const actionText = {
        mute: `🔇 **${result.targetName}** sudah di-mute.`,
        unmute: `🔈 **${result.targetName}** sudah di-unmute.`,
        deafen: `🔕 **${result.targetName}** sudah di-deafen.`,
        undeafen: `🔊 **${result.targetName}** sudah di-undeafen.`,
        disconnect: `🚪 **${result.targetName}** sudah dikeluarkan dari voice.`,
      };
      return actionText[result.action] || `✅ Aksi ${result.action} berhasil untuk ${result.targetName}.`;
    }

    case 'role': {
      if (result.action === 'add') {
        return `🏷️ Role **${result.roleName}** sudah ditambahkan ke **${result.targetName}**.`;
      }
      return `🏷️ Role **${result.roleName}** sudah dihapus dari **${result.targetName}**.`;
    }

    case 'timeout':
      return `⏱️ **${result.targetName}** sudah di-timeout selama **${result.duration}**.`;

    case 'nickname':
      return `✏️ Nickname **${result.oldName}** sudah diganti jadi **${result.newName}**.`;

    case 'reminder': {
      const modeText = result.delivery === 'voice' ? ' lewat suara di voice channel' : (result.delivery === 'both' ? ' lewat chat dan suara' : ' lewat chat');
      return `⏰ Oke, aku ingetin kamu **${result.duration}**${modeText}: "${result.text}"`;
    }

    case 'bot_sleep':
      return '😴 Oke, aku tidur dulu. Nanti mention lagi kalau butuh ya!';

    case 'bot_wake':
      return '🟢 Siap bertugas kembali!';

    case 'warn': {
      let msg = `⚠️ **${result.targetName}** telah diberi peringatan!\n`;
      msg += `📝 Alasan: ${result.reason}\n`;
      msg += `📊 Total peringatan: **${result.totalWarnings}x**`;
      if (result.extraAction) msg += result.extraAction;
      return msg;
    }

    case 'warn_list': {
      if (!result.warnings || result.warnings.length === 0) {
        return `✅ **${result.targetName}** tidak punya peringatan. Anak baik! 👍`;
      }
      let msg = `📋 **Peringatan untuk ${result.targetName}** (${result.warnings.length}x):\n\n`;
      result.warnings.forEach((w, i) => {
        const date = new Date(w.timestamp).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        msg += `${i + 1}. ${w.reason} — *${date}*\n`;
      });
      return msg.trim();
    }

    case 'warn_clear':
      if (result.clearedCount === 0) {
        return `ℹ️ **${result.targetName}** memang tidak punya peringatan.`;
      }
      return `🗑️ **${result.clearedCount}** peringatan untuk **${result.targetName}** sudah dihapus.`;

    case 'ban':
      return `🔨 **${result.targetName}** sudah di-ban dari server.\n📝 Alasan: ${result.reason}`;

    case 'kick':
      return `👢 **${result.targetName}** sudah di-kick dari server.\n📝 Alasan: ${result.reason}`;

    case 'pin_message':
      return `📌 Pesan dari **${result.author}** berhasil di-pin: "${result.messagePreview}"`;

    case 'unpin_message':
      return `📌 Pesan dari **${result.author}** sudah di-unpin.`;

    case 'create_channel': {
      const typeEmoji = result.channelType === 'voice' ? '🔊' : '💬';
      let msg = `${typeEmoji} Channel **${result.channelName}** (<#${result.channelId}>) berhasil dibuat!`;
      if (result.category) msg += `\n📁 Di kategori: **${result.category}**`;
      return msg;
    }

    case 'delete_channel':
      return `🗑️ Channel **${result.channelName}** sudah dihapus.`;

    case 'voicemaster_enabled': {
      let msg = `🔊 **VoiceMaster aktif!**\n`;
      msg += `📍 Hub channel: <#${result.hubChannelId}>`;
      if (result.created) msg += ' _(baru dibuat)_';
      msg += '\n\n💡 User yang join hub akan otomatis dibuatkan voice channel. Channel akan dihapus otomatis saat kosong.';
      return msg;
    }

    case 'voicemaster_disabled':
      return '🔇 **VoiceMaster dinonaktifkan.** Auto voice channel tidak aktif lagi.';

    case 'set_config': {
      if (result.action === 'removed') {
        return `⚙️ Setting **${result.setting}** sudah dihapus (kembali ke default).`;
      }
      return `⚙️ Setting **${result.setting}** sudah diatur ke <#${result.channelId}> (**${result.channelName}**).`;
    }

    case 'cancelled':
      return ''; // Already handled by the interactive flow

    default:
      return '✅ Selesai!';
  }
}

// ─── Natural Response Generator ────────────────────────────────────

async function generateNaturalResponse(plan, result, message) {
  const userId = message.author.id;
  const rawQuery = plan.rawQuery;

  // For chat/knowledge/code — use full Jarvis prompt
  if (plan.action === 'chat' || plan.action === 'knowledge' || plan.action === 'code_help') {
    const ctx = getContext(userId);
    const systemPrompt = buildJarvisPrompt({
      contextInjection: buildContextInjection(userId),
      styleInstruction: buildStyleInstruction(userId),
      userTopics: ctx.topics,
      responseStyle: plan.response_style,
    });

    const history = getHistory(userId);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6),
      { role: 'user', content: rawQuery },
    ];

    const answer = await chatCompletion(messages);
    addMessage(userId, 'user', rawQuery);
    addMessage(userId, 'assistant', answer);

    // For knowledge questions, add article button
    if (plan.action === 'knowledge') {
      return await sendWithArticleButton(message, answer, rawQuery, userId);
    }

    return answer;
  }

  // For action results — generate natural response
  const actionDesc = JSON.stringify({ action: plan.action, result, thought: plan.thought });
  const response = await chatCompletion([
    { role: 'system', content: ACTION_RESPONSE_PROMPT },
    { role: 'user', content: `Aksi: ${actionDesc}\nPesan awal user: "${rawQuery}"` },
  ], { maxTokens: 200 });

  addMessage(userId, 'user', rawQuery);
  addMessage(userId, 'assistant', response);
  return response;
}

// ─── Article Button (for knowledge questions) ──────────────────────

async function sendWithArticleButton(message, answer, query, userId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`jarvis_article_${message.id}`)
      .setLabel('📚 Cari Artikel Resmi')
      .setStyle(ButtonStyle.Secondary)
  );

  const text = answer.length > 1900 ? answer.slice(0, 1900) + '...' : answer;
  const reply = await message.reply({ content: text, components: [row] });

  try {
    const btn = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.customId === `jarvis_article_${message.id}` && i.user.id === userId,
      time: 60_000,
    });
    await btn.deferUpdate();
    await reply.edit({ content: text + '\n\n⏳ *Nyari artikel...*', components: [] });

    const { answer: ragAnswer, sources } = await ragPipeline(query);
    let articleText = text + '\n\n';
    if (sources.length > 0) {
      articleText += '📚 **Sumber Artikel:**\n';
      sources.forEach((s, i) => { articleText += `${i + 1}. [${s.title}](${s.url})\n`; });
      if (ragAnswer && ragAnswer !== answer) articleText += `\n📝 **Info tambahan:**\n${ragAnswer.slice(0, 800)}`;
    } else {
      articleText += '❌ Ga nemu artikel resmi buat topik ini.';
    }
    await reply.edit({ content: articleText.length > 1950 ? articleText.slice(0, 1950) + '...' : articleText, components: [] });
  } catch {
    try { await reply.edit({ components: [] }); } catch { }
  }

  return null; // Already replied
}

// ─── UPDATE Learning Handler ───────────────────────────────────────

async function handleUpdateLearn(message) {
  const userId = message.author.id;
  const channelId = message.channel.id;

  if (!hasPendingLearn(channelId, userId)) {
    await message.reply('Hmm, ga ada yang perlu di-update. Kalau aku ga paham sesuatu, jelasin dulu baru bilang UPDATE ya.');
    return;
  }

  await message.channel.sendTyping();
  const pattern = await completeLearning(channelId, userId);

  if (pattern) {
    await message.reply(`✅ Oke, gue udah belajar!\n\n🧠 **"${pattern.trigger}"** → ${pattern.meaning}\n\nSekarang kalau kamu bilang hal serupa, gue udah paham. Thanks udah ngajarin! 🙏`);
  } else {
    await message.reply('Hmm, gagal belajar. Coba ulangi lagi ya — jelasin dulu, baru UPDATE.');
  }
}

// ─── Utility ───────────────────────────────────────────────────────

function extractUserId(str) {
  if (!str) return null;
  const match = str.match(/<@!?(\d+)>/);
  if (match) return match[1];
  if (/^\d+$/.test(str)) return str;
  return null;
}

async function playVoiceIfInChannel(message, text) {
  const voiceChannel = getMemberVoiceChannel(message.member);
  if (voiceChannel) {
    try {
      const voiceText = await condenseForVoice(text);
      const audioBuffer = await synthesize(voiceText);
      await playInVoiceChannel(voiceChannel, audioBuffer);
    } catch (voiceErr) {
      logger.error(`Mention Voice playback error: ${voiceErr.message}`);
    }
  }
}

export default { handleMention };
