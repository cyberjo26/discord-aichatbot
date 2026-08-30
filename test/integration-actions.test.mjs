// Integration tests: moderation + voice actions with fully mocked Discord objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setupEnv, makeGuild, makeMember, makeChannel, makeMessage, makePermissions, makeVoiceState, makeReply } from './helpers.mjs';

setupEnv();

const { execTimeout, execBanKick, execWarn, execCreateChannel } = await import('../src/actions/moderation.js');
const { execVoiceCheck, execVoiceMod } = await import('../src/actions/voice.js');
const { execInvite } = await import('../src/actions/utility.js');

const OWNER = 'qa-owner-id';

// ─── Permission authorization (security-critical) ──────────────────

test('moderation: non-owner without ModerateMembers cannot timeout', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const author = makeMember({ id: '111111111111111111', displayName: 'Attacker', highestPosition: 5 });
  author.permissions = makePermissions([]);
  const message = makeMessage({ authorId: '111111111111111111', guild, member: author, content: 'timeout @victim' });
  const res = await execTimeout(message, { target_id: '<@222222222222222222>', duration: '10 menit' });
  assert.equal(res.success, false, 'must be rejected');
  assert.match(res.error, /permission/i);
});

test('moderation: owner bypasses permission check for timeout', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const owner = makeMember({ id: OWNER, displayName: 'Owner', highestPosition: 100 });
  const message = makeMessage({ authorId: OWNER, guild, member: owner });
  let timedOut = false;
  victim.timeout = async () => { timedOut = true; };
  const res = await execTimeout(message, { target_id: '<@222222222222222222>', duration: '10 menit' });
  assert.equal(res.success, true);
  assert.equal(timedOut, true);
});

test('moderation: cannot timeout guild owner', async () => {
  const guild = makeGuild({ ownerId: '333333333333333333' });
  const ownerMember = makeMember({ id: '333333333333333333', displayName: 'GuildOwner', highestPosition: 99 });
  guild.members.cache.set('333333333333333333', ownerMember);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 98 });
  mod.permissions = makePermissions([PermissionFlagsBits.ModerateMembers]);
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execTimeout(message, { target_id: '<@333333333333333333>', duration: '10 menit' });
  assert.equal(res.success, false);
  assert.match(res.error, /pemilik/i);
});

test('moderation: role hierarchy blocks moderation of higher roles', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 50 });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 60 });
  mod.permissions = makePermissions([PermissionFlagsBits.ModerateMembers]);
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execTimeout(message, { target_id: '<@222222222222222222>', duration: '10 menit' });
  assert.equal(res.success, false);
  assert.match(res.error, /terlalu tinggi/);
});

test('moderation: non-owner without KickMembers cannot kick', async () => {
  const guild = makeGuild({});
  const author = makeMember({ id: '111111111111111111', displayName: 'Attacker' });
  author.permissions = makePermissions([]);
  const message = makeMessage({ authorId: '111111111111111111', guild, member: author });
  const res = await execBanKick(message, { target_id: '<@222222222222222222>' }, 'kick');
  assert.equal(res.success, false);
  assert.match(res.error, /permission/i);
});

test('moderation: kick requires confirmation, cancel path', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 5 });
  mod.permissions = makePermissions([PermissionFlagsBits.KickMembers]);
  const reply = makeReply({ cancel: true });
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  message.reply = async () => reply;
  let kicked = false;
  victim.kick = async () => { kicked = true; };
  const res = await execBanKick(message, { target_id: '<@222222222222222222>', reason: 'spam' }, 'kick');
  assert.equal(res.success, true);
  assert.equal(res.type, 'cancelled');
  assert.equal(kicked, false, 'must not kick on cancel');
});

test('moderation: kick confirm path executes kick', async () => {
  const realNow = Date.now;
  Date.now = () => 1700000000000; // freeze time so confirmId is deterministic
  try {
    const guild = makeGuild({});
    const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
    guild.members.cache.set('222222222222222222', victim);
    const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 5 });
    mod.permissions = makePermissions([PermissionFlagsBits.KickMembers]);
    const confirmId = `confirm_kick_222222222222222222_${Date.now()}`;
    const reply = makeReply({ confirm: true, confirmId });
    const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
    message.reply = async () => reply;
    let kicked = false;
    victim.kick = async () => { kicked = true; };
    const res = await execBanKick(message, { target_id: '<@222222222222222222>', reason: 'spam' }, 'kick');
    assert.equal(res.success, true);
    assert.equal(res.type, 'kick');
    assert.equal(kicked, true, 'must kick on confirm');
  } finally {
    Date.now = realNow;
  }
});

test('moderation: warn signature stores string reason (regression: [object Object])', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 5 });
  mod.permissions = makePermissions([PermissionFlagsBits.ModerateMembers]);
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execWarn(message, { target_id: '<@222222222222222222>', reason: 'toxic behavior' });
  assert.equal(res.success, true);
  assert.equal(res.reason, 'toxic behavior');
  const { getWarnings } = await import('../src/utils/warnings.js');
  const list = getWarnings('guild-id', '222222222222222222');
  assert.equal(list.length >= 1, true);
  assert.notEqual(list[0].reason, '[object Object]', 'reason must not be [object Object]');
});

