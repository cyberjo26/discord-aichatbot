import assert from 'assert';
import { isSafeUrl } from './utils/security.js';
import { checkRateLimit, releaseRateLimit, cleanupRateLimits } from './utils/rate-limit.js';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log('--- SECURITY & RELIABILITY TESTS ---');

  // 1. SSRF Tests
  console.log('1. Testing SSRF Prevention...');
  const ssrfCases = [
    { url: 'http://localhost:8080/admin', expected: false },
    { url: 'http://127.0.0.1/server-status', expected: false },
    { url: 'http://192.168.1.1/router', expected: false },
    { url: 'http://10.0.0.5/api', expected: false },
    { url: 'http://172.16.0.1/db', expected: false },
    { url: 'http://169.254.169.254/latest/meta-data/', expected: false }, // AWS IMDS
    { url: 'http://0.0.0.0/test', expected: false },
    { url: 'http://[::1]/test', expected: false },
    { url: 'https://google.com', expected: true },
    { url: 'https://example.com/path?q=1', expected: true },
  ];

  for (const tc of ssrfCases) {
    const result = await isSafeUrl(tc.url);
    assert.strictEqual(result, tc.expected, `SSRF test failed for ${tc.url} (expected ${tc.expected}, got ${result})`);
  }
  console.log('✅ SSRF tests passed.');

  // 2. Rate Limit Tests
  console.log('2. Testing Rate Limits...');
  cleanupRateLimits(); // Reset
  
  // User limits
  const userId = 'user_test_1';
  let allowedCount = 0;
  for (let i = 0; i < 25; i++) {
    const res = checkRateLimit(userId, null);
    if (res.allowed) allowedCount++;
    releaseRateLimit(); // Release concurrency so it doesn't block
  }
  assert.strictEqual(allowedCount, 20, `User rate limit failed: expected 20, got ${allowedCount}`);

  // Guild limits
  const guildId = 'guild_test_1';
  const userId2 = 'user_test_2';
  allowedCount = 0;
  for (let i = 0; i < 160; i++) {
    const res = checkRateLimit(userId2 + '_' + i, guildId);
    if (res.allowed) allowedCount++;
    releaseRateLimit();
  }
  assert.strictEqual(allowedCount, 150, `Guild rate limit failed: expected 150, got ${allowedCount}`);

  // Concurrency limit
  allowedCount = 0;
  for (let i = 0; i < 60; i++) {
    const res = checkRateLimit(`user_${i}`, null);
    if (res.allowed) allowedCount++;
  }
  assert.strictEqual(allowedCount, 50, `Concurrency rate limit failed: expected 50, got ${allowedCount}`);
  
  // Cleanup concurrency
  for (let i = 0; i < 50; i++) releaseRateLimit();
  console.log('✅ Rate Limit tests passed.');

  // 3. Backup Path Validation
  console.log('3. Testing Backup Path Resolution...');
  // We can't easily run the backup loop here because it zips data, 
  // but we can verify that the necessary modules are loaded and the function exists
  const { initBackups } = await import('./utils/backup.js');
  assert.strictEqual(typeof initBackups, 'function', 'initBackups should be a function');
  console.log('✅ Backup structure tests passed.');

  console.log('🎉 ALL SECURITY TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
