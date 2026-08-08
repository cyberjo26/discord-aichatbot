import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import config from './config.js';
import logger from './utils/logger.js';
import { handlePrefixCommand } from './prefix-handler.js';
import { handleMention } from './mention-handler.js';
import { chatCompletion } from './ai/openrouter.js';
import { initPrefs, forceSavePrefs } from './utils/user-prefs.js';
import { initAfk, handleAfkMessageEvent, clearAfk, isAfk, forceSaveAfk } from './utils/afk.js';
import { initWakeSleep, isBotAwake } from './utils/wake-sleep.js';
import { initPatterns, forceSavePatterns } from './utils/learned-patterns.js';
import { initWarnings, addWarning, applyWarningEscalation } from './utils/warnings.js';
import { hasPendingLearn, addExplanation, completeLearning } from './utils/learned-patterns.js';
import { initServerSettings, getSetting, forceSaveSettings } from './utils/server-settings.js';
import { initVoiceMaster, handleVoiceStateUpdate } from './utils/voicemaster.js';
import { closeDB, initReminders, stopReminderPolling } from './utils/reminders.js';
import { handleVoiceWelcome } from './voice/welcome.js';
import { initBackups } from './utils/backup.js';
import { checkRateLimit, cleanupRateLimits, releaseRateLimit } from './utils/rate-limit.js';
import { healthCheck } from './utils/health.js';

// Import commands
import * as askCmd from './commands/ask.js';
import * as chatCmd from './commands/chat.js';
import * as summarizeCmd from './commands/summarize.js';
import * as helpCmd from './commands/help.js';
import * as adminCmd from './commands/admin.js';
import * as pingCmd from './commands/ping.js';
import * as weatherCmd from './commands/weather.js';
import * as inviteCmd from './commands/invite.js';

// Initialize persistent systems
initPrefs();
initAfk();
initWakeSleep();
initPatterns();
initWarnings();
initServerSettings();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
  ],
});

// Register slash commands in collection
client.commands = new Collection();
const commandModules = [askCmd, chatCmd, summarizeCmd, helpCmd, adminCmd, pingCmd, weatherCmd, inviteCmd];

for (const mod of commandModules) {
  client.commands.set(mod.data.name, mod);
  logger.debug(`Registered command: /${mod.data.name}`);
}

// Hack Guard: Memory store to track recent messages by each user (load/prevent spam)
const userMessageHistory = new Map();
const TRACK_WINDOW_MS = 4000; // 4 seconds interval
// Hack Guard: Per-user lock to prevent race condition during spam processing.
// When set, any new message from this user is deleted immediately (await in
// deletion loop yields control; concurrent handlers would otherwise re-trigger
// spam detection, reset history prematurely, and let some messages survive).
const userSpamLock = new Set();

// ─── Events ────────────────────────────────────────────────────────

function logGatewayState(label) {
  logger.info(`${label}: ws=${client.ws?.status ?? 'unknown'} ready=${client.isReady()} ping=${client.ws?.ping ?? 'unknown'}`);
}

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err?.stack || err?.message || err}`);
  try { forceSavePrefs(); } catch { /* best-effort flush on crash */ }
  try { forceSaveAfk(); } catch { /* best-effort flush on crash */ }
  try { forceSaveSettings(); } catch { /* best-effort flush on crash */ }
  try { forceSavePatterns(); } catch { /* best-effort flush on crash */ }
  try { closeDB(); } catch { /* DB may already be closed */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.stack || reason?.message || reason}`);
});

client.on('error', (err) => {
  logger.error(`Discord client error: ${err?.stack || err?.message || err}`);
});

client.on('warn', (msg) => {
  logger.warn(`Discord warn: ${msg}`);
});

client.on('shardError', (err, shardId) => {
  logger.error(`Shard error shard=${shardId}: ${err?.stack || err?.message || err}`);
});

client.on('shardDisconnect', (closeEvent, shardId) => {
  logger.warn(`Shard disconnect shard=${shardId} code=${closeEvent?.code ?? 'unknown'} reason=${closeEvent?.reason ?? 'unknown'}`);
});

client.on('reconnecting', () => {
  logger.warn('Discord reconnecting');
});

client.on('resume', (replayed) => {
  logger.info(`Discord resume: replayed=${replayed}`);
});

client.on('disconnect', () => {
  logger.warn('Discord disconnect');
});

