import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsTrayManager } from '../src/utils/tray-manager.js';

test('WindowsTrayManager initialization and controls', () => {
  const tray = new WindowsTrayManager({ port: 3899 });
  assert.ok(tray);
  assert.equal(tray.port, 3899);

  // Tray management lifecycle
  tray.start();
  tray.stop();
  assert.equal(tray.process, null);
});
