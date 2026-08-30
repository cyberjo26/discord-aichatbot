import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname);
const ENTRY = path.join(ROOT, 'src', 'index.js');
const LOG_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(LOG_DIR, 'supervisor.log');
const TZ = process.env.RESTART_TZ || process.env.TIMEZONE || 'Asia/Bangkok';
const SHUTDOWN_GRACE_MS = 15_000;
const CRASH_RESTART_DELAY_MS = 5_000;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* dir may already exist */ }

function ts() {
  return new Date().toISOString();
}

function write(message) {
  const line = `[${ts()}] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* log write is best-effort */ }
  console.log(`[supervisor] ${message}`);
}

/**
 * Milliseconds from `now` until the next 00:00:00 in `tz`.
 */
export function msUntilMidnight(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get('hour') % 24;
  const elapsedMs = ((hour * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return 24 * 60 * 60 * 1000 - elapsedMs;
}

let child = null;
let restartTimer = null;
let stopping = false;

function startBot() {
  write(`spawn: pid=${process.pid} entry=${ENTRY}`);
  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    stdio: 'inherit',
    detached: false,
    windowsHide: true,
  });

  write(`bot started: pid=${child.pid}`);

  child.on('exit', (code, signal) => {
    write(`bot exited: code=${code} signal=${signal ?? 'none'} at=${ts()}`);
    child = null;
    if (stopping) return;

    clearTimeout(restartTimer);
    write(`auto-restart scheduled in ${CRASH_RESTART_DELAY_MS / 1000}s (reason=exit)`);
    restartTimer = setTimeout(startBot, CRASH_RESTART_DELAY_MS).unref();
  });

  child.on('error', (err) => write(`spawn error: ${err.message}`));

  const waitMs = msUntilMidnight(TZ);
  write(`next scheduled restart in ${Math.round(waitMs / 60000)} min (tz=${TZ})`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(scheduledRestart, waitMs).unref();
}

async function scheduledRestart() {
  write('midnight reached: scheduling graceful restart');
  if (!child) return startBot();

  const exited = waitForExit(child);
  try { child.kill('SIGTERM'); write('signal=SIGTERM sent'); } catch (e) { write(`SIGTERM failed: ${e.message}`); }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS).unref()),
  ]);

  if (timedOut && child) {
    write(`graceful shutdown timed out (${SHUTDOWN_GRACE_MS}ms); sending SIGKILL`);
    try { child.kill('SIGKILL'); } catch (e) { write(`SIGKILL failed: ${e.message}`); }
    await exited;
  }
  startBot();
}

function waitForExit(proc) {
  return new Promise((resolve) => proc.once('exit', resolve));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(restartTimer);
    write(`${signal} received by supervisor; forwarding to bot`);
    try { child?.kill(signal); } catch { /* child may already be gone */ }
    setTimeout(() => { write('supervisor exit: timeout'); process.exit(0); }, SHUTDOWN_GRACE_MS).unref();
    if (child) child.once('exit', () => { write('supervisor exit: child exited'); process.exit(0); });
    else process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  write(`supervisor uncaught: ${err?.stack || err?.message || err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  write(`supervisor unhandled rejection: ${reason?.stack || reason?.message || reason}`);
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startBot();
}