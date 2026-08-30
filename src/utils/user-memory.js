import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import config from '../config.js';
import logger from './logger.js';
import { chatCompletion } from '../ai/router.js';

/**
 * Persistent User Memory — SQLite-backed.
 *
 * Three capabilities the old in-memory store lacked:
 * - user_state:   per-user quiet flag ("diam" → bot stays silent for THAT user
 *                 until they say speak again) + custom instructions text.
 * - user_facts:   durable facts passively extracted from conversations
 *                 (with TF-IDF retrieval; dedupe by similarity).
 * - All rows capped per user; least-recently-used facts evicted first.
 *
 * Storage: text rows only — a few MB for 1000 users on the 2GB budget.
 * ponytail: embeddings deliberately skipped; TF-IDF is enough at ≤50
 * facts/user. Upgrade path: add `embedding BLOB` column + cosine rank when
 * store exceeds ~5k rows.
 */

const MAX_FACTS_PER_USER = 50;
const FACT_TEXT_MAX = 200;
const CUSTOM_INSTRUCTIONS_MAX = 500;

// "jangan diam" (don't be silent) is an UNQUIET request even though it
// contains "diam" — check unquiet patterns first.
const UNQUIET_PATTERNS = /\b(ngomong\s*lagi|bicara\s*lagi|boleh\s*ngomong|jangan\s*(?:diam|diem)|speak\s*again|unmute|lanjut\s*ngomong)\b/i;
const QUIET_PATTERNS = /\b(diam|quiet|shut\s*up|bisu|jangan\s*bicara|stop\s*talking|hush)\b/i;

let db = null;

