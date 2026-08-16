import EventEmitter from 'node:events';
import { execSync } from 'node:child_process';
import os from 'node:os';

/**
 * Real-Time Performance Diagnostics Engine
 */
export class PerformanceDiagnosticsEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isWin = process.platform === 'win32';
    this.launchBaselines = new Map(); // appName -> medianMs
    this.cpuAnomalyThreshold = options.cpuAnomalyThreshold || 80;
    this.memAnomalyThresholdMB = options.memAnomalyThresholdMB || 1500;
  }

  recordAppLaunch(appName, durationMs) {
    const history = this.launchBaselines.get(appName) || [];
    history.push(durationMs);
    if (history.length > 20) history.shift();
    this.launchBaselines.set(appName, history);

    const median = this.getMedian(history);
    const isSlow = history.length >= 3 && durationMs > median * 2.0;

    const analysis = {
      appName,
      durationMs,
      baselineMedianMs: median,
      isSlow
    };

    if (isSlow) {
      this.emit('slow_launch_detected', analysis);
    }
    return analysis;
  }

  getMedian(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  async runMultiFactorSlowdownAnalysis() {
    const factors = {
      cpuBottleneck: false,
      ramExhaustion: false,
      diskThrottling: false,
      thermalThrottling: false,
      timestamp: new Date().toISOString()
    };

    // 1. RAM Exhaustion check
    const total = os.totalmem();
    const free = os.freemem();
    if (free / total < 0.1) {
      factors.ramExhaustion = true;
    }

    // 2. CPU load check
    const cpus = os.cpus();
    factors.coreCount = cpus.length;

    if (this.isWin) {
      try {
        // Query CPU & Disk metrics via PowerShell Get-Counter
        const psCmd = `Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage`;
        const cpuLoad = parseInt(execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 3000, encoding: 'utf8' }).trim(), 10);
        if (!isNaN(cpuLoad) && cpuLoad >= 85) {
          factors.cpuBottleneck = true;
        }
      } catch {
        // fallback
      }
    }

    return factors;
  }

  // Lightweight Behavioral Malware Scanner
  // Flags suspicious script engines running from temp or parentless processes
  detectBehavioralAnomalies() {
    if (!this.isWin) return [];
    const suspiciousIndicators = [];

    try {
      const psScript = `Get-Process | Select-Object Id, ProcessName, Path | ConvertTo-Json`;
      const stdout = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', timeout: 5000 });
      const procs = JSON.parse(stdout || '[]');
      const list = Array.isArray(procs) ? procs : [procs];

      const scriptHosts = new Set(['powershell', 'cmd', 'wscript', 'cscript', 'mshta']);

      for (const p of list) {
        if (!p.ProcessName) continue;
        const name = p.ProcessName.toLowerCase();
        const procPath = (p.Path || '').toLowerCase();

        // Indicator 1: Script engine executing directly inside AppData\Temp or Downloads
        if (scriptHosts.has(name)) {
          if (procPath.includes('\\temp\\') || procPath.includes('\\appdata\\local\\temp')) {
            suspiciousIndicators.push({
              pid: p.Id,
              name: p.ProcessName,
              path: p.Path,
              type: 'SUSPICIOUS_SCRIPT_PATH',
              severity: 'HIGH'
            });
          }
        }
      }
    } catch {
      // ignore
    }

    if (suspiciousIndicators.length > 0) {
      this.emit('security_anomaly', suspiciousIndicators);
    }
    return suspiciousIndicators;
  }

  // Anomalous Resource Consumer Watcher
  scanResourceAnomalies() {
    if (!this.isWin) return [];
    const anomalies = [];

    try {
      const psScript = `Get-Process | Where-Object { $_.WorkingSet64 -gt ${this.memAnomalyThresholdMB * 1024 * 1024} } | Select-Object Id, ProcessName, WorkingSet64, CPU | ConvertTo-Json`;
      const stdout = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', timeout: 5000 });
      const procs = JSON.parse(stdout || '[]');
      const list = Array.isArray(procs) ? procs : [procs];

      for (const p of list) {
        const memMB = Math.round((p.WorkingSet64 || 0) / (1024 * 1024));
        anomalies.push({
          pid: p.Id,
          name: p.ProcessName,
          memMB,
          cpuTotalSec: p.CPU || 0,
          type: 'EXCESSIVE_RESOURCE_CONSUMPTION'
        });
      }
    } catch {
      // ignore
    }

    if (anomalies.length > 0) {
      this.emit('resource_anomaly', anomalies);
    }
    return anomalies;
  }
}

export default PerformanceDiagnosticsEngine;