client.once('ready', async () => {
  logger.success(`🤖 ${config.botName} is online! [JARVIS MODE]`);
  logger.info(`   Logged in as: ${client.user.tag}`);
  logger.info(`   Servers: ${client.guilds.cache.size}`);
  logger.info(`   Commands: ${client.commands.size} (slash) + prefix (!) + @mention`);

  // Set activity based on wake/sleep state
  if (isBotAwake()) {
    client.user.setActivity('🧠 Mention aku!', { type: 3 }); // WATCHING
    client.user.setStatus('online');
  } else {
    client.user.setActivity('💤 Sleeping...', { type: 0 });
    client.user.setStatus('idle');
  }

  // Initialize VoiceMaster system
  await initVoiceMaster(client);

  // Restore pending reminders and start polling loop
  try {
    initReminders(client);
  } catch (err) {
    logger.error(`Reminder database initialization failed: ${err.message}`);
    shutdown('REMINDER_DB_INIT_FAILED', 1);
  }
  
  // Initialize backups
  initBackups();
  
  // Initialize health check loop (5 mins)
  setInterval(async () => {
    try {
      const h = await healthCheck(client);
      if (h.status !== 'healthy') {
        logger.warn(`Health check degraded: DB=${h.checks.database}, AI=${h.checks.aiStatus}, GW=${h.checks.gateway?.status}`);
      }
      logger.info(`Health snapshot: DB=${h.checks.database} AI=${h.checks.aiStatus} GW=${h.checks.gateway?.status} ws=${h.checks.gateway?.ws} ping=${h.checks.gateway?.ping}`);
      
      // Memory cleanup
      cleanupRateLimits();
      const now = Date.now();
      let cleanedHistory = 0;
      for (const [key, history] of userMessageHistory.entries()) {
        const lastTime = history[history.length - 1]?.timestamp || 0;
        if (now - lastTime > 60000) { // 1 min TTL
          userMessageHistory.delete(key);
          cleanedHistory++;
        }
      }
      if (cleanedHistory > 0) logger.debug(`Cleaned ${cleanedHistory} entries from userMessageHistory`);

      // Safety net: clear stale spam locks (try-finally should always release,
      // but guard against edge cases like unhandled rejections)
      if (userSpamLock.size > 0) {
        logger.warn(`Hack Guard: clearing ${userSpamLock.size} stale spam lock(s) during health check`);
        userSpamLock.clear();
      }

      // Gateway heartbeat
      logGatewayState('Heartbeat');
      
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
    }
  }, 5 * 60 * 1000);
});

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Do nothing while the bot is in sleep mode
  if (!isBotAwake()) {
    return interaction.reply({ content: '💤 Bot lagi tidur. Bangunin dulu ya!', ephemeral: true }).catch(() => {});
  }

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  const rateLimitResult = checkRateLimit(interaction.user.id, interaction.guild?.id);
  if (!rateLimitResult.allowed) {
    const s = Math.ceil(rateLimitResult.resetIn / 1000);
    if (rateLimitResult.reason === 'global_concurrency') {
      return interaction.reply({ content: `⏳ Server AI sedang sibuk. Coba beberapa saat lagi.`, ephemeral: true });
    }
    return interaction.reply({ content: `⏳ Wah, kamu terlalu cepat! Tunggu ${s} detik lagi ya.`, ephemeral: true });
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error(`Command /${interaction.commandName} crashed: ${err.message}`);
    logger.error(err.stack);

    const reply = {
      content: '❌ Terjadi error yang tidak terduga. Coba lagi nanti.',
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  } finally {
    // Only release when allowed — a denied result never held a token, and the
    // legacy branch of releaseRateLimit() would otherwise free someone else's.
    if (rateLimitResult?.allowed) releaseRateLimit(rateLimitResult.token);
  }
});

// ─── Hack Guard: Spam Signature Builder ───────────────────────────
// Build a normalized key from any message type so identical content
// (text, image, sticker, embed) can be detected across channels.
// - Text-only: signature = trimmed content (backward compatible)
// - Attachment/image: content + sorted attachment URLs appended
// - Sticker: content + sorted sticker IDs appended
// - Empty content + no attachments/stickers: null (won't match anything)
function buildSpamSignature(message) {
  const text = message.content?.trim() || '';

  const attachments = [...(message.attachments?.values() || [])]
    .map(a => a.proxyURL || a.url)
    .sort()
    .join('|');

  const stickers = [...(message.stickers?.values() || [])]
    .map(s => s.id)
    .sort()
    .join('|');

  const parts = [text];
  if (attachments) parts.push(`att:${attachments}`);
  if (stickers) parts.push(`stk:${stickers}`);

  const signature = parts.join('::');
  // Empty message with no attachments/stickers → null (skip detection)
  if (signature === '' || signature === '::') return null;
  return signature;
}

