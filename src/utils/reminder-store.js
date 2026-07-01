import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import config from '../config.js';
import logger from './logger.js';

const SCHEMA_VERSION = 2;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const GRACE_MS = 24 * 60 * 60 * 1000;
const INSTANCE_ID = `${process.pid}-${randomUUID()}`;

let db = null;

function createSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      guildId TEXT NOT NULL,
      text TEXT NOT NULL,
      triggerAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('text', 'voice', 'both')),
      fallbackChannelId TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled', 'missed')),
      timezone TEXT,
      claimedBy TEXT,
      leaseUntil INTEGER,
      completedAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(status, triggerAt);
    CREATE INDEX IF NOT EXISTS idx_reminders_user
      ON reminders(userId, status);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function migrateSchema(connection) {
  const table = connection.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'`
  ).get();

  if (!table) {
    createSchema(connection);
    connection.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const columns = connection.prepare(`PRAGMA table_info(reminders)`).all();
  const byName = new Map(columns.map((column) => [column.name, column]));
  const required = [
    'id', 'userId', 'guildId', 'text', 'triggerAt', 'createdAt', 'delivery',
    'fallbackChannelId', 'status', 'timezone', 'claimedBy', 'leaseUntil', 'completedAt',
  ];
  const idColumn = byName.get('id');
  const needsRebuild = required.some((name) => !byName.has(name))
    || idColumn?.type?.toUpperCase() !== 'INTEGER'
    || idColumn?.pk !== 1;

  if (!needsRebuild) {
    createSchema(connection);
    connection.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const has = (name) => byName.has(name);
  const expr = (name, fallback) => has(name) ? `"${name}"` : fallback;
  const migrate = connection.transaction(() => {
    connection.exec(`DROP TABLE IF EXISTS reminders_legacy_migration`);
    connection.exec(`ALTER TABLE reminders RENAME TO reminders_legacy_migration`);
    createSchema(connection);
    connection.exec(`
      INSERT OR IGNORE INTO reminders
        (id, userId, guildId, text, triggerAt, createdAt, delivery,
         fallbackChannelId, status, timezone, claimedBy, leaseUntil, completedAt)
      SELECT
        CASE WHEN CAST(${expr('id', 'NULL')} AS INTEGER) > 0
          THEN CAST(${expr('id', 'NULL')} AS INTEGER) ELSE NULL END,
        ${expr('userId', "''")},
        ${expr('guildId', "''")},
        ${expr('text', "''")},
        ${expr('triggerAt', '0')},
        ${expr('createdAt', '0')},
        CASE WHEN ${expr('delivery', "'text'")} IN ('text', 'voice', 'both')
          THEN ${expr('delivery', "'text'")} ELSE 'text' END,
        ${expr('fallbackChannelId', "''")},
        CASE WHEN ${expr('status', "'failed'")} IN
          ('pending', 'processing', 'completed', 'failed', 'cancelled', 'missed')
          THEN ${expr('status', "'failed'")} ELSE 'failed' END,
        ${expr('timezone', 'NULL')},
        ${expr('claimedBy', 'NULL')},
        ${expr('leaseUntil', 'NULL')},
        ${expr('completedAt', 'NULL')}
      FROM reminders_legacy_migration;
    `);
    connection.exec(`DROP TABLE reminders_legacy_migration`);
    createSchema(connection);
    connection.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  migrate.immediate();
  logger.info(`SQLite reminder schema migrated to v${SCHEMA_VERSION}`);
}

function normalizeReminder(reminder) {
  return {
    id: reminder.id == null ? null : Number(reminder.id),
    userId: String(reminder.userId || ''),
    guildId: String(reminder.guildId || ''),
    text: String(reminder.text || 'Reminder!'),
    triggerAt: Number(reminder.triggerAt) || Date.now(),
    createdAt: Number(reminder.createdAt) || Date.now(),
    delivery: ['text', 'voice', 'both'].includes(reminder.delivery) ? reminder.delivery : 'text',
    fallbackChannelId: String(reminder.fallbackChannelId || reminder.channelId || ''),
    status: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'missed'].includes(reminder.status)
      ? reminder.status
      : 'pending',
    timezone: reminder.timezone || config.timezone || 'Asia/Jakarta',
    claimedBy: reminder.claimedBy || null,
    leaseUntil: reminder.leaseUntil || null,
    completedAt: reminder.completedAt || null,
  };
}

function migrateLegacyJson(connection) {
  const migrationKey = 'legacy_json_migrated_v1';
  const done = connection.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(migrationKey);
  if (done) return;

  const legacyPath = path.resolve(config.legacyRemindersFile);
  if (!fs.existsSync(legacyPath)) {
    connection.prepare(`INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)`).run(migrationKey, 'absent');
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.reminders;
    if (!Array.isArray(list)) throw new Error('Format JSON reminder tidak valid');

    const insertWithId = connection.prepare(`
      INSERT OR IGNORE INTO reminders
        (id, userId, guildId, text, triggerAt, createdAt, delivery,
         fallbackChannelId, status, timezone, claimedBy, leaseUntil, completedAt)
      VALUES
        (@id, @userId, @guildId, @text, @triggerAt, @createdAt, @delivery,
         @fallbackChannelId, @status, @timezone, @claimedBy, @leaseUntil, @completedAt)
    `);
    const insertAuto = connection.prepare(`
      INSERT INTO reminders
        (userId, guildId, text, triggerAt, createdAt, delivery,
         fallbackChannelId, status, timezone)
      VALUES
        (@userId, @guildId, @text, @triggerAt, @createdAt, @delivery,
         @fallbackChannelId, @status, @timezone)
    `);
    const migrate = connection.transaction(() => {
      for (const raw of list) {
        const reminder = normalizeReminder(raw);
        if (!reminder.userId || !reminder.guildId || !reminder.fallbackChannelId) continue;
        if (Number.isInteger(reminder.id) && reminder.id > 0) insertWithId.run(reminder);
        else insertAuto.run(reminder);
      }
      connection.prepare(`INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)`).run(
        migrationKey,
        new Date().toISOString(),
      );
    });
    migrate.immediate();
    logger.info(`Migrated ${list.length} legacy JSON reminders to SQLite`);
  } catch (err) {
    logger.warn(`Legacy reminder JSON migration skipped: ${err.message}`);
  }
}

export function openReminderStore() {
  if (db?.open) return db;

  const dbPath = path.resolve(config.remindersDbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let connection;
  try {
    connection = new Database(dbPath);
    connection.pragma('journal_mode = WAL');
    connection.pragma('synchronous = NORMAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    migrateSchema(connection);
    migrateLegacyJson(connection);
    connection.prepare('SELECT 1').get();
    db = connection;
    return db;
  } catch (err) {
    try { connection?.close(); } catch { /* ignore close failure */ }
    db = null;
    throw new Error(`Gagal membuka SQLite reminder DB: ${err.message}`);
  }
}

export function closeReminderStore() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logger.warn(`SQLite checkpoint failed during shutdown: ${err.message}`);
  }
  db.close();
  db = null;
}

export function saveReminderRows(list) {
  const connection = openReminderStore();
  const upsert = connection.prepare(`
    INSERT INTO reminders
      (id, userId, guildId, text, triggerAt, createdAt, delivery,
       fallbackChannelId, status, timezone, claimedBy, leaseUntil, completedAt)
    VALUES
      (@id, @userId, @guildId, @text, @triggerAt, @createdAt, @delivery,
       @fallbackChannelId, @status, @timezone, @claimedBy, @leaseUntil, @completedAt)
    ON CONFLICT(id) DO UPDATE SET
      userId=excluded.userId, guildId=excluded.guildId, text=excluded.text,
      triggerAt=excluded.triggerAt, createdAt=excluded.createdAt,
      delivery=excluded.delivery, fallbackChannelId=excluded.fallbackChannelId,
      status=excluded.status, timezone=excluded.timezone,
      claimedBy=excluded.claimedBy, leaseUntil=excluded.leaseUntil,
      completedAt=excluded.completedAt
  `);
  const insertAuto = connection.prepare(`
    INSERT INTO reminders
      (userId, guildId, text, triggerAt, createdAt, delivery,
       fallbackChannelId, status, timezone)
    VALUES
      (@userId, @guildId, @text, @triggerAt, @createdAt, @delivery,
       @fallbackChannelId, @status, @timezone)
  `);
  const save = connection.transaction((rows) => {
    for (const raw of rows) {
      const reminder = normalizeReminder(raw);
      if (Number.isInteger(reminder.id) && reminder.id > 0) upsert.run(reminder);
      else insertAuto.run(reminder);
    }
  });
  save.immediate(list);
}

export function initializeReminderRows(now = Date.now()) {
  const connection = openReminderStore();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  connection.prepare(
    `DELETE FROM reminders
     WHERE status NOT IN ('pending', 'processing') AND triggerAt < ?`
  ).run(cutoff);
  connection.prepare(`
    UPDATE reminders
    SET status='pending', claimedBy=NULL, leaseUntil=NULL
    WHERE status='processing' AND (leaseUntil IS NULL OR leaseUntil <= ?)
      AND triggerAt >= ?
  `).run(now, now - GRACE_MS);
  connection.prepare(`
    UPDATE reminders
    SET status='missed', claimedBy=NULL, leaseUntil=NULL, completedAt=?
    WHERE status IN ('pending', 'processing') AND triggerAt < ?
  `).run(now, now - GRACE_MS);
  return listReminderRows();
}

export function listReminderRows() {
  return openReminderStore().prepare(`SELECT * FROM reminders ORDER BY id`).all();
}

export function claimDueReminderRows(now = Date.now(), limit = 25) {
  const connection = openReminderStore();
  const claim = connection.transaction(() => {
    connection.prepare(`
      UPDATE reminders
      SET status='pending', claimedBy=NULL, leaseUntil=NULL
      WHERE status='processing' AND leaseUntil <= ? AND triggerAt >= ?
    `).run(now, now - GRACE_MS);
    connection.prepare(`
      UPDATE reminders
      SET status='missed', claimedBy=NULL, leaseUntil=NULL, completedAt=?
      WHERE status IN ('pending', 'processing') AND triggerAt < ?
    `).run(now, now - GRACE_MS);

    const candidates = connection.prepare(`
      SELECT * FROM reminders
      WHERE status='pending' AND triggerAt <= ?
      ORDER BY triggerAt ASC LIMIT ?
    `).all(now, limit);
    const mark = connection.prepare(`
      UPDATE reminders
      SET status='processing', claimedBy=?, leaseUntil=?
      WHERE id=? AND status='pending'
    `);
    const claimed = [];
    for (const row of candidates) {
      const result = mark.run(INSTANCE_ID, now + CLAIM_LEASE_MS, row.id);
      if (result.changes === 1) {
        claimed.push({ ...row, status: 'processing', claimedBy: INSTANCE_ID, leaseUntil: now + CLAIM_LEASE_MS });
      }
    }
    return claimed;
  });
  return claim.immediate();
}

export function finishReminderClaim(id, status) {
  if (!['completed', 'failed'].includes(status)) throw new Error(`Invalid final reminder status: ${status}`);
  const result = openReminderStore().prepare(`
    UPDATE reminders
    SET status=?, claimedBy=NULL, leaseUntil=NULL, completedAt=?
    WHERE id=? AND claimedBy=? AND status='processing'
  `).run(status, Date.now(), id, INSTANCE_ID);
  return result.changes === 1;
}

export function createReminderRow(data) {
  const reminder = normalizeReminder({ ...data, id: null, status: 'pending' });
  const result = openReminderStore().prepare(`
    INSERT INTO reminders
      (userId, guildId, text, triggerAt, createdAt, delivery,
       fallbackChannelId, status, timezone)
    VALUES
      (@userId, @guildId, @text, @triggerAt, @createdAt, @delivery,
       @fallbackChannelId, @status, @timezone)
  `).run(reminder);
  return { ...reminder, id: Number(result.lastInsertRowid) };
}

export function listPendingRemindersForUser(userId) {
  return openReminderStore().prepare(`
    SELECT * FROM reminders WHERE userId=? AND status='pending' ORDER BY triggerAt
  `).all(userId);
}

export function cancelReminderRow(id) {
  return openReminderStore().prepare(`
    UPDATE reminders SET status='cancelled', completedAt=?
    WHERE id=? AND status='pending'
  `).run(Date.now(), id).changes === 1;
}

export function cancelReminderRowsForUser(userId) {
  return openReminderStore().prepare(`
    UPDATE reminders SET status='cancelled', completedAt=?
    WHERE userId=? AND status='pending'
  `).run(Date.now(), userId).changes;
}

export async function backupDatabase(destPath) {
  if (!db) return false;
  await db.backup(destPath);
  return true;
}

export function getReminderStorePath() {
  return path.resolve(config.remindersDbPath);
}
