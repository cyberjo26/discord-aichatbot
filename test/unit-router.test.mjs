// Round-robin provider rotation tests — all assertions are relative to the
// module's internal counter, so they stay correct regardless of which other
// tests ran first (the counter is shared module state).
import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { providerOrder } from '../src/ai/router.js';

const rotate = (arr, k) => [...arr.slice(k), ...arr.slice(0, k)];

test('router: providerOrder rotates across providers and wraps', () => {
  const original = config.aiProviderOrder;
  try {
    config.aiProviderOrder = ['alpha', 'beta', 'gamma'];
    const o1 = providerOrder({});
    const o2 = providerOrder({});
    const o3 = providerOrder({});
    const o4 = providerOrder({});
    // Every call is a cyclic rotation of the same list
    assert.deepEqual(o2, rotate(o1, 1));
    assert.deepEqual(o3, rotate(o1, 2));
    assert.deepEqual(o4, o1, 'rotation must wrap after the provider count');
    // All providers appear in every order
    assert.deepEqual(new Set(o1), new Set(['alpha', 'beta', 'gamma']));
  } finally {
    config.aiProviderOrder = original;
  }
});

test('router: counter stays bounded — rotation still cycles after 1000 calls', () => {
  const original = config.aiProviderOrder;
  try {
    config.aiProviderOrder = ['a', 'b', 'c'];
    for (let i = 0; i < 1000; i++) providerOrder({});
    const n1 = providerOrder({});
    const n2 = providerOrder({});
    const n3 = providerOrder({});
    // Rotation is still a clean cycle after 1000 calls (modulo, not growth)
    assert.deepEqual(n2, rotate(n1, 1));
    assert.deepEqual(n3, rotate(n1, 2));
    assert.deepEqual(new Set([n1[0], n2[0], n3[0]]), new Set(['a', 'b', 'c']));
  } finally {
    config.aiProviderOrder = original;
  }
});

test('router: explicit provider short-circuits without advancing the counter', () => {
  const original = config.aiProviderOrder;
  try {
    config.aiProviderOrder = ['a', 'b', 'c'];
    const before = providerOrder({});
    assert.deepEqual(providerOrder({ provider: 'custom' }), ['custom']);
    // Next rotation continues as if the passthrough call never happened
    assert.deepEqual(providerOrder({}), rotate(before, 1));
  } finally {
    config.aiProviderOrder = original;
  }
});

test('router: single configured provider returns as-is', () => {
  const original = config.aiProviderOrder;
  try {
    config.aiProviderOrder = ['only'];
    assert.deepEqual(providerOrder({}), ['only']);
    assert.deepEqual(providerOrder({ provider: 'gemini' }), ['gemini']);
  } finally {
    config.aiProviderOrder = original;
  }
});

test('router: resolves named custom provider aliases dynamically', async () => {
  const { getProvider } = await import('../src/ai/router.js');
  const { isNamedCustomEnabled } = await import('../src/ai/providers/custom-openai.js');

  process.env['9ROUTER_BASE_URL'] = 'https://api.9router.com/v1/chat/completions';
  process.env['9ROUTER_API_KEY'] = 'sk-9router';

  assert.equal(isNamedCustomEnabled('9router'), true);
  const p9 = getProvider('9router');
  assert.equal(typeof p9.complete, 'function');
  assert.equal(p9.enabled(), true);

  delete process.env['9ROUTER_BASE_URL'];
  delete process.env['9ROUTER_API_KEY'];
});

test('router: resolves built-in presets (sambanova, mistral, github)', async () => {
  const { getProvider } = await import('../src/ai/router.js');
  const { isNamedCustomEnabled, getNamedCustomConfig } = await import('../src/ai/providers/custom-openai.js');

  process.env['SAMBANOVA_API_KEY'] = 'sk-samba-123';
  process.env['GITHUB_TOKEN'] = 'ghp_secret';

  assert.equal(isNamedCustomEnabled('sambanova'), true);
  const sambaCfg = getNamedCustomConfig('sambanova');
  assert.equal(sambaCfg.baseURL, 'https://api.sambanova.ai/v1/chat/completions');
  assert.equal(sambaCfg.defaultModel, 'Meta-Llama-3.3-70B-Instruct');

  assert.equal(isNamedCustomEnabled('github'), true);
  const ghCfg = getNamedCustomConfig('github');
  assert.equal(ghCfg.baseURL, 'https://models.inference.ai.azure.com/chat/completions');
  assert.equal(ghCfg.defaultModel, 'gpt-4o-mini');

  const pSamba = getProvider('sambanova');
  assert.equal(pSamba.enabled(), true);

  delete process.env['SAMBANOVA_API_KEY'];
  delete process.env['GITHUB_TOKEN'];
});

test('commands: test-ai slash command module is valid', async () => {
  const testAiCmd = await import('../src/commands/test-ai.js');
  assert.equal(testAiCmd.data.name, 'test-ai');
  assert.equal(typeof testAiCmd.execute, 'function');
});

test('openai-factory: parses truncated JSON smoothly without crashing', async () => {
  const { createOpenAIProvider } = await import('../src/ai/providers/openai-factory.js');
  
  // Mock global fetch to return truncated JSON
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      text: async () => '{"id":"chatcmpl-123","choices":[{"index":0,"message":{"content":"I am MiniMax-M3 assistant',
    });

    const p = createOpenAIProvider('test-truncated', {
      baseURL: 'https://test.com',
      apiKey: 'test-key',
      defaultModel: 'test-model',
    });

    const res = await p.complete([{ role: 'user', content: 'Who are you' }]);
    assert.equal(res.text, 'I am MiniMax-M3 assistant');
  } finally {
    global.fetch = originalFetch;
  }
});
