import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.mjs';

setupEnv();

const { buildWelcomeEmbed, isHttpUrl, WELCOME_TITLE_MAX, WELCOME_MESSAGE_MAX } = await import('../src/utils/welcome-embed.js');

function memberFixture() {
  return {
    id: 'user-1',
    displayName: 'New Member',
    guild: { name: 'Test Server' },
    user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
  };
}

test('welcome embed renders member placeholders and image', () => {
  const embed = buildWelcomeEmbed(memberFixture(), {
    title: 'Welcome {user} to {server}',
    message: 'Say hi to {mention}, {user}!',
    image: 'https://cdn.example/welcome.png',
  }).toJSON();

  assert.equal(embed.title, 'Welcome New Member to Test Server');
  assert.equal(embed.description, 'Say hi to <@user-1>, New Member!');
  assert.equal(embed.image.url, 'https://cdn.example/welcome.png');
  assert.equal(embed.thumbnail.url, 'https://cdn.example/avatar.png');
});

test('welcome embed renders @{user} as in-embed mention', () => {
  const embed = buildWelcomeEmbed(memberFixture(), {
    message: 'Selamat datang @{user} di server Testing Cyberjo.',
  }).toJSON();

  assert.equal(embed.description, 'Selamat datang <@user-1> di server Testing Cyberjo.');
});

test('welcome embed rejects non-http image and caps Discord text limits', () => {
  const embed = buildWelcomeEmbed(memberFixture(), {
    title: 'x'.repeat(300),
    message: 'y'.repeat(5000),
    image: 'javascript:alert(1)',
  }).toJSON();

  assert.equal(embed.title.length, WELCOME_TITLE_MAX);
  assert.equal(embed.description.length, WELCOME_MESSAGE_MAX);
  assert.equal(embed.image, undefined);
});

test('welcome image validator accepts only http and https', () => {
  assert.equal(isHttpUrl('https://example.com/image.png'), true);
  assert.equal(isHttpUrl('http://example.com/image.png'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('not-a-url'), false);
});
