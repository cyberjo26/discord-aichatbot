// Unit tests — persistent user memory (user-memory.js)
// Covers: quiet state persistence, detectQuietIntent, custom instructions,
// fact dedupe/eviction/recall, memory injection, close/reopen durability.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { setupEnv } from './helpers.mjs';
setupEnv();

const { isQuiet, setQuiet, detectQuietIntent, detectQuietCommand, getCustomInstructions, setCustomInstructions, listFacts, clearFacts, recallFacts, buildMemoryInjection, closeUserMemory, addFact } = await import('../src/utils/user-memory.js');

describe('detectQuietIntent', () => {
  test('detects quiet directives (id + en)', () => {
    for (const text of ['diam!', 'DIAM', 'shut up', 'bisu dong', 'hush']) {
      assert.equal(detectQuietIntent(text), 'quiet', text);
    }
  });

  test('detects unquiet directives', () => {
    for (const text of ['ngomong lagi', 'bicara lagi dong', 'speak again', 'lanjut ngomong']) {
      assert.equal(detectQuietIntent(text), 'unquiet', text);
    }
  });

  test('"jangan diam" is unquiet, not quiet', () => {
    assert.equal(detectQuietIntent('jangan diam'), 'unquiet');
    assert.equal(detectQuietIntent('jangan diem'), 'unquiet');
  });

  test('normal chatter returns null', () => {
    assert.equal(detectQuietIntent('halo gimana kabarnya'), null);
    assert.equal(detectQuietIntent(''), null);
    assert.equal(detectQuietIntent(null), null);
  });

  test('does not false-positive on words containing diam as substring', () => {
    assert.equal(detectQuietIntent('cerita yang panjang dan megah'), null);
  });
});

describe('detectQuietCommand (prefix-command exact matcher)', () => {
  test('exact quiet commands match', () => {
    for (const cmd of ['diam', 'DIEM', 'quiet', 'bisu']) {
      assert.equal(detectQuietCommand(cmd), 'quiet', cmd);
    }
  });

  test('exact unquiet commands match (head or head+arg)', () => {
    assert.equal(detectQuietCommand('ngomong'), 'unquiet');
    assert.equal(detectQuietCommand('ngomong lagi'), 'unquiet');
    assert.equal(detectQuietCommand('jangan diam'), 'unquiet');
    assert.equal(detectQuietCommand('unmute'), 'unquiet');
  });

  test('command head with args still matches', () => {
    assert.equal(detectQuietCommand('diam ya'), 'quiet');
    assert.equal(detectQuietCommand('ngomong lagi dong'), 'unquiet');
  });

  test('other commands whose ARGS mention diam do NOT toggle', () => {
    assert.equal(detectQuietCommand('memory set jangan diam'), null);
    assert.equal(detectQuietCommand('ask gue lagi diam'), null);
    assert.equal(detectQuietCommand('chat gue diam aja deh'), null);
  });

  test('non-quiet commands return null', () => {
    assert.equal(detectQuietCommand('ask siapa presiden'), null);
    assert.equal(detectQuietCommand(''), null);
  });
});

describe('per-user quiet state', () => {
  test('defaults to not quiet', () => {
    assert.equal(isQuiet('user-a'), false);
  });

  test('set + persists across close/reopen', () => {
    setQuiet('user-a', true);
    assert.equal(isQuiet('user-a'), true);
    closeUserMemory();
    assert.equal(isQuiet('user-a'), true);
    setQuiet('user-a', false);
    assert.equal(isQuiet('user-a'), false);
  });

  test('quiet state is per-user', () => {
    setQuiet('user-b', true);
    assert.equal(isQuiet('user-b'), true);
    assert.equal(isQuiet('user-c'), false);
    setQuiet('user-b', false);
  });
});

describe('custom instructions', () => {
  test('set/get/persist', () => {
    setCustomInstructions('user-d', 'Panggil gue Ani, jawab singkat');
    assert.match(getCustomInstructions('user-d'), /Ani/);
    closeUserMemory();
    assert.match(getCustomInstructions('user-d'), /Ani/);
  });

  test('truncates to 500 chars', () => {
    const saved = setCustomInstructions('user-e', 'x'.repeat(900));
    assert.equal(saved.length, 500);
  });

  test('does not clobber quiet flag', () => {
    setQuiet('user-f', true);
    setCustomInstructions('user-f', 'jawab santai');
    assert.equal(isQuiet('user-f'), true);
    setQuiet('user-f', false);
  });
});

describe('facts store', () => {
  beforeEach(() => {
    clearFacts('user-g');
  });

  test('addFact stores and lists', () => {
    assert.equal(addFact('user-g', 'Suka main Valorant tiap malem'), true);
    assert.equal(addFact('user-g', 'Kerja shift malem'), true);
    assert.equal(listFacts('user-g').length, 2);
  });

  test('dedupe: similar fact bumps instead of inserting', () => {
    addFact('user-g', 'Suka main Valorant tiap malem');
    addFact('user-g', 'suka main valorant tiap malem banget');
    assert.equal(listFacts('user-g').length, 1);
    assert.equal(listFacts('user-g')[0].hits >= 1, true);
  });

  test('recallFacts ranks by token similarity', () => {
    addFact('user-g', 'Suka main Valorant tiap malem');
    addFact('user-g', 'Kerja shift malem di pabrik');
    addFact('user-g', 'Pelihara kucing oren bernama Oyen');
    const hits = recallFacts('user-g', 'dia main valorant');
    assert.ok(hits.length >= 1);
    assert.match(hits[0], /Valorant/i);
  });

  test('recallFacts empty store / no match returns []', () => {
    assert.deepEqual(recallFacts('user-g', 'apa itu quantum'), []);
  });

  test('cap: 50 facts max, LRU evicted', () => {
    for (let i = 0; i < 55; i++) {
      // Distinct tokens per fact — otherwise the dedupe collapses them.
      addFact('user-g', `hobi${i} main${i} game${i} seri${i} favorit${i}`);
    }
    assert.equal(listFacts('user-g').length, 50);
  });

  test('facts persist across close/reopen', () => {
    addFact('user-g', ' Fakta persist ');
    closeUserMemory();
    const rows = listFacts('user-g');
    assert.equal(rows.length >= 1, true);
    assert.match(rows[0].fact, /Fakta persist/);
  });
});

describe('buildMemoryInjection', () => {
  test('includes custom instructions', () => {
    setCustomInstructions('user-i', 'jawab pake bahasa jawa');
    const out = buildMemoryInjection('user-i', 'halo');
    assert.match(out, /INSTRUKSI PRIBADI/);
    assert.match(out, /bahasa jawa/);
  });

  test('returns empty string for unknown user', () => {
    assert.equal(buildMemoryInjection('nobody-here', 'halo'), '');
  });
});

describe('durability', () => {
  test('db file exists in isolated temp dir', () => {
    const dbPath = process.env.USER_MEMORY_DB_PATH;
    assert.ok(fs.existsSync(dbPath), `db should exist at ${dbPath}`);
  });
});

after(() => {
  closeUserMemory();
});
