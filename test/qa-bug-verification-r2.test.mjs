// QA regression-guard suite (round 2 → post-fix).
// These tests originally ASSERTED the buggy behaviour to pin each defect.
// Now that the fixes have landed, every assertion is INVERTED to assert the
// CORRECT behaviour, so any future regression of these bugs fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers.mjs';

setupEnv();

const ROOT = path.resolve(import.meta.dirname, '..');

// ─── Mock the fresh-answer pipeline's external dependencies ─────────
// fresh.js pulls webSearch / scrapeMultiple / chatCompletion. We stub all
// three so the pipeline runs fully offline and deterministically.
const FRESH_SOURCE = { title: 'Sumber Tes', url: 'https://example.com/artikel', snippet: 'snippet singkat' };

mock.module('../src/rag/search.js', {
  namedExports: {
    webSearch: async (query) => {
      if (String(query).includes('tanpasumber')) return [];
      return [FRESH_SOURCE];
    },
  },
  defaultExport: {
    webSearch: async (query) => (String(query).includes('tanpasumber') ? [] : [FRESH_SOURCE]),
  },
});

mock.module('../src/rag/scraper.js', {
  namedExports: {
    scrapeMultiple: async () => [{ ...FRESH_SOURCE, content: 'konten lengkap dari artikel' }],
  },
  defaultExport: {
    scrapeMultiple: async () => [{ ...FRESH_SOURCE, content: 'konten lengkap dari artikel' }],
  },
});

const fakeChatCompletion = async (messages) => {
  const sys = (messages || []).find((m) => m.role === 'system')?.content || '';
  if (sys.includes('gate classifier')) {
    return JSON.stringify({ needs_fresh_data: true, reason: 'test', search_query: 'test query' });
  }
  return JSON.stringify({ answer: 'Jawaban segar dari web.', sources_used: [1], confidence: 'high' });
};

mock.module('../src/ai/openrouter.js', {
  namedExports: { chatCompletion: fakeChatCompletion },
  defaultExport: { chatCompletion: fakeChatCompletion },
});

// Import modules AFTER mocks are registered.
const { checkRateLimit, releaseRateLimit, cleanupRateLimits } = await import('../src/utils/rate-limit.js');
const { parseAbsoluteTime } = await import('../src/utils/reminders.js');
const { freshAnswer, needsFreshData, looksTimeSensitive } = await import('../src/ai/fresh.js');