function open() {
  if (db?.open) return db;
  const dbPath = path.resolve(config.userMemoryDbPath || path.join(config.dataDir, 'user-memory.db'));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('busy_timeout = 5000');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS user_state (
      userId TEXT PRIMARY KEY,
      quiet INTEGER NOT NULL DEFAULT 0,
      quietedAt INTEGER,
      customInstructions TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      fact TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'correction')),
      hits INTEGER NOT NULL DEFAULT 0,
      lastUsed INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_facts_user ON user_facts(userId);
  `);
  db = connection;
  return db;
}

// ─── Per-user quiet state ──────────────────────────────────────────

export function isQuiet(userId) {
  const row = open().prepare(`SELECT quiet FROM user_state WHERE userId = ?`).get(userId);
  return Boolean(row?.quiet);
}

export function setQuiet(userId, quiet) {
  open().prepare(`
    INSERT INTO user_state (userId, quiet, quietedAt, customInstructions, updatedAt)
    VALUES (?, ?, ?, COALESCE((SELECT customInstructions FROM user_state WHERE userId = ?), ''), ?)
    ON CONFLICT(userId) DO UPDATE SET quiet = excluded.quiet, quietedAt = excluded.quietedAt, updatedAt = excluded.updatedAt
  `).run(userId, quiet ? 1 : 0, quiet ? Date.now() : null, userId, Date.now());
}

/**
 * Detect a quiet/unquiet directive in a message.
 * Returns 'quiet' | 'unquiet' | null. Checked in ALL entry points
 * (mention, prefix, slash) before anything else runs.
 */
export function detectQuietIntent(text) {
  if (!text) return null;
  // Unquiet first: "jangan diam" contains "diam" but means the opposite.
  if (UNQUIET_PATTERNS.test(text)) return 'unquiet';
  if (QUIET_PATTERNS.test(text)) return 'quiet';
  return null;
}

// Exact-command variant for prefix commands: only the command itself counts,
// never the args — `!memory set jangan diam` or `!ask gue lagi diam` must not
// toggle quiet state.
const QUIET_COMMANDS = new Set(['diam', 'diem', 'quiet', 'bisu', 'hush', 'shut-up', 'jangan-bicara', 'janganbicara']);
const UNQUIET_COMMANDS = new Set([
  'ngomong', 'ngomong lagi', 'ngomonglagi', 'bicara', 'bicara lagi', 'bicaralagi',
  'speak', 'speak again', 'unmute', 'lanjut', 'lanjut ngomong', 'jangan diam', 'jangan diem',
]);

export function detectQuietCommand(text) {
  if (!text) return null;
  const tokens = String(text).toLowerCase().trim().split(/\s+/);
  const head = tokens[0] || '';
  const head2 = tokens.slice(0, 2).join(' ');
  if (UNQUIET_COMMANDS.has(head) || UNQUIET_COMMANDS.has(head2)) return 'unquiet';
  if (QUIET_COMMANDS.has(head) || QUIET_COMMANDS.has(head2)) return 'quiet';
  return null;
}

// ─── Custom instructions ───────────────────────────────────────────

export function getCustomInstructions(userId) {
  const row = open().prepare(`SELECT customInstructions FROM user_state WHERE userId = ?`).get(userId);
  return row?.customInstructions || '';
}

export function setCustomInstructions(userId, text) {
  const clean = String(text || '').trim().slice(0, CUSTOM_INSTRUCTIONS_MAX);
  open().prepare(`
    INSERT INTO user_state (userId, quiet, quietedAt, customInstructions, updatedAt)
    VALUES (?, COALESCE((SELECT quiet FROM user_state WHERE userId = ?), 0), NULL, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET customInstructions = excluded.customInstructions, updatedAt = excluded.updatedAt
  `).run(userId, userId, clean, Date.now());
  return clean;
}

// ─── Facts: extract, store, recall ─────────────────────────────────

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

function similarity(a, b) {
  // Jaccard on token sets — cheap dedupe/rank without embeddings.
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function addFact(userId, fact, kind = 'fact') {
  const connection = open();
  const now = Date.now();
  const clean = fact.trim().slice(0, FACT_TEXT_MAX);
  if (!clean) return false;

  // Dedupe: high similarity to an existing fact bumps it instead of adding
  const existing = connection.prepare(`SELECT id, fact FROM user_facts WHERE userId = ?`).all(userId);
  for (const row of existing) {
    if (similarity(row.fact, clean) >= 0.6) {
      connection.prepare(`UPDATE user_facts SET hits = hits + 1, lastUsed = ? WHERE id = ?`).run(now, row.id);
      return false;
    }
  }

  connection.prepare(`
    INSERT INTO user_facts (userId, fact, kind, hits, lastUsed, createdAt) VALUES (?, ?, ?, 0, ?, ?)
  `).run(userId, clean, kind, now, now);

  // Evict least-recently-used beyond the cap
  const count = connection.prepare(`SELECT COUNT(*) AS c FROM user_facts WHERE userId = ?`).get(userId).c;
  if (count > MAX_FACTS_PER_USER) {
    connection.prepare(`
      DELETE FROM user_facts WHERE id IN (
        SELECT id FROM user_facts WHERE userId = ? ORDER BY lastUsed ASC, hits ASC LIMIT ?
      )
    `).run(userId, count - MAX_FACTS_PER_USER);
  }
  return true;
}

export function listFacts(userId) {
  return open().prepare(`SELECT * FROM user_facts WHERE userId = ? ORDER BY lastUsed DESC`).all(userId);
}

export function clearFacts(userId) {
  return open().prepare(`DELETE FROM user_facts WHERE userId = ?`).run(userId).changes;
}

/**
 * Recall facts relevant to a message. Ranks by token similarity, bumps
 * lastUsed/hits for the winners (usage-driven recency, like the learned
 * patterns' 500-cap eviction).
 */
export function recallFacts(userId, messageContent, limit = 5) {
  const rows = listFacts(userId);
  if (!rows.length) return [];
  const ranked = rows
    .map((row) => ({ row, score: similarity(row.fact, messageContent) }))
    .filter((r) => r.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (ranked.length) {
    const now = Date.now();
    const bump = open().prepare(`UPDATE user_facts SET hits = hits + 1, lastUsed = ? WHERE id = ?`);
    const tx = open().transaction(() => {
      for (const { row } of ranked) bump.run(now, row.id);
    });
    tx();
  }
  return ranked.map(({ row }) => row.fact);
}

/**
 * Passive extraction: pull durable facts out of a user message batch via a
 * cheap routing-tier AI call. Fire-and-forget safe; failures are swallowed.
 */
export async function extractFacts(userId, messages) {
  const conversation = messages
    .filter((m) => m && m.role === 'user' && m.content)
    .slice(-6)
    .map((m) => m.content)
    .join('\n');
  if (conversation.length < 40) return { added: 0 };

  try {
    const raw = await chatCompletion(
      [
        {
          role: 'system',
          content:
            'Ekstrak fakta personal user (hobi, pekerjaan, preferensi, hal penting yang layak diingat). ' +
            'Balas HANYA JSON array of strings (bahasa Indonesia), maksimal 3 fakta, masing-masing ≤25 kata. ' +
            'Hanya fakta yang berguna untuk percakapan masa depan. Jangan faktu tentu seperti nama sementara. ' +
            'Kalau tidak ada yang layak, balas [].',
        },
        { role: 'user', content: conversation },
      ],
      { task: 'routing' }
    );

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { added: 0 };
    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts)) return { added: 0 };

    let added = 0;
    for (const fact of facts) {
      if (typeof fact === 'string' && fact.trim()) {
        if (addFact(userId, fact, 'fact')) added++;
      }
    }
    if (added > 0) logger.debug(`User memory: +${added} fact(s) for ${userId}`);
    return { added };
  } catch (err) {
    logger.debug(`Fact extraction skipped: ${err.message}`);
    return { added: 0 };
  }
}

/**
 * Build the combined memory injection for the system prompt:
 * custom instructions + recalled facts. Empty string when nothing applies.
 */
export function buildMemoryInjection(userId, messageContent = '') {
  const parts = [];
  const instructions = getCustomInstructions(userId);
  if (instructions) parts.push(`INSTRUKSI PRIBADI USER (wajib diikuti): ${instructions}`);

  const facts = recallFacts(userId, messageContent);
  if (facts.length) parts.push(`HAL YANG DIKETAHUI TENTANG USER: ${facts.join(' | ')}`);

  return parts.join('\n');
}

export function closeUserMemory() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* best-effort */ }
  db.close();
  db = null;
}

export default {
  isQuiet, setQuiet, detectQuietIntent, detectQuietCommand, addFact,
  getCustomInstructions, setCustomInstructions,
  extractFacts, recallFacts, listFacts, clearFacts,
  buildMemoryInjection, closeUserMemory,
};
