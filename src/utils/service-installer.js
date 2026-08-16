import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Windows Service & Startup Task Manager
 */
export class WindowsServiceInstaller {
  constructor(options = {}) {
    this.taskName = options.taskName || 'PCMonitorOptimizer';
    this.appEntry = path.resolve(options.appEntry || './src/index.js');
    this.nodeExe = process.execPath;
    this.isWin = process.platform === 'win32';
  }

  generateTaskXml() {
    const cwd = path.resolve('.');
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PC Monitor and Optimizer Background Daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${this.nodeExe}</Command>
      <Arguments>${this.appEntry}</Arguments>
      <WorkingDirectory>${cwd}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  }

  installStartupTask() {
    if (!this.isWin) {
      return { success: false, reason: 'NON_WINDOWS' };
    }

    try {
      // Create scheduled task via schtasks on logon
      const cmd = `schtasks /Create /TN "${this.taskName}" /TR "\\"${this.nodeExe}\\" \\"${this.appEntry}\\"" /SC ONLOGON /RL LIMITED /F`;
      execSync(cmd, { stdio: 'pipe' });
      return { success: true, method: 'SCHTASKS', taskName: this.taskName };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  uninstallStartupTask() {
    if (!this.isWin) {
      return { success: false, reason: 'NON_WINDOWS' };
    }

    try {
      const cmd = `schtasks /Delete /TN "${this.taskName}" /F`;
      execSync(cmd, { stdio: 'pipe' });
      return { success: true, taskName: this.taskName };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  isInstalled() {
    if (!this.isWin) return false;
    try {
      const cmd = `schtasks /Query /TN "${this.taskName}"`;
      execSync(cmd, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

export default WindowsServiceInstaller;
