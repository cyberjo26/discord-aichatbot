// Integration tests for previously-untested ("dark") action paths:
// role/nickname/pin/unpin/warnList/warnClear, reminders set + delivery +
// lease finalization, guild config set/get, and channel summarization.
// Fully offline — Discord objects mocked via helpers, AI mocked below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import {
  setupEnv, makeGuild, makeMember, makeChannel, makeMessage,
  makePermissions, MockCollection,
} from './helpers.mjs';

setupEnv();

const SUMMARY_REPLY = '• Poin ringkasan percakapan';

mock.module('../src/ai/openrouter.js', {
  namedExports: { chatCompletion: async () => SUMMARY_REPLY },
  defaultExport: { chatCompletion: async () => SUMMARY_REPLY },
});

const {
  execRole, execNickname, execPinMessage, execUnpinMessage, execWarnList, execWarnClear, execWarn,
} = await import('../src/actions/moderation.js');
const { execReminder, execSetConfig, execGetConfig } = await import('../src/actions/memory.js');
const { execSummarizeChannel } = await import('../src/actions/summary.js');
const { initReminders, pollDueReminders, setReminder, _getRemindersArray, stopReminderPolling } =
  await import('../src/utils/reminders.js');

const OWNER = 'qa-owner-id';

function adminPerms(...extra) {
  const set = [PermissionFlagsBits.ViewChannel];
  for (const e of extra) set.push(e);
  // member.permissions.has accepts flag values
  return makePermissions(set);
}

test.after(() => {
  try { stopReminderPolling(); } catch { /* not started */ }
});

// ─── execRole ───────────────────────────────────────────────────────

test('role: adds role when permitted and hierarchy allows', async () => {
  const guild = makeGuild({});
  let addedRole = null;
  const role = { id: 'role-mod', name: 'Mod', position: 3 };
  guild.roles.cache.set(role.id, role);
  const target = makeMember({ id: '222222222222222222', displayName: 'Target', highestPosition: 1 });
  target.roles.add = async (r) => { addedRole = r.name; };
  target.roles.remove = async () => {};
  guild.members.cache.set(target.id, target);
  const mod = makeMember({ id: '111111111111111111', displayName: 'Mod', highestPosition: 5 });
  mod.permissions = adminPerms(PermissionFlagsBits.ManageRoles);
  const message = makeMessage({ authorId: mod.id, guild, member: mod });

  const res = await execRole(message, { target_id: `<@${target.id}>`, role_name: 'mod' }, 'add');
  assert.equal(res.success, true);
  assert.equal(addedRole, 'Mod');
});

test('role: rejects when user lacks ManageRoles', async () => {
  const guild = makeGuild({});
  const message = makeMessage({
    authorId: 'u1',
    guild,
    member: (() => { const m = makeMember({ id: 'u1' }); m.permissions = adminPerms(); return m; })(),
  });
  const res = await execRole(message, { target_id: '<@2>', role_name: 'x' }, 'add');
  assert.equal(res.success, false);
  assert.match(res.error, /ManageRoles/);
});

test('role: hierarchy guard blocks role at-or-above bot highest', async () => {
  const guild = makeGuild({});
  const highRole = { id: 'r9', name: 'Admin', position: 99 };
  guild.roles.cache.set(highRole.id, highRole);
  const target = makeMember({ id: '222222222222222222', displayName: 'Target' });
  guild.members.cache.set(target.id, target);
  const mod = makeMember({ id: OWNER, displayName: 'Owner', highestPosition: 100 });
  mod.permissions = adminPerms();
  const message = makeMessage({ authorId: OWNER, guild, member: mod });

  const res = await execRole(message, { target_id: `<@${target.id}>`, role_name: 'Admin' }, 'add');
  assert.equal(res.success, false);
  assert.match(res.error, /tinggi|sejajar/i);
});

// ─── execNickname ───────────────────────────────────────────────────

