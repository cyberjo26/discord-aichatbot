// Unified warning escalation policy tests.
// Pins the single source of truth (warnings.js#applyWarningEscalation):
//   #3 -> 10-min timeout
//   #5 -> kick (owner + role-hierarchy guarded; 1h-timeout + mod-alert fallback)
// All other totals -> no action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, makeGuild, makeMember, makeChannel } from './helpers.mjs';

setupEnv();

const { applyWarningEscalation } = await import('../src/utils/warnings.js');

const spyMember = ({ id = '222222222222222222', highestPosition = 1 } = {}) => {
  const calls = { timeout: [], kick: [] };
  // highestPosition goes through makeMember so it lands on roles.highest.position
  const member = makeMember({ id, displayName: 'Victim', highestPosition });
  member.timeout = async (ms, reason) => { calls.timeout.push({ ms, reason }); };
  member.kick = async (reason) => { calls.kick.push(reason); };
  return { member, calls };
};

test('warnings: totals below/above thresholds do not act (1, 2, 4)', async () => {
  for (const total of [1, 2, 4]) {
    const { member, calls } = spyMember();
    const guild = makeGuild({});
    const res = await applyWarningEscalation({ guild, member, total });
    assert.equal(res.action, 'none', `total ${total} must not escalate`);
    assert.equal(res.text, '');
    assert.equal(calls.timeout.length, 0, `total ${total}: no timeout`);
    assert.equal(calls.kick.length, 0, `total ${total}: no kick`);
  }
});

test('warnings: #3 applies a 10-minute timeout', async () => {
  const { member, calls } = spyMember();
  const res = await applyWarningEscalation({ guild: makeGuild({}), member, total: 3 });
  assert.equal(res.action, 'timeout');
  assert.equal(calls.timeout.length, 1);
  assert.equal(calls.timeout[0].ms, 10 * 60 * 1000, 'must be exactly 10 minutes');
  assert.equal(calls.kick.length, 0);
  assert.match(res.text, /10 menit/);
});

test('warnings: #3 timeout failure reports failure without throwing', async () => {
  const { member, calls } = spyMember();
  member.timeout = async () => { throw new Error('no permission'); };
  const res = await applyWarningEscalation({ guild: makeGuild({}), member, total: 3 });
  assert.equal(res.action, 'timeout');
  assert.match(res.text, /Gagal menerapkan auto-timeout/);
  assert.equal(calls.kick.length, 0);
});

test('warnings: #5 kicks when hierarchy allows', async () => {
  const { member, calls } = spyMember();
  const res = await applyWarningEscalation({ guild: makeGuild({}), member, total: 5 });
  assert.equal(res.action, 'kick');
  assert.equal(calls.kick.length, 1);
  assert.equal(calls.timeout.length, 0, 'no fallback timeout on successful kick');
  assert.match(res.text, /Auto-kick diterapkan/);
});

test('warnings: #5 cannot kick the guild owner — 1h fallback timeout', async () => {
  const { member, calls } = spyMember({ id: 'owner-id' });
  const res = await applyWarningEscalation({ guild: makeGuild({ ownerId: 'owner-id' }), member, total: 5 });
  assert.equal(res.action, 'kick', 'action reports kick intent even when blocked');
  assert.equal(calls.kick.length, 0, 'owner must never be kicked');
  assert.equal(calls.timeout.length, 1);
  assert.equal(calls.timeout[0].ms, 60 * 60 * 1000, 'fallback is exactly 1 hour');
  assert.match(res.text, /Auto-kick gagal: User adalah owner server/);
});

test('warnings: #5 skips kick when target role is not below bot', async () => {
  const guild = makeGuild({});
  // Use the bot's actual position so the test stays robust if it changes
  const botPosition = (await guild.members.fetchMe()).roles.highest.position;
  const { member, calls } = spyMember({ highestPosition: botPosition });
  const res = await applyWarningEscalation({ guild, member, total: 5 });
  assert.equal(res.action, 'kick');
  assert.equal(calls.kick.length, 0, 'must not kick equal/higher role');
  assert.equal(calls.timeout.length, 1, 'falls back to 1h timeout');
  assert.match(res.text, /Role user sama\/lebih tinggi dari bot/);
});

test('warnings: #5 blocked kick sends mod alert when channelId is given', async () => {
  const { member, calls } = spyMember({ id: 'owner-id' });
  const modLog = makeChannel({ id: 'mod-log-1' });
  let alertSent = false;
  modLog.send = async () => { alertSent = true; };
  const guild = makeGuild({ ownerId: 'owner-id', channels: [modLog] });
  const config = (await import('../src/config.js')).default;
  const prev = config.modLogChannelId;
  config.modLogChannelId = 'mod-log-1';
  try {
    const res = await applyWarningEscalation({ guild, member, total: 5, channelId: 'mod-log-1' });
    assert.equal(res.action, 'kick');
    assert.equal(calls.kick.length, 0, 'owner is never kicked');
    assert.equal(calls.timeout.length, 1, '1h fallback timeout');
    assert.equal(alertSent, true, 'mod alert must fire on blocked kick');
  } finally {
    config.modLogChannelId = prev;
  }
});

test('warnings: #5 kick API failure falls back to 1h timeout', async () => {
  const { member, calls } = spyMember();
  // Record the attempt, then fail like the Discord API would
  member.kick = async () => { calls.kick.push('attempt'); throw new Error('Missing Permissions'); };
  const res = await applyWarningEscalation({ guild: makeGuild({}), member, total: 5 });
  assert.equal(res.action, 'kick');
  assert.equal(calls.kick.length, 1, 'kick was attempted');
  assert.equal(calls.timeout.length, 1, 'fallback 1h timeout applied');
  assert.match(res.text, /Auto-kick gagal: Missing Permissions/);
});

test('warnings: total 6+ still escalates to kick (>= 5)', async () => {
  const { member, calls } = spyMember();
  const res = await applyWarningEscalation({ guild: makeGuild({}), member, total: 7 });
  assert.equal(res.action, 'kick');
  assert.equal(calls.kick.length, 1);
});
