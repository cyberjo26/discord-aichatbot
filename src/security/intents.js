// Discord Gateway Intent Bits constants (zero external dependencies)
export const GatewayIntents = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1, // Privileged
  GUILD_MODERATION: 1 << 2,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8, // Privileged
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15 // Privileged
});

// Minimal OAuth2 permission bits
export const PermissionBits = Object.freeze({
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n
});

// Minimal safe baseline intent set (excludes privileged intents)
export const MINIMAL_SAFE_INTENTS = GatewayIntents.GUILDS | GatewayIntents.GUILD_MESSAGES;

// Minimal bot invite permission bitmask calculation
export function calculateMinimalPermissions() {
  return (
    PermissionBits.VIEW_CHANNEL |
    PermissionBits.SEND_MESSAGES |
    PermissionBits.EMBED_LINKS |
    PermissionBits.READ_MESSAGE_HISTORY
  ).toString();
}
