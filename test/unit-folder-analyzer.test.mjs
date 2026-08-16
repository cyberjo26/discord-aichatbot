import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FolderAnalysisEngine } from '../src/utils/folder-analyzer.js';

const TEST_DIR = path.resolve('./temp/test-folder-analyzer');
const QUARANTINE_DIR = path.join(TEST_DIR, 'quarantine');

test.beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

test('FolderAnalysisEngine detects duplicate folders', () => {
  const engine = new FolderAnalysisEngine({
    quarantineDir: QUARANTINE_DIR,
    dbPath: path.join(TEST_DIR, 'meta.json')
  });

  const folderA = path.join(TEST_DIR, 'folderA');
  const folderB = path.join(TEST_DIR, 'folderB');
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);

  fs.writeFileSync(path.join(folderA, 'file.txt'), 'hello duplicate world');
  fs.writeFileSync(path.join(folderB, 'file.txt'), 'hello duplicate world');

  const scanRes = engine.scan(TEST_DIR);
  assert.equal(scanRes.duplicates.length, 1);
  assert.equal(scanRes.duplicates[0].category, 'duplicate');
});

test('FolderAnalysisEngine quarantine and restore workflow', () => {
  const engine = new FolderAnalysisEngine({
    quarantineDir: QUARANTINE_DIR,
    dbPath: path.join(TEST_DIR, 'meta.json'),
    quarantineRetentionDays: 30
  });

  const targetFolder = path.join(TEST_DIR, 'victim-folder');
  fs.mkdirSync(targetFolder);
  fs.writeFileSync(path.join(targetFolder, 'data.txt'), 'preserve me');

  // Quarantine
  const record = engine.quarantine(targetFolder);
  assert.ok(record.id);
  assert.equal(fs.existsSync(targetFolder), false);
  assert.equal(fs.existsSync(record.quarantinePath), true);

  // Restore
  const restored = engine.restore(record.id);
  assert.equal(restored.id, record.id);
  assert.equal(fs.existsSync(targetFolder), true);
  assert.equal(fs.readFileSync(path.join(targetFolder, 'data.txt'), 'utf8'), 'preserve me');
});

test('FolderAnalysisEngine custom ignore patterns & .pcmonignore', () => {
  const engine = new FolderAnalysisEngine({
    quarantineDir: QUARANTINE_DIR,
    dbPath: path.join(TEST_DIR, 'meta.json')
  });

  // Create .pcmonignore file
  fs.writeFileSync(path.join(TEST_DIR, '.pcmonignore'), 'custom-skip-dir\n# comment\n');

  const ignoredDir = path.join(TEST_DIR, 'custom-skip-dir');
  fs.mkdirSync(ignoredDir);
  fs.writeFileSync(path.join(ignoredDir, 'file.txt'), 'ignore me');

  const normalDir = path.join(TEST_DIR, 'normal-dir');
  fs.mkdirSync(normalDir);
  fs.writeFileSync(path.join(normalDir, 'normal.txt'), 'keep me');

  const scanRes = engine.scan(TEST_DIR);
  // TEST_DIR root + normal-dir = 2 directories (custom-skip-dir ignored)
  assert.equal(scanRes.totalScanned, 2);
});
