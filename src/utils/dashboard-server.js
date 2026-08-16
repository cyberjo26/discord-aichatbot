import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Embedded Web Dashboard & Local Tray API
 * Zero heavy frameworks - pure Node http module
 */
export class DashboardServer {
  constructor(app, options = {}) {
    this.app = app;
    this.port = options.port || 3899;
    this.server = null;
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API Routes
    if (pathname === '/api/status') {
      const metrics = await this.app.core.getSystemMetrics();
      const tray = this.app.ramScheduler.getTrayStatus();
      const tierConfig = this.app.tierConfig;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ metrics, tray, tierConfig }));
    }

    if (pathname === '/api/optimize-ram' && req.method === 'POST') {
      await this.app.ramScheduler.runOptimizationCycle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, lastResult: this.app.ramScheduler.lastResult }));
    }

    if (pathname === '/api/set-tier' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { tier } = JSON.parse(body);
          this.app.setTier(tier);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, tierConfig: this.app.tierConfig }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (pathname === '/api/audit-logs') {
      const logs = this.app.storage.getAuditLogs(50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(logs));
    }

    if (pathname === '/api/scan-folders' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { path: dirPath } = JSON.parse(body || '{}');
          const target = dirPath || './';
          const scanResults = this.app.folderAnalyzer.scan(target);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(scanResults));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Serve HTML Dashboard Frontend
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this.renderHtmlDashboard());
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  renderHtmlDashboard() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PC Monitor & Optimizer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 960px; margin: auto; }
    .card { background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid #334155; }
    h1, h2, h3 { margin-top: 0; }
    .row { display: flex; gap: 16px; margin-bottom: 16px; }
    .col { flex: 1; }
    button { background: #3b82f6; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    button:hover { background: #2563eb; }
    select { background: #0f172a; color: #fff; border: 1px solid #475569; padding: 8px; border-radius: 6px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: #0284c7; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #334155; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>PC Monitor & Optimizer Dashboard</h1>

    <div class="card">
      <div class="row" style="align-items: center; justify-content: space-between;">
        <div>
          <h2>System Health</h2>
          <p id="metrics-text">Loading metrics...</p>
        </div>
        <div>
          <button onclick="optimizeRam()">Optimize RAM Now</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Interface Complexity Tier</h2>
      <select id="tier-select" onchange="changeTier()">
        <option value="Basic">Basic (One-Click Actions)</option>
        <option value="Advanced">Advanced (Toggles & Detailed Controls)</option>
        <option value="Expert">Expert (Granular Thresholds & Policies)</option>
      </select>
    </div>

    <div class="card">
      <h2>Recent Audit History</h2>
      <div id="logs-container">Loading audit logs...</div>
    </div>
  </div>

  <script>
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('metrics-text').innerText =
        \`RAM Usage: \${data.metrics.memUsagePercent}% (\${data.metrics.freeMemMB} MB Free) | Next RAM Clean: \${data.tray.nextScheduled || 'Disabled'}\`;
      document.getElementById('tier-select').value = data.tierConfig.tier;
    }

    async function loadLogs() {
      const res = await fetch('/api/audit-logs');
      const logs = await res.json();
      let html = '<table><tr><th>Time</th><th>Module</th><th>Action</th><th>Target</th></tr>';
      logs.forEach(l => {
        html += \`<tr><td>\${l.timestamp.substring(11, 19)}</td><td>\${l.module}</td><td>\${l.action}</td><td>\${l.target || '-'}</td></tr>\`;
      });
      html += '</table>';
      document.getElementById('logs-container').innerHTML = html;
    }

    async function optimizeRam() {
      await fetch('/api/optimize-ram', { method: 'POST' });
      await loadStatus();
      await loadLogs();
    }

    async function changeTier() {
      const tier = document.getElementById('tier-select').value;
      await fetch('/api/set-tier', { method: 'POST', body: JSON.stringify({ tier }) });
      await loadStatus();
    }

    loadStatus();
    loadLogs();
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`;
  }
}

export default DashboardServer;
