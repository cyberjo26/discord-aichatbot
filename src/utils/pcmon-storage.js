import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * User Experience Safeguards & Audit Storage Engine
 */
export class PcMonStorage {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.resolve('./data');
    this.dbPath = options.dbPath || path.join(this.dataDir, 'pcmon.sqlite');
    this.initDatabase();
  }

  initDatabase() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Create Audit Log Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        metrics_delta TEXT,
        trigger_type TEXT DEFAULT 'AUTOMATED'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Ensure default complexity tier
    const tier = this.getSetting('complexity_tier');
    if (!tier) {
      this.saveSetting('complexity_tier', 'Basic');
    }
  }

  logAudit({ module, action, target = null, details = null, metricsDelta = null, triggerType = 'AUTOMATED' }) {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (timestamp, module, action, target, details, metrics_delta, trigger_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      new Date().toISOString(),
      module,
      action,
      target,
      details ? JSON.stringify(details) : null,
      metricsDelta ? JSON.stringify(metricsDelta) : null,
      triggerType
    );
    return res.lastInsertRowid;
  }

  getAuditLogs(limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset);
    return rows.map((r) => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : null,
      metrics_delta: r.metrics_delta ? JSON.parse(r.metrics_delta) : null
    }));
  }

  getSetting(key) {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  saveSetting(key, value) {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  // 3 Complexity Tiers: Basic, Advanced, Expert
  getTierConfig() {
    const tier = this.getSetting('complexity_tier') || 'Basic';
    switch (tier) {
      case 'Expert':
        return {
          tier: 'Expert',
          ramIntervalMs: this.getSetting('ram_interval_ms') || 15 * 60 * 1000,
          ramCpuThreshold: this.getSetting('ram_cpu_threshold') || 25,
          staleDays: this.getSetting('stale_days') || 60,
          quarantineRetentionDays: this.getSetting('quarantine_retention_days') || 30,
          cpuAnomalyThreshold: this.getSetting('cpu_anomaly_threshold') || 80,
          memAnomalyMB: this.getSetting('mem_anomaly_mb') || 1500,
          dndStartHour: this.getSetting('dnd_start_hour') || 22,
          dndEndHour: this.getSetting('dnd_end_hour') || 7,
          allowAutoClean: true,
          detailedAlerts: true
        };
      case 'Advanced':
        return {
          tier: 'Advanced',
          ramIntervalMs: this.getSetting('ram_interval_ms') || 60 * 60 * 1000,
          staleDays: this.getSetting('stale_days') || 60,
          allowAutoClean: true,
          detailedAlerts: false
        };
      case 'Basic':
      default:
        return {
          tier: 'Basic',
          oneClickOptimize: true,
          ramIntervalMs: 60 * 60 * 1000,
          staleDays: 90,
          allowAutoClean: true,
          detailedAlerts: false
        };
    }
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

export default PcMonStorage;
