// Slash command deployment logic tests.
// Mocks discord.js REST/Routes so no real Discord API call is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as realDiscord from 'discord.js';

const calls = [];
class FakeREST {
  setToken(token) {
    this.token = token;
    return this;
  }
  async put(route, opts) {
    calls.push({ route, body: opts.body });
    return [];
  }
}

const Routes = {
  applicationCommands: (clientId) => `global/${clientId}`,
  applicationGuildCommands: (clientId, guildId) => `guild/${clientId}/${guildId}`,
};

// Keep real SlashCommandBuilder/EmbedBuilder/etc for the command modules;
// replace only REST and Routes so the network is never touched.
mock.module('discord.js', {
  namedExports: { ...realDiscord, REST: FakeREST, Routes },
});

const { registerCommands } = await import('../src/deploy-commands.js');

test('deploy: registers globally to all servers', async () => {
  calls.length = 0;
  process.env.DISCORD_TOKEN = 'tok';
  process.env.DISCORD_CLIENT_ID = 'client-123';
  delete process.env.GUILD_ID;

  const result = await registerCommands();

  assert.equal(calls.length, 1, 'exactly one global PUT, no guild PUT');
  assert.equal(calls[0].route, 'global/client-123');
  assert.equal(calls[0].body.length, 9, 'all 9 commands deployed');
  assert.equal(result.count, 9);
  assert.equal(result.guildId, null);
});

test('deploy: also registers to dev guild when GUILD_ID set', async () => {
  calls.length = 0;
  process.env.DISCORD_TOKEN = 'tok';
  process.env.DISCORD_CLIENT_ID = 'client-123';
  process.env.GUILD_ID = 'guild-456';

  const result = await registerCommands();

  assert.equal(calls.length, 2, 'global PUT + guild PUT');
  assert.equal(calls[0].route, 'global/client-123');
  assert.equal(calls[1].route, 'guild/client-123/guild-456');
  assert.equal(result.guildId, 'guild-456');
});

test('deploy: throws when token or clientId missing', async () => {
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_CLIENT_ID;
  await assert.rejects(() => registerCommands(), /DISCORD_TOKEN and DISCORD_CLIENT_ID/);
});
