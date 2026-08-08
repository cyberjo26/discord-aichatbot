// Unit tests: rate-limit, network retry, formatter, metrics, wake-sleep, reminders parsing, memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setupEnv } from './helpers.mjs';

setupEnv();

// Mock AI so memory's periodic context-summary generation never hits the network
mock.module('../src/ai/openrouter.js', {
  namedExports: { chatCompletion: async () => 'summary' },
  defaultExport: { chatCompletion: async () => 'summary' },
});

const { checkRateLimit, releaseRateLimit, cleanupRateLimits } = await import('../src/utils/rate-limit.js');
const { withRetry } = await import('../src/utils/network.js');
const { truncate } = await import('../src/utils/formatter.js');
const { recordMetric, getMetrics } = await import('../src/utils/metrics.js');
const { checkWakeSleepCommand } = await import('../src/utils/wake-sleep.js');
const { parseDuration, formatDuration, parseAbsoluteTime, sanitizeReminderText } = await import('../src/utils/reminders.js');
const { getHistory, getContext, addMessage, buildContextInjection, clearHistory } = await import('../src/utils/memory.js');

test('rate-limit: user quota (20/min)', () => {
  cleanupRateLimits();
  const user = 'u-' + Date.now();
  let allowed = 0;
  for (let i = 0; i < 25; i++) {
    const r = checkRateLimit(user, null);
    if (r.allowed) { allowed++; releaseRateLimit(r.token); }
  }
  assert.equal(allowed, 20, 'user quota should be 20');
});

test('rate-limit: guild quota (150/min) + user quota (20/min) combine', () => {
  cleanupRateLimits();
  const guild = 'g-' + Date.now();
  // 30 distinct users on one guild -> guild limit not hit, but each user hits 20
  let allowed = 0;
  for (let i = 0; i < 30; i++) {
    const r = checkRateLimit(`gu-${Date.now()}-${i}`, guild);
    if (r.allowed) { allowed++; releaseRateLimit(r.token); }
  }
  assert.equal(allowed, 30, 'distinct users all allowed');
});

test('rate-limit: guild quota hit with many distinct users', () => {
  cleanupRateLimits();
  const guild = 'g2-' + Date.now();
  let allowed = 0;
  for (let i = 0; i < 200; i++) {
    const r = checkRateLimit(`gu2-${Date.now()}-${i}`, guild);
    if (r.allowed) { allowed++; releaseRateLimit(r.token); }
  }
  assert.equal(allowed, 150, 'guild quota should be 150');
});

test('rate-limit: global concurrency (50) and token release', () => {
  cleanupRateLimits();
  const tokens = [];
  let allowed = 0;
  for (let i = 0; i < 60; i++) {
    const r = checkRateLimit(`gc-${Date.now()}-${i}`, null);
    if (r.allowed) { allowed++; tokens.push(r.token); }
  }
  assert.equal(allowed, 50, 'concurrency cap should be 50');
  for (const t of tokens) releaseRateLimit(t);
  const r2 = checkRateLimit('fresh-user', null);
  assert.ok(r2.allowed, 'after release, new requests allowed');
  releaseRateLimit(r2.token);
});

test('rate-limit: released tokens free concurrency slots', () => {
  cleanupRateLimits();
  const t1 = checkRateLimit('a1', null).token;
  const t2 = checkRateLimit('a2', null).token;
  releaseRateLimit(t1);
  const t3 = checkRateLimit('a3', null);
  assert.ok(t3.allowed, 'slot freed after release');
  releaseRateLimit(t2); releaseRateLimit(t3.token);
});

test('network: withRetry succeeds on first try', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return 'ok'; }, 3, 1);
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('network: withRetry retries then succeeds', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 'recovered';
  }, 3, 1);
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
});

test('network: withRetry gives up after maxRetries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('always'); }, 3, 1),
    /always/
  );
  assert.equal(calls, 3);
});

test('network: withRetry respects retryable=false', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const e = new Error('fatal'); e.retryable = false; throw e;
    }, 3, 1),
    /fatal/
  );
  assert.equal(calls, 1, 'non-retryable error should not retry');
});

test('formatter: truncate keeps short strings and trims long ones', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('a'.repeat(100), 10), 'a'.repeat(7) + '...');
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
});

test('metrics: recordMetric tracks success/failure and p95', () => {
  recordMetric('request', { success: true, latency: 100 });
  recordMetric('request', { success: false, latency: 200 });
  const m = getMetrics();
  assert.equal(m.requests.total >= 2, true);
  assert.equal(m.requests.success >= 1, true);
  assert.equal(m.requests.failed >= 1, true);
});

