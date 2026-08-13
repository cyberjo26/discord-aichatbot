import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { commandData } from './commands/index.js';

/**
 * Register slash commands with Discord.
 *
 * - Global: available in every server the bot is in. Existing servers pick
 *   these up quickly; brand-new servers can take up to ~1 hour to propagate.
 * - Guild (GUILD_ID): optional instant override for a single dev guild, which
 *   is useful during development to see changes immediately.
 *
 * Returns metadata about what was deployed so callers can log it.
 */
export async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID || null;

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  // Global — this is what makes commands appear in every server.
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });

  // Optional dev-guild override for instant updates while developing.
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
  }

  return { global: true, guildId, count: commandData.length };
}

// When run directly (`npm run deploy-commands`), deploy and exit.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerCommands()
    .then(({ guildId, count }) => {
      console.log(
        `✅ Deployed ${count} slash commands globally${guildId ? ` + guild ${guildId} (instant)` : ''}`
      );
    })
    .catch((err) => {
      console.error('❌ Failed to deploy commands:', err);
      process.exit(1);
    });
}
