import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ChannelType, PermissionFlagsBits } from 'discord.js';

import { chatCompletion } from './ai/openrouter.js';
import { buildAgentRoutingPrompt, buildJarvisPrompt, ACTION_RESPONSE_PROMPT } from './ai/prompts.js';
import { ragPipeline } from './rag/pipeline.js';
import { getHistory, getContext, addMessage, buildContextInjection } from './utils/memory.js';
import { trackInteraction, buildStyleInstruction } from './utils/user-prefs.js';
import { isOwner } from './utils/permissions.js';
import { isBotAwake, sleep, wake } from './utils/wake-sleep.js';
import { hasPendingLearn, addExplanation, completeLearning, startPendingLearn, buildLearnedKnowledge } from './utils/learned-patterns.js';
import config from './config.js';
import logger from './utils/logger.js';
import { checkRateLimit, releaseRateLimit } from './utils/rate-limit.js';
import { recordMetric } from './utils/metrics.js';
import { handleVoiceResponse } from './utils/voice-response.js';

// Import extracted actions
import {
  execTimeout,
  execBanKick,
  execRole,
  execNickname,
  execPinMessage,
  execUnpinMessage,
  execWarn,
  execWarnList,
  execWarnClear,
  execCreateChannel,
  execDeleteChannel,
  execSummarize,
  execSummarizeChannel,
  execVoiceCheck,
  execVoiceMod,
  execSetupVoiceMaster,
  execReminder,
  execSetConfig,
  execGetConfig,
  execPing,
  execWeather,
  execInvite
} from './actions/index.js';

// ─── Message Deduplication ─────────────────────────────────────────
const processedMessages = new Map(); // messageId -> timestamp
const DEDUP_TTL_MS = 30_000; // 30 seconds

function isDuplicate(messageId) {
  const now = Date.now();
  
  // Cleanup old entries
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > DEDUP_TTL_MS) {
      processedMessages.delete(id);
    }
  }
  
  if (processedMessages.has(messageId)) return true;
  
  processedMessages.set(messageId, now);
  return false;
}

// Add input validation utility
export function sanitizeInput(text, maxLength = 2000) {
  if (!text || typeof text !== 'string') return '';
  
  // Remove potential injection attempts (control chars)
  const sanitized = text
    // eslint-disable-next-line no-control-regex -- intentional control-char stripping
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
  
  return sanitized.slice(0, maxLength);
}