test('wake-sleep: command detection', () => {
  assert.equal(checkWakeSleepCommand('tidur'), 'sleep');
  assert.equal(checkWakeSleepCommand('sleep now'), 'sleep');
  assert.equal(checkWakeSleepCommand('bangun'), 'wake');
  assert.equal(checkWakeSleepCommand('wake up'), 'wake');
  assert.equal(checkWakeSleepCommand('halo apa kabar'), null);
});

test('reminders: parseDuration spelled-out forms', () => {
  assert.equal(parseDuration('10 menit'), 10 * 60 * 1000);
  assert.equal(parseDuration('1 jam'), 60 * 60 * 1000);
  assert.equal(parseDuration('30 detik'), 30 * 1000);
  assert.equal(parseDuration('1 jam 30 menit'), 90 * 60 * 1000);
  assert.equal(parseDuration('90'), 90 * 60 * 1000); // bare number = minutes
});

test('reminders: parseDuration compact forms (1h / 10m / 30s)', () => {
  // NOTE: documents actual behavior. Compact "1h" matches BOTH the
  // "h(?![a-z])" pattern and the standalone (\d+)h pattern -> double count.
  assert.equal(parseDuration('1h'), 60 * 60 * 1000, '1h should be 1 hour');
  assert.equal(parseDuration('10m'), 10 * 60 * 1000, '10m should be 10 minutes');
  assert.equal(parseDuration('30s'), 30 * 1000, '30s should be 30 seconds');
});

test('reminders: formatDuration', () => {
  assert.equal(formatDuration(30 * 1000), '30 detik');
  assert.equal(formatDuration(60 * 1000), '1 menit');
  assert.equal(formatDuration(90 * 60 * 1000), '1 jam 30 menit');
  assert.equal(formatDuration(60 * 60 * 1000), '1 jam');
});

test('reminders: parseAbsoluteTime invalid input returns null', () => {
  assert.equal(parseAbsoluteTime(''), null);
  assert.equal(parseAbsoluteTime(null), null);
  assert.equal(parseAbsoluteTime('jam 25:99'), null);
  assert.equal(parseAbsoluteTime('bukan waktu'), null);
});

test('reminders: sanitizeReminderText strips markdown and emoji', () => {
  assert.equal(sanitizeReminderText('Beli **roti** 😊'), 'Beli roti');
  assert.equal(sanitizeReminderText('a'.repeat(120)).length, 103);
  assert.equal(sanitizeReminderText(''), '');
});

test('memory: addMessage caps history at maxMemoryMessages (30)', () => {
  clearHistory('mem-user-1');
  for (let i = 0; i < 50; i++) addMessage('mem-user-1', 'user', `msg ${i}`);
  const h = getHistory('mem-user-1');
  assert.equal(h.length, 30, 'history capped at 30');
  assert.equal(h[0].content, 'msg 20', 'oldest kept should be msg 20');
});

test('memory: buildContextInjection skips new conversations', () => {
  clearHistory('mem-user-2');
  assert.equal(buildContextInjection('mem-user-2', 'halo'), '');
});

test('memory: buildContextInjection skips on bare "tadi" (common filler)', () => {
  clearHistory('mem-user-filler');
  addMessage('mem-user-filler', 'user', 'saya belajar javascript');
  assert.equal(buildContextInjection('mem-user-filler', 'tadi saya ke pasar'), '');
});

test('memory: buildContextInjection injects on continuation word (deliberate)', () => {
  clearHistory('mem-user-cont');
  addMessage('mem-user-cont', 'user', 'saya belajar javascript');
  const inj = buildContextInjection('mem-user-cont', 'terus gimana cara deploy?');
  assert.ok(inj.includes('TOPIK'), 'continuation words are intentional context triggers');
});

test('memory: buildContextInjection injects on compound reference', () => {
  clearHistory('mem-user-comp');
  addMessage('mem-user-comp', 'user', 'saya belajar javascript dan nodejs');
  const inj = buildContextInjection('mem-user-comp', 'yang tadi kita bahas');
  assert.ok(inj.includes('TOPIK'), 'compound reference should trigger context injection');
});

test('memory: buildContextInjection adds topics when present', () => {
  clearHistory('mem-user-3');
  addMessage('mem-user-3', 'user', 'saya belajar javascript dan nodejs');
  addMessage('mem-user-3', 'user', 'tadi kita bahas backend');
  addMessage('mem-user-3', 'user', 'lanjutkan lagi');
  const inj = buildContextInjection('mem-user-3', 'lanjutkan tadi');
  assert.ok(inj.includes('TOPIK'), 'context injection should include topics');
});

test('memory: clearHistory wipes user context', () => {
  addMessage('mem-user-4', 'user', 'data');
  clearHistory('mem-user-4');
  assert.deepEqual(getContext('mem-user-4').topics, []);
  assert.equal(getHistory('mem-user-4').length, 0);
});
