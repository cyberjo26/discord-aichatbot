import { ChannelType, PermissionFlagsBits } from 'discord.js';
import logger from './logger.js';
import config from '../config.js';
import { synthesize } from '../voice/tts.js';
import { playInGuildVoiceQueue, playInVoiceChannelDirect } from '../voice/player.js';
import { sanitizeDisplayName } from '../voice/welcome.js';
import {
  cancelReminderRow,
  cancelReminderRowsForUser,
  claimDueReminderRows,
  closeReminderStore,
  createReminderRow,
  finishReminderClaim,
  initializeReminderRows,
  listPendingRemindersForUser,
  listReminderRows,
  openReminderStore,
  saveReminderRows,
} from './reminder-store.js';

export const closeDB = closeReminderStore;

let reminders = [];
let pollingInterval = null;
let isPolling = false;

export function parseDuration(text) {
  if (!text) return 0;
  const normalized = text.toLowerCase().trim();
  let totalMs = 0;

  const patterns = [
    { regex: /(\d+)\s*(?:detik|dtk|det|s(?:ec(?:ond)?s?)?)\b/gi, multiplier: 1000 },
    { regex: /(\d+)\s*(?:menit|mnt|min(?:ute)?s?|m(?!s|i|e|n|a))\b/gi, multiplier: 60 * 1000 },
    { regex: /(\d+)\s*(?:jam|hour?s?|h(?![a-z]))\b/gi, multiplier: 60 * 60 * 1000 },
    { regex: /(\d+)h/gi, multiplier: 60 * 60 * 1000 },
    { regex: /(\d+)m(?!s|i|e|n)/gi, multiplier: 60 * 1000 },
    { regex: /(\d+)s\b/gi, multiplier: 1000 },
  ];

  for (const { regex, multiplier } of patterns) {
    let match;
    while ((match = regex.exec(normalized)) !== null) {
      totalMs += parseInt(match[1]) * multiplier;
    }
  }

  if (totalMs === 0) {
    const plainNum = normalized.match(/^(\d+)$/);
    if (plainNum) {
      totalMs = parseInt(plainNum[1]) * 60 * 1000;
    }
  }

  return totalMs;
}

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} detik`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;

  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (remainMins === 0) return `${hours} jam`;
  return `${hours} jam ${remainMins} menit`;
}

export function parseAbsoluteTime(text, timezone = 'Asia/Bangkok') {
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const isTomorrow = normalized.includes('besok');

  let hour = -1;
  let minute = 0;

  const timeRegex = /(?:jam|pukul|pkl)?\s*(\d{1,2})[:.](\d{2})/i;
  const hourOnlyRegex = /(?:jam|pukul|pkl)\s*(\d{1,2})/i;

  let match = normalized.match(timeRegex);
  if (match) {
    hour = parseInt(match[1]);
    minute = parseInt(match[2]);
  } else {
    match = normalized.match(hourOnlyRegex);
    if (match) {
      hour = parseInt(match[1]);
      minute = 0;
    }
  }

  if (hour === -1 || hour > 23 || minute > 59) return null;

  const hasPagi = normalized.includes('pagi');
  const hasSiang = normalized.includes('siang');
  const hasSore = normalized.includes('sore');
  const hasMalam = normalized.includes('malam');

  if (hasPagi) {
    if (hour === 12) hour = 0; 
  } else if (hasSiang) {
    if (hour < 12 && hour >= 1 && hour <= 5) hour += 12;
    else if (hour === 12) hour = 12;
  } else if (hasSore) {
    if (hour < 12) hour += 12;
  } else if (hasMalam) {
    if (hour < 12) hour += 12;
    else if (hour === 12) hour = 0; // Next day handles midnight wrapping below
  }

  const now = new Date();
  
  // Calculate Target Time natively in NodeJS by parsing formatted string in the target timezone
  const dtfDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dtfTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  const [yyyy, mm, dd] = dtfDate.format(now).split('-');
  const [currH, currM, currS] = dtfTime.format(now).split(':');
  
  // Only infer PM if it's for today and time has passed. If "besok", don't infer PM.
  if (!hasPagi && !hasSiang && !hasSore && !hasMalam && hour < 12 && !isTomorrow) {
    if (parseInt(currH) > hour && parseInt(currH) < 24) {
      hour += 12;
    }
  }

  const localizedNow = new Date(`${yyyy}-${mm}-${dd}T${currH}:${currM}:${currS}Z`);
  const offsetMs = localizedNow.getTime() - now.getTime();
  
  const targetLocal = new Date(localizedNow.getTime());
  targetLocal.setUTCHours(hour, minute, 0, 0);

  if (isTomorrow) {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
  } else {
    // If time has passed today, assume tomorrow
    if (targetLocal.getTime() <= localizedNow.getTime()) {
      targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
    }
  }

  return targetLocal.getTime() - offsetMs;
}

export function sanitizeReminderText(text) {
  if (!text) return '';
  let clean = text.normalize('NFKC');
  clean = clean.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Control}\u200b-\u200d\ufeff]/gu, '');
  clean = clean.replace(/[*_~`>#|\\-]/g, '');
  clean = clean.trim().replace(/\s+/g, ' ');
  if (clean.length > 100) {
    clean = clean.slice(0, 100).trim() + '...';
  }
  return clean;
}

