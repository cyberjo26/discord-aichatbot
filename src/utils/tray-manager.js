import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Windows System Tray Runner & Native Tray Process
 * Creates a lightweight PowerShell Windows Forms NotifyIcon
 */
export class WindowsTrayManager {
  constructor(options = {}) {
    this.port = options.port || 3899;
    this.process = null;
    this.isWin = process.platform === 'win32';
  }

  start() {
    if (!this.isWin || this.process) return;

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $True
$notify.Text = "PC Monitor & Optimizer"

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = $contextMenu.Items.Add("Open Dashboard")
$itemOpen.add_Click({
    Start-Process "http://127.0.0.1:${this.port}"
})

$itemClean = $contextMenu.Items.Add("Optimize RAM Now")
$itemClean.add_Click({
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:${this.port}/api/optimize-ram" -Method Post | Out-Null
        $notify.ShowBalloonTip(3000, "PC Optimizer", "RAM optimized successfully!", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {}
})

$itemExit = $contextMenu.Items.Add("Exit")
$itemExit.add_Click({
    $notify.Visible = $False
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $contextMenu

[System.Windows.Forms.Application]::Run()
`;

    this.process = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
      detached: true,
      stdio: 'ignore'
    });

    this.process.unref();
  }

  stop() {
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}

export default WindowsTrayManager;
