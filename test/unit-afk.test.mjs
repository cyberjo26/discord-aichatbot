// Unit tests for the AFK system: store (set/get/is/clear), time formatting,
// notice building, and natural-language AFK intent detection
// (detectAfkIntent) with reason extraction and false-positive rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setupEnv } from './helpers.mjs';

setupEnv();

const {
  setAfk,
  getAfk,
  isAfk,
  clearAfk,
  formatAfkSince,
  buildAfkNotice,
  detectAfkIntent,
  sendTempMessage,
} = await import('../src/utils/afk.js');

// ─── detectAfkIntent: natural-language AFK statements ──────────────
test('detectAfkIntent: English AFK statements match', () => {
  assert.equal(detectAfkIntent('Im going to afk because want to dinner').matched, true);
  assert.equal(detectAfkIntent('going afk for study').matched, true);
  assert.equal(detectAfkIntent('i will be afk for a while').matched, true);
  assert.equal(detectAfkIntent('brb').matched, true);
});

test('detectAfkIntent: Indonesian AFK statements match', () => {
  assert.equal(detectAfkIntent('Gw afk dulu mau makan').matched, true);
  assert.equal(detectAfkIntent('aku afk sebentar, mau sholat').matched, true);
  assert.equal(detectAfkIntent('gue afk bentar makan dulu').matched, true);
  assert.equal(detectAfkIntent('gw brb dulu').matched, true);
});

test('detectAfkIntent: extracts the reason (English)', () => {
  assert.equal(detectAfkIntent('Im going to afk because want to dinner').reason, 'dinner');
  assert.equal(detectAfkIntent('going afk for study').reason, 'study');
  assert.equal(detectAfkIntent('i will be afk for a while').reason, 'a while');
});

test('detectAfkIntent: extracts the reason (Indonesian)', () => {
  assert.equal(detectAfkIntent('Gw afk dulu mau makan').reason, 'makan');
  assert.equal(detectAfkIntent('aku afk sebentar, mau sholat').reason, 'sholat');
  assert.equal(detectAfkIntent('gue afk bentar makan dulu').reason, 'makan dulu');
});

test('detectAfkIntent: bare brb falls back to reason "brb"', () => {
  assert.equal(detectAfkIntent('brb').reason, 'brb');
  assert.equal(detectAfkIntent('gw brb dulu').reason, 'brb');
});

test('detectAfkIntent: no reason given falls back to "AFK"', () => {
  assert.equal(detectAfkIntent('gw afk nih').reason, 'AFK');
});

test('detectAfkIntent: rejects non-AFK talk about afk', () => {
  assert.equal(detectAfkIntent('gimana caranya biar ga dianggap afk').matched, false);
  assert.equal(detectAfkIntent('jangan afk ya').matched, false);
  assert.equal(detectAfkIntent('dia afk').matched, false);
  assert.equal(detectAfkIntent('!afk tidur').matched, false, '!afk command is not NL intent');
  assert.equal(detectAfkIntent('').matched, false);
  assert.equal(detectAfkIntent('   ').matched, false);
});

// ─── Store: set / get / is / clear ─────────────────────────────────
test('afk store: set then isAfk/getAfk return the entry', () => {
  clearAfk('u-set-1');
  const entry = setAfk('u-set-1', 'tidur', 'g1');
  assert.equal(isAfk('u-set-1'), true);
  assert.equal(getAfk('u-set-1').reason, 'tidur');
  assert.equal(getAfk('u-set-1').guildId, 'g1');
  assert.equal(typeof entry.setAt, 'number');
});

test('afk store: reason is trimmed, empty reason defaults to AFK', () => {
  clearAfk('u-set-2');
  assert.equal(setAfk('u-set-2', '  makan malam  ').reason, 'makan malam');
  clearAfk('u-set-3');
  assert.equal(setAfk('u-set-3', '   ').reason, 'AFK');
});

test('afk store: clear removes entry and returns it; unknown user returns null', () => {
  setAfk('u-clear-1', 'kerja');
  assert.equal(isAfk('u-clear-1'), true);
  const removed = clearAfk('u-clear-1');
  assert.equal(removed.reason, 'kerja');
  assert.equal(isAfk('u-clear-1'), false);
  assert.equal(getAfk('u-clear-1'), null);
  assert.equal(clearAfk('u-never-existed'), null);
});

// ─── formatAfkSince ─────────────────────────────────────────────────
test('formatAfkSince: renders human-readable durations', () => {
  const now = Date.now();
  assert.equal(formatAfkSince(now), 'baru saja');
  assert.equal(formatAfkSince(now - 5 * 60 * 1000), '5 menit lalu');
  assert.equal(formatAfkSince(now - 60 * 60 * 1000), '1 jam lalu');
  assert.equal(formatAfkSince(now - 2 * 3600 * 1000), '2 jam lalu');
  assert.equal(formatAfkSince(now - 3 * 24 * 3600 * 1000), '3 hari lalu');
});

// ─── buildAfkNotice ─────────────────────────────────────────────────
test('buildAfkNotice: mentions user + reason when AFK, null otherwise', () => {
  clearAfk('u-notice-1');
  assert.equal(buildAfkNotice('u-notice-1'), null);
  setAfk('u-notice-1', 'makan');
  const notice = buildAfkNotice('u-notice-1');
  assert.ok(notice.includes('<@u-notice-1>'));
  assert.ok(notice.includes('makan'));
  assert.ok(notice.includes('AFK'));
});

// ─── sendTempMessage: auto-delete after 3s ─────────────────────────
test('sendTempMessage: replies and auto-deletes after 3s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let deleted = 0;
    const sent = { delete: async () => { deleted++; } };
    const message = { reply: async () => sent, channel: { send: async () => sent } };

    const result = await sendTempMessage(message, { text: 'halo', reply: true });

    assert.equal(result, sent);
    assert.equal(deleted, 0, 'not deleted before ttl');
    mock.timers.tick(3000);
    await Promise.resolve();
    assert.equal(deleted, 1, 'deleted exactly once after 3s');
  } finally {
    mock.timers.reset();
  }
});

test('sendTempMessage: uses channel.send when reply is false', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let deleted = 0;
    const sent = { delete: async () => { deleted++; } };
    let channelSends = 0;
    let replies = 0;
    const message = {
      reply: async () => { replies++; return sent; },
      channel: { send: async () => { channelSends++; return sent; } },
    };

    const result = await sendTempMessage(message, { text: 'halo' });

    assert.equal(result, sent);
    assert.equal(channelSends, 1, 'channel.send called');
    assert.equal(replies, 0, 'reply not called');
    mock.timers.tick(3000);
    await Promise.resolve();
    assert.equal(deleted, 1);
  } finally {
    mock.timers.reset();
  }
});

test('sendTempMessage: returns null when send fails', async () => {
  const message = { reply: async () => { throw new Error('no perms'); } };
  const result = await sendTempMessage(message, { text: 'halo', reply: true });
  assert.equal(result, null);
});
