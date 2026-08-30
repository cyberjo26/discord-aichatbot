// Security tests: SSRF edge cases beyond the built-in suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.mjs';

setupEnv();

const { isSafeUrl, safeHttpAgent, safeHttpsAgent } = await import('../src/utils/security.js');

test('SSRF: blocks private IPv4 ranges incl. AWS metadata', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
  ]) {
    assert.equal(await isSafeUrl(url), false, `should block ${url}`);
  }
});

test('SSRF: blocks loopback IPv6', async () => {
  assert.equal(await isSafeUrl('http://[::1]/'), false);
  assert.equal(await isSafeUrl('http://[::1]:8080/x'), false);
});

test('SSRF: blocks localhost by name (DNS resolves to loopback)', async () => {
  assert.equal(await isSafeUrl('http://localhost:8080/'), false);
  assert.equal(await isSafeUrl('http://localhost/'), false);
});

test('SSRF: blocks non-http(s) protocols', async () => {
  assert.equal(await isSafeUrl('file:///etc/passwd'), false);
  assert.equal(await isSafeUrl('ftp://example.com'), false);
  assert.equal(await isSafeUrl('gopher://localhost:70/'), false);
  assert.equal(await isSafeUrl('javascript:alert(1)'), false);
  assert.equal(await isSafeUrl('data:text/html,<b>hi</b>'), false);
});

test('SSRF: blocks malformed / unresolvable hosts', async () => {
  assert.equal(await isSafeUrl('not a url'), false);
  assert.equal(await isSafeUrl(''), false);
  assert.equal(await isSafeUrl('https://'), false);
});

test('SSRF: allows public https URLs', async () => {
  assert.equal(await isSafeUrl('https://example.com'), true);
  assert.equal(await isSafeUrl('https://example.com/path?q=1#frag'), true);
});

test('SSRF: blocks IPv4-mapped IPv6 loopback', async () => {
  assert.equal(await isSafeUrl('http://[::ffff:127.0.0.1]/'), false);
  assert.equal(await isSafeUrl('http://[::ffff:169.254.169.254]/'), false);
});

test('SSRF: blocks dot-decimal disguised forms', async () => {
  // 0x7f000001 == 127.0.0.1 ; 2130706433 == 127.0.0.1 decimal
  assert.equal(await isSafeUrl('http://0x7f000001/'), false, 'hex loopback should be blocked');
  assert.equal(await isSafeUrl('http://2130706433/'), false, 'decimal loopback should be blocked');
  assert.equal(await isSafeUrl('http://127.1/'), false, 'short dot-decimal should be blocked');
});

test('SSRF: safe agents expose custom lookup without crashing', async () => {
  // The agents are constructed at module load — just verify they exist and can
  // be passed to an http(s) request without throwing on construction.
  assert.ok(safeHttpAgent);
  assert.ok(safeHttpsAgent);
  // http.Agent instances store the custom lookup as a property
  assert.equal(typeof safeHttpAgent.options?.lookup, 'function');
  assert.equal(typeof safeHttpsAgent.options?.lookup, 'function');
});

test('SSRF: isSafeUrl handles IPv4-mapped + bracket forms', async () => {
  // Already covered above; ensure no crash on pathological forms
  assert.equal(typeof await isSafeUrl('http://[::ffff:10.0.0.1]/'), 'boolean');
  assert.equal(typeof await isSafeUrl('http://[2001:db8::1]/'), 'boolean');
});
