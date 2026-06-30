import 'dotenv/config';
import { REST, Routes } from 'discord.js';

// Import command data
import { data as askData } from './commands/ask.js';
import { data as chatData } from './commands/chat.js';
import { data as summarizeData } from './commands/summarize.js';
import { data as helpData } from './commands/help.js';
import { data as adminData } from './commands/admin.js';
import { data as pingData } from './commands/ping.js';
import { data as weatherData } from './commands/weather.js';
import { data as inviteData } from './commands/invite.js';

const commands = [
  askData,
  chatData,
  summarizeData,
  helpData,
  adminData,
  pingData,
  weatherData,
  inviteData
].map((cmd) => cmd.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('❌ DISCORD_TOKEN and DISCORD_CLIENT_ID are required in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

async function deploy() {
  try {
    console.log(`🔄 Deploying ${commands.length} slash commands...`);

    if (guildId) {
      // Guild-specific (instant, for development)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log(`✅ Commands deployed to guild ${guildId} (instant)`);
    } else {
      // Global (takes up to 1 hour to propagate)
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands,
      });
      console.log('✅ Commands deployed globally (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('❌ Failed to deploy commands:', err);
    process.exit(1);
  }
}

deploy();
