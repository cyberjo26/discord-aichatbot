import { condenseForVoice, synthesize, resolveEnglishVoice } from '../voice/tts.js';
import config from '../config.js';
import { playInVoiceChannel, getMemberVoiceChannel } from '../voice/player.js';

/**
 * Handle playing a voice response.
 *
 * If the member is not in a voice channel, TTS synthesis is skipped entirely
 * (no condense AI call, no TTS API hit) to preserve the TTS rate limit. The
 * caller remains responsible for sending the text reply in that case.
 *
 * @param {object} member - GuildMember to check voice channel for
 * @param {string} text - Raw text to speak
 * @param {object} [interaction] - Command interaction to reply/edit
 * @param {object} [replyOptions] - Reply options object to modify/send
 * @returns {Promise<boolean>} - Returns true if played in VC, false if skipped
 */
export async function handleVoiceResponse(member, text, interaction = null, replyOptions = null) {
  const voiceChannel = getMemberVoiceChannel(member);

  // User not in voice channel → skip TTS entirely to preserve rate limit.
  // Caller already sent / will send the text reply.
  if (!voiceChannel) {
    return false;
  }

  const voiceText = await condenseForVoice(text);
  // Translated text (TTS_TRANSLATE_ENGLISH) must use an English voice.
  const voice = config.ttsTranslateEnglish ? resolveEnglishVoice() : undefined;
  const audioBuffer = await synthesize(voiceText, voice);

  if (interaction && replyOptions) {
    await interaction.editReply(replyOptions);
  }
  await playInVoiceChannel(voiceChannel, audioBuffer);
  return true;
}

export default { handleVoiceResponse };
