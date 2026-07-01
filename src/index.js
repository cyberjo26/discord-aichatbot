import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import config from './config.js';
import logger from './utils/logger.js';
import { handlePrefixCommand } from './prefix-handler.js';
import { handleMention } from './mention-handler.js';
import { chatCompletion } from './ai/openrouter.js';
import { initPrefs, forceSavePrefs } from './utils/user-prefs.js';
import { initWakeSleep, isBotAwake } from './utils/wake-sleep.js';
import { initPatterns, forceSavePatterns } from './utils/learned-patterns.js';
import { initWarnings, addWarning } from './utils/warnings.js';
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

// ─── Events ────────────────────────────────────────────────────────

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
      const h = await healthCheck();
      if (h.status !== 'healthy') {
        logger.warn(`Health check degraded: DB=${h.checks.database}, AI=${h.checks.aiStatus}`);
      }
      
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
      
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
    }
  }, 5 * 60 * 1000);
});

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  const { allowed, remaining, resetIn, reason } = checkRateLimit(interaction.user.id, interaction.guild?.id);
  if (!allowed) {
    const s = Math.ceil(resetIn / 1000);
    if (reason === 'global_concurrency') {
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
    releaseRateLimit();
  }
});

// Message handler: Mentions + Prefix commands
client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // ─── Hack Guard: Anti-spam across different channels ─────────
  if (message.guild) {
    const userId = message.author.id;
    const now = Date.now();
    let history = userMessageHistory.get(userId) || [];

    // Clean up history older than TRACK_WINDOW_MS relative to 'now'
    history = history.filter(item => now - item.timestamp <= TRACK_WINDOW_MS);

    // Save current message info
    history.push({
      messageId: message.id,
      channelId: message.channel.id,
      timestamp: now,
      message: message
    });

    userMessageHistory.set(userId, history);

    // Check for identical messages across unique channels
    const contentCounts = new Map();
    let spamItems = null;

    for (const item of history) {
      const content = item.message.content;
      if (!contentCounts.has(content)) {
        contentCounts.set(content, []);
      }
      contentCounts.get(content).push(item);
    }

    for (const items of contentCounts.values()) {
      const uniqueChannels = [...new Set(items.map(i => i.channelId))];
      if (uniqueChannels.length >= 3) {
        spamItems = items;
        break;
      }
    }

    if (spamItems) {
      logger.warn(`🚨 Hack Guard terpicu untuk ${message.author.tag} (${userId})! (3 pesan sama di 3 channel berbeda)`);

      // Delete all messages that match the spam content in the history window
      for (const item of spamItems) {
        try {
          await item.message.delete().catch(() => {});
        } catch (err) {
          logger.error(`Gagal menghapus pesan ${item.messageId} di Hack Guard: ${err.message}`);
        }
      }

      // Reset history window
      userMessageHistory.set(userId, []);

      // Register warning
      const systemBotId = message.client.user.id;
      const result = addWarning(message.guild.id, userId, 'Hack Guard: Spam pesan yang sama di 3+ channel berbeda.', systemBotId);

      let warningMessage = `🚨 **Hack Guard Terpicu!**\n` +
        `Akun <@${userId}> terdeteksi mengirim pesan yang sama persis di 3 channel berbeda dalam waktu singkat (indikasi akun di-hack/self-bot).\n` +
        `⚠️ **Tindakan:** Pesan telah dihapus dan user diberi warning (**${result.total}/5**).`;

      // Determine timeout duration
      let timeoutDurationMs = 30 * 1000; // Default 30 seconds
      let timeoutMsg = '30 detik';

      if (result.total >= 5) {
        timeoutDurationMs = 60 * 60 * 1000;
        timeoutMsg = '1 jam';
      } else if (result.total >= 3) {
        timeoutDurationMs = 10 * 60 * 1000;
        timeoutMsg = '10 menit';
      }

      try {
        await message.member.timeout(timeoutDurationMs, `Auto-timeout: Hack Guard (${timeoutMsg})`);
        warningMessage += `\n⏱️ **Auto-timeout ${timeoutMsg}** diterapkan.`;
      } catch {
        warningMessage += '\n⚠️ Gagal menerapkan auto-timeout (bot tidak memiliki permission).';
      }

      await message.channel.send(warningMessage).catch(() => {});
      return; // Stop processing further handlers for this event
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

  const { allowed, remaining, resetIn, reason } = checkRateLimit(message.author.id, message.guild?.id);
  if (!allowed) {
    const s = Math.ceil(resetIn / 1000);
    if (reason === 'global_concurrency') {
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
    releaseRateLimit();
  }
});

// ─── VoiceMaster: Auto voice channel ───────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
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
  logger.info(`${signal} received, shutting down...`);
  
  // Flush all stores to disk atomically
  try { forceSavePrefs(); } catch(e) { logger.error(`Shutdown: savePrefs error: ${e.message}`); }
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