export async function handleMention(message) {
  let rateLimitToken = null;
  const totalStart = Date.now();
  try {
    // Include guildId so guild quotas apply to mention traffic too
    const rateLimit = checkRateLimit(message.author.id, message.guild?.id ?? null);
    if (!rateLimit.allowed) {
      await message.reply(`⏱️ Slow down! Coba lagi dalam ${Math.ceil(rateLimit.resetIn / 1000)} detik.`);
      return;
    }
    rateLimitToken = rateLimit.token;

    // Deduplicate — prevent processing same message multiple times
    if (isDuplicate(message.id)) {
      logger.warn(`⚠️ Duplikat pesan ${message.id}, skip.`);
      return;
    }

    const client = message.client;
    const botId = client.user.id;
    const rawContent = sanitizeInput(
      message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(),
      2000
    );

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

    // totalStart declared at function entry for catch-block access
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📩 Pesan dari ${message.author.username}: "${rawContent}"`);

    // Only build heavy server context if the user query suggests an action might need it
    const needsHeavyContext = ACTION_HINT.test(rawContent);
    const serverCtx = gatherServerContext(message, { includeHeavy: needsHeavyContext });

    // Step 1: local fast path for safe, obvious intents; AI only for ambiguity/actions.
    logger.info(`[Step 1] 🧠 Reasoning — menganalisis pesan...`);
    const reasonStart = Date.now();
    const { prompt: learnedKnowledge, hasMatch } = await buildLearnedKnowledge(rawContent);
    const plan = (!hasMatch && fastRoute(rawContent)) || await analyzeAndPlan(rawContent, message, serverCtx, learnedKnowledge);

    // Guard: if the classifier picked ask_clarification but the message has no
    // moderation/utility action keyword, the user is just chatting. Downgrade to
    // chat so we get a natural in-character reply instead of the rigid "belum
    // paham + UPDATE" clarification prompt. Genuine action-command ambiguity
    // (e.g. "ban him" with no target) still keeps the clarification + learn flow.
    if (plan.action === 'ask_clarification' && !ACTION_HINT.test(rawContent)) {
      logger.info(`[Step 1] 🔁 ask_clarification -> chat (no action keyword, looks like chat)`);
      plan.action = 'chat';
      plan.response_style = plan.response_style || 'casual';
    }

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
      recordMetric('request', { success: true, latency: totalMs });
      logger.success(`✅ DONE — Total waktu: ${(totalMs / 1000).toFixed(1)}s (reason: ${(reasonMs / 1000).toFixed(1)}s + response: ${(respMs / 1000).toFixed(1)}s)`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      return;
    }

    // Step 2: Send "checking..." reply, execute action, then edit with result
    const pendingReply = await message.reply('⏳ Oke, saya periksa dulu...').catch(() => null);

    logger.info(`[Step 2] ⚡ Executing action: ${plan.action}...`);
    const actionStart = Date.now();
    const result = await executeAction(plan, message);
    const actionMs = Date.now() - actionStart;
    logger.info(`[Step 2] ✅ Action selesai dalam ${(actionMs / 1000).toFixed(1)}s → success: ${result.success}`);

    if (result.replied) {
      // Action already sent its own reply, remove the pending message
      if (pendingReply) await pendingReply.delete().catch(() => { });
      const totalMs = Date.now() - totalStart;
      recordMetric('request', { success: true, latency: totalMs });
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
    recordMetric('request', { success: true, latency: totalMs });
    logger.success(`✅ DONE — Total waktu: ${(totalMs / 1000).toFixed(1)}s (reason: ${(reasonMs / 1000).toFixed(1)}s + action: ${(actionMs / 1000).toFixed(1)}s)`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  } catch (err) {
    const totalMs = Date.now() - totalStart;
    recordMetric('request', { success: false, latency: totalMs });
    logger.error(`❌ Mention handler error: ${err.message}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    await message.reply('Aduh, ada yang error nih. Coba lagi ya.').catch(() => { });
  } finally {
    if (rateLimitToken) {
      releaseRateLimit(rateLimitToken);
    }
  }
}

// ─── Server Context ────────────────────────────────────────────────

function gatherServerContext(message, options = {}) {
  const guild = message.guild;
  if (!guild) return 'Konteks: Pesan di DM (bukan server)';

  const lines = [`Server: ${guild.name}`, `Channel: #${message.channel.name}`, `User: ${message.author.username} (${message.author.id})`];

  if (isOwner(message.author.id)) lines.push('⭐ User ini adalah OWNER bot');

  // Mentioned users
  const mentioned = message.mentions.users.filter(u => u.id !== message.client.user.id);
  if (mentioned.size > 0) {
    lines.push('Mentioned users: ' + mentioned.map(u => `${u.username} (<@${u.id}>)`).join(', '));
  }

  if (options.includeHeavy) {
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
  }

  return lines.join('\n');
}

// ─── AI Reasoning ──────────────────────────────────────────────────

