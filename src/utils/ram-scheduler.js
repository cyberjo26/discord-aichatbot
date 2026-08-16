import EventEmitter from 'node:events';
import { execSync } from 'node:child_process';
import os from 'node:os';

/**
 * Automated RAM Optimization Scheduler with Smart Deferral
 */
export class RamOptimizationScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMs = Math.max(options.intervalMs || 60 * 60 * 1000, 15 * 60 * 1000); // min 15m
    this.timer = null;
    this.nextRunTimestamp = null;
    this.lastResult = null;
    this.isWin = process.platform === 'win32';
    this.cpuBusyThreshold = options.cpuBusyThreshold || 25; // % CPU threshold to defer
    this.isPaused = false;
  }

  start() {
    if (this.timer) return;
    this.scheduleNext(this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextRunTimestamp = null;
    }
  }

  scheduleNext(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunTimestamp = Date.now() + delayMs;
    this.timer = setTimeout(() => this.runOptimizationCycle(), delayMs);
  }

  getTrayStatus() {
    return {
      nextScheduled: this.nextRunTimestamp ? new Date(this.nextRunTimestamp).toISOString() : null,
      lastOptimization: this.lastResult,
      isPaused: this.isPaused
    };
  }

  // Probe Windows for Fullscreen App, Presentation Mode, or Game
  // ponytail: Use PowerShell fallback. Native SHQueryUserNotificationState needs C++ binding.
  async isUserBusyOrFullscreen() {
    if (!this.isWin) return false;
    try {
      const psScript = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class WinState {
            [DllImport("shell32.dll")]
            public static extern int SHQueryUserNotificationState(out int qState);
        }
"@
        $state = 0
        [WinState]::SHQueryUserNotificationState([ref]$state) | Out-Null
        $state
      `;
      const stdout = execSync(`powershell -NoProfile -Command "${psScript.trim()}"`, {
        encoding: 'utf8',
        timeout: 4000
      }).trim();

      const stateNum = parseInt(stdout, 10);
      // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4
      return [2, 3, 4].includes(stateNum);
    } catch {
      return false;
    }
  }

  async checkCpuLoad() {
    const cpus1 = os.cpus();
    await new Promise((res) => setTimeout(res, 300));
    const cpus2 = os.cpus();

    let idleDiff = 0;
    let totalDiff = 0;

    for (let i = 0; i < cpus1.length; i++) {
      const t1 = cpus1[i].times;
      const t2 = cpus2[i].times;
      const idle = t2.idle - t1.idle;
      const total =
        (t2.user - t1.user) +
        (t2.nice - t1.nice) +
        (t2.sys - t1.sys) +
        (t2.irq - t1.irq) +
        idle;

      idleDiff += idle;
      totalDiff += total;
    }

    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 100);
  }

  async runOptimizationCycle() {
    if (this.isPaused) {
      this.scheduleNext(this.intervalMs);
      return;
    }

    // 1. Check Fullscreen/Presentation
    const isBusy = await this.isUserBusyOrFullscreen();
    if (isBusy) {
      this.emit('deferred', { reason: 'FULLSCREEN_OR_PRESENTATION' });
      this.scheduleNext(10 * 60 * 1000); // Retry in 10 mins
      return;
    }

    // 2. Check CPU Threshold
    const cpuUsage = await this.checkCpuLoad();
    if (cpuUsage > this.cpuBusyThreshold) {
      this.emit('deferred', { reason: 'HIGH_CPU_LOAD', cpuUsage });
      this.scheduleNext(10 * 60 * 1000); // Retry in 10 mins
      return;
    }

    // 3. Execute RAM cleanup
    const beforeFree = os.freemem();
    let reclaimedBytes = 0;

    if (this.isWin) {
      try {
        execSync(`powershell -NoProfile -Command "[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()"`, {
          stdio: 'ignore',
          timeout: 5000
        });
      } catch {
        // ignore
      }
    }

    const afterFree = os.freemem();
    reclaimedBytes = Math.max(0, afterFree - beforeFree);

    this.lastResult = {
      timestamp: new Date().toISOString(),
      reclaimedMB: Math.round(reclaimedBytes / (1024 * 1024)),
      freeMemMB: Math.round(afterFree / (1024 * 1024))
    };

    this.emit('optimized', this.lastResult);
    this.scheduleNext(this.intervalMs);
  }

  skipNext() {
    this.scheduleNext(this.intervalMs);
    this.emit('skipped', { nextScheduled: new Date(this.nextRunTimestamp).toISOString() });
  }

  delay(delayMs = 60 * 60 * 1000) {
    this.scheduleNext(delayMs);
    this.emit('delayed', { nextScheduled: new Date(this.nextRunTimestamp).toISOString() });
  }
}

export default RamOptimizationScheduler;
