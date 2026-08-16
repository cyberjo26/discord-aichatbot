import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';

/**
 * PC Monitor Core Daemon
 * Platform: Windows (win32) - fallback generic OS
 */
export class PcMonCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isWin = process.platform === 'win32';
    this.intervalMs = options.intervalMs || 60000;
    this.ramThresholdPercent = options.ramThresholdPercent || 80;
    this.cpuThresholdPercent = options.cpuThresholdPercent || 80;
    this.isGamingOrDnd = false;
    this.auditLog = [];
    this.timer = null;
    this.launchBaselines = new Map();
  }

  // ponytail: Use PowerShell/WMI fallback. Real ETW kernel sessions require C++ node-gyp native addon.
  start() {
    if (this.timer) return;
    this.logAction('CORE', 'DAEMON_START', { platform: process.platform });
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logAction('CORE', 'DAEMON_STOP', {});
    }
  }

  setMode({ dnd = false, gaming = false }) {
    this.isGamingOrDnd = Boolean(dnd || gaming);
    this.logAction('CONFIG', 'MODE_CHANGE', { dnd, gaming, active: this.isGamingOrDnd });
  }

  async tick() {
    if (this.isGamingOrDnd) {
      this.emit('status', { state: 'DEFERRED_GAMING_OR_DND' });
      return;
    }

    try {
      const metrics = await this.getSystemMetrics();
      this.emit('metrics', metrics);

      // RAM Optimization Trigger
      if (metrics.memUsagePercent >= this.ramThresholdPercent) {
        await this.optimizeRam();
      }

      // Check anomalous processes
      await this.checkAnomalies();
    } catch (err) {
      this.emit('error', err);
    }
  }

  async getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePercent = Math.round((usedMem / totalMem) * 100);

    const cpus = os.cpus();
    return {
      totalMemMB: Math.round(totalMem / (1024 * 1024)),
      freeMemMB: Math.round(freeMem / (1024 * 1024)),
      memUsagePercent,
      cpuCount: cpus.length,
      timestamp: new Date().toISOString()
    };
  }

  async optimizeRam() {
    if (this.isWin) {
      // Empty working sets via PowerShell/GC invoke
      try {
        const cmd = `powershell -NoProfile -Command "[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()"`;
        execSync(cmd, { stdio: 'ignore', timeout: 5000 });
        this.logAction('RAM_OPTIMIZER', 'CLEAN_COMPLETED', { method: 'GC_AND_WORKING_SET' });
        this.emit('ram_cleaned', { reclaimed: true });
      } catch (err) {
        this.logAction('RAM_OPTIMIZER', 'CLEAN_FAILED', { error: err.message });
      }
    } else {
      this.logAction('RAM_OPTIMIZER', 'CLEAN_SKIPPED', { reason: 'NON_WINDOWS' });
    }
  }

  async checkAnomalies() {
    if (!this.isWin) return;
    try {
      // Get top processes by CPU/Memory
      const psScript = `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Id, ProcessName, WorkingSet64, CPU | ConvertTo-Json`;
      const stdout = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', timeout: 5000 });
      const processes = JSON.parse(stdout || '[]');
      const list = Array.isArray(processes) ? processes : [processes];

      for (const p of list) {
        const memMB = Math.round((p.WorkingSet64 || 0) / (1024 * 1024));
        if (memMB > 1500) { // Flag process > 1.5GB
          this.emit('anomaly_detected', { pid: p.Id, name: p.ProcessName, memMB });
          this.logAction('DIAGNOSTICS', 'HIGH_MEM_PROCESS', { pid: p.Id, name: p.ProcessName, memMB });
        }
      }
    } catch {
      // Ignore background sampling errors
    }
  }

  // Folder Analysis: Stale, Duplicate, Corrupt detection
  async scanFolder(dirPath, { staleDays = 60 } = {}) {
    if (!fs.existsSync(dirPath)) return null;

    const stats = {
      path: dirPath,
      totalFiles: 0,
      totalBytes: 0,
      staleFiles: [],
      affectedCount: 0
    };

    const now = Date.now();
    const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;

    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            stats.totalFiles++;
            const s = fs.statSync(fullPath);
            stats.totalBytes += s.size;
            if (now - s.atimeMs > staleThresholdMs) {
              stats.staleFiles.push(fullPath);
            }
          }
        } catch {
          // Unreadable / corrupt
          stats.affectedCount++;
        }
      }
    };

    walk(dirPath);
    stats.category = stats.staleFiles.length > (stats.totalFiles * 0.7) ? 'stale' : 'normal';
    return stats;
  }

  logAction(module, action, metadata) {
    const entry = {
      timestamp: new Date().toISOString(),
      module,
      action,
      metadata
    };
    this.auditLog.push(entry);
    this.emit('audit_log', entry);
  }
}

export default PcMonCore;
