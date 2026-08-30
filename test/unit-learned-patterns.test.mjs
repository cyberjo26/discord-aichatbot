// Pattern-ID uniqueness after eviction.
// Drives the real completeLearning() flow with mocked AI (no network), inserts
// MAX+1 patterns so the least-used one is evicted, then asserts ids are unique
// and the newest id is max+1 (never length+1, which would collide).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpFile = path.join(os.tmpdir(), `lp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

let patternCounter = 0;
mock.module('../src/ai/openrouter.js', {
  namedExports: {
    chatCompletion: async () => {
      patternCounter++;
      return JSON.stringify({
        trigger: `trigger-${patternCounter}`,
        meaning: 'arti yang dimaksud',
        examples: ['contoh pemakaian'],
      });
    },
  },
});
mock.module('../src/ai/providers/gemini.js', {
  namedExports: {
    geminiEmbedding: async () => [0.1, 0.2, 0.3],
  },
});

const config = (await import('../src/config.js')).default;
config.learnedPatternsFile = tmpFile;

const lp = await import('../src/utils/learned-patterns.js');

test('learned-patterns: ids stay unique after eviction (max+1, not length+1)', async () => {
  for (let i = 1; i <= 501; i++) {
    const channelId = `lpch-${i}`;
    lp.startPendingLearn(channelId, 'user-1', `pesan awal ${i}`);
    assert.equal(lp.addExplanation(channelId, 'user-1', 'penjelasan'), true);
    const created = await lp.completeLearning(channelId, 'user-1');
    assert.ok(created, `pattern ${i} should be created`);
  }

  const all = lp.getAllPatterns();
  assert.equal(all.length, 500, '501st insert must evict the least-used pattern');

  const ids = all.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids must be unique after eviction');
  assert.equal(Math.max(...ids), 501, 'newest id must be max-existing+1, never reused');

  lp.forceSavePatterns(); // clears the debounce timer; writes to temp file
  fs.rmSync(tmpFile, { force: true });
});
