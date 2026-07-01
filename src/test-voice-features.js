import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import Database from 'better-sqlite3';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ai-bot-test-'));
process.env.TEST_ENV = '1';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client';
process.env.OPENROUTER_API_KEY ||= 'test-key';
process.env.DATABASE_PATH = path.join(testRoot, 'voice-reminders.db');
process.env.LEGACY_REMINDERS_FILE = path.join(testRoot, 'voice-reminders.json');
process.env.SERVER_SETTINGS_FILE = path.join(testRoot, 'server-settings.json');

const { handleVoiceWelcome, sanitizeDisplayName, _cooldowns } = await import('./voice/welcome.js');
const {
  parseAbsoluteTime, 
  sanitizeReminderText, 
  saveRemindersToFile, 
  initReminders, 
  pollDueReminders, 
  setReminder,
  cancelReminder,
  _setRemindersArray, 
  _getRemindersArray,
  _stopPolling,
  closeDB
} = await import('./utils/reminders.js');
const { setSetting } = await import('./utils/server-settings.js');
const player = await import('./voice/player.js');

// Setup Mock Environment
const testRemindersPath = process.env.DATABASE_PATH;

// Helper to reset reminders
function resetTestReminders() {
  _setRemindersArray([]);
  if (fs.existsSync(testRemindersPath)) fs.unlinkSync(testRemindersPath);
}

// Clean up after test
function cleanup() {
  _stopPolling();
  closeDB();
  const resolvedTestRoot = path.resolve(testRoot);
  const resolvedTempRoot = path.resolve(os.tmpdir());
  if (resolvedTestRoot.startsWith(`${resolvedTempRoot}${path.sep}`)) {
    fs.rmSync(resolvedTestRoot, { recursive: true, force: true });
  }
}

// Logger mock
function logger(msg) {
  console.log(`[TEST] ${msg}`);
}

