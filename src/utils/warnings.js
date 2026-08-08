import fs from 'fs';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';
import { sendModAlert } from './discord-helpers.js';

const WARNINGS_FILE = config.dataDir + '/warnings.json';
let warnings = {}; // { guildId: { userId: [{ reason, warnedBy, timestamp }] } }

/**
 * Initialize warnings from file
 */
export function initWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
      const totalWarns = Object.values(warnings).reduce((sum, guild) =>
        sum + Object.values(guild).reduce((s, arr) => s + arr.length, 0), 0
      );
      logger.info(`⚠️ Loaded ${totalWarns} warnings`);
    }
  } catch (err) {
    logger.warn(`Failed to load warnings: ${err.message}`);
    warnings = {};
  }
}

function save() {
  safeWriteJson(WARNINGS_FILE, warnings);
}

/**
 * Add a warning to a user
 */
export function addWarning(guildId, userId, reason, warnedBy) {
  if (!warnings[guildId]) warnings[guildId] = {};
  if (!warnings[guildId][userId]) warnings[guildId][userId] = [];

  const entry = {
    reason,
    warnedBy,
    timestamp: new Date().toISOString(),
  };

  warnings[guildId][userId].push(entry);
  save();

  return {
    total: warnings[guildId][userId].length,
    entry,
  };
}

/**
 * Get warnings for a user
 */
export function getWarnings(guildId, userId) {
  return (warnings[guildId] && warnings[guildId][userId]) || [];
}

/**
 * Unified warning escalation policy — the single source of truth for every
 * entry point (`!warn`, AI/mention `warn`, Hack Guard). Policy:
 *   - warning #3 → 10-minute timeout
 *   - warning #5 → kick (owner + role-hierarchy guarded; on failure fall back
 *     to a 1-hour timeout and alert mods via sendModAlert)
 *
 * @returns {{ action: 'none'|'timeout'|'kick', text: string }} — `text` is a
 * ready-to-append status line for the caller's reply.
 */
export async function applyWarningEscalation({ guild, member, total, channelId = null }) {
  if (total === 3) {
    try {
      await member.timeout(10 * 60 * 1000, 'Auto-timeout: 3 warnings reached');
      return { action: 'timeout', text: '\n⏱️ **Auto-timeout 10 menit** diterapkan (3 peringatan tercapai).' };
    } catch {
      return { action: 'timeout', text: '\n⚠️ Gagal menerapkan auto-timeout (bot tidak memiliki permission).' };
    }
  }

  if (total >= 5) {
    let kickFailedReason = null;
    try {
      if (member.id === guild.ownerId) {
        kickFailedReason = 'User adalah owner server.';
      } else {
        const botMember = await guild.members.fetchMe();
        if (member.roles.highest.position >= botMember.roles.highest.position) {
          kickFailedReason = 'Role user sama/lebih tinggi dari bot.';
        } else {
          await member.kick('5/5 warnings reached — auto-kick');
          return { action: 'kick', text: '\n🔨 **Auto-kick diterapkan** (5+ peringatan tercapai).' };
        }
      }
    } catch (err) {
      kickFailedReason = err.message;
    }

    // Kick blocked or failed — fall back to a 1-hour timeout and alert mods
    let text = '';
    try {
      await member.timeout(60 * 60 * 1000, `Auto-timeout: 5+ warnings reached (kick gagal: ${kickFailedReason})`);
      text = '\n⏱️ **Auto-timeout 1 jam** diterapkan (5+ peringatan tercapai).';
    } catch { /* timeout also failed — mod alert is still sent below */ }

    if (channelId) {
      await sendModAlert(
        guild,
        `**Warning 5/5:** auto-kick gagal untuk <@${member.id}>`,
        `**Alasan:** ${kickFailedReason}\n` +
        `**User:** <@${member.id}> (${member.displayName})\n` +
        `**Channel:** <#${channelId}>\n` +
        `**Total warning:** ${total}/5\n` +
        `⚠️ Perlu tindakan manual (kick/ban).`
      );
    }
    return { action: 'kick', text: `${text}\n⚠️ Auto-kick gagal: ${kickFailedReason}` };
  }

  return { action: 'none', text: '' };
}

/**
 * Clear all warnings for a user
 */
export function clearWarnings(guildId, userId) {
  if (warnings[guildId] && warnings[guildId][userId]) {
    const count = warnings[guildId][userId].length;
    delete warnings[guildId][userId];
    save();
    return count;
  }
  return 0;
}

export default { initWarnings, addWarning, getWarnings, clearWarnings };
