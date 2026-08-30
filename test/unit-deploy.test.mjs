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
    calls.push({ type: 'put', route, body: opts.body });
    return [];
  }
  async get(route) {
    calls.push({ type: 'get', route });
    if (route === 'users/@me/guilds') {
      return [{ id: 'guild-1' }, { id: 'guild-2' }];
    }
    return [];
  }
}

const Routes = {
  applicationCommands: (clientId) => `global/${clientId}`,
  applicationGuildCommands: (clientId, guildId) => `guild/${clientId}/${guildId}`,
  userGuilds: () => 'users/@me/guilds',
};

// Keep real SlashCommandBuilder/EmbedBuilder/etc for the command modules;
// replace only REST and Routes so the network is never touched.
mock.module('discord.js', {
  namedExports: { ...realDiscord, REST: FakeREST, Routes },
});

const { registerCommands, cleanAllGuildCommands } = await import('../src/deploy-commands.js');

test('deploy: registers globally to all servers', async () => {
  calls.length = 0;
  process.env.DISCORD_TOKEN = 'tok';
  process.env.DISCORD_CLIENT_ID = 'client-123';
  delete process.env.GUILD_ID;

  const result = await registerCommands();

  assert.equal(calls.length, 1, 'exactly one global PUT, no guild PUT');
  assert.equal(calls[0].route, 'global/client-123');
  assert.equal(calls[0].body.length, 10, 'all 10 commands deployed');
  assert.equal(result.count, 10);
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

test('deploy: cleanAllGuildCommands cleans guild-specific commands from all joined servers', async () => {
  calls.length = 0;
  process.env.DISCORD_TOKEN = 'tok';
  process.env.DISCORD_CLIENT_ID = 'client-123';

  const result = await cleanAllGuildCommands();

  assert.equal(result.cleanedCount, 2);
  const putCalls = calls.filter((c) => c.type === 'put');
  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].route, 'guild/client-123/guild-1');
  assert.deepEqual(putCalls[0].body, []);
  assert.equal(putCalls[1].route, 'guild/client-123/guild-2');
  assert.deepEqual(putCalls[1].body, []);
});

test('deploy: throws when token or clientId missing', async () => {
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_CLIENT_ID;
  await assert.rejects(() => registerCommands(), /DISCORD_TOKEN and DISCORD_CLIENT_ID/);
});