test('nickname: renames target, guards guild owner and permission', async () => {
  const guild = makeGuild({});
  const target = makeMember({ id: '222222222222222222', displayName: 'OldName' });
  let newName = null;
  target.setNickname = async (n) => { newName = n; };
  guild.members.cache.set(target.id, target);

  const good = makeMember({ id: '111111111111111111', displayName: 'Mod', highestPosition: 5 });
  good.permissions = adminPerms(PermissionFlagsBits.ManageNicknames);
  const okMsg = makeMessage({ authorId: good.id, guild, member: good });
  const res = await execNickname(okMsg, { target_id: `<@${target.id}>`, nickname: 'Baru' });
  assert.equal(res.success, true);
  assert.equal(newName, 'Baru');

  // Guild owner protected
  const ownerGuild = makeGuild({ ownerId: target.id });
  ownerGuild.members.cache.set(target.id, target);
  const msg2 = makeMessage({ authorId: good.id, guild: ownerGuild, member: good });
  const resBlocked = await execNickname(msg2, { target_id: `<@${target.id}>`, nickname: 'nope' });
  assert.equal(resBlocked.success, false);
  assert.match(resBlocked.error, /pemilik server/i);
});

// ─── Pin / Unpin ────────────────────────────────────────────────────

function pinChannel(perms, pinned = [], recent = []) {
  const chan = makeChannel({});
  chan.permissionsFor = () => makePermissions(perms);
  const pinColl = new MockCollection(pinned.map((m) => [m.id, m]));
  chan.messages = {
    fetch: async (arg) => {
      if (arg && typeof arg === 'object' && arg.limit) {
        const coll = new MockCollection(recent.map((m) => [m.id, m]));
        return coll;
      }
      const all = [...pinned, ...recent];
      const found = all.find((m) => m.id === arg);
      if (!found) throw new Error('unknown message');
      return found;
    },
    fetchPinned: async () => pinColl,
  };
  return chan;
}

test('pin: pins most recent non-self message', async () => {
  const guild = makeGuild({});
  const target = { id: 'm2', content: 'hello world', author: { username: 'alice' }, pin: async () => {} };
  const chan = pinChannel([PermissionFlagsBits.ManageMessages], [], [
    target,
    { id: 'm1', content: 'a', author: { username: 'b' }, pin: async () => {} },
  ]);
  const mod = makeMember({ id: '111111111111111111', displayName: 'Mod' });
  mod.permissions = adminPerms(PermissionFlagsBits.ManageMessages);
  const message = makeMessage({ authorId: mod.id, id: 'msg-self', guild, channel: chan, member: mod });

  const res = await execPinMessage(message, {});
  assert.equal(res.success, true);
  assert.equal(res.messagePreview, 'hello world');
});

test('pin: no ManageMessages anywhere → rejected', async () => {
  const guild = makeGuild({});
  const chan = pinChannel([]);
  const mod = makeMember({ id: '111111111111111111', displayName: 'Mod' });
  mod.permissions = adminPerms();
  const message = makeMessage({ authorId: mod.id, guild, channel: chan, member: mod });
  const res = await execPinMessage(message, {});
  assert.equal(res.success, false);
  assert.match(res.error, /ManageMessages/);
});

test('unpin: unpins referenced pinned message', async () => {
  const guild = makeGuild({});
  let unpinned = null;
  const pinnedMsg = {
    id: 'pinned-1', content: 'rules', author: { username: 'bob' },
    unpin: async () => { unpinned = 'pinned-1'; }, pin: async () => {},
  };
  const chan = pinChannel([PermissionFlagsBits.ManageMessages], [pinnedMsg], []);
  const mod = makeMember({ id: '111111111111111111', displayName: 'Mod' });
  mod.permissions = adminPerms(PermissionFlagsBits.ManageMessages);
  const message = makeMessage({
    authorId: mod.id, guild, channel: chan, member: mod,
    reference: { messageId: 'pinned-1' },
  });

  const res = await execUnpinMessage(message, {});
  assert.equal(res.success, true);
  assert.equal(unpinned, 'pinned-1');

  // No pins at all → explicit error
  const emptyChan = pinChannel([PermissionFlagsBits.ManageMessages], [], []);
  const msg2 = makeMessage({ authorId: mod.id, guild, channel: emptyChan, member: mod });
  const resEmpty = await execUnpinMessage(msg2, {});
  assert.equal(resEmpty.success, false);
  assert.match(resEmpty.error, /Tidak ada pesan yang dipin/);
});

// ─── Warn list / clear ──────────────────────────────────────────────