// Message handler: Mentions + Prefix commands
client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // ─── Hack Guard: Anti-spam across different channels ─────────
  if (message.guild) {
    const userId = message.author.id;
    const now = Date.now();

    // Race-condition guard: if this user is already mid-spam-processing,
    // delete the incoming message immediately and stop.  Without this,
    // concurrent messageCreate handlers interleave at the deletion-loop
    // `await`, re-trigger detection, reset history at different times, and
    // let some spam messages survive (the "not all deleted" bug).
    if (userSpamLock.has(userId)) {
      await message.delete().catch(() => {});
      return;
    }

    let history = userMessageHistory.get(userId) || [];

    // Clean up history older than TRACK_WINDOW_MS relative to 'now'
    history = history.filter(item => now - item.timestamp <= TRACK_WINDOW_MS);

    // Build spam signature (text + attachments + stickers).
    // Null signature = empty message with no media → skip tracking.
    const signature = buildSpamSignature(message);
    if (signature) {
      history.push({
        messageId: message.id,
        channelId: message.channel.id,
        signature,
        timestamp: now,
      });
    }

    userMessageHistory.set(userId, history);

    // Check for identical signatures across unique channels
    const sigCounts = new Map();
    let spamItems = null;

    for (const item of history) {
      if (!sigCounts.has(item.signature)) {
        sigCounts.set(item.signature, []);
      }
      sigCounts.get(item.signature).push(item);
    }

    for (const items of sigCounts.values()) {
      const uniqueChannels = [...new Set(items.map(i => i.channelId))];
      if (uniqueChannels.length >= 3) {
        spamItems = items;
        break;
      }
    }

    if (spamItems) {
      // Lock this user synchronously — BEFORE any `await` — so that any
      // message arriving during the deletion/punishment phase is caught by
      // the guard at the top of this block and deleted immediately.
      userSpamLock.add(userId);

      try {
        logger.warn(`🚨 Hack Guard terpicu untuk ${message.author.tag} (${userId})! (3 pesan sama di 3 channel berbeda)`);

        // Re-read history to capture messages that may have arrived between
        // detection and lock acquisition (detection itself is synchronous,
        // so this is a belt-and-suspenders safety net).
        const spamSignature = spamItems[0].signature;
        const latestHistory = userMessageHistory.get(userId) || [];
        const allSpamItems = latestHistory.filter(item => item.signature === spamSignature);

        // Collect unique channel IDs involved in the spam burst — used for
        // both the initial deletion and the backfill prune sweep below.
        const involvedChannelIds = [...new Set(allSpamItems.map(i => i.channelId))];
        const deletedIds = new Set();

        // Delete all messages that match the spam signature in the history window
        for (const item of allSpamItems) {
          try {
            const ch = message.guild.channels.cache.get(item.channelId);
            if (ch) {
              await ch.messages.delete(item.messageId).catch(err => {
                // 10008 = Unknown Message (already deleted) — expected during
                // concurrent bursts; only log genuinely unexpected failures.
                if (err.code !== 10008) {
                  logger.debug(`Hack Guard: gagal hapus pesan ${item.messageId} (code ${err.code}): ${err.message}`);
                }
              });
              deletedIds.add(item.messageId);
            }
          } catch (err) {
            logger.error(`Gagal menghapus pesan ${item.messageId} di Hack Guard: ${err.message}`);
          }
        }

        // ─── Backfill Prune ───────────────────────────────────────
        // Sweep recent messages in each involved channel to catch spam that
        // arrived before the bot started processing or was skipped during
        // concurrent handler interleaving. Fetch last 20 messages per channel
        // and delete any from this user matching the spam signature.
        for (const channelId of involvedChannelIds) {
          const ch = message.guild.channels.cache.get(channelId);
          if (!ch || typeof ch.isTextBased === 'function' && !ch.isTextBased()) continue;
          try {
            const recent = await ch.messages.fetch({ limit: 20 });
            for (const [msgId, msg] of recent) {
              if (msg.author.id !== userId) continue;
              if (deletedIds.has(msgId)) continue; // already deleted above
              if (buildSpamSignature(msg) === spamSignature) {
                await msg.delete().catch(err => {
                  if (err.code !== 10008) {
                    logger.debug(`Hack Guard backfill: gagal hapus pesan ${msgId} (code ${err.code}): ${err.message}`);
                  }
                });
                deletedIds.add(msgId);
              }
            }
          } catch (err) {
            logger.debug(`Hack Guard backfill: gagal fetch channel ${channelId}: ${err.message}`);
          }
        }

        logger.debug(`Hack Guard: total ${deletedIds.size} pesan dihapus (termasuk backfill) untuk ${userId}`);

        // Reset history window
        userMessageHistory.set(userId, []);

        // Register warning
        const systemBotId = message.client.user.id;
        const result = addWarning(message.guild.id, userId, 'Hack Guard: Spam pesan yang sama di 3+ channel berbeda.', systemBotId);

        let warningMessage = `🚨 **Hack Guard Terpicu!**\n` +
          `Akun <@${userId}> terdeteksi mengirim pesan yang sama persis di 3 channel berbeda dalam waktu singkat (indikasi akun di-hack/self-bot).\n` +
          `⚠️ **Tindakan:** Pesan telah dihapus dan user diberi warning (**${result.total}/5**).`;

        // Determine punishment based on warning count
        let timeoutDurationMs = 30 * 1000; // Default 30 seconds
        let timeoutMsg = '30 detik';

        if (result.total >= 3) {
          timeoutDurationMs = 10 * 60 * 1000;
          timeoutMsg = '10 menit';
        }

        try {
          await message.member.timeout(timeoutDurationMs, `Auto-timeout: Hack Guard (${timeoutMsg})`);
          warningMessage += `\n⏱️ **Auto-timeout ${timeoutMsg}** diterapkan.`;
        } catch {
          warningMessage += '\n⚠️ Gagal menerapkan auto-timeout (bot tidak memiliki permission).';
        }

        // Auto-kick at 5/5 warnings — shared policy (warnings.js#applyWarningEscalation)
        if (result.total >= 5) {
          const escalation = await applyWarningEscalation({
            guild: message.guild,
            member: message.member,
            total: result.total,
            channelId: message.channel.id,
          });
          if (escalation.text) warningMessage += escalation.text;
        }

        await message.channel.send(warningMessage).catch(() => {});
      } finally {
        // Always release the lock — even if an error occurred mid-processing
        userSpamLock.delete(userId);
      }

      return; // Stop processing further handlers for this event
    }
  }

  // ─── AFK: auto-return + mention/reply notification ────────────
  // Runs for every guild message: clears the author's own AFK when they
  // are seen again, and notifies anyone who mentions/replies to an AFK user.
  if (message.guild) {
    try {
      await handleAfkMessageEvent(message);
    } catch (err) {
      logger.debug(`AFK handler error: ${err.message}`);
    }
  }

  // ─── Pending Learn Session (no @mention needed) ───────────────
  // If user has a pending learn session, capture their messages
  // even without @mention so they can explain naturally
  if (hasPendingLearn(message.channel.id, message.author.id)) {
    const text = message.content.trim();
    if (!text) return;

    // Check if this is the UPDATE trigger
    if (text.replace(/["']/g, '').trim().toUpperCase() === 'UPDATE') {
      try {
        await message.channel.sendTyping();
        const pattern = await completeLearning(message.channel.id, message.author.id);
        if (pattern) {
          await message.reply(`✅ Oke, gue udah belajar!\n\n🧠 **"${pattern.trigger}"** → ${pattern.meaning}\n\nSekarang kalau kamu bilang hal serupa, gue udah paham. Thanks udah ngajarin! 🙏`);
        } else {
          await message.reply('Hmm, gagal belajar. Coba ulangi lagi ya — jelasin dulu, baru UPDATE.');
        }
      } catch (err) {
        logger.error(`Learn update failed: ${err.message}`);
        await message.reply('Aduh, error saat belajar. Coba lagi ya.').catch(() => {});
      }
      return;
    }

    // Otherwise, capture as explanation
    addExplanation(message.channel.id, message.author.id, text);
    await message.react('📝').catch(() => {}); // React to confirm we captured it
    return;
  }

  // ─── DM Support (Jarvis Mode in Private Message) ──────────────
  // In DMs every message is directed at the bot — no @mention needed.
  // Prefix commands (!) still work in DMs (handled below).
  if (!message.guild && !message.content.startsWith('!')) {
    try {
      await handleMention(message);
    } catch (err) {
      logger.error(`DM mention handler crashed: ${err.message}`);
      await message.reply('❌ Terjadi error. Coba lagi nanti.').catch(() => {});
    }
    return;
  }

  // ─── @Mention handler (Jarvis Mode) ───────────────────────────
  if (message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true })) {
    try {
      await handleMention(message);
    } catch (err) {
      logger.error(`Mention handler crashed: ${err.message}`);
      await message.reply('❌ Terjadi error. Coba lagi nanti.').catch(() => {});
    }
    return; // Don't process as prefix command
  }

  // ─── Prefix commands (!) ──────────────────────────────────────
  if (!message.content.startsWith('!')) return;

  // Do nothing while the bot is in sleep mode (wake is via @mention only)
  if (!isBotAwake()) return;

  const rateLimitResult = checkRateLimit(message.author.id, message.guild?.id);
  if (!rateLimitResult.allowed) {
    const s = Math.ceil(rateLimitResult.resetIn / 1000);
    if (rateLimitResult.reason === 'global_concurrency') {
      return message.reply(`⏳ Server AI sedang sibuk. Coba beberapa saat lagi.`).catch(() => {});
    }
    return message.reply(`⏳ Tunggu ${s} detik lagi sebelum pakai command.`).catch(() => {});
  }

  try {
    await handlePrefixCommand(message);
  } catch (err) {
    logger.error(`Prefix command crashed: ${err.message}`);
    await message.reply('❌ Terjadi error. Coba lagi nanti.').catch(() => {});
  } finally {
    if (rateLimitResult?.allowed) releaseRateLimit(rateLimitResult.token);
  }
});

