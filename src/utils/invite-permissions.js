import { PermissionFlagsBits } from 'discord.js';

/**
 * ─── Invite Permissions ─────────────────────────────────────────────
 * Central list of Discord permissions the bot requests during OAuth
 * invite. Keep this list in sync with the features the bot actually
 * uses. All invite URL builders should import from this module so
 * there is only ONE source of truth.
 *
 * Evidence for each permission — grep these paths if a permission
 * needs to be removed or added:
 *   - ManageMessages   → src/actions/moderation.js, prefix-handler.js (prune, pin/unpin)
 *   - SendMessagesInThreads → prefix-handler.js (!act thread targets)
 *   - ModerateMembers  → src/actions/moderation.js (timeout, auto-timeout on warn)
 *   - KickMembers      → src/actions/moderation.js, prefix-handler.js (!kick)
 *   - BanMembers       → src/actions/moderation.js (execBanKick)
 *   - ManageChannels   → src/actions/moderation.js, utils/voicemaster.js
 *   - ManageRoles      → src/actions/moderation.js (role add/remove)
 *   - ManageNicknames  → src/actions/moderation.js, prefix-handler.js (!cn)
 *   - MuteMembers      → src/actions/voice.js, utils/voicemaster.js (!bungkam)
 *   - DeafenMembers    → src/actions/voice.js, utils/voicemaster.js
 *   - MoveMembers      → src/actions/voice.js, utils/voicemaster.js (!dc)
 *   - MentionEveryone  → src/mention-handler.js (announce/broadcast)
 *   - ChangeNickname   → bot's own nickname change
 */

// Ordered list of PermissionFlagsBits keys the invite requests.
export const INVITE_PERMISSION_KEYS = [
  // Baseline text
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'SendMessagesInThreads',
  'AddReactions',
  'UseExternalEmojis',
  'MentionEveryone',

  // Baseline voice
  'Connect',
  'Speak',
  'UseVAD',

  // Moderation — messages
  'ManageMessages',

  // Moderation — members
  'ModerateMembers',
  'KickMembers',
  'BanMembers',
  'ManageNicknames',
  'ChangeNickname',

  // Moderation — voice
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',

  // Server management
  'ManageChannels',
  'ManageRoles',
];

/**
 * Compute the invite permission bitfield as a BigInt string.
 * Missing keys are skipped safely so a discord.js upgrade that removes
 * a flag won't crash the invite command.
 * @returns {string} decimal string suitable for the OAuth `permissions` query param
 */
export function getInvitePermissionsBits() {
  let bits = 0n;
  for (const key of INVITE_PERMISSION_KEYS) {
    const flag = PermissionFlagsBits[key];
    if (typeof flag === 'bigint') {
      bits |= flag;
    }
  }
  return bits.toString();
}

/**
 * Build the OAuth invite URL for the given client id.
 * Scope stays `bot applications.commands` — the code has always shipped both.
 * @param {string} clientId
 * @returns {string}
 */
export function buildInviteUrl(clientId) {
  const permissions = getInvitePermissionsBits();
  return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
}

export default { INVITE_PERMISSION_KEYS, getInvitePermissionsBits, buildInviteUrl };