export function saveRemindersToFile(remindersList) {
  try {
    saveReminderRows(remindersList);
    return true;
  } catch (err) {
    logger.error(`SQLite save failed: ${err.message}`);
    return false;
  }
}

export function initReminders(client) {
  try {
    openReminderStore();
    reminders = initializeReminderRows();
    logger.info(`⏰ Loaded ${reminders.length} voice/text reminders from SQLite storage`);
  } catch (err) {
    logger.error(`Failed to load persistent reminders: ${err.message}`);
    closeReminderStore();
    throw err;
  }

  startPolling(client);
}

function startPolling(client) {
  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    if (isPolling) return;
    isPolling = true;

    try {
      await pollDueReminders(client);
    } catch (err) {
      logger.error(`Error in reminder polling cycle: ${err.message}`);
    } finally {
      isPolling = false;
    }
  }, 5000);
}

export async function pollDueReminders(client) {
  const due = claimDueReminderRows();
  if (due.length === 0) return;

  for (const r of due) {
    try {
      await deliverReminder(client, r);
    } catch (err) {
      logger.error(`Failed to deliver reminder #${r.id}: ${err.message}`);
      r.status = 'failed';
    }
    let persisted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        persisted = finishReminderClaim(r.id, r.status);
        if (persisted) break;
      } catch (err) {
        logger.error(`Reminder #${r.id} status save attempt ${attempt} failed: ${err.message}`);
      }
    }
    if (!persisted) {
      logger.error(`FATAL: Reminder #${r.id} final status could not be persisted; lease recovery may retry delivery.`);
    }
  }
  reminders = listReminderRows();
}