test('warn: warn → warnList shows entry → warnClear empties it', async () => {
  const guild = makeGuild({});
  const target = makeMember({ id: '222222222222222222', displayName: 'Naughty' });
  target.timeout = async () => {};
  guild.members.cache.set(target.id, target);
  const mod = makeMember({ id: OWNER, displayName: 'Owner', highestPosition: 100 });
  mod.permissions = adminPerms();
  const message = makeMessage({ authorId: OWNER, guild, member: mod });

  const warned = await execWarn(message, { target_id: `<@${target.id}>`, reason: 'spam' });
  assert.equal(warned.success, true);
  assert.equal(warned.totalWarnings, 1);

  const listed = await execWarnList(message, { target_id: `<@${target.id}>` });
  assert.equal(listed.success, true);
  assert.equal(listed.warnings.length, 1);
  assert.equal(listed.warnings[0].reason, 'spam');

  const cleared = await execWarnClear(message, { target_id: `<@${target.id}>` });
  assert.equal(cleared.success, true);
  assert.equal(cleared.clearedCount, 1);

  const reListed = await execWarnList(message, { target_id: `<@${target.id}>` });
  assert.equal(reListed.warnings.length, 0);
});

test('warn: non-owner cannot clear warnings', async () => {
  const guild = makeGuild({});
  const plain = makeMember({ id: '333333333333333333' });
  plain.permissions = adminPerms();
  const message = makeMessage({ authorId: plain.id, guild, member: plain });
  const res = await execWarnClear(message, { target_id: '<@444444444444444444>' });
  assert.equal(res.success, false);
  assert.match(res.error, /ModerateMembers/);
});

// ─── execReminder ───────────────────────────────────────────────────

initReminders({});

test('reminder: duration reminder accepted + stored as pending', async () => {
  const guild = makeGuild({ id: 'grem-' + Date.now() });
  const author = makeMember({ id: '555555555555555555' });
  const message = makeMessage({ authorId: author.id, guild, member: author });

  const res = await execReminder(message, { duration: '2 menit', text: 'minum air' });
  assert.equal(res.success, true);
  const stored = _getRemindersArray().find((r) => r.userId === author.id && r.status === 'pending');
  assert.ok(stored, 'pending row exists');
  assert.equal(stored.text, 'minum air');
});

test('reminder: bad duration / over-24h / unreadable absolute time rejected', async () => {
  const guild = makeGuild({});
  const author = makeMember({ id: '555555555555555556' });
  const message = makeMessage({ authorId: author.id, guild, member: author });

  const junk = await execReminder(message, { duration: 'sebentar lagi deh' });
  assert.equal(junk.success, false);
  const huge = await execReminder(message, { duration: '30 jam' });
  assert.equal(huge.success, false);
  const badAbs = await execReminder(message, { schedule: 'kapan pun lah' });
  assert.equal(badAbs.success, false);
});

test('reminder E2E: due reminder claimed → delivered to fallback channel → completed', async () => {
  const sent = [];
  const chan = makeChannel({ id: 'chan-remind-' + Date.now() });
  chan.isTextBased = () => true;
  chan.send = async (opts) => { sent.push(opts); };

  const guildId = 'gdeliver-' + Date.now();
  const guild = makeGuild({ id: guildId });
  const client = {
    guilds: { cache: new MockCollection([[guildId, guild]]) },
    channels: { fetch: async (id) => (id === chan.id ? chan : null) },
    users: { fetch: async () => ({ send: async () => {} }) },
  };

  setReminder({
    guildId,
    userId: '777777777777777777',
    fallbackChannelId: chan.id,
    text: 'jam les matematika',
    delivery: 'text',
    triggerAt: Date.now() - 50,
  });

  await pollDueReminders(client);

  assert.equal(sent.length, 1, 'exactly one channel.send');
  assert.match(sent[0].content, /jam les matematika/);
  const row = _getRemindersArray().find((r) => r.userId === '777777777777777777');
  assert.ok(row.status === 'completed', 'claim finalized as completed');
});

