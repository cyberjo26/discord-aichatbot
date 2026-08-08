// Security regression tests for the mention input sanitizer.
// sanitizeInput must strip control characters (injection vector), preserve
// legit whitespace (tab/newline/CR), trim, truncate, and reject non-strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.mjs';

setupEnv();

const { sanitizeInput } = await import('../src/mention-handler.js');

test('sanitizer: strips NUL and all control characters', () => {
  // \x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F must all be removed
  const evil = `a\x00b\x08c\x0Bd\x0Ce\x0Ff\x1Fg\x7Fh`;
  assert.equal(sanitizeInput(evil), 'abcdefgh');
});

test('sanitizer: preserves tab, newline, and carriage return', () => {
  const input = 'a\x09b\x0Ac\x0Dd'; // tab, LF, CR
  assert.equal(sanitizeInput(input), 'a\tb\nc\rd');
});

test('sanitizer: trims surrounding whitespace', () => {
  assert.equal(sanitizeInput('   halo dunia  '), 'halo dunia');
});

test('sanitizer: truncates to maxLength', () => {
  assert.equal(sanitizeInput('x'.repeat(100), 10).length, 10);
  assert.equal(sanitizeInput('x'.repeat(3000)).length, 2000, 'default cap is 2000');
});

test('sanitizer: rejects non-string input', () => {
  assert.equal(sanitizeInput(null), '');
  assert.equal(sanitizeInput(undefined), '');
  assert.equal(sanitizeInput(123), '');
  assert.equal(sanitizeInput({}), '');
  assert.equal(sanitizeInput(''), '');
});

test('sanitizer: combined injection attempt is neutralized', () => {
  const payload = `\x00\x1F@bot\x00 halo\x1F \x7F`;
  const out = sanitizeInput(payload, 2000);
  assert.equal(out, '@bot halo');
  assert.ok(!out.includes('\x00') && !out.includes('\x1F') && !out.includes('\x7F'));
});
