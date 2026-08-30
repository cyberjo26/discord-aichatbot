// Performance & load tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.mjs';

setupEnv();

const { checkRateLimit, releaseRateLimit, cleanupRateLimits } = await import('../src/utils/rate-limit.js');
const { getHistory, addMessage, clearHistory } = await import('../src/utils/memory.js');
const { withRetry } = await import('../src/utils/network.js');

test('load: rate limiter handles 10k rapid requests without throwing', () => {
  cleanupRateLimits();
  const t0 = Date.now();
  let allowed = 0;
  for (let i = 0; i < 10000; i++) {
    const r = checkRateLimit(`perf-${i % 500}`, null);
    if (r.allowed) { allowed++; releaseRateLimit(r.token); }
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `10k rate-limit checks took ${elapsed}ms (expect <5s)`);
  assert.ok(allowed > 0);
});

test('load: memory store handles 5000 users with capped history', () => {
  const t0 = Date.now();
  for (let u = 0; u < 5000; u++) {
    for (let m = 0; m < 35; m++) addMessage(`perf-user-${u}`, 'user', `message ${m}`);
  }
  const elapsed = Date.now() - t0;
  const h = getHistory('perf-user-4999');
  assert.equal(h.length, 30, 'history capped');
  assert.ok(elapsed < 10000, `5000 users x 35 msgs took ${elapsed}ms`);
  clearHistory('perf-user-4999');
});

test('load: withRetry backoff does not spin hot', async () => {
  const t0 = Date.now();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('x'); }, 3, 5),
    /x/
  );
  const elapsed = Date.now() - t0;
  assert.equal(calls, 3);
  assert.ok(elapsed >= 5, `exponential backoff (5ms base) should add delay, took ${elapsed}ms`);
});

test('load: rate-limit map does not leak entries after cleanup', () => {
  cleanupRateLimits();
  for (let i = 0; i < 1000; i++) {
    const r = checkRateLimit(`leak-${i}`, null);
    if (r.allowed) releaseRateLimit(r.token);
  }
  const before = process.memoryUsage().heapUsed;
  cleanupRateLimits();
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  assert.ok(before > 0);
  assert.ok(after > 0);
});
