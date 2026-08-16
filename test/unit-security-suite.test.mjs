import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSecurityConfig } from '../src/security/config.js';
import { TokenRotationManager } from '../src/security/rotation.js';
import { SecurityRateLimiter } from '../src/security/validator.js';
import { TamperResistantAuditLogger } from '../src/security/audit.js';
import { MINIMAL_SAFE_INTENTS, calculateMinimalPermissions, GatewayIntents } from '../src/security/intents.js';

test('loadSecurityConfig validates presence and format of token', () => {
  delete process.env.DISCORD_TOKEN;
  assert.throws(() => loadSecurityConfig(), /FATAL: DISCORD_TOKEN is missing or invalid/);

  process.env.DISCORD_TOKEN = 'short';
  assert.throws(() => loadSecurityConfig(), /FATAL: DISCORD_TOKEN is missing or invalid/);

  process.env.DISCORD_TOKEN = 'valid_discord_token_sample_1234567890';
  const cfg = loadSecurityConfig();
  assert.equal(cfg.discordToken, 'valid_discord_token_sample_1234567890');
});

test('TokenRotationManager rotates token and triggers event', () => {
  const manager = new TokenRotationManager('initial_secret_token_12345');
  assert.equal(manager.getCurrentToken(), 'initial_secret_token_12345');

  const history = [];
  manager.on('rotated', (data) => {
    history.push(data);
  });

  manager.rotate('rotated_secret_token_67890');
  assert.equal(manager.getCurrentToken(), 'rotated_secret_token_67890');
  assert.equal(history.length, 1);
  assert.equal(history[0].previousToken, 'initial_secret_token_12345');
  assert.equal(history[0].newToken, 'rotated_secret_token_67890');

  manager.emergencyOverride('emergency_override_token_99999');
  assert.equal(manager.getCurrentToken(), 'emergency_override_token_99999');
  assert.equal(history.length, 2);
  assert.equal(history[1].previousToken, 'rotated_secret_token_67890');
  assert.equal(history[1].newToken, 'emergency_override_token_99999');
});

test('SecurityRateLimiter handles request limits and IP blocking', () => {
  const limiter = new SecurityRateLimiter({ maxRequests: 2, windowMs: 1000 });

  const r1 = limiter.checkLimit('user_1');
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);

  const r2 = limiter.checkLimit('user_1');
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);

  const r3 = limiter.checkLimit('user_1');
  assert.equal(r3.allowed, false);
  assert.equal(r3.reason, 'rate_limited');

  limiter.blockIp('192.168.1.100');
  const r4 = limiter.checkLimit('user_2', '192.168.1.100');
  assert.equal(r4.allowed, false);
  assert.equal(r4.reason, 'ip_blocked');
});

test('TamperResistantAuditLogger signs and detects hash chain tampering', () => {
  const logger = new TamperResistantAuditLogger(null, 'test-secret');

  logger.log('admin_1', 'TOKEN_ROTATE', { key: 'val' });
  logger.log('admin_2', 'EMERGENCY_RESET', { key: 'val2' });

  const verification = logger.verifyChain();
  assert.equal(verification.valid, true);
  assert.equal(verification.count, 2);

  // Tamper with first entry
  logger.entries[0].details.key = 'tampered';
  const tamperedVerification = logger.verifyChain();
  assert.equal(tamperedVerification.valid, false);
});

test('Scope minimization defines minimal intents and permission bitmask', () => {
  assert.equal(MINIMAL_SAFE_INTENTS & GatewayIntents.MESSAGE_CONTENT, 0);
  assert.equal(MINIMAL_SAFE_INTENTS & GatewayIntents.GUILD_PRESENCES, 0);

  const perms = calculateMinimalPermissions();
  assert.ok(typeof perms === 'string');
  assert.ok(BigInt(perms) > 0n);
});
