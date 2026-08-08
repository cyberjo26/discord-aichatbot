// Shared helpers for QA test suites.
// Sets isolated env BEFORE any src module import, and builds mock Discord objects.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-qa-'));

export function setupEnv(extra = {}) {
  // NOTE: force these values (not `|| fallback`) because the shell may already
  // carry the real project .env values in the process environment.
  process.env.TEST_ENV = '1';
  process.env.DISCORD_TOKEN = 'qa-discord-token';
  process.env.DISCORD_CLIENT_ID = 'qa-client-id';
  process.env.OPENROUTER_API_KEY = 'qa-openrouter';
  process.env.OWNER_ID = 'qa-owner-id';
  process.env.AI_PROVIDER_ORDER = 'openrouter';
  process.env.LOG_LEVEL = 'error';
  process.env.DATABASE_PATH = path.join(TEMP_ROOT, 'voice-reminders.db');
  process.env.LEGACY_REMINDERS_FILE = path.join(TEMP_ROOT, 'voice-reminders.json');
  process.env.SERVER_SETTINGS_FILE = path.join(TEMP_ROOT, 'server-settings.json');
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return TEMP_ROOT;
}

export const tempRoot = () => TEMP_ROOT;

// ─── Mock Discord Collection (subset of discord.js Collection) ─────
export class MockCollection extends Map {
  filter(fn) {
    const out = new MockCollection();
    for (const [k, v] of this) if (fn(v, k, this)) out.set(k, v);
    return out;
  }
  map(fn) { return [...this.values()].map((v) => fn(v, v?.id, this)); }
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
  some(fn) { for (const v of this.values()) if (fn(v)) return true; return false; }
  first(n) { const arr = [...this.values()]; return n === undefined ? arr[0] : arr.slice(0, n); }
  sort(fn) {
    const arr = [...this.entries()].sort((a, b) => fn(a[1], b[1]));
    const out = new MockCollection();
    for (const [k, v] of arr) out.set(k, v);
    return out;
  }
  at(n) { return [...this.values()].at(n); }
  each(fn) { for (const v of this.values()) fn(v); return this; }
}

// ─── Permissions mock ──────────────────────────────────────────────
export function makePermissions(flags = []) {
  const set = new Set(flags);
  return {
    has: (...perms) => perms.every((p) => set.has(p)),
    add: (...perms) => perms.forEach((p) => set.add(p)),
    remove: (...perms) => perms.forEach((p) => set.delete(p)),
  };
}

export function makeRole({ id, name, position = 0 }) {
  return { id, name, position, mention: `<@&${id}>` };
}

export function makeVoiceState({ selfMute = false, serverMute = false, selfDeaf = false, serverDeaf = false, streaming = false, selfVideo = false, channelId = null, channel = null } = {}) {
  return {
    selfMute, serverMute, selfDeaf, serverDeaf, streaming, selfVideo, channelId, channel,
    setMute: async () => {}, setDeaf: async () => {}, disconnect: async () => {},
    setChannel: async () => {},
  };
}

export function makeMember({
  id = 'member-id', displayName = 'Member', username = 'member', nickname = null,
  voice = null, roles = [], highestPosition = 0, guildId = 'guild-id',
} = {}) {
  const rolesColl = new MockCollection();
  roles.forEach((r) => rolesColl.set(r.id, r));
  return {
    id,
    displayName,
    user: { id, username, tag: `${username}#0001`, bot: false },
    nickname,
    voice: voice || makeVoiceState({}),
    permissions: makePermissions(),
    roles: {
      highest: makeRole({ id: 'role-highest', name: 'highest', position: highestPosition }),
      cache: rolesColl,
    },
    guild: { id: guildId },
    timeout: async () => {}, kick: async () => {}, ban: async () => {},
    setNickname: async () => {},
  };
}

