import test from 'node:test';
import assert from 'node:assert/strict';
import { PcMonCore } from '../src/utils/pcmon-core.js';

test('PcMonCore initialization and metrics', async () => {
  const core = new PcMonCore({ intervalMs: 10000 });
  assert.ok(core);

  const metrics = await core.getSystemMetrics();
  assert.ok(metrics.totalMemMB > 0);
  assert.ok(typeof metrics.memUsagePercent === 'number');

  core.setMode({ gaming: true });
  assert.equal(core.isGamingOrDnd, true);

  core.setMode({ gaming: false });
  assert.equal(core.isGamingOrDnd, false);
});

test('PcMonCore folder scan functionality', async () => {
  const core = new PcMonCore();
  const res = await core.scanFolder('./test');
  assert.ok(res);
  assert.ok(res.totalFiles > 0);
  assert.ok(typeof res.category === 'string');
});