// ─── BUG-1 (FIXED): welcome status uses a real newline join ────────
test('BUG-1 fixed: welcome status joins with a real newline, not literal \\n', () => {
  const prefix = fs.readFileSync(path.join(ROOT, 'src/prefix-handler.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'src/commands/admin.js'), 'utf8');
  const literal = ".join('\\\\n')"; // source-level backslash+n
  assert.ok(!prefix.includes(literal), 'prefix-handler no longer uses literal \\n join');
  assert.ok(!admin.includes(literal), 'admin.js no longer uses literal \\n join');
});

// ─── BUG-2 (FIXED): guild quota no longer leaks on user rejection ──
test('BUG-2 fixed: denied request does not consume a guild-quota slot', () => {
  cleanupRateLimits();
  const guild = 'g-fixed-' + Date.now();
  const spammer = 'spammer-' + Date.now();

  const tokens = [];
  for (let i = 0; i < 20; i++) {
    const r = checkRateLimit(spammer, guild);
    assert.ok(r.allowed, `request ${i} should be allowed`);
    tokens.push(r.token);
  }

  const denied = checkRateLimit(spammer, guild);
  assert.equal(denied.allowed, false, '21st request denied');
  assert.equal(denied.reason, 'user_quota');

  // Guild cap is 150; spammer consumed exactly 20. With the leak fixed the
  // denied request consumed NOTHING, so other users get 150 - 20 = 130.
  let allowedForOthers = 0;
  for (let i = 0; i < 200; i++) {
    const r = checkRateLimit(`other-${Date.now()}-${i}`, guild);
    if (r.allowed) { allowedForOthers++; releaseRateLimit(r.token); }
    else break;
  }
  assert.equal(allowedForOthers, 130, 'no guild slot leaked (130, not 129)');

  for (const t of tokens) releaseRateLimit(t);
  cleanupRateLimits();
});

// ─── BUG-3 (FIXED): markPatternUsed is now invoked ──────────────────
test('BUG-3 fixed: markPatternUsed has at least one caller in src/', () => {
  const srcDir = path.join(ROOT, 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  };
  walk(srcDir);

  let callCount = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (/function\s+markPatternUsed/.test(line)) continue; // definition
      if (/markPatternUsed\s*\(/.test(line)) callCount++;
    }
  }
  assert.ok(callCount >= 1, 'markPatternUsed() is now called (usage tracking wired)');
});

// ─── BUG-4 (FIXED): GuildMessageTyping intent declared ──────────────
test('BUG-4 fixed: GuildMessageTyping intent is declared', () => {
  const index = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
  assert.ok(index.includes("client.on('typingStart'"), 'typingStart listener present');
  assert.ok(index.includes('GuildMessageTyping'), 'GuildMessageTyping intent now declared');
});

// ─── BUG-5 (FIXED): config.warningsFile defined + used ──────────────
test('BUG-5 fixed: config.warningsFile is defined so warnings are backed up', async () => {
  const config = (await import('../src/config.js')).default;
  assert.ok(config.warningsFile, 'config.warningsFile is now defined');
  assert.ok(config.warningsFile.endsWith('warnings.json'), 'points at warnings.json');

  const warnings = fs.readFileSync(path.join(ROOT, 'src/utils/warnings.js'), 'utf8');
  assert.ok(warnings.includes('config.warningsFile'), 'warnings.js now reads config.warningsFile');
});

// ─── BUG-6 (FIXED): geminiEmbedding uses the rotated key list ───────
test('BUG-6 fixed: geminiEmbedding uses the multi-key rotation', () => {
  const gemini = fs.readFileSync(path.join(ROOT, 'src/ai/providers/gemini.js'), 'utf8');
  const embedFn = gemini.slice(gemini.indexOf('export async function geminiEmbedding'));
  assert.ok(embedFn.includes('geminiApiKeys'), 'embedding now references the multi-key list');
});

// ─── BUG-7 (FIXED): /ping has a fetch timeout ───────────────────────
test('BUG-7 fixed: /ping slash command caps its fetch with a timeout', () => {
  const pingCmd = fs.readFileSync(path.join(ROOT, 'src/commands/ping.js'), 'utf8');
  assert.ok(pingCmd.includes('AbortSignal.timeout'), '/ping now uses AbortSignal.timeout');
});

// ─── BUG-8 (FIXED): /chat uses the same history window as !chat ─────
test('BUG-8 fixed: /chat slices history to the same window as !chat', () => {
  const chatCmd = fs.readFileSync(path.join(ROOT, 'src/commands/chat.js'), 'utf8');
  assert.ok(chatCmd.includes('history.slice(-6)'), '/chat now uses history.slice(-6)');
});

// ─── BUG-9 (FIXED): "jam 6 siang" parses to 18:00 ───────────────────
test('BUG-9 fixed: parseAbsoluteTime("jam 6 siang") is 18:00, not 06:00', () => {
  const tz = 'Asia/Jakarta';
  const ms = parseAbsoluteTime('jam 6 siang', tz);
  assert.ok(ms, 'parsed to a timestamp');
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms)));
  assert.equal(hour, 18, '"jam 6 siang" resolves to 18:00');

  // Sanity: genuine late-morning "siang" (10–11) must NOT be shifted.
  const ms10 = parseAbsoluteTime('jam 10 siang', tz);
  const hour10 = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms10)));
  assert.equal(hour10, 10, '"jam 10 siang" stays 10:00');
});

// ─── SEC-A (FIXED): /test-ai is permission-gated ────────────────────
test('SEC-A fixed: /test-ai sets default member permissions', () => {
  const testAi = fs.readFileSync(path.join(ROOT, 'src/commands/test-ai.js'), 'utf8');
  assert.ok(testAi.includes('setDefaultMemberPermissions'), '/test-ai now sets default member permissions');
  assert.ok(testAi.includes('Administrator'), 'gated on Administrator');
});