async function analyzeAndPlan(rawContent, message, serverCtx, learnedKnowledge) {
  const systemPrompt = buildAgentRoutingPrompt(serverCtx, learnedKnowledge);

  try {
    const response = await chatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: rawContent }],
      {
        task: 'routing',
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
        'get_config', 'bot_sleep', 'bot_wake', 'ask_clarification'
      ]
    },
    thought: { type: 'string' },
    params: {
      type: 'object',
      properties: {
        target_id: { type: 'string' },
        target_name: { type: 'string' },
        role_name: { type: 'string' },
        duration: { type: 'string' },
        reason: { type: 'string' },
        text: { type: 'string' },
        schedule: { type: 'string' },
        delivery: { type: 'string', enum: ['text', 'voice', 'both'] },
        url: { type: 'string' },
        count: { type: 'integer' },
        message_id: { type: 'string' },
        channel_name: { type: 'string' },
        channel_type: { type: 'string', enum: ['text', 'voice'] },
        action: { type: 'string' },
        hub_channel_id: { type: 'string' },
        setting: { type: 'string' },
        channel_id: { type: 'string' },
        nickname: { type: 'string' }
      }
    },
    response_style: { type: 'string', enum: ['casual', 'informative', 'mentor', 'playful'] }
  },
  required: ['action', 'thought']
};

// ─── Fast Router ───────────────────────────────────────────────────

