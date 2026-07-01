import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logger.js';
import { getReminderStorePath, backupDatabase } from './reminder-store.js';

/**
 * Automates backups of critical persistent data files.
 */
export async function backupDataFiles() {
  const filesToBackup = [];
  
  if (config.learnedPatternsFile) filesToBackup.push(config.learnedPatternsFile);
  if (config.serverSettingsFile) filesToBackup.push(config.serverSettingsFile);
  if (config.userPrefsFile) filesToBackup.push(config.userPrefsFile);
  if (config.wakeSleepFile) filesToBackup.push(config.wakeSleepFile);
  if (config.warningsFile) filesToBackup.push(config.warningsFile);
  
  let reminderDbPath = null;
  try {
    reminderDbPath = getReminderStorePath();
    if (reminderDbPath) filesToBackup.push(reminderDbPath);
  } catch (err) {
    logger.warn('Failed to resolve reminder DB path for backup');
  }
  
  const backupDir = path.join(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let successCount = 0;
  
  for (const file of filesToBackup) {
    if (fs.existsSync(file)) {
      try {
        const filename = path.basename(file);
        const backupPath = path.join(backupDir, `${filename}.${timestamp}.bak`);
        if (file === reminderDbPath) {
          await backupDatabase(backupPath);
        } else {
          fs.copyFileSync(file, backupPath);
        }
        successCount++;
      } catch (err) {
        logger.error(`Failed to backup ${file}: ${err.message}`);
      }
    }
  }
  
  // Cleanup old backups (keep only last 7 days)
  try {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const existingBackups = fs.readdirSync(backupDir);
    
    let deletedCount = 0;
    for (const file of existingBackups) {
      if (!file.endsWith('.bak')) continue;
      
      const filePath = path.join(backupDir, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > SEVEN_DAYS_MS) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      logger.debug(`Cleaned up ${deletedCount} old backup files`);
    }
  } catch (err) {
    logger.error(`Failed to cleanup old backups: ${err.message}`);
  }
  
  if (successCount > 0) {
    logger.info(`📦 Backup completed for ${successCount} data files`);
  }
}

/**
 * Initializes the daily backup job.
 */
export function initBackups() {
  // Run once immediately, then daily
  backupDataFiles();
  
  const DAILY_MS = 24 * 60 * 60 * 1000;
  setInterval(backupDataFiles, DAILY_MS);
}

export default { initBackups, backupDataFiles };