async function deliverReminder(client, r) {
  logger.info(`🔔 Delivering reminder #${r.id} for user ${r.userId} (delivery: ${r.delivery})`);
  
  const guild = client.guilds.cache.get(r.guildId);
  if (!guild) {
    logger.warn(`Guild ${r.guildId} not found for reminder #${r.id}`);
    r.status = 'failed';
    return;
  }

  let voiceDelivered = false;
  let textDelivered = false;
  const textClean = sanitizeReminderText(r.text);

  // Fallback string if member can't be fetched
  let displayName = 'pengguna';
  
  // We queue the playback task; channel resolution happens inside the queue when it's this task's turn
  if (r.delivery === 'voice' || r.delivery === 'both') {
    await playInGuildVoiceQueue(guild.id, async () => {
      // Fetch latest member state right now
      const currentMember = await guild.members.fetch(r.userId).catch(() => null);
      if (currentMember) {
        displayName = sanitizeDisplayName(currentMember.displayName);
      }
      
      const voiceChannel = currentMember?.voice?.channel;
      
      if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
        const botMember = guild.members.me;
        const permissions = voiceChannel.permissionsFor(botMember);
        
        if (permissions && 
            permissions.has(PermissionFlagsBits.ViewChannel) && 
            permissions.has(PermissionFlagsBits.Connect) && 
            permissions.has(PermissionFlagsBits.Speak)) {
          
          const speakText = `Kak ${displayName}, sudah waktunya. Jangan lupa ${textClean}.`;
          let audioBuffer = null;
          
          try {
            audioBuffer = await synthesize(speakText);
          } catch(err) {
            logger.error(`Reminder TTS failed: ${err.message}`);
          }
          
          if (audioBuffer) {
            try {
              await playInVoiceChannelDirect(voiceChannel, audioBuffer);
              voiceDelivered = true;
              logger.info(`Voice reminder #${r.id} queued for channel ${voiceChannel.name}`);
            } catch (err) {
              logger.error(`Voice reminder playback failed: ${err.message}`);
            }
          }
        } else {
          logger.warn(`Missing voice permissions in channel ${voiceChannel.name} to play reminder #${r.id}`);
        }
      } else {
        logger.debug(`User is not in a normal voice channel for reminder #${r.id}`);
      }
    });
  }

  if (r.delivery === 'text' || r.delivery === 'both' || !voiceDelivered) {
    let msg = `⏰ <@${r.userId}> — **Reminder:** ${r.text}`;
    if (!voiceDelivered && (r.delivery === 'voice' || r.delivery === 'both')) {
      msg += ' *(Fallback teks karena kamu tidak berada di voice channel atau bot kurang permission)*';
    }

    try {
      const fallbackChannel = await client.channels.fetch(r.fallbackChannelId).catch(() => null);
      if (fallbackChannel && fallbackChannel.isTextBased()) {
        await fallbackChannel.send({ 
          content: msg,
          allowedMentions: { parse: [], users: [r.userId] }
        });
        textDelivered = true;
        logger.info(`Text reminder #${r.id} sent to fallback channel ${r.fallbackChannelId}`);
      } else {
        throw new Error(`Fallback channel not accessible`);
      }
    } catch (err) {
      logger.error(`Text fallback failed for reminder #${r.id}: ${err.message}`);
      // Hierarchical Fallback: Try sending DM if origin channel fails
      try {
        const user = await client.users.fetch(r.userId).catch(() => null);
        if (user) {
          await user.send(msg);
          textDelivered = true;
          logger.info(`Text reminder #${r.id} sent via DM to user ${r.userId} as channel fallback`);
        }
      } catch (dmErr) {
        logger.error(`DM fallback also failed for reminder #${r.id}: ${dmErr.message}`);
      }
    }
  }

  if (voiceDelivered || textDelivered) {
    r.status = 'completed';
  } else {
    r.status = 'failed';
  }
}

export function getUserReminders(userId) {
  return listPendingRemindersForUser(userId)
    .map(r => ({
      id: r.id,
      text: r.text,
      triggerAt: r.triggerAt,
      remainingMs: r.triggerAt - Date.now(),
      delivery: r.delivery,
    }));
}

export function cancelReminder(id) {
  const cancelled = cancelReminderRow(id);
  if (!cancelled) return false;
  reminders = listReminderRows();
  logger.info(`⏰ Reminder #${id} cancelled`);
  return true;
}

export function cancelAllReminders(userId) {
  const count = cancelReminderRowsForUser(userId);
  reminders = listReminderRows();
  logger.info(`⏰ Cancelled ${count} reminders for user ${userId}`);
  return count;
}

export function setReminder({ guildId, userId, fallbackChannelId, text, delivery = 'text', triggerAt }) {
  const newReminder = createReminderRow({
    guildId,
    userId,
    fallbackChannelId,
    text,
    delivery,
    triggerAt,
    timezone: config.timezone || 'Asia/Bangkok',
    status: 'pending',
    createdAt: Date.now()
  });
  reminders = listReminderRows();

  logger.info(`⏰ Reminder #${newReminder.id} set: "${text}" triggering at ${new Date(triggerAt).toISOString()} (delivery: ${delivery})`);

  const remainingMs = triggerAt - Date.now();
  return { id: newReminder.id, triggerAt, durationText: formatDuration(remainingMs) };
}

// Export internal reminders array reference for tests
export function _setRemindersArray(arr) {
  reminders = arr;
}
export function _getRemindersArray() {
  return reminders;
}
export function _stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

export const stopReminderPolling = _stopPolling;
