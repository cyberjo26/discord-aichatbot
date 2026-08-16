import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PcMonStorage } from '../src/utils/pcmon-storage.js';
import { PcOptimizerApp } from '../src/index.js';

const TEST_DIR = path.resolve('./temp/storage-tests');

test.beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(TEST_DIR)) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  }
});

test('PcMonStorage audit logging & tier configs', () => {
  const dbPath = path.join(TEST_DIR, 'test-storage.sqlite');
  const storage = new PcMonStorage({ dbPath });

  // Test Audit Log
  const id = storage.logAudit({
    module: 'RAM_CLEANER',
    action: 'CLEAN',
    target: 'SYSTEM',
    details: { reclaimedMB: 350 },
    metricsDelta: { freeBefore: 1000, freeAfter: 1350 }
  });
  assert.ok(id > 0);

  const logs = storage.getAuditLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].module, 'RAM_CLEANER');
  assert.equal(logs[0].details.reclaimedMB, 350);

  // Test Complexity Tiers (Basic, Advanced, Expert)
  assert.equal(storage.getTierConfig().tier, 'Basic');

  storage.saveSetting('complexity_tier', 'Expert');
  assert.equal(storage.getTierConfig().tier, 'Expert');
  assert.equal(storage.getTierConfig().ramIntervalMs, 15 * 60 * 1000);

  storage.close();
});

test('PcOptimizerApp initialization & lifecycle', async () => {
  const dbPath = path.join(TEST_DIR, 'test-app.sqlite');
  const app = new PcOptimizerApp({ dbPath, port: 4899 });
  assert.ok(app.core);
  assert.ok(app.folderAnalyzer);
  assert.ok(app.ramScheduler);
  assert.ok(app.diagnostics);
  assert.ok(app.dashboard);

  app.setTier('Advanced');
  assert.equal(app.tierConfig.tier, 'Advanced');

  await app.start();
  app.stop();

  const logs = app.storage.getAuditLogs();
  assert.ok(logs.length >= 2);
  app.storage.close();
});
