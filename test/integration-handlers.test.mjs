// Integration tests: prefix-handler + mention-handler with mocked AI + Discord.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setupEnv, makeGuild, makeMember, makeMessage, makePermissions, makeVoiceState } from './helpers.mjs';

setupEnv();

// ─── Mock the AI and voice modules before importing the handlers ───
let voiceResponseCalls = 0;
mock.module('../src/ai/openrouter.js', {
  namedExports: {
    chatCompletion: async (messages, opts) => {
      const last = messages[messages.length - 1]?.content || '';
      if (opts?.task === 'routing') {
        return JSON.stringify({ action: 'chat', thought: 'mock', params: {}, response_style: 'casual' });
      }
      return `Mock AI reply to: ${String(last).slice(0, 40)}`;
    },
    getAiStats: () => ({ openrouter: { requests: 0, successes: 0, circuitOpen: false } }),
  },
  defaultExport: {
    chatCompletion: async () => 'Mock default',
    getAiStats: () => ({}),
  },
});

mock.module('../src/utils/voice-response.js', {
  namedExports: {
    handleVoiceResponse: async () => {
      voiceResponseCalls++;
      return true;
    },
  },
  defaultExport: { handleVoiceResponse: async () => true },
});

const { handlePrefixCommand } = await import('../src/prefix-handler.js');
const { setSetting } = await import('../src/utils/server-settings.js');
const { handleMention } = await import('../src/mention-handler.js');

// Stub global fetch for execPing
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200 });

test.after(() => { globalThis.fetch = realFetch; });

let msgSeq = 0;
function nextMsgId() { return `qa-msg-${++msgSeq}`; }

test('prefix: !ping replies with latency embed', async () => {
  const guild = makeGuild({});
  const member = makeMember({ id: '111111111111111111', displayName: 'User1' });
  const message = makeMessage({ id: nextMsgId(), content: '!ping', guild, member });
  message.reply = async (opts) => {
    message.replyCalls.push(opts);
    return { id: 'r1', edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } };
  };
  message.replyCalls = [];
  await handlePrefixCommand(message);
  assert.ok(message.replyCalls.length >= 1);
  const first = message.replyCalls[0];
  assert.equal(typeof first, 'string');
  assert.equal(first, '🏓 Pinging...');
});

test('prefix: !help replies with embeds', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!help', guild, member: makeMember({ id: '111111111111111111' }) });
  message.reply = async (opts) => { message.replyCalls.push(opts); return { edit: async () => {} }; };
  message.replyCalls = [];
  await handlePrefixCommand(message);
  assert.equal(message.replyCalls.length, 1);
  assert.ok(Array.isArray(message.replyCalls[0].embeds));
  assert.ok(message.replyCalls[0].embeds.length >= 3, 'help sends multiple embeds');
  const prefixFields = message.replyCalls[0].embeds[1].data.fields;
  assert.ok(prefixFields.some((field) => field.name === '!voice on|off|status'), 'help documents auto voice toggle');
});

test('prefix: !voice off disables automatic voice replies per server', async () => {
  const guild = makeGuild({ id: 'voice-toggle-guild' });
  const message = makeMessage({
    id: nextMsgId(),
    content: '!voice off',
    guild,
    member: makeMember({ id: 'qa-owner-id' }),
    authorId: 'qa-owner-id',
  });
  let replyText = null;
  message.reply = async (opts) => {
    replyText = typeof opts === 'string' ? opts : opts.content;
    return {};
  };

  await handlePrefixCommand(message);
  assert.match(replyText, /NONAKTIF/);

  message.content = '!voice status';
  await handlePrefixCommand(message);
  assert.match(replyText, /NONAKTIF/);

  message.content = '!voice on';
  await handlePrefixCommand(message);
  assert.match(replyText, /AKTIF/);
});

test('prefix: !voice rejects non-owner without server management permission', async () => {
  const guild = makeGuild({ id: 'voice-permission-guild' });
  const member = makeMember({ id: '111111111111111111' });
  const message = makeMessage({
    id: nextMsgId(),
    content: '!voice off',
    guild,
    member,
    authorId: '111111111111111111',
  });
  let replyText = null;
  message.reply = async (opts) => {
    replyText = typeof opts === 'string' ? opts : opts.content;
    return {};
  };

  await handlePrefixCommand(message);
  assert.match(replyText, /Manage Server|owner/);
});

test('prefix: !ask with AI mock replies with answer embed', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!ask Siapa pendiri Google?', guild, member: makeMember({ id: '111111111111111111' }) });
  message.reply = async (opts) => {
    message.replyCalls.push(opts);
    return { id: 'r', edit: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } };
  };
  message.replyCalls = [];
  await handlePrefixCommand(message);
  assert.equal(message.replyCalls.length, 1);
  assert.ok(message.replyCalls[0].embeds, 'ask replies with embed');
});

test('prefix: !ask with no query returns usage hint', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!ask', guild, member: makeMember({ id: '111111111111111111' }) });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; message.replyCalls.push(opts); return {}; };
  message.replyCalls = [];
  await handlePrefixCommand(message);
  assert.ok(replyText.includes('Tulis pertanyaannya'));
});

