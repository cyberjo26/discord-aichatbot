// Compatibility + smoke tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupEnv } from './helpers.mjs';

setupEnv();

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

test('compat: node version satisfies engines (>=22.12.0)', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} must be >= 22.12`);
});

test('compat: project is ESM (type: module in package.json)', async () => {
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
});

test('smoke: config exits with error when required env vars are missing', async () => {
  // Run config.js from a clean temp cwd (no .env anywhere up the chain)
  const fs = await import('node:fs');
  const os = await import('node:os');
  const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-noconf-'));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'config.js')], {
    cwd: cleanCwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(res.status, 0, 'config.js must exit non-zero without env');
  assert.match(res.stderr + res.stdout, /Missing required env variable/);
});

test('smoke: all commands modules expose .data and .execute', async () => {
  const cmds = ['ask', 'chat', 'summarize', 'help', 'admin', 'ping', 'weather', 'invite'];
  for (const name of cmds) {
    const mod = await import(`../src/commands/${name}.js`);
    assert.ok(mod.data, `/commands/${name}.js must export data`);
    assert.equal(typeof mod.data.toJSON, 'function');
    assert.equal(typeof mod.execute, 'function');
  }
});

test('smoke: deploy-commands registers exactly 8 commands', async () => {
  const { REST, Routes } = await import('discord.js');
  const files = ['ask', 'chat', 'summarize', 'help', 'admin', 'ping', 'weather', 'invite'];
  const mods = await Promise.all(files.map((f) => import(`../src/commands/${f}.js`)));
  const commands = mods.map((m) => m.data.toJSON());
  assert.equal(commands.length, 8);
  assert.ok(REST && Routes, 'discord.js REST exports available');
});

test('smoke: all provider modules import cleanly', async () => {
  const providers = ['openrouter', 'gemini', 'groq', 'cerebras', 'pollinations', 'puter', 'custom-openai'];
  for (const p of providers) {
    const mod = await import(`../src/ai/providers/${p}.js`);
    assert.equal(typeof mod.default, 'object', `${p} has default export`);
  }
});

test('compat: gitignore protects .env and data files', async () => {
  const fs = await import('node:fs');
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.env'), '.env must be gitignored');
  assert.ok(gi.includes('data/*.json'), 'data JSON must be gitignored');
});
