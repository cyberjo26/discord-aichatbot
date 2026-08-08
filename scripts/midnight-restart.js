/**
 * Supervisor: run the bot and restart it every day at 00:00.
 *
 * Use as the hosting panel startup command when the panel has no scheduler:
 *   node scripts/midnight-restart.js
 *
 * Restart timezone comes from RESTART_TZ, falling back to TIMEZONE, then Asia/Bangkok.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const TZ = process.env.RESTART_TZ || process.env.TIMEZONE || 'Asia/Bangkok';
const SHUTDOWN_GRACE_MS = 15_000;
const CRASH_RESTART_DELAY_MS = 5_000;

/**
 * Milliseconds from `now` until the next 00:00:00 in `tz`.
 * Exported for the self-check in scripts/midnight-restart.test.js.
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
  // Intl can emit hour 24 for midnight in hour12:false mode.
  const hour = get('hour') % 24;
  const elapsedMs = ((hour * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return 24 * 60 * 60 * 1000 - elapsedMs;
}

function log(message) {
  console.log(`[supervisor] ${message}`);
}

let child = null;
let restartTimer = null;
let stopping = false;

function startBot() {
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    clearTimeout(restartTimer);
    log(`bot exited (code=${code} signal=${signal}); restarting in ${CRASH_RESTART_DELAY_MS / 1000}s`);
    restartTimer = setTimeout(startBot, CRASH_RESTART_DELAY_MS).unref();
  });

  child.on('error', (err) => log(`spawn failed: ${err.message}`));

  const waitMs = msUntilMidnight(TZ);
  log(`bot started (pid=${child.pid}); next scheduled restart in ${Math.round(waitMs / 60000)} min (${TZ})`);

  clearTimeout(restartTimer);
  restartTimer = setTimeout(scheduledRestart, waitMs).unref();
}

async function scheduledRestart() {
  if (!child) return startBot();

  log('midnight reached; sending SIGTERM for graceful shutdown');
  const exited = waitForExit(child);
  child.kill('SIGTERM');

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS).unref()),
  ]);

  if (timedOut && child) {
    log('graceful shutdown timed out; sending SIGKILL');
    child.kill('SIGKILL');
    await exited;
  }
  // The 'exit' handler clears `child`, then this restart path spawns the new process.
  startBot();
}

function waitForExit(proc) {
  return new Promise((resolve) => proc.once('exit', resolve));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(restartTimer);
    log(`${signal} received; forwarding to bot`);
    child?.kill(signal);
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    if (child) child.once('exit', () => process.exit(0));
    else process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startBot();
}