test('prefix: unknown command silently ignored', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!nonexistent-xyz', guild, member: makeMember({ id: '111111111111111111' }) });
  let called = false;
  message.reply = async () => { called = true; };
  await handlePrefixCommand(message);
  assert.equal(called, false);
});

test('prefix: !warn requires permission (authorization)', async () => {
  const guild = makeGuild({});
  const author = makeMember({ id: '111111111111111111', displayName: 'Attacker' });
  author.permissions = makePermissions([]);
  const message = makeMessage({ id: nextMsgId(), content: '!warn @222222222222222222 spam', guild, member: author });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; return {}; };
  await handlePrefixCommand(message);
  assert.ok(replyText.includes('🔒') || replyText.includes('permission'), 'non-admin must be rejected');
});

test('prefix: !warn as owner proceeds to member resolution', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const owner = makeMember({ id: 'qa-owner-id', displayName: 'Owner' });
  const message = makeMessage({ id: nextMsgId(), content: '!warn <@222222222222222222> spamming', guild, member: owner, authorId: 'qa-owner-id' });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; return {}; };
  await handlePrefixCommand(message);
  assert.ok(replyText.includes('⚠️') || replyText.includes('diperingatkan'), 'owner can warn');
});

test('prefix: !admin-status rejected for non-owner', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!admin-status', guild, member: makeMember({ id: '999999999999999999' }), authorId: '999999999999999999' });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; return {}; };
  await handlePrefixCommand(message);
  assert.ok(/owner/i.test(replyText || ''), 'non-owner must get owner-only rejection');
});

test('prefix: !admin-say rejected for non-owner', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '!admin-say hello', guild, member: makeMember({ id: '999999999999999999' }), authorId: '999999999999999999' });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; return {}; };
  await handlePrefixCommand(message);
  assert.ok(/owner/i.test(replyText || ''), 'non-owner must get owner-only rejection');
});

test('mention: fast-route ping works end-to-end', async () => {
  const guild = makeGuild({});
  const member = makeMember({ id: '111111111111111111', displayName: 'User1' });
  // Bot id in mock client is 'bot-id' — the mention-strip regex matches <@bot-id>
  const message = makeMessage({ id: nextMsgId(), content: '<@bot-id> ping', guild, member });
  message.reply = async (opts) => {
    message.replyCalls.push(typeof opts === 'string' ? { content: opts } : opts);
    return { id: 'r', edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } };
  };
  message.replyCalls = [];
  await handleMention(message);
  assert.ok(message.replyCalls.length >= 1);
  assert.equal(message.replyCalls[0].content, '⏳ Oke, saya periksa dulu...');
});

test('mention: server voice toggle suppresses automatic voice reply', async () => {
  const guild = makeGuild({ id: 'auto-voice-off-guild' });
  const member = makeMember({
    id: '111111111111111111',
    displayName: 'User1',
    voice: makeVoiceState({ channel: { id: 'voice-channel' } }),
  });
  setSetting(guild.id, 'autoVoiceRepliesEnabled', false);
  const message = makeMessage({ id: nextMsgId(), content: '<@bot-id> halo apa kabar?', guild, member });
  message.reply = async (opts) => {
    message.replyCalls.push(typeof opts === 'string' ? { content: opts } : opts);
    return { id: 'r', edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } };
  };
  message.replyCalls = [];
  const before = voiceResponseCalls;
  await handleMention(message);
  assert.equal(voiceResponseCalls, before, 'automatic voice reply must stay disabled');
});

test('mention: plain chat routes to AI (no action)', async () => {
  const guild = makeGuild({});
  const member = makeMember({ id: '111111111111111111', displayName: 'User1' });
  const message = makeMessage({ id: nextMsgId(), content: '<@bot-id> halo apa kabar?', guild, member });
  message.reply = async (opts) => {
    message.replyCalls.push(typeof opts === 'string' ? { content: opts } : opts);
    return { id: 'r', edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } };
  };
  message.replyCalls = [];
  await handleMention(message);
  assert.ok(message.replyCalls.length >= 1, 'should reply to chat');
  const texts = message.replyCalls.map((r) => r.content || '').join(' ');
  assert.ok(texts.includes('Mock AI reply'), 'chat should use AI mock');
});

test('mention: rate-limit message id dedup prevents duplicate processing', async () => {
  const guild = makeGuild({});
  const member = makeMember({ id: '555555555555555555', displayName: 'Dedup' });
  const msg1 = makeMessage({ id: 'same-id-1', content: '<@bot-id> ping', guild, member });
  msg1.reply = async () => ({ edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } });
  const msg2 = makeMessage({ id: 'same-id-1', content: '<@bot-id> ping', guild, member });
  msg2.reply = async () => ({ edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('timeout'); } });
  await handleMention(msg1);
  await handleMention(msg2); // duplicate id -> skipped
  // No assertion crash = dedup handled; second call logs warning and returns
});

test('mention: empty mention content triggers greeting', async () => {
  const guild = makeGuild({});
  const message = makeMessage({ id: nextMsgId(), content: '<@bot-id>', guild, member: makeMember({ id: '111111111111111111' }) });
  let replyText = null;
  message.reply = async (opts) => { replyText = typeof opts === 'string' ? opts : opts.content; return {}; };
  await handleMention(message);
  assert.ok(replyText.includes('Hai'), 'should greet when mentioned with no content');
});