// ─── SEC-B (FIXED): belajar:/ajarkan: learning is permission-gated ──
test('SEC-B fixed: belajar:/ajarkan: trigger is gated behind a permission check', () => {
  const mention = fs.readFileSync(path.join(ROOT, 'src/mention-handler.js'), 'utf8');
  // The learn trigger block must reference a permission/owner gate.
  const learnBlock = mention.slice(mention.indexOf("belajar:"));
  assert.ok(/canTeach|isOwner|ManageGuild/.test(learnBlock), 'learn trigger now checks canTeach/isOwner/ManageGuild');
});

// ─── Fresh-answer pipeline: local time-sensitivity check ────────────
test('fresh: looksTimeSensitive detects time anchors and ignores evergreen text', () => {
  assert.equal(looksTimeSensitive('berita terbaru hari ini'), true);
  assert.equal(looksTimeSensitive('siapa juara dunia 2026'), true);
  assert.equal(looksTimeSensitive('apa itu fotosintesis'), false);
  assert.equal(looksTimeSensitive('jelaskan cara kerja recursion'), false);
});

// ─── Fresh-answer pipeline: gate decisions ──────────────────────────
test('fresh: needsFreshData short-circuits greetings (no) and time anchors (yes)', async () => {
  const greeting = await needsFreshData('halo');
  assert.equal(greeting.needsFreshData, false, 'greeting needs no fresh data');

  const anchored = await needsFreshData('siapa juara dunia 2026');
  assert.equal(anchored.needsFreshData, true, 'time-anchored query needs fresh data');
});

// ─── Fresh-answer pipeline: full Find→Compare→Select→Connect→Conclude ─
test('fresh: freshAnswer returns a web-grounded answer with mapped sources', async () => {
  const result = await freshAnswer('berita terbaru hari ini tentang ' + Date.now());
  assert.equal(result.usedFreshData, true, 'pipeline used fresh web data');
  assert.equal(result.answer, 'Jawaban segar dari web.');
  assert.equal(result.confidence, 'high');
  assert.equal(result.sources.length, 1, 'one source mapped from sources_used');
  assert.equal(result.sources[0].url, FRESH_SOURCE.url);
});

// ─── Fresh-answer pipeline: graceful fallback when no sources ───────
test('fresh: freshAnswer falls back (usedFreshData=false) when the web yields nothing', async () => {
  const result = await freshAnswer('berita tanpasumber hari ini ' + Date.now());
  assert.equal(result.usedFreshData, false, 'no web sources → fall back to internal knowledge');
  assert.equal(result.answer, '');
});

// ─── R3: bare new/baru/recent no longer force casual chat through web ─
test('r3-fresh: bare "new"/"baru"/"recent" are no longer time anchors', () => {
  assert.equal(looksTimeSensitive('gw baru bangun tidur'), false);
  assert.equal(looksTimeSensitive('check my new setup'), false);
  // Compound time anchors still fire.
  assert.equal(looksTimeSensitive('siapa yang menang final terbaru'), true);
});

// ─── R3: reaction-roles getter returns independent copies ───────────
test('r3-rrole: bindings from one guild never leak into another', async () => {
  const { addReactionRole, getReactionRoles } = await import('../src/utils/reaction-roles.js');
  const a = 'grA-' + Date.now();
  const b = 'grB-' + Date.now();

  assert.equal(addReactionRole(a, { messageId: 'm1', channelId: 'c1', emoji: '👍', roleId: 'r1' }), true);

  // Guild B must see an empty list (pre-fix: shared DEFAULT_EMPTY array)
  assert.deepEqual(getReactionRoles(b), [], 'no cross-guild leak');

  // Mutating a returned list must not corrupt stored state
  const list = getReactionRoles(a);
  list.push({ messageId: 'rogue', channelId: 'x', emoji: 'x', roleId: 'x' });
  assert.equal(getReactionRoles(a).length, 1, 'returned array is a defensive copy');

  addReactionRole(b, { messageId: 'm2', channelId: 'c2', emoji: '🎉', roleId: 'r2' });
  assert.deepEqual(
    getReactionRoles(a).map((e) => e.messageId),
    ['m1'],
    'guild A unchanged after guild B write'
  );
});