test('moderation: warn escalation — unified policy 3rd triggers timeout, 5th triggers kick', async () => {
  const { clearWarnings } = await import('../src/utils/warnings.js');
  clearWarnings('guild-id', '222222222222222222');
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim2', highestPosition: 1 });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod', highestPosition: 5 });
  mod.permissions = makePermissions([PermissionFlagsBits.ModerateMembers]);
  let timeoutCalls = 0, kickCalls = 0;
  victim.timeout = async () => { timeoutCalls++; };
  victim.kick = async () => { kickCalls++; };

  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  for (let i = 1; i <= 5; i++) {
    await execWarn(message, { target_id: '<@222222222222222222>', reason: `r${i}` });
  }
  assert.equal(timeoutCalls, 1, '3rd warning: auto timeout (unified ladder)');
  assert.equal(kickCalls, 1, '5th warning: auto kick (unified ladder)');
  clearWarnings('guild-id', '222222222222222222');
});

test('voice: execVoiceMod requires MuteMembers permission', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim' });
  guild.members.cache.set('222222222222222222', victim);
  const author = makeMember({ id: '111111111111111111', displayName: 'Attacker' });
  author.permissions = makePermissions([]);
  const message = makeMessage({ authorId: '111111111111111111', guild, member: author });
  const res = await execVoiceMod(message, { target_id: '<@222222222222222222>' }, 'mute');
  assert.equal(res.success, false);
  assert.match(res.error, /permission/i);
});

test('voice: execVoiceMod handles target not in voice', async () => {
  const guild = makeGuild({});
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', voice: makeVoiceState({ channelId: null }) });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod' });
  mod.permissions = makePermissions([PermissionFlagsBits.MuteMembers]);
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execVoiceMod(message, { target_id: '<@222222222222222222>' }, 'mute');
  assert.equal(res.success, false);
  assert.match(res.error, /tidak di voice/);
});

test('voice: execVoiceMod mute succeeds when target in VC', async () => {
  const guild = makeGuild({});
  const vc = makeChannel({ id: '900000000000000001', name: 'Lounge', type: 2 });
  const voiceState = makeVoiceState({ channelId: '900000000000000001', channel: vc });
  const victim = makeMember({ id: '222222222222222222', displayName: 'Victim', voice: voiceState });
  guild.members.cache.set('222222222222222222', victim);
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod' });
  mod.permissions = makePermissions([PermissionFlagsBits.MuteMembers]);
  let muted = false;
  voiceState.setMute = async () => { muted = true; };
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execVoiceMod(message, { target_id: '<@222222222222222222>' }, 'mute');
  assert.equal(res.success, true);
  assert.equal(muted, true);
});

test('voice: execVoiceCheck returns channel roster', async () => {
  const guild = makeGuild({});
  const vc = makeChannel({ id: '900000000000000001', name: 'Lounge', type: 2 });
  const m1 = makeMember({ id: '222222222222222222', displayName: 'Alice', voice: makeVoiceState({ selfMute: true, channelId: '900000000000000001' }) });
  vc.members.set('222222222222222222', m1);
  const vc2 = makeChannel({ id: '900000000000000002', name: 'Empty', type: 2 });
  guild.channels.cache.set('900000000000000001', vc);
  guild.channels.cache.set('900000000000000002', vc2);
  const message = makeMessage({ guild, member: makeMember({ id: '444444444444444444' }) });
  const res = await execVoiceCheck(message);
  assert.equal(res.success, true);
  assert.equal(res.data.length, 1, 'only non-empty channels listed');
  assert.equal(res.data[0].members[0].name, 'Alice');
  assert.ok(res.data[0].members[0].status.includes('muted'));
});

test('utility: execInvite builds proper OAuth URL', async () => {
  const message = makeMessage({});
  message.client.user.id = '900000000000000000';
  let sent = null;
  message.reply = async (opts) => { sent = opts; };
  const res = await execInvite(message);
  assert.equal(res.success, true);
  assert.ok(sent.components.length > 0);
  const url = sent.components[0].components[0].data.url;
  assert.ok(url.startsWith('https://discord.com/api/oauth2/authorize?client_id=900000000000000000'));
  assert.ok(url.includes('scope=bot%20applications.commands'));
});

test('moderation: execCreateChannel maps name & type params (regression: channel_name vs name)', async () => {
  const guild = makeGuild({});
  const mod = makeMember({ id: '444444444444444444', displayName: 'Mod' });
  mod.permissions = makePermissions([PermissionFlagsBits.ManageChannels]);
  let createdName = null;
  guild.channels.create = async ({ name, type }) => { createdName = name; return { id: '900000000000000003', name, type }; };
  const message = makeMessage({ authorId: '444444444444444444', guild, member: mod });
  const res = await execCreateChannel(message, { name: 'General-2', type: 'text' });
  assert.equal(res.success, true);
  assert.equal(createdName, 'General-2');
});
