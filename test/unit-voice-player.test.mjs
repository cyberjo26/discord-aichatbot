// Voice player leak guard: a connection 'error' event must destroy the
// connection (and must not crash the process — EventEmitter 'error' without a
// listener throws). Uses a mocked @discordjs/voice so no real voice is joined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

// Force the real playback path (player.js bypasses when TEST_ENV is set)
delete process.env.TEST_ENV;

const connection = new EventEmitter();
const player = new EventEmitter();
player.play = () => {};
const state = { status: 'ready' };
let destroyedCount = 0;
connection.state = state;
connection.destroy = () => {
  destroyedCount++;
  state.status = 'destroyed';
};
connection.subscribe = () => {};
connection.guild = { id: 'test-guild' };

mock.module('@discordjs/voice', {
  namedExports: {
    joinVoiceChannel: () => connection,
    getVoiceConnection: () => null,
    createAudioPlayer: () => player,
    createAudioResource: () => ({}),
    entersState: async () => 'ready',
    AudioPlayerStatus: { Idle: 'idle' },
    VoiceConnectionStatus: {
      Ready: 'ready',
      Disconnected: 'disconnected',
      Signalling: 'signalling',
      Connecting: 'connecting',
      Destroyed: 'destroyed',
    },
    StreamType: { Arbitrary: 'arbitrary' },
    NoSubscriberBehavior: { Play: 'play' },
  },
});

const { playInVoiceChannelDirect } = await import('../src/voice/player.js');

test('voice: connection error destroys connection instead of crashing', async () => {
  const playing = playInVoiceChannelDirect(
    { id: 'vc-1', name: 'Test VC', guild: { id: 'test-guild', voiceAdapterCreator: {} } },
    Buffer.from('fake audio')
  );
  // Let join/play attach listeners first
  await new Promise((r) => setImmediate(r));

  // Without a listener, this emit would throw and crash the process
  assert.doesNotThrow(() => connection.emit('error', new Error('transport boom')));
  assert.equal(destroyedCount, 1, 'connection error must destroy the connection');

  // A player error after the connection error must not double-destroy or hang
  player.emit('error', new Error('player boom'));
  await assert.rejects(playing);
  assert.equal(destroyedCount, 1, 'destroy must be idempotent');
});
