import fs from 'fs';
import path from 'path';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

function timestamp() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function getDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const logDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'bot.log');

// Rotation: when bot.log exceeds MAX_LOG_BYTES, rename it to bot-<date>.log
// (overwriting any same-day rollover) and start fresh. Keeps a long-running
// bot's log bounded instead of growing forever.
// 5 MB × 3 files = ~20 MB worst case — sized for small (2 GB) VPS disks.
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_LOG_FILES = 3; // keep at most 3 rotated files

function rotateIfNeeded() {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size < MAX_LOG_BYTES) return;

    const rotated = path.join(logDir, `bot-${getDateString()}.log`);
    fs.renameSync(logFile, rotated);

    // Prune oldest rotated files beyond MAX_LOG_FILES
    const rotatedFiles = fs.readdirSync(logDir)
      .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    while (rotatedFiles.length > MAX_LOG_FILES) {
      fs.unlinkSync(path.join(logDir, rotatedFiles.shift()));
    }
  } catch {
    // File may not exist yet or rename failed (e.g. locked on Windows) —
    // rotation is best-effort; logging continues into the current file.
  }
}

function writeToFile(level, ...args) {
  try {
    rotateIfNeeded();
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    // eslint-disable-next-line no-control-regex -- intentional ANSI escape stripping
    const plainText = message.replace(/\x1b\[[0-9;]*m/g, '');
    const dateStamp = getDateString() + ' ' + timestamp();
    fs.appendFileSync(logFile, `[${dateStamp}] [${level}] ${plainText}\n`);
  } catch (err) {
    // ignore
  }
}

const logger = {
  debug(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.debug) {
      console.log(`${colors.dim}[${timestamp()}] [DEBUG]${colors.reset}`, ...args);
      writeToFile('DEBUG', ...args);
    }
  },
  info(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      console.log(`${colors.cyan}[${timestamp()}] [INFO]${colors.reset}`, ...args);
      writeToFile('INFO', ...args);
    }
  },
  success(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      console.log(`${colors.green}[${timestamp()}] [OK]${colors.reset}`, ...args);
      writeToFile('OK', ...args);
    }
  },
  warn(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.warn) {
      console.warn(`${colors.yellow}[${timestamp()}] [WARN]${colors.reset}`, ...args);
      writeToFile('WARN', ...args);
    }
  },
  error(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.error) {
      console.error(`${colors.red}[${timestamp()}] [ERROR]${colors.reset}`, ...args);
      writeToFile('ERROR', ...args);
    }
  },
  command(user, command, args = '') {
    console.log(
      `${colors.magenta}[${timestamp()}] [CMD]${colors.reset} ${user} → /${command} ${args}`
    );
    writeToFile('CMD', `${user} -> /${command} ${args}`);
  },
};

export default logger;