export function makeChannel({ id = 'chan-id', name = 'general', type = 0, members = [], guildId = 'guild-id' } = {}) {
  const memberMap = new MockCollection();
  members.forEach((m) => memberMap.set(m.id, m));
  return {
    id, name, type, guildId,
    members: memberMap,
    isTextBased: () => type === 0,
    isThread: () => false,
    permissionsFor: () => makePermissions(),
    send: async () => ({}),
    sendTyping: async () => {},
    bulkDelete: async () => ({ size: 0 }),
    delete: async () => {},
    pin: async () => {},
    unpin: async () => {},
    messages: {
      fetch: async () => new MockCollection(),
      fetchPinned: async () => new MockCollection(),
      delete: async () => {},
    },
    awaitMessages: async () => ({ first: () => null }),
    setRateLimitPerUser: async () => {},
  };
}

export function makeGuild({
  id = 'guild-id', name = 'Test Guild', ownerId = 'owner-id', channels = [], roles = [],
  membersCache = null, afkChannelId = null,
} = {}) {
  const chCache = new MockCollection();
  channels.forEach((c) => chCache.set(c.id, c));
  const roleCache = new MockCollection();
  roles.forEach((r) => roleCache.set(r.id, r));
  const members = membersCache || new MockCollection();
  const botMember = makeMember({ id: 'bot-id', displayName: 'Bot', username: 'bot', highestPosition: 10 });
  return {
    id, name, ownerId, afkChannelId,
    channels: {
      cache: chCache,
      create: async () => ({ id: 'new-chan', name: 'new-channel', type: 0 }),
    },
    roles: { cache: roleCache },
    members: {
      cache: members,
      me: botMember,
      fetch: async (target) => {
        if (target && typeof target === 'object') {
          const query = String(target.query || '').toLowerCase();
          const out = new MockCollection();
          for (const [, m] of members) {
            if (!query || m.displayName.toLowerCase().includes(query) || m.user.username.toLowerCase().includes(query)) {
              out.set(m.id, m);
            }
          }
          return out;
        }
        if (target === 'bot-id') return botMember;
        const found = members.get(target) || [...members.values()].find((m) => m.displayName === target);
        return found || null;
      },
      fetchMe: async () => botMember,
    },
    fetchOwner: async () => ({ send: async () => {} }),
  };
}

/**
 * Build a mock Discord Message object for integration tests.
 */
export function makeMessage({
  id = 'msg-id', content = '', authorId = 'user-id', authorTag = 'User#0001', authorName = 'User',
  guild = null, channel = null, member = null, client = null, mentions = null, reference = null,
  channelId = 'chan-id', attachments = [], stickers = [],
} = {}) {
  const resolvedMember = member || (guild ? makeMember({ id: authorId, displayName: authorName }) : null);
  const resolvedChannel = channel || makeChannel({ id: channelId });
  const resolvedClient = client || {
    user: { id: 'bot-id', tag: 'Bot#0001' },
    ws: { ping: 42 },
    guilds: { cache: new MockCollection() },
    channels: { cache: new MockCollection(), fetch: async () => null },
  };
  const reply = {
    id: `reply-${Date.now()}`,
    edit: async () => {},
    delete: async () => {},
    awaitMessageComponent: async () => { throw new Error('timeout'); },
  };
  return {
    id,
    content,
    author: { id: authorId, username: authorName, tag: authorTag, bot: false, send: async () => {} },
    guild,
    channel: resolvedChannel,
    member: resolvedMember,
    client: resolvedClient,
    mentions: mentions || {
      users: { filter: () => new MockCollection(), first: () => null, size: 0 },
      has: () => false,
    },
    reference,
    createdTimestamp: Date.now(),
    attachments: new MockCollection(attachments.map((a) => [a.id || a.url, a])),
    stickers: new MockCollection(stickers.map((s) => [s.id, s])),
    reply: async (opts) => ({
      ...reply,
      ...(typeof opts === 'string' ? {} : opts),
    }),
    react: async () => {},
    delete: async () => {},
  };
}

export function makeReply({ confirm = false, cancelId = null, confirmId = null, timeouts = 0, user = 'mod' } = {}) {
  const reply = {
    id: 'reply-id',
    edit: async () => {},
    delete: async () => {},
    awaitMessageComponent: async () => {
      if (timeouts > 0) throw new Error('timeout');
      if (confirm) return { customId: confirmId || 'confirm', user: { id: user }, deferUpdate: async () => {} };
      return { customId: cancelId || 'cancel', user: { id: user }, deferUpdate: async () => {} };
    },
  };
  return reply;
}