const ACTION_HINT = /\b(mute|unmute|deafen|undeafen|disconnect|role|timeout|ban|kick|warn|pin|unpin|remind|ingatkan|ringkas|summary|summarize|announce|pengumuman|channel|voicemaster|config|setting|tidur|bangun|nickname|nick|ping|weather|cuaca|invite|undang)\b/i;
const CODE_HINT = /```|\b(kode|coding|javascript|typescript|node\.?js|python|java|php|golang|rust|html|css|sql|bug|error|crash|not working|ga jalan|stack trace)\b/i;
const CHAT_HINT = /^(hai|halo|hello|hi|hey|pagi|siang|sore|malam|makasih|terima kasih|thanks|thank you|oke|ok|baik|siap|mantap)[!. ]*$/i;

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
  return null;
}

// ─── Action Dispatcher ─────────────────────────────────────────────

async function executeAction(plan, message) {
  const { action, params } = plan;

  switch (action) {
    case 'chat': return { success: true, type: 'chat' };
    case 'knowledge': return { success: true, type: 'knowledge' };

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

    case 'ask_clarification': {
      startPendingLearn(message.channel.id, message.author.id, plan.rawQuery);
      const q = params.question || 'Tunggu, siapa yang kamu maksud? Tag orangnya dulu dong 😤';
      await message.reply(q + '\n\n💡 *Kasih detailnya (ga perlu tag aku), terus kirim* **UPDATE** *biar gue ingat buat lain waktu.*');
      return { success: true, type: 'clarification', replied: true };
    }

    default: return { success: true, type: 'chat' };
  }
}


async function execAnnounceAsk(message, params, plan) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return { success: false, error: 'Kamu tidak punya permission MentionEveryone untuk membuat pengumuman.' };
  }

  const defaultAnnounceId = config.announceChannelId;
  const rawChannelId = params.channel_id ? params.channel_id.replace(/[<#>]/g, '') : null;
  const targetChannelId = rawChannelId || defaultAnnounceId || message.channel.id;

  const targetChannel = guild.channels.cache.get(targetChannelId);
  if (!targetChannel) {
    return { success: false, error: 'Channel pengumuman tidak ditemukan.' };
  }

  const botPerms = targetChannel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.SendMessages)) {
    return { success: false, error: `Bot tidak punya permission SendMessages di channel <#${targetChannel.id}>.` };
  }

  const announceText = params.text || plan.rawQuery;

  try {
    const confirmId = `confirm_announce_${Date.now()}`;
    const cancelId = `cancel_announce_${Date.now()}`;

    const embed = new EmbedBuilder()
      .setColor('#3b5998')
      .setTitle('📢 Draf Pengumuman')
      .setDescription(`Apakah kamu yakin ingin mengirim pengumuman berikut ke <#${targetChannel.id}>?\n\n${announceText}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('✅ Kirim').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel('❌ Batal').setStyle(ButtonStyle.Secondary)
    );

    const reply = await message.reply({ embeds: [embed], components: [row] });

    try {
      const i = await reply.awaitMessageComponent({
        filter: (interaction) => interaction.user.id === message.author.id,
        time: 45000
      });
      await i.deferUpdate();

      if (i.customId === confirmId) {
        await targetChannel.send(announceText);
        await reply.edit({ content: `✅ Pengumuman dikirim ke <#${targetChannel.id}>.`, embeds: [], components: [] });
        return { success: true, type: 'announce', replied: true };
      } else {
        await reply.edit({ content: '❌ Pengumuman dibatalkan.', embeds: [], components: [] });
        return { success: true, type: 'cancelled', replied: true };
      }
    } catch {
      await reply.edit({ content: '⏰ Waktu konfirmasi habis. Pengumuman dibatalkan.', embeds: [], components: [] });
      return { success: true, type: 'cancelled', replied: true };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Direct Action Result Formatter (no AI call) ───────────────────

const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

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

    case 'timeout': {
      return randomOf([
        `⏱️ **${result.targetName}** sudah di-timeout selama **${result.duration}**.`,
        `⏱️ Istirahat dulu ya! **${result.targetName}** di-timeout **${result.duration}**.`,
        `⏱️ Di-timeout dulu **${result.targetName}** selama **${result.duration}** biar adem.`
      ]);
    }

    case 'nickname':
      return `✏️ Nickname **${result.oldName}** sudah diganti jadi **${result.newName}**.`;

    case 'reminder': {
      const modeText = result.delivery === 'voice' ? ' lewat suara di voice channel' : (result.delivery === 'both' ? ' lewat chat dan suara' : ' lewat chat');
      return `⏰ Oke, aku ingetin kamu **${result.duration}**${modeText}: "${result.text}"`;
    }

    case 'bot_sleep':
      return randomOf([
        '😴 Oke, aku tidur dulu. Nanti mention lagi kalau butuh ya!',
        '😴 Ngantuk... Aku bobo dulu. Jangan lupa bangunin nanti!',
        '😴 Bye, mau hibernasi dulu. Ketik bangunkanku kalau butuh.'
      ]);

    case 'bot_wake':
      return randomOf([
        '🟢 Siap bertugas kembali!',
        '🟢 Halo lagi! Ada kerjaan apa nih?',
        '🟢 Sudah bangun! Siap melayani, Bos!'
      ]);

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
      return randomOf([
        `🔨 **${result.targetName}** sudah di-ban dari server.\n📝 Alasan: ${result.reason}`,
        `🔨 Toko palu beraksi! **${result.targetName}** berhasil di-ban.\n📝 Alasan: ${result.reason}`,
        `🔨 Selamat tinggal **${result.targetName}**, kamu resmi di-ban.\n📝 Alasan: ${result.reason}`
      ]);

    case 'kick':
      return randomOf([
        `👢 **${result.targetName}** sudah di-kick dari server.\n📝 Alasan: ${result.reason}`,
        `👢 Tendangan maut meluncur! **${result.targetName}** berhasil di-kick.\n📝 Alasan: ${result.reason}`,
        `👢 **${result.targetName}** didepak dari server.\n📝 Alasan: ${result.reason}`
      ]);

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
      contextInjection: buildContextInjection(userId, rawQuery),
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
      sources.forEach((s, idx) => {
        articleText += `[${idx + 1}] ${s.title} — ${s.url}\n`;
      });
      articleText += `\n${ragAnswer}`;
    } else {
      articleText += '❌ Tidak menemukan artikel terkait.';
    }
    await reply.edit({ content: articleText.length > 1950 ? articleText.slice(0, 1950) + '...' : articleText, components: [] });
  } catch {
    try { await reply.edit({ components: [] }); } catch { /* reply already gone */ }
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

async function playVoiceIfInChannel(message, text) {
  try {
    await handleVoiceResponse(message.member, text);
  } catch (voiceErr) {
    logger.error(`Mention Voice playback error: ${voiceErr.message}`);
  }
}

export default { handleMention };
