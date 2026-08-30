// New bugs found during this QA pass.
// These assert CORRECT behavior, so they fail while the bug exists.
// They serve as documentation + fix verification targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setupEnv, makeGuild, makeMember, makeMessage, makePermissions } from './helpers.mjs';

setupEnv();

const { parseDuration, formatDuration } = await import('../src/utils/reminders.js');
const { execTimeout } = await import('../src/actions/moderation.js');

test('BUG-1: parseDuration compact unit forms must not double-count', () => {
  // compact '1h' matches BOTH the h(?![a-z]) pattern AND the (\d+)h pattern -> 2x
  assert.equal(parseDuration('1h'), 60 * 60 * 1000, '1h = 1 hour');
  assert.equal(parseDuration('10m'), 10 * 60 * 1000, '10m = 10 minutes');
  assert.equal(parseDuration('30s'), 30 * 1000, '30s = 30 seconds');
  assert.equal(parseDuration('1h30m'), 90 * 60 * 1000, '1h30m = 90 minutes');
  // English word forms previously double-counted too (1 hour -> 2 hours)
  assert.equal(parseDuration('1 hour'), 60 * 60 * 1000, '1 hour = 1 hour, not 2');
  assert.equal(parseDuration('10 minutes'), 10 * 60 * 1000, '10 minutes = 10 minutes');
  assert.equal(parseDuration('30 sec'), 30 * 1000, '30 sec = 30 seconds');
  // Days now supported (keeps !to/@bot consistent with execTimeout)
  assert.equal(parseDuration('2 hari'), 2 * 24 * 60 * 60 * 1000, '2 hari = 2 days');
  assert.equal(parseDuration('2d'), 2 * 24 * 60 * 60 * 1000, '2d = 2 days');
  assert.equal(parseDuration('1d30m'), 24 * 60 * 60 * 1000 + 30 * 60 * 1000, '1d30m sums');
  assert.equal(formatDuration(2 * 24 * 60 * 60 * 1000), '2 hari');
});

test('BUG-2: execTimeout parses Indonesian durations correctly', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 5 });
  mod.permissions = makePermissions([PermissionFlagsBits.ModerateMembers]);
  let lastDuration = null;
  victim.timeout = async (ms) => { lastDuration = ms; };
  const message = makeMessage({ id: 'bugs-1', authorId: '444444444444444444', guild, member: mod });

  // "jam" contains 'm' -> currently parsed as minutes (should be hours)
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '1 jam' });
  assert.equal(lastDuration, 60 * 60 * 1000, '"1 jam" should be 1 hour, not 1 minute');

  // "hari" contains 'h' -> currently parsed as hours (should be days)
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '2 hari' });
  assert.equal(lastDuration, 2 * 24 * 60 * 60 * 1000, '"2 hari" should be 2 days');

  // "detik" contains 'd' -> currently parsed as days (should be seconds)
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '30 detik' });
  assert.equal(lastDuration, 30 * 1000, '"30 detik" should be 30 seconds');

  // compact forms + decimals + compounds + Discord 28-day cap clamp
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '2d' });
  assert.equal(lastDuration, 2 * 24 * 60 * 60 * 1000, '"2d" should be 2 days');
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '1.5 jam' });
  assert.equal(lastDuration, 1.5 * 60 * 60 * 1000, '"1.5 jam" should be 1.5 hours');
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '1h30m' });
  assert.equal(lastDuration, 90 * 60 * 1000, '"1h30m" should be 90 minutes');
  await execTimeout(message, { target_id: '<@222222222222222222>', duration: '30 hari' });
  assert.equal(lastDuration, 28 * 24 * 60 * 60 * 1000, '"30 hari" clamps to Discord 28-day cap');
});
