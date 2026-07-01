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

function writeToFile(level, ...args) {
  try {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
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