async function runTests() {
  logger("Starting offline unit test suite...");
  
  try {
    resetTestReminders();

    // ─── Test 1: Sanitize Display Name ──────────────────────────────────
    logger("Test 1: Sanitize Display Name");
    assert.strictEqual(sanitizeDisplayName("cyberjo26 😊"), "cyberjo26");
    assert.strictEqual(sanitizeDisplayName("   Martin\n   "), "Martin");
    assert.strictEqual(sanitizeDisplayName("a".repeat(40)), "a".repeat(32));
    assert.strictEqual(sanitizeDisplayName("Hello\u200bWorld"), "HelloWorld");
    assert.strictEqual(sanitizeDisplayName(""), "User");
    logger("✅ Test 1 Passed!");

    // ─── Test 2: Absolute Time Parser (Indonesian) ────────────────────────────────────
    logger("Test 2: Absolute Time Parser (Indonesian)");
    // Mock Date.now() to a fixed time (e.g. 10:00 AM today)
    const realDateNow = Date.now;
    const fixedNow = new Date('2024-01-01T10:00:00Z').getTime();
    Date.now = () => fixedNow;
    
    try {
      const parsed1 = parseAbsoluteTime("jam 3 sore");
      assert.ok(parsed1 > fixedNow);
      
      const parsed2 = parseAbsoluteTime("besok jam 7 pagi");
      assert.ok(parsed2 > fixedNow + 12 * 60 * 60 * 1000);
      
      const parsedPast = parseAbsoluteTime("jam 1 pagi");
      assert.ok(parsedPast > fixedNow); // Must adjust to tomorrow if passed
      logger("✅ Test 2 Passed!");
    } finally {
      Date.now = realDateNow; // Restore
    }

    // ─── Test 3: Sanitize Reminder Text ──────────────────────────────────
    logger("Test 3: Sanitize Reminder Text");
    assert.strictEqual(sanitizeReminderText("Beli obat **PENTING** 😊"), "Beli obat PENTING");
    assert.strictEqual(sanitizeReminderText("a".repeat(120)).endsWith("..."), true);
    assert.strictEqual(sanitizeReminderText("a".repeat(120)).length, 103);
    logger("✅ Test 3 Passed!");

    // ─── Test 4: Reminder Persistence (Safe Save & Restore) ─────────────
    logger("Test 4: Reminder Persistence");
    const oldDb = new Database(testRemindersPath);
    oldDb.exec(`
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY, userId TEXT, guildId TEXT, text TEXT,
        triggerAt INTEGER, createdAt INTEGER, delivery TEXT,
        fallbackChannelId TEXT, status TEXT
      )
    `);
    oldDb.prepare(`INSERT INTO reminders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('50', 'old-user', 'guild1', 'Schema lama', Date.now() + 20_000,
        Date.now(), 'text', 'chan1', 'pending');
    oldDb.close();

    fs.writeFileSync(process.env.LEGACY_REMINDERS_FILE, JSON.stringify({ reminders: [{
      id: 51,
      guildId: 'guild1',
      userId: 'json-user',
      fallbackChannelId: 'chan1',
      text: 'JSON lama',
      delivery: 'text',
      triggerAt: Date.now() + 20_000,
      status: 'pending',
      createdAt: Date.now(),
    }] }));

    const testList = [{
      id: 101,
      guildId: "guild1",
      userId: "user1",
      fallbackChannelId: "chan1",
      text: "Makan Siang",
      delivery: "voice",
      triggerAt: Date.now() + 10000,
      timezone: "Asia/Bangkok",
      status: "pending",
      createdAt: Date.now()
    }];
    
    _setRemindersArray(testList);
    const saved = saveRemindersToFile(testList);
    assert.strictEqual(saved, true);
    assert.ok(fs.existsSync(testRemindersPath));
    
    // Simulate restart
    _setRemindersArray([]);
    initReminders({}); // Mock client
    
    const loaded = _getRemindersArray();
    assert.strictEqual(loaded.length, 3);
    assert.ok(loaded.some((row) => row.text === 'Schema lama'));
    assert.ok(loaded.some((row) => row.text === 'JSON lama'));
    assert.ok(loaded.some((row) => row.text === 'Makan Siang'));
    assert.ok(loaded.every((row) => Number.isInteger(row.id)));
    logger("✅ Test 4 Passed!");

    // ─── Test 5: Voice Queue Integrity ──────────────────────────────────
    logger("Test 5: Voice Queue Integrity");
    const executionOrder = [];
    let throwErrorOn1 = false;
    
    const mockTask1 = async () => {
      executionOrder.push(1);
      if (throwErrorOn1) throw new TypeError("Mocked adapterCreator is not a function");
      await new Promise(r => setTimeout(r, 10));
    };
    
    const mockTask2 = async () => {
      executionOrder.push(2);
      await new Promise(r => setTimeout(r, 10));
    };

    // Run without errors
    const q1 = player.playInGuildVoiceQueue('guild1', mockTask1);
    const q2 = player.playInGuildVoiceQueue('guild1', mockTask2);
    
    await Promise.all([q1, q2]);
    assert.deepStrictEqual(executionOrder, [1, 2]);

    // Run with error in task 1 - task 2 should still run!
    executionOrder.length = 0;
    throwErrorOn1 = true;
    
    const e1 = player.playInGuildVoiceQueue('guild2', mockTask1).catch(() => {});
    const e2 = player.playInGuildVoiceQueue('guild2', mockTask2);
    
    await Promise.all([e1, e2]);
    assert.deepStrictEqual(executionOrder, [1, 2]); // 2 must execute despite 1 throwing
    logger("✅ Test 5 Passed!");

    // ─── Test 6: Voice Welcome Hub Logic ──────────────────────────────────
    logger("Test 6: Voice Welcome Hub Logic");
    
    // Config mock
    setSetting("g1", "voicemasterHubId", "hub123");

    // Clear cooldowns before test
    _cooldowns.clear();

    const mockPermissions = {
      has: () => true // Allow ViewChannel, Connect, Speak
    };

    const mockState1 = { 
      member: { id: "u1", user: { bot: false }, displayName: "TestUser" }, 
      guild: { 
        id: "g1", 
        afkChannelId: "afk", 
        members: { 
          me: {},
          fetch: async () => ({ displayName: "TestUser", voice: { channelId: "temp123" } })
        } 
      }, 
      channelId: "vc_other",
      channel: { id: "vc_other", type: 2, name: "Other", permissionsFor: () => mockPermissions }
    };
    const mockState2 = { ...mockState1, channelId: "hub123", channel: { id: "hub123", type: 2, name: "Hub", permissionsFor: () => mockPermissions } };
    const mockState3 = { ...mockState1, channelId: "temp123", channel: { id: "temp123", type: 2, name: "Temp", permissionsFor: () => mockPermissions } };
    
    // Scenario 1: Moving from another VC to hub to temp VC (Should NOT welcome)
    await handleVoiceWelcome(mockState1, mockState2); // VC -> hub
    await handleVoiceWelcome(mockState2, mockState3); // hub -> temp
    assert.strictEqual(_cooldowns.has("g1-u1"), false, "Should not welcome when transferring from another VC");
    
    // Scenario 2: Joining from null to hub to temp VC (SHOULD welcome)
    const mockStateNull = { ...mockState1, channelId: null, channel: null };
    await handleVoiceWelcome(mockStateNull, mockState2); // null -> hub
    assert.strictEqual(_cooldowns.has("g1-u1"), false, "Should not welcome instantly in hub, must wait for move");
    
    let synthesizeCalls = 0;
    let playCalls = 0;
    await handleVoiceWelcome(mockState2, mockState3, {
      scheduleFn: (callback) => callback(),
      synthesizeFn: async () => {
        synthesizeCalls++;
        return Buffer.from('mock-audio');
      },
      playFn: async () => {
        playCalls++;
      },
    });
    assert.strictEqual(_cooldowns.has("g1-u1"), true, "Should welcome after transferring from null -> hub -> temp VC");
    assert.strictEqual(synthesizeCalls, 1, 'Welcome should synthesize exactly once');
    assert.strictEqual(playCalls, 1, 'Welcome should play exactly once');
    
    logger("✅ Test 6 Passed!");

    logger('Test 7: Atomic Reminder Claim');
    let textSendCount = 0;
    const due = setReminder({
      guildId: 'guild1',
      userId: 'user1',
      fallbackChannelId: 'chan1',
      text: 'Atomic claim',
      delivery: 'text',
      triggerAt: Date.now() - 1,
    });
    const mockClient = {
      guilds: { cache: new Map([['guild1', {}]]) },
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => { textSendCount++; },
        }),
      },
    };
    await Promise.all([pollDueReminders(mockClient), pollDueReminders(mockClient)]);
    assert.strictEqual(textSendCount, 1, 'Concurrent polls must deliver once');
    assert.strictEqual(_getRemindersArray().find((row) => row.id === due.id)?.status, 'completed');
    logger('✅ Test 7 Passed!');

    logger("🎉 All Offline Unit Tests Passed!");
  } catch (err) {
    console.error(`❌ Test Failed: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

runTests();