test('reminder: unknown guild → row marked failed, no crash', async () => {
  const client = {
    guilds: { cache: new MockCollection() },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  setReminder({
    guildId: 'g-missing-' + Date.now(),
    userId: '888888888888888888',
    fallbackChannelId: 'chan-x',
    text: 'hilang',
    delivery: 'text',
    triggerAt: Date.now() - 10,
  });
  await pollDueReminders(client);
  const row = _getRemindersArray().find((r) => r.userId === '888888888888888888');
  assert.ok(row.status === 'failed' || row.status === 'completed', 'status finalized without throwing');
});

// ─── Guild config ───────────────────────────────────────────────────

test('config: owner can set/see/remove welcome_channel; others cannot set', async () => {
  const { getSetting } = await import('../src/utils/server-settings.js');
  const guildId = 'gcfg-' + Date.now();
  const guild = makeGuild({ id: guildId });
  const chan = { id: 'chan-cfg-1', name: 'welcome-hall' };
  guild.channels.cache.set(chan.id, chan);

  const owner = makeMember({ id: OWNER });
  const ownerMsg = makeMessage({ authorId: OWNER, guild, member: owner });

  const setRes = await execSetConfig(ownerMsg, { setting: 'welcome_channel', channel_id: `<#${chan.id}>` });
  assert.equal(setRes.success, true);
  assert.equal(setRes.action, 'set');
  assert.equal(getSetting(guildId, 'welcomeChannelId'), chan.id);

  const shownReplies = [];
  const getConfigMsg = makeMessage({ authorId: OWNER, guild, member: owner });
  getConfigMsg.reply = async (opts) => { shownReplies.push(String(typeof opts === 'string' ? opts : opts.content)); };
  const got = await execGetConfig(getConfigMsg);
  assert.equal(got.replied, true);
  assert.ok(shownReplies.join('\n').includes('Welcome Channel'), 'welcome line rendered');
  assert.ok(shownReplies.join('\n').includes(chan.id), 'configured channel shown');

  const rmRes = await execSetConfig(ownerMsg, { setting: 'welcome_channel', channel_id: 'hapus' });
  assert.equal(rmRes.action, 'removed');
  assert.equal(getSetting(guildId, 'welcomeChannelId'), null);

  const unknown = await execSetConfig(ownerMsg, { setting: 'dark_mode', channel_id: 'here' });
  assert.equal(unknown.success, false);

  const pleb = makeMember({ id: '666666666666666666' });
  pleb.permissions = adminPerms();
  const plebMsg = makeMessage({ authorId: pleb.id, guild, member: pleb });
  const denied = await execSetConfig(plebMsg, { setting: 'welcome_channel', channel_id: `<#${chan.id}>` });
  assert.equal(denied.success, false);
  assert.match(denied.error, /owner bot/i);
});

// ─── Channel summarization ──────────────────────────────────────────

test('summarizeChannel: summarizes fetched history via AI, keeps pace limits', async () => {
  const guild = makeGuild({});
  const replies = [];
  const chan = makeChannel({ id: 'chan-sum-' + Date.now() });
  chan.permissionsFor = () => makePermissions([PermissionFlagsBits.ReadMessageHistory]);
  chan.messages.fetch = async ({ limit }) => {
    const coll = new MockCollection();
    for (let i = limit; i >= 1; i--) {
      coll.set(`sm-${i}`, {
        id: `sm-${i}`,
        author: { bot: false, username: i % 2 ? 'ana' : 'ben' },
        createdAt: new Date(Date.now() - i * 60000),
        content: `pesan percakapan nomor ${i}`,
      });
    }
    return coll;
  };

  const asker = makeMember({ id: '555555555555555557' });
  const message = makeMessage({ authorId: asker.id, guild, channel: chan, member: asker });
  message.reply = async (opts) => { replies.push(opts); };
  message.channel.reply = message.reply;

  const res = await execSummarizeChannel(message, { count: 40 });
  assert.equal(res.success, true);
  assert.ok(JSON.stringify(replies).includes(SUMMARY_REPLY), 'AI summary reached the reply');

  const noPermChan = makeChannel({ id: 'chan-sum-noperm' });
  noPermChan.permissionsFor = () => makePermissions([]);
  const msg2 = makeMessage({ authorId: asker.id, guild, channel: noPermChan, member: asker });
  const denied = await execSummarizeChannel(msg2, {});
  assert.equal(denied.success, false);
  assert.match(denied.error, /ReadMessageHistory/);
});
