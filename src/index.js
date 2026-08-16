import { PcMonCore } from './utils/pcmon-core.js';
import { FolderAnalysisEngine } from './utils/folder-analyzer.js';
import { RamOptimizationScheduler } from './utils/ram-scheduler.js';
import { PerformanceDiagnosticsEngine } from './utils/perf-diagnostics.js';
import { PcMonStorage } from './utils/pcmon-storage.js';
import { DashboardServer } from './utils/dashboard-server.js';
import { WindowsServiceInstaller } from './utils/service-installer.js';
import { WindowsTrayManager } from './utils/tray-manager.js';

export class PcOptimizerApp {
  constructor(options = {}) {
    this.storage = new PcMonStorage(options);
    this.tierConfig = this.storage.getTierConfig();

    this.core = new PcMonCore({
      intervalMs: this.tierConfig.ramIntervalMs,
      cpuThresholdPercent: this.tierConfig.cpuAnomalyThreshold || 80
    });

    this.folderAnalyzer = new FolderAnalysisEngine({
      quarantineRetentionDays: this.tierConfig.quarantineRetentionDays || 30
    });

    this.ramScheduler = new RamOptimizationScheduler({
      intervalMs: this.tierConfig.ramIntervalMs,
      cpuBusyThreshold: this.tierConfig.ramCpuThreshold || 25
    });

    this.diagnostics = new PerformanceDiagnosticsEngine({
      cpuAnomalyThreshold: this.tierConfig.cpuAnomalyThreshold || 80,
      memAnomalyThresholdMB: this.tierConfig.memAnomalyMB || 1500
    });

    this.dashboard = new DashboardServer(this, { port: options.port || 3899 });
    this.installer = new WindowsServiceInstaller();
    this.tray = new WindowsTrayManager({ port: options.port || 3899 });

    this.wireEvents();
  }

  wireEvents() {
    this.ramScheduler.on('optimized', (res) => {
      this.storage.logAudit({
        module: 'RAM_SCHEDULER',
        action: 'OPTIMIZE_RAM',
        metricsDelta: res
      });
    });

    this.ramScheduler.on('deferred', (res) => {
      this.storage.logAudit({
        module: 'RAM_SCHEDULER',
        action: 'DEFERRED_CLEANUP',
        details: res
      });
    });

    this.diagnostics.on('security_anomaly', (res) => {
      this.storage.logAudit({
        module: 'DIAGNOSTICS',
        action: 'SECURITY_ALERT',
        details: res
      });
    });
  }

  setTier(tierName) {
    this.storage.saveSetting('complexity_tier', tierName);
    this.tierConfig = this.storage.getTierConfig();
  }

  async start(options = {}) {
    this.core.start();
    this.ramScheduler.start();
    await this.dashboard.start();
    if (options.enableTray !== false) {
      this.tray.start();
    }
    this.storage.logAudit({
      module: 'SYSTEM',
      action: 'APP_START',
      details: { tier: this.tierConfig.tier }
    });
  }

  stop() {
    this.core.stop();
    this.ramScheduler.stop();
    this.dashboard.stop();
    this.tray.stop();
    this.storage.logAudit({
      module: 'SYSTEM',
      action: 'APP_STOP'
    });
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const app = new PcOptimizerApp();
  app.start().then(() => {
    console.log(`[PC-MON] Running at http://127.0.0.1:3899 with System Tray indicator.`);
  });
}

export default PcOptimizerApp;
