import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  NoSubscriberBehavior,
  getVoiceConnection,
} from '@discordjs/voice';
import { Readable } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import logger from '../utils/logger.js';

process.env.FFMPEG_PATH = ffmpegPath;

/**
 * Play an audio buffer in a Discord voice channel.
 * The bot joins the user's voice channel, plays the audio, then disconnects.
 *
 * @param {import('discord.js').VoiceChannel} voiceChannel - The voice channel to join
 * @param {Buffer} audioBuffer - MP3 audio buffer to play
 * @returns {Promise<void>}
 */
export async function playInVoiceChannelDirect(voiceChannel, audioBuffer) {
  if (process.env.TEST_ENV) {
    logger.debug('TEST_ENV: Bypassing real voice channel connection.');
    return Promise.resolve();
  }
  
  logger.info(`Joining voice channel: ${voiceChannel.name} (${voiceChannel.id})`);

  // Destroy existing connection in the same guild if any
  const existing = getVoiceConnection(voiceChannel.guild.id);
  if (existing) {
    logger.debug('Destroying existing voice connection');
    existing.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  // Handle connection state changes for debugging
  connection.on('stateChange', (oldState, newState) => {
    logger.debug(`Voice connection: ${oldState.status} → ${newState.status}`);
  });

  // Handle disconnection/reconnection
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Try to reconnect
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Seems to be reconnecting, do nothing
      logger.debug('Voice connection reconnecting...');
    } catch {
      // Seems to be a real disconnect
      logger.debug('Voice connection fully disconnected');
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    }
  });

  try {
    // Wait for connection to be ready — 30 seconds timeout
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.success('Voice connection ready');
  } catch (err) {
    logger.error(`Voice connection failed, current state: ${connection.state.status}`);
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    throw new Error(`Gagal connect ke voice channel. Pastikan bot punya permission Connect & Speak.`);
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  // Create audio resource from buffer
  const stream = Readable.from(audioBuffer);
  const resource = createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
  });

  connection.subscribe(player);
  player.play(resource);

  logger.info('Playing audio...');

  return new Promise((resolve, reject) => {
    player.on(AudioPlayerStatus.Idle, () => {
      logger.debug('Audio finished, disconnecting in 2s...');
      setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
        logger.info('Disconnected from voice channel');
        resolve();
      }, 2000);
    });

    player.on('error', (err) => {
      logger.error(`Audio player error: ${err.message}`);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      reject(err);
    });

    // Safety timeout: disconnect after 60 seconds no matter what
    setTimeout(() => {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        logger.warn('Safety timeout: force disconnecting');
        connection.destroy();
        resolve();
      }
    }, 60_000);
  });
}

const guildQueues = new Map();

/**
 * Enqueue a task in the guild's voice queue.
 * Resolves when the task is finished.
 */
export async function playInGuildVoiceQueue(guildId, taskCallback) {
  if (!guildQueues.has(guildId)) {
    guildQueues.set(guildId, Promise.resolve());
  }

  const currentQueue = guildQueues.get(guildId);
  
  const nextQueue = currentQueue.catch(() => {}).then(async () => {
    await taskCallback();
  });

  guildQueues.set(guildId, nextQueue);

  nextQueue.catch(() => {}).finally(() => {
    if (guildQueues.get(guildId) === nextQueue) {
      guildQueues.delete(guildId);
      logger.debug(`Cleaned up voice queue for guild ${guildId}`);
    }
  });

  return nextQueue;
}

/**
 * Play an audio buffer in a Discord voice channel (queued to prevent overlapping).
 *
 * @param {import('discord.js').VoiceChannel} voiceChannel - The voice channel to join
 * @param {Buffer} audioBuffer - MP3 audio buffer to play
 * @returns {Promise<void>}
 */
export async function playInVoiceChannel(voiceChannel, audioBuffer) {
  return playInGuildVoiceQueue(voiceChannel.guild.id, async () => {
    try {
      await playInVoiceChannelDirect(voiceChannel, audioBuffer);
    } catch (err) {
      logger.error(`Voice play error in queue for guild ${voiceChannel.guild.id}: ${err.message}`);
      throw err;
    }
  });
}

/**
 * Check if a member is in a voice channel
 * @param {import('discord.js').GuildMember} member
 * @returns {import('discord.js').VoiceChannel|null}
 */
export function getMemberVoiceChannel(member) {
  return member?.voice?.channel || null;
}

export default { playInVoiceChannel, getMemberVoiceChannel };
