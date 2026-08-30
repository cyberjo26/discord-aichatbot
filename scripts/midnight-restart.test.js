/**
 * Self-check for msUntilMidnight(). Run: node scripts/midnight-restart.test.js
 */
import assert from 'node:assert/strict';
import { msUntilMidnight } from './midnight-restart.js';

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Bangkok'; // UTC+7, no DST

// 17:00 UTC == 00:00 Bangkok next day -> a full day of wait.
assert.equal(msUntilMidnight(TZ, new Date('2026-08-02T17:00:00.000Z')), DAY);

// 16:59:59.000 UTC == 23:59:59 Bangkok -> 1s left.
assert.equal(msUntilMidnight(TZ, new Date('2026-08-02T16:59:59.000Z')), 1000);

// 00:00 UTC == 07:00 Bangkok -> 17h left.
assert.equal(msUntilMidnight(TZ, new Date('2026-08-02T00:00:00.000Z')), 17 * 60 * 60 * 1000);

// Always inside (0, DAY].
for (let m = 0; m < DAY; m += 7 * 60 * 1000) {
  const ms = msUntilMidnight(TZ, new Date(Date.UTC(2026, 7, 2) + m));
  assert.ok(ms > 0 && ms <= DAY, `out of range: ${ms}`);
}

// DST zone stays in range too.
for (const iso of ['2026-03-29T00:30:00.000Z', '2026-10-25T00:30:00.000Z']) {
  const ms = msUntilMidnight('Europe/Berlin', new Date(iso));
  assert.ok(ms > 0 && ms <= DAY, `${iso} -> ${ms}`);
}

console.log('ok: msUntilMidnight');