// ─── VoiceMaster: Auto voice channel ───────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Do nothing while the bot is in sleep mode
  if (!isBotAwake()) return;

  // 1. Process Voice Welcome FIRST so it can register the null -> hub transition
  try {
    await handleVoiceWelcome(oldState, newState);
  } catch (err) {
    logger.error(`Voice welcome error: ${err.message}`);
  }

  // 2. THEN process VoiceMaster, which might move the user from hub -> temp
  try {
    await handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    logger.error(`VoiceMaster error: ${err.message}`);
  }
});

// ─── Welcome new members ───────────────────────────────────────────

// ─── AFK: typing clears status ────────────────────────────────────
// discord.js typingStart fires for guild channels (and DMs); no privileged
// intent required. Typing = user is back → clear their AFK silently.
client.on('typingStart', (typing) => {
  const user = typing?.user;
  if (!user || user.bot) return;
  if (isAfk(user.id)) {
    clearAfk(user.id);
    logger.info(`⌨️ ${user.tag} mengetik — status AFK dihapus`);
  }
});

client.on('guildMemberAdd', async (member) => {
  if (!isBotAwake()) return;

  try {
    // Find welcome channel: server-settings > config (.env) > system channel
    let channel = null;
    const settingsWelcome = getSetting(member.guild.id, 'welcomeChannelId');
    if (settingsWelcome) {
      channel = member.guild.channels.cache.get(settingsWelcome);
    }
    if (!channel && config.welcomeChannelId) {
      channel = member.guild.channels.cache.get(config.welcomeChannelId);
    }
    if (!channel) {
      channel = member.guild.systemChannel;
    }
    if (!channel) return;

    // Generate a natural welcome message with AI
    const prompt = `Kamu adalah ${config.botName}, bot asisten di server Discord "${member.guild.name}".
Seseorang bernama "${member.displayName}" baru saja bergabung ke server.
Buatkan pesan sambutan yang hangat, friendly, dan singkat (2-3 kalimat).
Tag user dengan <@${member.id}>.
Jangan terlalu formal. Gunakan emoji yang sesuai.
Bahasa Indonesia.`;

    const welcome = await chatCompletion(
      [{ role: 'system', content: prompt }, { role: 'user', content: 'Buat sambutan.' }],
      { maxTokens: 150 }
    );

    await channel.send(welcome);
    logger.info(`👋 Welcome message sent for ${member.displayName}`);
  } catch (err) {
    logger.error(`Welcome message failed: ${err.message}`);
  }
});

// ─── Graceful shutdown ─────────────────────────────────────────────

function shutdown(signal, exitCode = 0) {
  logger.info(`Shutdown: signal=${signal} code=${exitCode} ws=${client.ws?.status} ready=${client.isReady()}`);

  // Flush all stores to disk atomically
  try { forceSavePrefs(); } catch(e) { logger.error(`Shutdown: savePrefs error: ${e.message}`); }
  try { forceSaveAfk(); } catch(e) { logger.error(`Shutdown: saveAfk error: ${e.message}`); }
  try { forceSaveSettings(); } catch(e) { logger.error(`Shutdown: saveSettings error: ${e.message}`); }
  try { forceSavePatterns(); } catch(e) { logger.error(`Shutdown: savePatterns error: ${e.message}`); }
  
  stopReminderPolling();
  try {
    closeDB();
  } catch (err) {
    logger.error(`Failed to close reminder database: ${err.message}`);
    exitCode = 1;
  }
  client.destroy();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Login ─────────────────────────────────────────────────────────

client.login(config.discordToken).catch((err) => {
  logger.error(`Failed to login: ${err.message}`);
  logger.error('Check your DISCORD_TOKEN in .env');
  process.exit(1);
});
