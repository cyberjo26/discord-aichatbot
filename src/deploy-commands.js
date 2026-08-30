import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { commandData } from './commands/index.js';

export function resolveClientId(token, explicitClientId = null) {
  if (explicitClientId && typeof explicitClientId === 'string' && /^\d{17,20}$/.test(explicitClientId.trim())) {
    return explicitClientId.trim();
  }
  const envId = process.env.DISCORD_CLIENT_ID;
  if (token && token.includes('.')) {
    try {
      const decoded = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
      if (/^\d{17,20}$/.test(decoded)) {
        return decoded;
      }
    } catch {
      // fallback
    }
  }
  return envId?.trim() || null;
}

/**
 * Register slash commands with Discord.
 *
 * - Global: available in every server the bot is in. Overwrites global registry,
 *   wiping out any obsolete slash commands (like /play, /nowplaying, /search).
 * - Guild (GUILD_ID): optional instant override for a single dev guild, which
 *   is useful during development to see changes immediately.
 *
 * Returns metadata about what was deployed so callers can log it.
 */
export async function registerCommands(explicitClientId = null) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = resolveClientId(token, explicitClientId);
  const guildId = process.env.GUILD_ID || null;

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  // Global — registers active commands and removes any old global commands
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });

  // Optional dev-guild override for instant updates while developing.
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
  }

  return { global: true, guildId, count: commandData.length };
}

/**
 * Wipe any legacy guild-specific commands across all servers the bot is in.
 * Ensures no leftover guild-scoped commands (e.g. /play, /nowplaying, /search) remain.
 */
export async function cleanAllGuildCommands(explicitClientId = null) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = resolveClientId(token, explicitClientId);

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  let cleanedCount = 0;

  try {
    const guilds = await rest.get(Routes.userGuilds());
    if (Array.isArray(guilds)) {
      for (const guild of guilds) {
        try {
          await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
          cleanedCount++;
        } catch {
          // ignore permissions errors on single guilds
        }
      }
    }
  } catch {
    // If fetching user guilds fails, clean GUILD_ID if configured
    if (process.env.GUILD_ID) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, process.env.GUILD_ID), { body: [] });
        cleanedCount++;
      } catch {
        // ignore fallback errors
      }
    }
  }

  return { cleanedCount };
}

// When run directly (`npm run deploy-commands`), deploy and exit.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const shouldCleanGuilds = process.argv.includes('--clean-guilds') || process.argv.includes('--clean');

  (async () => {
    if (shouldCleanGuilds) {
      console.log('🧹 Cleaning legacy guild-specific commands from all servers...');
      const { cleanedCount } = await cleanAllGuildCommands();
      console.log(`✅ Cleaned guild-specific commands from ${cleanedCount} server(s).`);
    }

    const { guildId, count } = await registerCommands();
    console.log(
      `✅ Deployed ${count} slash commands globally${guildId ? ` + guild ${guildId} (instant)` : ''}`
    );
  })().catch((err) => {
    console.error('❌ Failed to deploy commands:', err);
    process.exit(1);
  });
}
