import test from 'node:test';
import assert from 'node:assert/strict';
import { RamOptimizationScheduler } from '../src/utils/ram-scheduler.js';
import { PerformanceDiagnosticsEngine } from '../src/utils/perf-diagnostics.js';

test('RamOptimizationScheduler scheduling and tray status', () => {
  const scheduler = new RamOptimizationScheduler({ intervalMs: 15 * 60 * 1000 });
  scheduler.start();

  const status = scheduler.getTrayStatus();
  assert.ok(status.nextScheduled);
  assert.equal(status.isPaused, false);

  scheduler.skipNext();
  const statusAfterSkip = scheduler.getTrayStatus();
  assert.ok(statusAfterSkip.nextScheduled);

  scheduler.delay(30 * 60 * 1000);
  const statusAfterDelay = scheduler.getTrayStatus();
  assert.ok(statusAfterDelay.nextScheduled);

  scheduler.stop();
  assert.equal(scheduler.getTrayStatus().nextScheduled, null);
});

test('RamOptimizationScheduler CPU load calculation', async () => {
  const scheduler = new RamOptimizationScheduler();
  const load = await scheduler.checkCpuLoad();
  assert.ok(typeof load === 'number');
  assert.ok(load >= 0 && load <= 100);
});

test('PerformanceDiagnosticsEngine launch baseline tracking', () => {
  const engine = new PerformanceDiagnosticsEngine();

  // Baseline data
  engine.recordAppLaunch('app.exe', 100);
  engine.recordAppLaunch('app.exe', 110);
  engine.recordAppLaunch('app.exe', 90);

  // Normal launch
  const normal = engine.recordAppLaunch('app.exe', 120);
  assert.equal(normal.isSlow, false);

  // Slow launch (> 2x baseline)
  const slow = engine.recordAppLaunch('app.exe', 300);
  assert.equal(slow.isSlow, true);
  assert.equal(slow.baselineMedianMs, 110);
});

test('PerformanceDiagnosticsEngine multi-factor and anomaly scans', async () => {
  const engine = new PerformanceDiagnosticsEngine({ memAnomalyThresholdMB: 2000 });

  const factors = await engine.runMultiFactorSlowdownAnalysis();
  assert.ok(typeof factors.ramExhaustion === 'boolean');
  assert.ok(typeof factors.cpuBottleneck === 'boolean');

  const behavioral = engine.detectBehavioralAnomalies();
  assert.ok(Array.isArray(behavioral));

  const resourceAnomalies = engine.scanResourceAnomalies();
  assert.ok(Array.isArray(resourceAnomalies));
});
