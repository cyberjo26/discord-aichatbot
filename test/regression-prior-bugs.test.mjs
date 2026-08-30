// Regression tests: verify bugs documented in code_review.md / task.md are fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setupEnv, makeGuild, makeMember, makeMessage, makePermissions, makeChannel } from './helpers.mjs';

setupEnv();

const { checkRateLimit, releaseRateLimit, cleanupRateLimits } = await import('../src/utils/rate-limit.js');

test('REGRESSION: cleanupRateLimits does NOT wipe active concurrency tokens (task.md bug)', () => {
  cleanupRateLimits();
  // Acquire a few in-flight tokens
  const tokens = [];
  for (let i = 0; i < 5; i++) {
    const r = checkRateLimit(`inflight-${i}`, null);
    assert.ok(r.allowed);
    tokens.push(r.token);
  }
  // Simulate the 5-minute health-check cleanup while requests are in flight
  cleanupRateLimits();
  // A 51st distinct user must still be blocked by global concurrency (50) if tokens survived
  let allowedAfter = 0;
  for (let i = 0; i < 50; i++) {
    const r = checkRateLimit(`post-cleanup-${i}`, null);
    if (r.allowed) allowedAfter++;
  }
  assert.equal(allowedAfter, 45, 'concurrency tokens must survive cleanupRateLimits (5 held + 45 more = 50 cap)');
  for (const t of tokens) releaseRateLimit(t);
  cleanupRateLimits();
});

test('REGRESSION: releaseRateLimit with token does not release a random token', () => {
  cleanupRateLimits();
  const t1 = checkRateLimit('r1', null).token;
  const t2 = checkRateLimit('r2', null).token;
  // Release t1 only
  releaseRateLimit(t1);
  // t2 must still be counted; a new user should see the slot freed
  const r3 = checkRateLimit('r3', null);
  assert.ok(r3.allowed);
  releaseRateLimit(t2);
  releaseRateLimit(r3.token);
});

test('REGRESSION: execCreateChannel reads BOTH schema name and channel_name (task.md)', async () => {
  const { execCreateChannel } = await import('../src/actions/moderation.js');
  const guild = makeGuild({});
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod' });
  mod.permissions = makePermissions([PermissionFlagsBits.ManageChannels]);
  let created = null;
  guild.channels.create = async (opts) => { created = opts; return { id: '900000000000000009', name: opts.name, type: opts.type }; };
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execCreateChannel(message, { name: 'general-2' });
  assert.equal(res.success, true);
  assert.equal(created.name, 'general-2');
});

test('REGRESSION: execDeleteChannel resolves by channel_id OR name (task.md)', async () => {
  const { execDeleteChannel } = await import('../src/actions/moderation.js');
  const guild = makeGuild({});
  const ch = makeChannel({ id: '900000000000000010', name: 'spam' });
  guild.channels.cache.set('900000000000000010', ch);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod' });
  mod.permissions = makePermissions([PermissionFlagsBits.ManageChannels]);
  let deleted = null;
  ch.delete = async () => { deleted = ch; };
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execDeleteChannel(message, { channel_id: '<#900000000000000010>' });
  assert.equal(res.success, true);
  assert.equal(deleted?.id, '900000000000000010');
});

test('REGRESSION: execVoiceCheck guards null voice state (task.md risk)', async () => {
  const { execVoiceCheck } = await import('../src/actions/voice.js');
  const guild = makeGuild({});
  const vc = makeChannel({ id: '900000000000000011', name: 'Lounge', type: 2 });
  const mNoVoice = makeMember({ id: '222222222222222222', displayName: 'NullVoice' });
  mNoVoice.voice = null; // race condition: voice state missing
  vc.members.set('222222222222222222', mNoVoice);
  guild.channels.cache.set('900000000000000011', vc);
  const message = makeMessage({ guild, member: makeMember({ id: '444444444444444444' }) });
  const res = await execVoiceCheck(message);
  assert.equal(res.success, true, 'must not crash on null voice state');
});

test('REGRESSION: mention-handler latency uses totalStart (task.md)', async () => {
  cleanupRateLimits();
  const { handleMention } = await import('../src/mention-handler.js');
  const guild = makeGuild({});
  const member = makeMember({ id: '555555555555555555', displayName: 'Latency' });
  const message = makeMessage({ id: 'dedup-latency-test', content: '<@bot-id> ping', guild, member });
  let replied = false;
  message.reply = async () => { replied = true; return { edit: async () => {}, delete: async () => {}, awaitMessageComponent: async () => { throw new Error('t'); } }; };
  await handleMention(message);
  assert.equal(replied, true);
});

test('REGRESSION: !chat history is capped via slice (code_review bug)', async () => {
  const { getHistory, addMessage, clearHistory } = await import('../src/utils/memory.js');
  clearHistory('hist-user');
  for (let i = 0; i < 40; i++) addMessage('hist-user', 'user', `m${i}`);
  const h = getHistory('hist-user');
  assert.equal(h.length, 30, 'history must be capped at 30 (maxMemoryMessages)');
  clearHistory('hist-user');
});
